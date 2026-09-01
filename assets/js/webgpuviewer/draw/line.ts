import { colorToFloats } from "../util"
import { WebGpuRenderer } from "../renderer/renderer"

/**
 * Port of `draw/Line.kt` - an anti-aliased line, drawn by a compute shader.
 *
 * Unlike the rest of `draw/`, this writes to a storage texture rather than drawing into a render
 * pass, so **[texture] must have been created with `STORAGE_BINDING`**. A canvas surface is not:
 * the swapchain texture only carries `RENDER_ATTACHMENT` (plus `TEXTURE_BINDING`), so this can only
 * target an offscreen texture the caller allocated itself - `Mipmap.blank` is one. The same
 * restriction applies on Android; nothing in the viewer core draws through here.
 *
 * The shader stores rather than blends, so overlapping lines replace each other instead of
 * compositing - again as in the Kotlin.
 */

const LINE_SHADER = `
struct Params {
    start: vec2<f32>,
    end: vec2<f32>,
    color: vec4<f32>,
    width: f32,
}

@group(0) @binding(0) var output_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(output_tex);
    if (id.x >= dims.x || id.y >= dims.y) { return; }

    let pos = vec2<f32>(f32(id.x), f32(id.y));
    let ab = params.end - params.start;
    let ap = pos - params.start;
    let len_sq = dot(ab, ab);
    let t = select(clamp(dot(ap, ab) / len_sq, 0.0, 1.0), 0.0, len_sq == 0.0);
    let closest = params.start + t * ab;
    let dist = length(pos - closest);

    let half_w = params.width * 0.5;
    if (dist <= half_w + 0.5) {
        let coverage = clamp(half_w - dist + 0.5, 0.0, 1.0);
        let alpha = params.color.a * coverage;
        textureStore(output_tex, vec2<i32>(id.xy), vec4<f32>(params.color.rgb, alpha));
    }
}
`

let pipeline: GPUComputePipeline | null = null

function getPipeline(): GPUComputePipeline {
    if (pipeline) return pipeline
    const device = WebGpuRenderer.device
    pipeline = device.createComputePipeline({
        layout: "auto",
        compute: {
            module: device.createShaderModule({ code: LINE_SHADER }),
            entryPoint: "main",
        },
    })
    return pipeline
}

// Params is vec2, vec2, vec4, f32: the vec4 must sit at offset 16, so 48 bytes with padding.
const scratch = new Float32Array(12)

/**
 * Draw a line from ([x1], [y1]) to ([x2], [y2]) in normalised `[0, 1]` coordinates over
 * [texture], [thickness] pixels wide.
 */
export function drawLine(
    encoder: GPUCommandEncoder,
    texture: GPUTexture,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number,
    thickness: number,
) {
    const device = WebGpuRenderer.device
    const [r, g, b, a] = colorToFloats(color)

    scratch.set([
        x1 * texture.width,
        y1 * texture.height,
        x2 * texture.width,
        y2 * texture.height,
        r,
        g,
        b,
        a,
        thickness,
    ])

    const uniform = device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(uniform, 0, scratch)

    const built = getPipeline()
    const pass = encoder.beginComputePass()
    pass.setPipeline(built)
    pass.setBindGroup(
        0,
        device.createBindGroup({
            layout: built.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: texture.createView() },
                { binding: 1, resource: { buffer: uniform } },
            ],
        }),
    )
    pass.dispatchWorkgroups(Math.ceil(texture.width / 8), Math.ceil(texture.height / 8))
    pass.end()
}
