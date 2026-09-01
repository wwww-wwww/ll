import { Offset, colorToFloats } from "../util"
import type { TileRenderer } from "../renderer/tilerenderer"
import type { ImagePage } from "../viewer/imagepage"
import { Transition, beginClearedPass, blitCached, getCachedTexture } from "./transition"

// The rest of the family lives in files of its own; re-exported here so callers have one
// place to reach every transition, as the Kotlin package does.
export { TransitionCube, TransitionCubeOuter } from "./cube"
export { TransitionFadeWhite } from "./fadewhite"
export { TransitionFlipLeft, TransitionFlipRight } from "./flip"
export { TransitionSphere } from "./sphere"
export {
    TransitionStackDown,
    TransitionStackLeft,
    TransitionStackRight,
    TransitionStackUp,
} from "./stack"

/**
 * Slide transition: both pages go to cached textures, then get blitted side by side at an offset.
 *
 * The cache keys on the page's own transform, and a page turn only animates the offset, so that
 * render happens once per transition and every later frame is a cache hit plus a 1:1 blit. Each
 * page's background is drawn separately, live, at the same offset.
 */
class TransitionBasicHorizontal extends Transition {
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

        const pass = beginClearedPass(encoder, dst)
        try {
            if (frac > 0) {
                page2.drawBackgroundColumns(pass, dst, 1 - frac, 0)
                page1.drawBackgroundColumns(pass, dst, -frac, 0)
                blitCached(pass, cached2, 1 - frac, 0)
                blitCached(pass, cached1, -frac, 0)
            } else {
                page2.drawBackgroundColumns(pass, dst, -(frac + 1), 0)
                page1.drawBackgroundColumns(pass, dst, -frac, 0)
                blitCached(pass, cached2, -(frac + 1), 0)
                blitCached(pass, cached1, -frac, 0)
            }
        } finally {
            pass.end()
        }
    }
}

/** The same slide, vertically. */
class TransitionBasicVertical extends Transition {
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

        const pass = beginClearedPass(encoder, dst)
        try {
            if (frac > 0) {
                page1.drawBackgroundColumns(pass, dst, 0, -frac)
                page2.drawBackgroundColumns(pass, dst, 0, 1 - frac)
                blitCached(pass, cached1, 0, -frac)
                blitCached(pass, cached2, 0, 1 - frac)
            } else {
                page2.drawBackgroundColumns(pass, dst, 0, -(frac + 1))
                page1.drawBackgroundColumns(pass, dst, 0, -frac)
                blitCached(pass, cached2, 0, -(frac + 1))
                blitCached(pass, cached1, 0, -frac)
            }
        } finally {
            pass.end()
        }
    }
}

export const TransitionBasic = new TransitionBasicHorizontal()
export const TransitionBasicVerticalInstance = new TransitionBasicVertical()

/**
 * No animation: [page1] stays on screen for the whole drag and the turn just jumps once it
 * commits (handled outside `render` - by the time page2 would show, the offset is back to 0 and
 * the normal live-render path takes over). Draws page1 straight to [dst], skipping the
 * cached-texture indirection every other transition uses.
 */
class TransitionNoneImpl extends Transition {
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
        page1.renderCacheSeed(encoder, dst, tiles)
    }
}

export const TransitionNone = new TransitionNoneImpl()

const BLEND_SHADER = `
struct Uniforms {
    blend: f32,
    bg1: vec4<f32>,
    bg2: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var tex1: texture_2d<f32>;
@group(0) @binding(2) var tex2: texture_2d<f32>;
@group(0) @binding(3) var tex_sampler: sampler;

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
    let c1 = textureSample(tex1, tex_sampler, in.uv);
    let c2 = textureSample(tex2, tex_sampler, in.uv);

    // The cache holds premultiplied colour, so compositing over the page's own background is a
    // straight add rather than a mix.
    let comp1 = uniforms.bg1.rgb * (1.0 - c1.a) + c1.rgb;
    let comp2 = uniforms.bg2.rgb * (1.0 - c2.a) + c2.rgb;

    let blended = mix(to_linear(comp1), to_linear(comp2), uniforms.blend);

    return vec4<f32>(to_srgb(blended), 1.0);
}
`

/** Cross-fade, blended in linear light and composited over each page's own background colour. */
class TransitionFadeImpl extends Transition {
    private blendPipelineOrNull: GPURenderPipeline | null = null
    private blendSamplerOrNull: GPUSampler | null = null
    private readonly scratch = new Float32Array(12)

    private get blendPipeline(): GPURenderPipeline {
        if (!this.blendPipelineOrNull) {
            const module = this.device.createShaderModule({ code: BLEND_SHADER })
            this.blendPipelineOrNull = this.device.createRenderPipeline({
                layout: "auto",
                vertex: { module, entryPoint: "vs_main" },
                fragment: { module, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
                primitive: { topology: "triangle-list" },
            })
        }
        return this.blendPipelineOrNull
    }

    private get blendSampler(): GPUSampler {
        if (!this.blendSamplerOrNull) this.blendSamplerOrNull = this.device.createSampler()
        return this.blendSamplerOrNull
    }

    private blendCached(
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        cachedView1: GPUTextureView | null,
        cachedView2: GPUTextureView | null,
        bg1: number,
        bg2: number,
        blend: number,
    ) {
        if (!cachedView1 || !cachedView2) return

        // std140-ish layout the shader declares: a scalar padded to a vec4, then two vec4s.
        this.scratch.set([blend, 0, 0, 0, ...colorToFloats(bg1), ...colorToFloats(bg2)])

        const uniformBuffer = this.device.createBuffer({
            size: 48,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        this.device.queue.writeBuffer(uniformBuffer, 0, this.scratch)

        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: dst.createView(),
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                },
            ],
        })

        const pipeline = this.blendPipeline
        pass.setPipeline(pipeline)
        pass.setBindGroup(
            0,
            this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniformBuffer } },
                    { binding: 1, resource: cachedView1 },
                    { binding: 2, resource: cachedView2 },
                    { binding: 3, resource: this.blendSampler },
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

        // blend: 0 = fully page1, 1 = fully page2
        const blend = frac > 0 ? frac : -frac

        const bg1 = page1.backgroundColor ?? 0xff000000 | 0
        const bg2 = page2.backgroundColor ?? 0xff000000 | 0

        this.blendCached(encoder, dst, cached1, cached2, bg1, bg2, blend)
    }
}

export const TransitionFade = new TransitionFadeImpl()
