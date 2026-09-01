import { nextFrame, yieldToEventLoop } from "../util"
// Cyclic with this module, and benign: each side reaches the other only from inside a function.
import { FilterChain } from "../filter/filterchain"

/**
 * Device ownership and the frame loop - the port of `renderer/WebGpuRenderer.kt`.
 *
 * The Kotlin runs every GPU call on a dedicated render thread behind a mutex, since a long upload
 * elsewhere stalls a queued frame. There is one thread here and no mutex, but the hazard survives:
 * an upload that never yields blocks the next `requestAnimationFrame` just as thoroughly. So the
 * split remains, with awaiting the lock standing in for taking the mutex:
 *
 *  - [withLock] serialises work that must appear atomically to the renderer.
 *  - [unlocked] runs long resource work that yields as it goes, so a frame woken by one of those
 *    yields gets through instead of blocking on the lock and handing the turn straight back.
 *
 * The surface is a [GPUCanvasContext], and there is no `present()` - the browser composites the
 * canvas once the frame's work is submitted.
 */
export class WebGpuRenderer {
    static adapter: GPUAdapter
    static device: GPUDevice
    static format: GPUTextureFormat = "rgba8unorm"

    /** Global draw offset, applied by every placement - see `Image.placement`. */
    static offsetX = 0
    static offsetY = 0

    private static initPromise: Promise<GPUDevice> | null = null

    /**
     * Acquire the adapter and device once for the page. Every later `WebGpuRenderer` shares them,
     * the way the Kotlin's companion object does.
     */
    static async initDevice(): Promise<GPUDevice> {
        if (WebGpuRenderer.initPromise) return WebGpuRenderer.initPromise

        WebGpuRenderer.initPromise = (async () => {
            const adapter = await navigator.gpu?.requestAdapter()
            if (!adapter) throw new Error("need a browser that supports WebGPU")

            // The Kotlin asks for TimestampQuery when the adapter has it, and falls back to a
            // fixed batch size when it doesn't - see TileRenderer.nextBatchSize.
            const requiredFeatures: GPUFeatureName[] = []
            if (adapter.features.has("timestamp-query")) requiredFeatures.push("timestamp-query")

            const device = await adapter.requestDevice({ requiredFeatures })

            device.lost.then(info => {
                console.error("WebGpuRenderer: device lost", info.reason, info.message)
                WebGpuRenderer.deviceLostHandlers.forEach(fn => {
                    try {
                        fn()
                    } catch (e) {
                        console.error("WebGpuRenderer: device-lost handler failed", e)
                    }
                })
            })
            device.addEventListener?.("uncapturederror", (e: Event) => {
                console.error("WebGpuRenderer:", (e as GPUUncapturedErrorEvent).error)
            })

            WebGpuRenderer.adapter = adapter
            WebGpuRenderer.device = device
            return device
        })()

        return WebGpuRenderer.initPromise
    }

    private static readonly deviceLostHandlers: (() => void)[] = []

    /**
     * Register [fn] to run when the device is lost - for anything caching device-owned objects. A
     * registry rather than direct calls, because the listeners (the mipmap texture pool) already
     * import this module, so calling them from here would close the cycle.
     */
    static onDeviceLost(fn: () => void) {
        WebGpuRenderer.deviceLostHandlers.push(fn)
    }

    static get timestampsSupported(): boolean {
        return WebGpuRenderer.device?.features.has("timestamp-query") ?? false
    }

    // The lock is a promise chain: awaiting it is the equivalent of taking the render mutex, and
    // it serialises in the same order requests arrive.
    private static lock: Promise<unknown> = Promise.resolve()

    /** `WebGpuRenderer.withContext` - runs [block] with the render lock held. */
    static withLock<R>(block: (device: GPUDevice) => R | Promise<R>): Promise<R> {
        const run = WebGpuRenderer.lock.then(() => block(WebGpuRenderer.device))
        // Swallowed only so a failing block doesn't poison later acquisitions; the caller still
        // sees the rejection through the returned promise.
        WebGpuRenderer.lock = run.catch(() => { })
        return run
    }

    /**
     * `WebGpuRenderer.onDispatcher` - runs [block] *without* the lock.
     *
     * Only for work that owns its resources outright (an image not yet reachable from a page) or
     * cannot be observed mid-flight. Anything needing to appear atomically belongs in [withLock].
     */
    static async unlocked<R>(block: (device: GPUDevice) => R | Promise<R>): Promise<R> {
        return block(WebGpuRenderer.device)
    }

    // --- Upload pacing --------------------------------------------------------------------

    /**
     * Whether an animation is on screen, republished every frame by `ImageViewerState.collect`.
     *
     * A hitch only shows while something moves: 80ms on a still page reads as the page appearing,
     * the same 80ms mid-turn reads as a stutter.
     */
    static animating = false

    private static uploadChain: Promise<void> = Promise.resolve()

    /** Longest an upload will wait for the screen to settle before going anyway. */
    private static readonly STILLNESS_CAP_MS = 500

    /**
     * Run one texture upload, serialised against the others and held off while an animation runs.
     *
     * Pacing by *size* was disproved: 128KB strips cut the per-frame upload 94-fold, left the worst
     * frame interval exactly where it was (83ms) and cost 1.6s of latency per page. Upload volume is
     * not what delays presentation, so this does not ration it.
     *
     * Scheduling is what remains. [onSubmittedWorkDone] holds the queue to one copy at a time
     * whatever `decodeConcurrency` says, and the stillness wait moves it out of visible frames.
     */
    static pacedUpload(copy: () => void): Promise<void> {
        const previous = WebGpuRenderer.uploadChain
        let release: () => void = () => { }
        WebGpuRenderer.uploadChain = new Promise<void>(resolve => {
            release = resolve
        })

        return (async () => {
            await previous
            try {
                await WebGpuRenderer.waitForStillness()
                copy()
                await WebGpuRenderer.device.queue.onSubmittedWorkDone()
            } finally {
                release()
            }
        })()
    }

    /**
     * Wait for the screen to stop moving, up to [STILLNESS_CAP_MS]. The cap prevents a deadlock: an
     * animation that never ends, or one driven by the page being uploaded, would hold its own
     * texture hostage.
     */
    static async whenStill() {
        return WebGpuRenderer.waitForStillness()
    }

    private static async waitForStillness() {
        if (!WebGpuRenderer.animating) return
        const deadline = performance.now() + WebGpuRenderer.STILLNESS_CAP_MS
        while (WebGpuRenderer.animating && performance.now() < deadline) await nextFrame()
    }

    // --- Per-surface state ----------------------------------------------------------------

    private context: GPUCanvasContext | null = null
    canvas: HTMLCanvasElement | null = null

    /**
     * Post-processing over the finished frame - see [FilterChain]. Empty by default, in which case
     * [render] hands the canvas texture straight to its caller as it always did.
     */
    readonly filters = new FilterChain()

    width = 0
    height = 0

    /** `init(scope, surface, width, height)` - the canvas is the surface here. */
    init(canvas: HTMLCanvasElement, width: number, height: number) {
        this.canvas = canvas
        this.width = width
        this.height = height

        canvas.width = width
        canvas.height = height

        if (!this.context) {
            this.context = canvas.getContext("webgpu") as GPUCanvasContext
        }

        this.context.configure({
            device: WebGpuRenderer.device,
            format: WebGpuRenderer.format,
            colorSpace: "srgb",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            alphaMode: "premultiplied",
        })
    }

    /**
     * Record and submit one frame. Holds the render lock for the whole of it, so a tile
     * generation batch can never land halfway through a frame's recording.
     */
    async render(fn: (encoder: GPUCommandEncoder, texture: GPUTexture) => void | Promise<void>) {
        await WebGpuRenderer.withLock(async device => {
            const context = this.context
            if (!context) return

            let texture: GPUTexture
            try {
                // Blocks on the compositor when no swap-chain buffer is free.
                texture = context.getCurrentTexture()
            } catch (e) {
                console.warn("WebGpuRenderer: failed to get current texture", e)
                return
            }

            try {
                const encoder = device.createCommandEncoder()
                // Draws into an offscreen texture when filters are enabled; endFrame runs them over
                // it and lands the result on the canvas.
                await fn(encoder, this.filters.beginFrame(texture))
                this.filters.endFrame(encoder, texture)
                device.queue.submit([encoder.finish()])
            } catch (e) {
                // Don't rethrow - allow the app to continue rendering next frame.
                console.error("WebGpuRenderer: render error", e)
            }
        })
    }

    cleanup() {
        this.filters.cleanup()
        this.context?.unconfigure()
        this.context = null
    }
}

/** Yield between chunks of a long upload - re-exported so the renderer package reads as one. */
export { yieldToEventLoop }
