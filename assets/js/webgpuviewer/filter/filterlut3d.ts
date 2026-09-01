import { FilterFullscreen } from "./filterfullscreen"
import { Lut3d } from "./lut3d"

const scratch = new DataView(new ArrayBuffer(4))

/** 1.0 as an IEEE half. */
const ONE_HALF = 0x3c00

/**
 * Float to IEEE half, round-to-nearest, saturating rather than overflowing to infinity.
 *
 * By hand rather than through `Float16Array`, which is too recent to rely on here - and the LUT
 * texture has to be `rgba16float`, since that is the widest format WebGPU filters by default.
 */
export function toHalf(value: number): number {
    scratch.setFloat32(0, value)
    const bits = scratch.getUint32(0)
    const sign = (bits >>> 16) & 0x8000
    const magnitude = bits & 0x7fffffff

    if (magnitude >= 0x7f800000) {
        // NaN keeps a payload bit so it stays a NaN; infinity stays infinity.
        const nan = magnitude > 0x7f800000 ? 0x200 : 0
        return (sign | 0x7c00 | nan) & 0xffff
    }

    const rounded = magnitude + 0x1000
    if (rounded >= 0x47800000) return (sign | 0x7bff) & 0xffff // saturate to 65504
    if (rounded >= 0x38800000) return (sign | ((rounded - 0x38000000) >>> 13)) & 0xffff
    if (magnitude < 0x33000000) return sign & 0xffff // rounds to zero

    // Subnormal: shift the implicit one back in by hand.
    const exponent = magnitude >>> 23
    const shift = 126 - exponent
    const mantissa = (magnitude & 0x7fffff) | 0x800000
    return (sign | ((mantissa + (1 << (shift - 1))) >>> shift)) & 0xffff
}

const FRAGMENT = `
struct Params {
    size: f32,
    limited: f32,
    intensity: f32,
    unused: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var lut: texture_3d<f32>;
@group(0) @binding(3) var lut_sampler: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // This pass is 1:1 with its source, so take the texel outright - no sampler, no filtering to
    // soften what the viewer already resolved, and no coordinate rounding to get wrong.
    let texel = textureLoad(src, vec2<i32>(in.position.xy), 0);
    if (texel.a <= 0.0 || params.intensity <= 0.0) {
        return texel;
    }

    // The frame is premultiplied - undo that, so the table sees the colour itself.
    let colour = clamp(texel.rgb / texel.a, vec3<f32>(0.0), vec3<f32>(1.0));

    let levels = mix(vec3<f32>(16.0 / 255.0), vec3<f32>(235.0 / 255.0), colour);
    let input = mix(colour, levels, params.limited);

    // Entry centres, so the ends of the table land on the ends of the range.
    let half_texel = 0.5 / params.size;
    let coord = mix(vec3<f32>(half_texel), vec3<f32>(1.0 - half_texel), input);
    // Level 0 explicitly: the early return above makes this non-uniform control flow, where
    // textureSample's implicit derivatives are not allowed.
    let mapped = textureSampleLevel(lut, lut_sampler, coord, 0.0).rgb;

    return vec4<f32>(mix(colour, mapped, params.intensity) * texel.a, texel.a);
}
`

/**
 * Applies a 3D colour lookup table to the finished frame - the port of `filter/FilterLut3d.kt`.
 *
 * One fragment pass, so as the last filter in the chain it writes the canvas directly. The table is
 * a 3D texture sampled trilinearly, which is what makes a coarse LUT (a 33- or 64-point cube) look
 * smooth: the hardware interpolates between entries.
 */
export class FilterLut3d extends FilterFullscreen {
    private _lut: Lut3d | null = null

    /** The table to apply. Null leaves the frame untouched, the same as disabling the filter. */
    get lut(): Lut3d | null {
        return this._lut
    }

    set lut(value: Lut3d | null) {
        this._lut = value
        this.pending = value
        this.limitedRange = value?.limitedRange ?? false
        this.invalidate()
    }

    private _intensity = 1

    /**
     * How far to apply the table, 0..1. Not a quality control - it interpolates toward the original
     * colour, so a partly applied display profile is a partly wrong one - but useful for showing
     * what a look is doing.
     */
    get intensity(): number {
        return this._intensity
    }

    set intensity(value: number) {
        this._intensity = value
        this.uniformsDirty = true
        this.invalidate()
    }

    private _limitedRange = false

    /**
     * Look the table up over TV levels (16..235) rather than the full 0..255 range. Set from
     * [Lut3d.limitedRange] whenever [lut] is assigned, so a madVR table gets this on its own.
     */
    get limitedRange(): boolean {
        return this._limitedRange
    }

    set limitedRange(value: boolean) {
        this._limitedRange = value
        this.uniformsDirty = true
        this.invalidate()
    }

    constructor(lut: Lut3d | null = null) {
        super()
        // Through the setter, so a LUT passed to the constructor uploads like any other.
        this.lut = lut
    }

    /** Nothing to apply without a table - see [Filter.active]. */
    override get active(): boolean {
        return this.enabled && this._lut !== null
    }

    protected override get code(): string {
        return FRAGMENT
    }

    private pending: Lut3d | null = null
    private texture: GPUTexture | null = null
    private view: GPUTextureView | null = null
    private lutSize = 0
    private uniformsDirty = true

    private uniformsOrNull: GPUBuffer | null = null

    private get uniforms(): GPUBuffer {
        if (!this.uniformsOrNull) {
            this.uniformsOrNull = this.device.createBuffer({
                label: this.label,
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            })
        }
        return this.uniformsOrNull
    }

    private lutSamplerOrNull: GPUSampler | null = null

    // Trilinear between entries, clamped so the outermost half-texel doesn't wrap around.
    private get lutSampler(): GPUSampler {
        if (!this.lutSamplerOrNull) {
            this.lutSamplerOrNull = this.device.createSampler({
                magFilter: "linear",
                minFilter: "linear",
                addressModeU: "clamp-to-edge",
                addressModeV: "clamp-to-edge",
                addressModeW: "clamp-to-edge",
            })
        }
        return this.lutSamplerOrNull
    }

    protected override prepare(_srcWidth: number, _srcHeight: number) {
        // [active] keeps this filter out of the chain until a table is set, but bind something real
        // regardless rather than leave the pass unbindable.
        const next = this.pending ?? (this.texture === null ? Lut3d.identity() : null)
        if (next !== null) {
            this.pending = null
            this.upload(next)
        }
        if (this.uniformsDirty) {
            this.uniformsDirty = false
            this.writeUniforms()
        }
    }

    protected override entries(src: GPUTextureView): GPUBindGroupEntry[] {
        return [
            { binding: 0, resource: { buffer: this.uniforms } },
            { binding: 1, resource: src },
            { binding: 2, resource: this.view! },
            { binding: 3, resource: this.lutSampler },
        ]
    }

    override cleanup() {
        this.texture?.destroy()
        this.texture = null
        this.view = null
        // Not just the texture: upload() skips creating one when the size already matches.
        this.lutSize = 0
        this.rebind()
    }

    private upload(lut: Lut3d) {
        if (this.lutSize !== lut.size) {
            this.texture?.destroy()
            this.texture = this.device.createTexture({
                label: this.label,
                size: { width: lut.size, height: lut.size, depthOrArrayLayers: lut.size },
                dimension: "3d",
                format: "rgba16float",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            })
            this.view = this.texture.createView({ dimension: "3d" })
            this.lutSize = lut.size
        }

        // RGBA halves: the alpha is unused by the shader but the format has no three-channel form.
        const halves = new Uint16Array(lut.size * lut.size * lut.size * 4)
        for (let i = 0, o = 0; i < lut.data.length; i += 3, o += 4) {
            halves[o] = toHalf(lut.data[i])
            halves[o + 1] = toHalf(lut.data[i + 1])
            halves[o + 2] = toHalf(lut.data[i + 2])
            halves[o + 3] = ONE_HALF
        }

        this.device.queue.writeTexture(
            { texture: this.texture! },
            halves,
            { bytesPerRow: lut.size * 8, rowsPerImage: lut.size },
            { width: lut.size, height: lut.size, depthOrArrayLayers: lut.size },
        )

        // The bind group holds the old view when the table changed size.
        this.rebind()
        this.uniformsDirty = true
    }

    private readonly uniformBytes = new Float32Array(4)

    private writeUniforms() {
        this.uniformBytes[0] = this.lutSize
        this.uniformBytes[1] = this._limitedRange ? 1 : 0
        this.uniformBytes[2] = this._intensity
        this.uniformBytes[3] = 0
        this.device.queue.writeBuffer(this.uniforms, 0, this.uniformBytes)
    }
}
