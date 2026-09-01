import { WebGpuRenderer } from "./renderer"

/**
 * How [TileRenderer] resizes a high-quality tile - the port of `renderer/Rescaler.kt`.
 * [Upscaler] magnifying, [Downscaler] shrinking.
 *
 * With no [factor] - the defaults - [RenderPage.render] resolves the tile in one step. A [factor]
 * above 1 splits that: [RenderPage.render] resolves at [firstStepScale], then this covers the
 * rest, once. The leftover is still the first step's filter doing it.
 *
 * Four calls per tile, in order, all on the tile worker: [input] for the `size`-square texture
 * the first step draws into, the caller drawing the page into it inset by [halo], [encode], then
 * [resolve].
 */
export abstract class Rescaler {
    protected get device(): GPUDevice {
        return WebGpuRenderer.device
    }

    /** False when this device can't run it - [TileRenderer] then resolves in one step instead. */
    get supported(): boolean {
        return true
    }

    /** How much one run resizes by. 1 means it does nothing, and the tile path skips it. */
    get factor(): number {
        return 1
    }

    /**
     * The WGSL the first step resolves with, composed into [RenderPage.filtered]'s pipeline. An
     * [Upscaler] defines `resolve_magnify(uv) -> vec4<f32>`, a [Downscaler]
     * `resolve_minify(src_start, scale) -> vec4<f32>`, both against [RenderPage]'s header -
     * `transform`, `src_tex0..3`, `totalLoad`, `to_linear_exact`.
     */
    abstract get code(): string

    /**
     * Input pixels of surrounding page each output pixel needs, cut off again by [resolve].
     * Without it a convolutional rescaler is wrong along every tile edge and the seams show.
     */
    get halo(): number {
        return 0
    }

    /**
     * Settle what this tile gets, before anything else here is asked about it. A rescaler whose
     * [factor] varies with the zoom latches it here, so every reader that follows agrees.
     *
     * Not in the Kotlin, whose rescalers all have a fixed [factor].
     */
    plan(_scale: number, _tileSize: number) { }

    /** The scale the first step resolves the tile at, leaving [factor] for this to cover. */
    abstract firstStepScale(scale: number): number

    /** The tile's own span measured in first-step pixels. */
    abstract firstStepSpan(tileSize: number): number

    /** True when a tile at [scale] has a whole [factor] of resizing to give this. */
    abstract appliesAt(scale: number): boolean

    /** True when a tile of [tileSize] divides the way [firstStepSpan] needs it to. */
    fits(_tileSize: number): boolean {
        return true
    }

    /** The square texture the first step renders into. Null if this rescaler can't run. */
    input(_size: number): GPUTexture | null {
        return null
    }

    /** [input]'s view, kept rather than remade per tile. Valid only after [input] has answered. */
    get inputView(): GPUTextureView | null {
        return null
    }

    /** Encode the resize of [input]'s current contents. */
    encode(_encoder: GPUCommandEncoder, _size: number) { }

    /** Draw the middle of the resized result - the tile itself, halo removed - into [pass]. */
    resolve(_pass: GPURenderPassEncoder) { }

    cleanup() { }
}

/**
 * A [Rescaler] for tiles that magnify the page, where a filter has to invent detail the source
 * doesn't have. [UpscalerCatmullRom] by default, [UpscalerArtCnn] the alternative. Both supply
 * [code] themselves rather than inheriting Catmull-Rom's the way the Kotlin does: importing it
 * here would make a cycle these modules evaluate through, and `extends` is not deferred.
 *
 * The first step resolves at `scale / factor`, so this only runs given a whole [factor] of zoom.
 * Below that the first step would shrink the page to make room, losing the detail this exists to
 * reconstruct.
 */
export abstract class Upscaler extends Rescaler {
    override firstStepScale(scale: number): number {
        return scale / this.factor
    }

    override firstStepSpan(tileSize: number): number {
        return tileSize / this.factor
    }

    override appliesAt(scale: number): boolean {
        return scale >= this.factor
    }

    /** The first step resolves a fraction of the tile, so it has to be a whole number of pixels. */
    override fits(tileSize: number): boolean {
        return tileSize % this.factor === 0
    }
}

/**
 * A [Rescaler] for tiles that shrink the page, averaging detail away without aliasing rather than
 * inventing any. [DownscalerBox] is the only one.
 *
 * The mirror of [Upscaler]: the first step resolves at `scale * factor`, larger than the tile,
 * and this reduces it the rest of the way.
 */
export abstract class Downscaler extends Rescaler {
    override firstStepScale(scale: number): number {
        return scale * this.factor
    }

    override firstStepSpan(tileSize: number): number {
        return tileSize * this.factor
    }

    override appliesAt(scale: number): boolean {
        return scale <= 1 / this.factor
    }
}
