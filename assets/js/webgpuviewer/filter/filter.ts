import { WebGpuRenderer } from "../renderer/renderer"
import type { FilterChain } from "./filterchain"

/**
 * One post-processing step over the finished frame, run by [FilterChain] between the viewer's draw
 * and the canvas - the port of `filter/Filter.kt`.
 *
 * A filter reads [run]'s `src` and writes `dst`; the chain owns both and ping-pongs them, so a
 * filter never allocates its input or output. A multi-pass filter takes intermediates from
 * [FilterChain.scratch] and writes only its last pass into `dst`.
 *
 * Fragment or compute is the filter's choice. [FilterFullscreen] covers the fragment case, which
 * can write the canvas texture directly, so the last filter in the chain costs no extra copy. A
 * compute filter must say so with [usesCompute]: the canvas texture has no storage binding, so the
 * chain gives it an offscreen destination and blits that to the screen afterwards.
 */
export abstract class Filter {
    protected get device(): GPUDevice {
        return WebGpuRenderer.device
    }

    /** Ask for a redraw - set by [FilterChain] when this filter joins it. */
    onUpdate: (() => void) | null = null

    private _enabled = true

    get enabled(): boolean {
        return this._enabled
    }

    set enabled(value: boolean) {
        if (this._enabled === value) return
        this._enabled = value
        this.invalidate()
    }

    /** Redraw with this filter's new settings. Call after anything that changes its output. */
    protected invalidate() {
        this.onUpdate?.()
    }

    /**
     * Whether the chain runs this filter at all this frame - [enabled] plus whatever else it needs
     * to do anything, so one switched on but not yet configured costs nothing. A chain whose
     * filters are all inactive is skipped outright: no offscreen pass.
     */
    get active(): boolean {
        return this.enabled
    }

    /** Shown in pass labels. */
    get label(): string {
        return this.constructor.name
    }

    /**
     * The format this filter writes. The chain's own textures are `rgba8unorm`, matching the
     * canvas; a filter needing headroom between passes should say `rgba16float` instead.
     */
    get outputFormat(): GPUTextureFormat {
        return "rgba8unorm"
    }

    /** True when [run] writes `dst` from a compute pass, so it must be a storage texture. */
    get usesCompute(): boolean {
        return false
    }

    /** Output size, for a filter that resamples - the input size by default. */
    outputWidth(width: number, _height: number): number {
        return width
    }

    outputHeight(_width: number, height: number): number {
        return height
    }

    abstract run(
        chain: FilterChain,
        encoder: GPUCommandEncoder,
        src: GPUTextureView,
        srcWidth: number,
        srcHeight: number,
        dst: GPUTextureView,
        dstWidth: number,
        dstHeight: number,
    ): void

    /** Release GPU resources. Called by [FilterChain.cleanup]. */
    cleanup() { }
}
