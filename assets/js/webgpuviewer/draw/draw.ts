import { colorToFloats } from "../util"
import { WebGpuRenderer } from "../renderer/renderer"
import { drawText } from "./text"

/**
 * Immediate-mode primitives - the port of the `draw/` package (`Draw`, `Rect`, `Circle`,
 * `Clear`).
 *
 * `Line` is not ported - nothing draws through it. `Text` is, in `text.ts`, but by rasterising
 * on a 2D canvas rather than rebuilding Android's glyph atlas.
 *
 * Every call allocates a fresh uniform buffer rather than reusing one: several rects can share a
 * pass, and `queue.writeBuffer` is ordered against `submit` rather than against other writes, so
 * a reused buffer would give every rect in the batch the last colour written.
 */

const scratch = new Float32Array(8)

function device(): GPUDevice {
    return WebGpuRenderer.device
}

const BLEND: GPUBlendState = {
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
}

const RECT_SHADER = `
struct Params {
    rect: vec4<f32>,  // left, top, right, bottom in normalized [0, 1] coords
    color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), // Top-left
        vec2<f32>(0.0, 1.0), // Bottom-left
        vec2<f32>(1.0, 0.0), // Top-right
        vec2<f32>(1.0, 0.0), // Top-right
        vec2<f32>(0.0, 1.0), // Bottom-left
        vec2<f32>(1.0, 1.0)  // Bottom-right
    );

    let pos = positions[vertex_index];

    let x = mix(params.rect.x, params.rect.z, pos.x);
    let y = mix(params.rect.y, params.rect.w, pos.y);

    var out: VertexOutput;
    out.position = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return params.color;
}
`

// Center/radius are in target pixels, matched against @builtin(position) - already window-space
// pixels - so the circle stays round regardless of the target's aspect ratio. The vertex stage
// just covers the whole clip space; the fragment stage discards everything outside the circle.
const CIRCLE_SHADER = `
struct Params {
    center: vec2<f32>,
    radius: f32,
    _pad: f32,
    color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, 1.0)
    );

    var out: VertexOutput;
    out.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let dist = length(in.position.xy - params.center);
    let coverage = clamp(params.radius - dist + 0.5, 0.0, 1.0);
    let alpha = params.color.a * coverage;
    return vec4<f32>(params.color.rgb, alpha);
}
`

/** Pipelines are built on first use, as the Kotlin's `by lazy` does. */
function lazyPipeline(code: string, depthStencil?: GPUDepthStencilState) {
    let pipeline: GPURenderPipeline | null = null
    return () => {
        if (pipeline) return pipeline
        const module = device().createShaderModule({ code })
        pipeline = device().createRenderPipeline({
            layout: "auto",
            vertex: { module, entryPoint: "vs_main" },
            fragment: {
                module,
                entryPoint: "fs_main",
                targets: [{ format: "rgba8unorm", blend: BLEND }],
            },
            primitive: { topology: "triangle-list" },
            ...(depthStencil ? { depthStencil } : {}),
        })
        return pipeline
    }
}

const rectPipeline = lazyPipeline(RECT_SHADER)
const circlePipeline = lazyPipeline(CIRCLE_SHADER)

function uniformBuffer(data: Float32Array, size: number): GPUBuffer {
    const buffer = device().createBuffer({
        size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    device().queue.writeBuffer(buffer, 0, data, 0, size / 4)
    return buffer
}

function bindUniform(pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, buffer: GPUBuffer) {
    pass.setPipeline(pipeline)
    pass.setBindGroup(
        0,
        device().createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer } }],
        }),
    )
}

export const Draw = {
    /**
     * Fill [texture] with [color] in a pass of its own. The default page draw uses this, since
     * `getCurrentTexture` rotates buffers and leaving one alone would show stale content from
     * several frames ago.
     */
    clear(encoder: GPUCommandEncoder, texture: GPUTexture, color: number) {
        const [r, g, b, a] = colorToFloats(color)
        encoder
            .beginRenderPass({
                colorAttachments: [
                    {
                        view: texture.createView(),
                        loadOp: "clear",
                        storeOp: "store",
                        clearValue: { r, g, b, a },
                    },
                ],
            })
            .end()
    },

    /**
     * Draw a filled rectangle into an existing render pass, so it can share a pass with other
     * draws. Sets its own pipeline, so the caller must set theirs again before drawing something
     * else. Coordinates are normalised `[0, 1]` over the target.
     */
    rect(
        pass: GPURenderPassEncoder,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        color: number,
    ) {
        const [r, g, b, a] = colorToFloats(color)
        scratch.set([x1, y1, x2, y2, r, g, b, a])
        bindUniform(pass, rectPipeline(), uniformBuffer(scratch, 32))
        pass.draw(6)
    },

    /** As [rect], opening a `load` pass on [texture] of its own. */
    rectInto(
        encoder: GPUCommandEncoder,
        texture: GPUTexture,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        color: number,
    ) {
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                { view: texture.createView(), loadOp: "load", storeOp: "store" },
            ],
        })
        Draw.rect(pass, x1, y1, x2, y2, color)
        pass.end()
    },

    /** `Draw.text` - see `text.ts`. */
    text: drawText,

    /**
     * Draw a filled circle into an existing render pass. [cx]/[cy]/[radius] are in the target's
     * pixels, matching the render pass's own coordinate space directly.
     */
    circle(
        pass: GPURenderPassEncoder,
        cx: number,
        cy: number,
        radius: number,
        color: number,
    ) {
        const [r, g, b, a] = colorToFloats(color)
        scratch.set([cx, cy, radius, 0, r, g, b, a])
        bindUniform(pass, circlePipeline(), uniformBuffer(scratch, 32))
        pass.draw(6)
    },
}
