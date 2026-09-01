import { WebGpuRenderer } from "./renderer"

/**
 * One triangle covering the whole destination, for passes that are a function of every pixel
 * rather than a drawing of anything - the port of `renderer/Fullscreen.kt`. Used by
 * `FilterFullscreen`'s output filters and [UpscalerArtCnn]'s halo crop.
 *
 * Here rather than beside the filters so both can reach it: the filter modules already depend on
 * this one, and pointing it back would make a cycle.
 */
export const Fullscreen = {
    /**
     * Supplies `vs_main` and a `VertexOutput` carrying [0,1] uv, top-left to bottom-right - the
     * orientation the viewer's own draws use. Prepend it to a fragment stage.
     */
    VERTEX: `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );

    let pos = positions[vertex_index];

    var out: VertexOutput;
    out.position = vec4<f32>(pos, 0.0, 1.0);
    out.uv = vec2<f32>(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
    return out;
}
`,

    /**
     * Pipeline for [VERTEX] plus [code], writing [format]. No blend state: the triangle replaces
     * every pixel, and what these passes read already carries the alpha their destination needs.
     */
    buildPipeline(code: string, format: GPUTextureFormat, label: string): GPURenderPipeline {
        const device = WebGpuRenderer.device
        const module = device.createShaderModule({ code: Fullscreen.VERTEX + code })
        return device.createRenderPipeline({
            label,
            layout: "auto",
            vertex: { module, entryPoint: "vs_main" },
            fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
        })
    },

    /** A pass over the whole of [dst]. Clears, since the triangle covers every pixel anyway. */
    beginPass(
        encoder: GPUCommandEncoder,
        dst: GPUTextureView,
        label: string,
    ): GPURenderPassEncoder {
        return encoder.beginRenderPass({
            label,
            colorAttachments: [
                {
                    view: dst,
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                },
            ],
        })
    },
}
