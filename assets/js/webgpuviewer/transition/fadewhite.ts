import { Offset, colorToFloats } from "../util"
import type { TileRenderer } from "../renderer/tilerenderer"
import type { ImagePage } from "../viewer/imagepage"
import { Transition, getCachedTexture } from "./transition"

/**
 * Port of `TransitionFadeWhite` - a dip to white between the two pages.
 *
 * Unlike [TransitionFade], which cross-fades the two directly, this is two half-length fades: the
 * outgoing page to white over the first half, then white to the incoming page over the second. So
 * only ever one cached texture is on screen, and the blend is against a constant rather than
 * another sample. Blended in linear light, as everything else here is.
 */

const FADE_WHITE_SHADER = `
struct Uniforms {
    fade: f32,
    bg: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var src_tex: texture_2d<f32>;
@group(0) @binding(2) var src_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0)
    );

    let pos = positions[vertex_index];

    var out: VertexOutput;
    out.position = vec4<f32>(pos.x * 2.0 - 1.0, 1.0 - pos.y * 2.0, 0.0, 1.0);
    out.uv = pos;
    return out;
}

fn to_linear(srgb: vec3<f32>) -> vec3<f32> {
    let cutoff = srgb <= vec3<f32>(0.04045);
    let lower = srgb / vec3<f32>(12.92);
    let higher = pow((srgb + vec3<f32>(0.055)) / vec3<f32>(1.055), vec3<f32>(2.4));
    return select(higher, lower, cutoff);
}

fn to_srgb(linear: vec3<f32>) -> vec3<f32> {
    let cutoff = linear <= vec3<f32>(0.0031308);
    let lower = linear * vec3<f32>(12.92);
    let higher = vec3<f32>(1.055) * pow(linear, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    return select(higher, lower, cutoff);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let c = textureSample(src_tex, src_sampler, in.uv);

    // The cache holds premultiplied colour, so compositing over the page's background is an add.
    let comp = uniforms.bg.rgb * (1.0 - c.a) + c.rgb;

    // Blend toward white in linear space
    let blended = mix(to_linear(comp), vec3<f32>(1.0), uniforms.fade);

    return vec4<f32>(to_srgb(blended), 1.0);
}
`

class TransitionFadeWhiteImpl extends Transition {
    private pipelineOrNull: GPURenderPipeline | null = null
    private samplerOrNull: GPUSampler | null = null
    private readonly scratch = new Float32Array(8)

    private get fadePipeline(): GPURenderPipeline {
        if (!this.pipelineOrNull) {
            const module = this.device.createShaderModule({ code: FADE_WHITE_SHADER })
            this.pipelineOrNull = this.device.createRenderPipeline({
                layout: "auto",
                vertex: { module, entryPoint: "vs_main" },
                fragment: { module, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
                primitive: { topology: "triangle-list" },
            })
        }
        return this.pipelineOrNull
    }

    private get sampler(): GPUSampler {
        if (!this.samplerOrNull) this.samplerOrNull = this.device.createSampler()
        return this.samplerOrNull
    }

    private fadeWhiteCached(
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        cachedView: GPUTextureView | null,
        bg: number,
        fade: number,
    ) {
        if (!cachedView) return

        // A scalar padded to a vec4, then the colour - the layout the shader declares.
        this.scratch.set([fade, 0, 0, 0, ...colorToFloats(bg)])

        const uniform = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        this.device.queue.writeBuffer(uniform, 0, this.scratch)

        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: dst.createView(),
                    loadOp: "clear",
                    storeOp: "store",
                    // White, so the letterbox around a page matches what it is dipping through.
                    clearValue: { r: 1, g: 1, b: 1, a: 1 },
                },
            ],
        })

        const pipeline = this.fadePipeline
        pass.setPipeline(pipeline)
        pass.setBindGroup(
            0,
            this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniform } },
                    { binding: 1, resource: cachedView },
                    { binding: 2, resource: this.sampler },
                ],
            }),
        )
        pass.draw(6)
        pass.end()
    }

    render(
        page1: ImagePage,
        page2: ImagePage,
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        frac: number,
        pos1: Offset,
        pos2: Offset,
        tiles: TileRenderer,
    ) {
        const cached1 = getCachedTexture(page1, true, encoder, dst.width, dst.height, tiles)
        const cached2 = getCachedTexture(page2, false, encoder, dst.width, dst.height, tiles)

        const t = frac > 0 ? frac : -frac

        if (t < 0.5) {
            // First half: the outgoing page fades to white.
            this.fadeWhiteCached(encoder, dst, cached1, page1.backgroundColor ?? 0, t * 2)
        } else {
            // Second half: white fades to the incoming page.
            this.fadeWhiteCached(encoder, dst, cached2, page2.backgroundColor ?? 0, (1 - t) * 2)
        }
    }
}

export const TransitionFadeWhite = new TransitionFadeWhiteImpl()
