import { Fullscreen } from "../renderer/fullscreen"
import { Filter } from "./filter"
import type { FilterChain } from "./filterchain"

/** Enough for [FilterChain]'s texture ring, so a steady chain builds none per frame. */
const CACHED_BIND_GROUPS = 4

/**
 * A [Filter] that is one fragment pass over the whole frame - the port of
 * `filter/FilterFullscreen.kt`, and the shape every per-pixel filter takes.
 *
 * Subclasses supply [code] (an `fs_main` taking [Fullscreen.VERTEX]'s `VertexOutput`) and [entries]
 * (its group 0 bindings). Bind groups are kept per source texture rather than for the last one
 * only, since [FilterChain] rotates its textures across frames and a single-entry cache would then
 * miss every frame; a filter whose own bindings change - a new LUT, say - calls [rebind].
 *
 * There is no blend state: the pass covers every pixel and replaces it, and the frame it reads
 * already carries the alpha the canvas needs.
 */
export abstract class FilterFullscreen extends Filter {
    /** WGSL fragment stage. [Fullscreen.VERTEX] is prepended, so `VertexOutput` and `in.uv` are in scope. */
    protected abstract get code(): string

    private pipelineOrNull: GPURenderPipeline | null = null

    protected get pipeline(): GPURenderPipeline {
        if (!this.pipelineOrNull) {
            this.pipelineOrNull = Fullscreen.buildPipeline(this.code, this.outputFormat, this.label)
        }
        return this.pipelineOrNull
    }

    /** Group 0 bindings for this pass, with the chain's current input as [src]. */
    protected abstract entries(src: GPUTextureView): GPUBindGroupEntry[]

    // Keyed by the view object, which the chain keeps alive for as long as its slot.
    private readonly bound: (GPUTextureView | null)[] = new Array(CACHED_BIND_GROUPS).fill(null)
    private readonly bindGroups: (GPUBindGroup | null)[] = new Array(CACHED_BIND_GROUPS).fill(null)
    private nextBindGroup = 0

    /** Drop the cached bind groups, for a filter whose own bindings have changed. */
    protected rebind() {
        this.bound.fill(null)
        this.bindGroups.fill(null)
        this.invalidate()
    }

    private bindGroupFor(src: GPUTextureView): GPUBindGroup {
        for (let i = 0; i < this.bound.length; i++) {
            if (this.bound[i] === src) {
                const group = this.bindGroups[i]
                if (group) return group
            }
        }

        const group = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            label: this.label,
            entries: this.entries(src),
        })
        this.bound[this.nextBindGroup] = src
        this.bindGroups[this.nextBindGroup] = group
        this.nextBindGroup = (this.nextBindGroup + 1) % CACHED_BIND_GROUPS
        return group
    }

    /** Prepare GPU state for this frame - uploads and the like, before the pass opens. */
    protected prepare(_srcWidth: number, _srcHeight: number) { }

    override run(
        _chain: FilterChain,
        encoder: GPUCommandEncoder,
        src: GPUTextureView,
        srcWidth: number,
        srcHeight: number,
        dst: GPUTextureView,
        _dstWidth: number,
        _dstHeight: number,
    ) {
        this.prepare(srcWidth, srcHeight)

        // Before the pass opens: prepare() may have replaced a binding and dropped the cache.
        const group = this.bindGroupFor(src)

        const pass = Fullscreen.beginPass(encoder, dst, this.label)
        try {
            pass.setPipeline(this.pipeline)
            pass.setBindGroup(0, group)
            pass.draw(3)
        } finally {
            pass.end()
        }
    }
}
