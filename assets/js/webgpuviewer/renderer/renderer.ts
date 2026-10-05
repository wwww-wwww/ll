import { nextFrame, yieldToEventLoop } from "../util"
// Cyclic with this module, and benign: each side reaches the other only from inside a function.
import { FilterChain } from "../filter/filterchain"
import { Hdr } from "./hdr"

/**
 * Device ownership and the frame loop.
 *
 * An upload that never yields blocks the next `requestAnimationFrame`, so GPU work is split:
 *
 *  - [withLock] serialises work that must appear atomically to the renderer.
 *  - [unlocked] runs long resource work that yields as it goes, so a frame woken by one of those
 *    yields gets through instead of blocking on the lock and handing the turn straight back.
 *
 * The browser composites the canvas once the frame's work is submitted.
 */
/**
 * `"drawn"` - a frame was recorded and submitted. `"retry"` - nothing drawn this frame but the
 * renderer is otherwise fine (a transient `getCurrentTexture` failure); ask again next frame.
 * `"unavailable"` - nothing can be drawn until something external changes (WebGPU never
 * initialized, or this instance has no canvas) - repeatedly invalidating would just spin
 * `requestAnimationFrame` forever, so a caller should stop asking until told otherwise.
 */
export type FrameResult = "drawn" | "retry" | "unavailable"

export class WebGpuRenderer {
    static adapter: GPUAdapter
    static device: GPUDevice

    /** Set once `device.lost` resolves - see `unavailableReason`. */
    private static deviceLost = false

    /** Human-readable reason nothing can currently be drawn, or null if the device is fine. */
    static get unavailableReason(): string | null {
        if (WebGpuRenderer.deviceLost) return "WebGPU device lost"
        if (!WebGpuRenderer.device) return "WebGPU never initialized"
        return null
    }

    /** Follows `Hdr.frameFormat`. */
    static get format(): GPUTextureFormat {
        return Hdr.frameFormat
    }

    /** Global draw offset, applied by every placement - see `Image.placement`. */
    static offsetX = 0
    static offsetY = 0

    private static initPromise: Promise<GPUDevice> | null = null

    /**
     * Acquire the adapter and device once for the page. Every later `WebGpuRenderer` shares them.
     */
    static async initDevice(): Promise<GPUDevice> {
        if (WebGpuRenderer.initPromise) return WebGpuRenderer.initPromise

        WebGpuRenderer.initPromise = (async () => {
            const adapter = await navigator.gpu?.requestAdapter()
            if (!adapter) throw new Error("need a browser that supports WebGPU")

            // Optional: without it, TileRenderer.nextBatchSize falls back to a fixed batch size.
            const requiredFeatures: GPUFeatureName[] = []
            if (adapter.features.has("timestamp-query")) requiredFeatures.push("timestamp-query")

            const device = await adapter.requestDevice({ requiredFeatures })

            // Before any canvas configures - `Hdr.resolve` probes a disposable canvas since a
            // `GPUCanvasContext` has no `getCapabilities`.
            Hdr.attachDisplay()
            Hdr.resolve(device)

            device.lost.then(info => {
                WebGpuRenderer.deviceLost = true
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

    // A promise chain, so it serialises in the order requests arrive.
    private static lock: Promise<unknown> = Promise.resolve()

    /** Runs [block] with the render lock held. */
    static withLock<R>(block: (device: GPUDevice) => R | Promise<R>): Promise<R> {
        const run = WebGpuRenderer.lock.then(() => block(WebGpuRenderer.device))
        // Swallowed only so a failing block doesn't poison later acquisitions; the caller still
        // sees the rejection through the returned promise.
        WebGpuRenderer.lock = run.catch(() => { })
        return run
    }

    /**
     * Runs [block] *without* the lock.
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

    /** What the canvas was last configured as - see `configure`. */
    private configuredFormat: GPUTextureFormat = "rgba8unorm"

    init(canvas: HTMLCanvasElement, width: number, height: number) {
        this.canvas = canvas
        this.width = width
        this.height = height

        canvas.width = width
        canvas.height = height

        if (!this.context) {
            this.context = canvas.getContext("webgpu") as GPUCanvasContext
        }

        // No images exist yet on a fresh canvas, so any stranded HDR claims are safe to drop.
        Hdr.resetContent()
        Hdr.latchFrameFormat()
        this.configure(Hdr.frameFormat)
    }

    /** Configures the canvas, requesting extended range when [format] is float - see `Hdr`. */
    private configure(format: GPUTextureFormat) {
        if (!this.context) return
        this.context.configure({
            device: WebGpuRenderer.device,
            format,
            colorSpace: "srgb",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            alphaMode: "premultiplied",
            // Chrome's extended-range canvas config - not yet in the WebGPU types.
            ...(format === "rgba16float" ?
                ({ toneMapping: { mode: "extended" } } as object)
                : {}),
        } as GPUCanvasConfiguration)
        this.configuredFormat = format
    }

    /**
     * Record and submit one frame. Holds the render lock for the whole of it, so a tile
     * generation batch can never land halfway through a frame's recording.
     *
     * The browser manages its own swapchain, so a failed `getCurrentTexture` only retries -
     * reconfiguring the context, which a canvas of no size needs. See `FrameResult`.
     */
    async render(
        fn: (encoder: GPUCommandEncoder, texture: GPUTexture) => void | Promise<void>,
    ): Promise<FrameResult> {
        let result: FrameResult = "unavailable"
        await WebGpuRenderer.withLock(async device => {
            const context = this.context
            // Only `init` builds one, so a redraw alone accomplishes nothing.
            if (!context) return

            // Only reconfigures between frames, the one point guaranteed clear of old resources.
            try {
                Hdr.latchFrameFormat()
                if (Hdr.frameFormat !== this.configuredFormat) this.configure(Hdr.frameFormat)
            } catch (e) {
                // Escaping would end the frame loop.
                console.error("WebGpuRenderer: HDR presentation update failed", e)
            }

            let texture: GPUTexture
            try {
                // Blocks on the compositor when no swap-chain buffer is free.
                texture = context.getCurrentTexture()
            } catch (e) {
                console.warn("WebGpuRenderer: failed to get current texture", e)
                // A context that has lost its configuration - a canvas resized to nothing and
                // back, above all - gets it again rather than staying dark for good. Not `init`:
                // that resets `Hdr`'s content tracking, which would be wrong mid-session.
                if (this.canvas && this.width > 0 && this.height > 0) {
                    this.canvas.width = this.width
                    this.canvas.height = this.height
                    this.configure(Hdr.frameFormat)
                }
                result = "retry"
                return
            }

            try {
                const encoder = device.createCommandEncoder()
                // Draws into an offscreen texture when filters are enabled; endFrame runs them over
                // it and lands the result on the canvas.
                await fn(encoder, this.filters.beginFrame(texture))
                this.filters.endFrame(encoder, texture)
                device.queue.submit([encoder.finish()])
                result = "drawn"
            } catch (e) {
                // Don't rethrow - allow the app to continue rendering next frame.
                console.error("WebGpuRenderer: render error", e)
                result = "retry"
            }
        })
        return result
    }

    cleanup() {
        // Once the device is lost there is nothing to free.
        if (!WebGpuRenderer.deviceLost) this.filters.cleanup()
        this.context?.unconfigure()
        this.context = null
    }
}

/** Yield between chunks of a long upload - re-exported so the renderer package reads as one. */
export { yieldToEventLoop }
