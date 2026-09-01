import { WebGpuRenderer } from "../renderer/renderer"
import type { Filter } from "./filter"
import { FilterFullscreen } from "./filterfullscreen"

/** Textures kept per size and format, so consecutive frames don't share one. */
const RING = 3

const BLIT_FS = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(src, src_sampler, in.uv);
}
`

class Slot {
    inUse = false
    lastFrame = Number.NEGATIVE_INFINITY

    constructor(
        readonly texture: GPUTexture,
        readonly view: GPUTextureView,
    ) { }
}

/**
 * The output filter chain - the port of `filter/FilterChain.kt`.
 *
 * The viewer draws its frame into an offscreen texture, each enabled [Filter] runs over the result
 * of the one before, and the last writes the canvas. Held by [WebGpuRenderer] and reachable as
 * `ImageViewerState.filters`. With nothing enabled the chain steps out of the way entirely -
 * [beginFrame] hands back the canvas texture itself, so a viewer with no filters draws exactly as
 * it did before.
 *
 * Textures are pooled and recycled within the frame, so a chain of any length runs on two
 * screen-sized textures rather than one per filter.
 */
export class FilterChain {
    private get device(): GPUDevice {
        return WebGpuRenderer.device
    }

    /** Set by the viewer - a filter's settings change has to reach the screen somehow. */
    onInvalidate: (() => void) | null = null

    private readonly invalidateCallback = () => this.onInvalidate?.()

    private _filters: Filter[] = []

    /** The chain, in the order they run. Assign to change it. */
    get filters(): Filter[] {
        return this._filters
    }

    set filters(value: Filter[]) {
        this._filters.forEach(f => (f.onUpdate = null))
        value.forEach(f => (f.onUpdate = this.invalidateCallback))
        this._filters = value
        this.invalidateCallback()
    }

    /** This frame's active filters, fixed at [beginFrame] so [endFrame] can't see a half-change. */
    private readonly active: Filter[] = []

    private sceneSlot: Slot | null = null

    private poolWidth = 0
    private poolHeight = 0

    /**
     * Where this frame should be drawn: an offscreen texture when any filter is enabled, and the
     * canvas texture itself when none is. [endFrame] must follow on either path.
     */
    beginFrame(surface: GPUTexture): GPUTexture {
        // Slots a throwing frame never handed back - the pool only ever lives within one frame.
        this.releaseAll()
        this.frame++

        if (this.poolWidth !== surface.width || this.poolHeight !== surface.height) {
            this.destroyPool()
            this.poolWidth = surface.width
            this.poolHeight = surface.height
        }

        this.active.length = 0
        for (const filter of this._filters) if (filter.active) this.active.push(filter)
        if (this.active.length === 0) {
            // Two screen-sized textures is real memory to leave behind a filter that is switched
            // off; turning one back on is a settings change, and can afford to reallocate.
            this.destroyPool()
            return surface
        }

        const slot = this.acquire(surface.width, surface.height, "rgba8unorm", false)
        this.sceneSlot = slot
        return slot.texture
    }

    /** Run the chain over what [beginFrame] handed out, ending on [surface]. */
    endFrame(encoder: GPUCommandEncoder, surface: GPUTexture) {
        const scene = this.sceneSlot
        if (!scene) return
        this.sceneSlot = null

        let srcSlot: Slot | null = scene
        let src: GPUTextureView = scene.view
        let width = surface.width
        let height = surface.height

        try {
            for (let i = 0; i < this.active.length; i++) {
                const filter = this.active[i]
                const outWidth = filter.outputWidth(width, height)
                const outHeight = filter.outputHeight(width, height)
                const last = i === this.active.length - 1

                // The canvas is a render attachment of one fixed format - a compute filter, or one
                // that resamples or wants headroom, has to land offscreen and be blitted.
                const direct =
                    last &&
                    !filter.usesCompute &&
                    filter.outputFormat === "rgba8unorm" &&
                    outWidth === surface.width &&
                    outHeight === surface.height

                const dstSlot =
                    direct ? null : (
                        this.acquire(outWidth, outHeight, filter.outputFormat, filter.usesCompute)
                    )
                const dst = dstSlot?.view ?? surface.createView()

                filter.run(this, encoder, src, width, height, dst, outWidth, outHeight)

                // Only after run() - until it returns, this is the texture it reads from.
                if (srcSlot) srcSlot.inUse = false
                srcSlot = dstSlot
                src = dst
                width = outWidth
                height = outHeight

                if (last && !direct) {
                    this.tailBlit.run(
                        this,
                        encoder,
                        src,
                        width,
                        height,
                        surface.createView(),
                        surface.width,
                        surface.height,
                    )
                }
            }
        } finally {
            if (srcSlot) srcSlot.inUse = false
            this.active.length = 0
        }
    }

    /**
     * A pooled texture for a filter's own intermediate pass, free for the rest of this frame. The
     * caller must hand it back with [release] before returning from [Filter.run].
     */
    scratch(
        width: number,
        height: number,
        format: GPUTextureFormat = "rgba8unorm",
        storage = false,
    ): GPUTextureView {
        return this.acquire(width, height, format, storage).view
    }

    /** Return a [scratch] texture to the pool. */
    release(view: GPUTextureView) {
        for (const slots of this.pool.values()) {
            for (const slot of slots) {
                if (slot.view === view) {
                    slot.inUse = false
                    return
                }
            }
        }
    }

    cleanup() {
        this._filters.forEach(f => f.cleanup())
        this.destroyPool()
    }

    // ---- texture pool ----

    private readonly pool = new Map<string, Slot[]>()

    private frame = 0

    private key(width: number, height: number, format: GPUTextureFormat, storage: boolean): string {
        return `${width}x${height}:${format}:${storage ? 1 : 0}`
    }

    private acquire(
        width: number,
        height: number,
        format: GPUTextureFormat,
        storage: boolean,
    ): Slot {
        const key = this.key(width, height, format, storage)
        let slots = this.pool.get(key)
        if (!slots) {
            slots = []
            this.pool.set(key, slots)
        }

        let free: Slot | null = null
        for (const slot of slots) {
            if (!slot.inUse && (free === null || slot.lastFrame < free.lastFrame)) free = slot
        }

        // Rotate rather than reuse: writing the texture the previous frame is still reading from
        // makes the GPU serialise the two, the same hazard TileRenderer's stencil ring avoids. Only
        // up to [RING] of them, since a chain needing several within one frame must come back round.
        if (free !== null && (free.lastFrame !== this.frame - 1 || slots.length >= RING)) {
            free.inUse = true
            free.lastFrame = this.frame
            return free
        }

        let usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
        if (storage) usage |= GPUTextureUsage.STORAGE_BINDING

        const texture = this.device.createTexture({ size: { width, height }, format, usage })
        const slot = new Slot(texture, texture.createView())
        slot.inUse = true
        slot.lastFrame = this.frame
        slots.push(slot)
        return slot
    }

    private releaseAll() {
        this.sceneSlot = null
        for (const slots of this.pool.values()) for (const slot of slots) slot.inUse = false
    }

    private destroyPool() {
        for (const slots of this.pool.values()) for (const slot of slots) slot.texture.destroy()
        this.pool.clear()
        this.sceneSlot = null
    }

    // ---- tail blit ----

    private blitSamplerOrNull: GPUSampler | null = null

    // Linear, not nearest: the only filters reaching this path are the ones that couldn't write the
    // canvas, which includes any that resampled to a different size.
    private get blitSampler(): GPUSampler {
        if (!this.blitSamplerOrNull) {
            this.blitSamplerOrNull = this.device.createSampler({
                magFilter: "linear",
                minFilter: "linear",
                addressModeU: "clamp-to-edge",
                addressModeV: "clamp-to-edge",
            })
        }
        return this.blitSamplerOrNull
    }

    /**
     * Copies a filter's offscreen result to the canvas - see [endFrame]'s `direct`. A filter
     * itself, so it inherits the pipeline, pass and per-texture bind group caching rather than
     * repeating them; it is never in [filters], and runs only when [endFrame] asks it to.
     */
    private readonly tailBlit: FilterFullscreen = new (class extends FilterFullscreen {
        constructor(private readonly chain: FilterChain) {
            super()
        }
        override get label(): string {
            return "FilterChain blit"
        }
        protected override get code(): string {
            return BLIT_FS
        }
        protected override entries(src: GPUTextureView): GPUBindGroupEntry[] {
            return [
                { binding: 0, resource: src },
                { binding: 1, resource: this.chain.blitSampler },
            ]
        }
    })(this)
}
