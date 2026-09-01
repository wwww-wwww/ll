import { Offset } from "../util"
import { Draw } from "../draw/draw"
import type { TileRenderer } from "../renderer/tilerenderer"
import type { ImagePage } from "../viewer/imagepage"
import { Transition, blendBackgroundColor, getCachedTexture } from "./transition"

/**
 * Port of `TransitionSphere` - the two pages wrap onto a sphere, which spins half a turn.
 *
 * Three phases over the turn: the flat page curls onto a hemisphere, the sphere rotates by pi, and
 * the far hemisphere flattens back out. Each page is rendered flat into a cached screen-sized
 * texture first, so the flat render happens once per transition while only the wrap and spin are
 * per-frame.
 *
 * What the hemisphere wraps is the page's rect - see `ImagePage.pageRect` - clipped to that
 * surface. A page zoomed past the surface clips to the whole of it, so the cache is taken exactly
 * as drawn, pan and zoom included - nothing undoes the page's transform. A page smaller than the
 * surface wraps just its own rect, so the sphere is the page rather than the letterbox around it.
 *
 * That rect is `ImagePage.wholeRect`, not `pageRect`, so a spread wraps as one sheet with both its
 * pages rather than turning one side and dropping the other.
 */

/** Tessellated 32x32 grid, six vertices per quad. */
const SPHERE_VERTEX_COUNT = 32 * 32 * 6

const SPHERE_SHADER = `
struct Uniforms {
    // The page's rect inside the cached surface: (x1, y1, x2, y2), normalised. May reach outside
    // it, which is what the clip in the vertex stage is for.
    page_rect: vec4<f32>,
    dst_width: f32,
    dst_height: f32,
    transition: f32,
    is_second: f32,
}

@group(0) @binding(0) var<uniform> transform: Uniforms;
@group(0) @binding(1) var src_tex: texture_2d<f32>;
@group(0) @binding(2) var src_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) sphere_z: f32,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    const COLS: u32 = 32u;
    const ROWS: u32 = 32u;
    let quad_index = vertex_index / 6u;
    let vert_in_quad = vertex_index % 6u;
    let col = quad_index % COLS;
    let row = quad_index / COLS;

    let x0 = f32(col) / f32(COLS);
    let x1 = f32(col + 1u) / f32(COLS);
    let y0 = f32(row) / f32(ROWS);
    let y1 = f32(row + 1u) / f32(ROWS);

    var uv: vec2<f32>;
    switch (vert_in_quad) {
        case 0u: { uv = vec2<f32>(x0, y0); }
        case 1u: { uv = vec2<f32>(x0, y1); }
        case 2u: { uv = vec2<f32>(x1, y0); }
        case 3u: { uv = vec2<f32>(x1, y0); }
        case 4u: { uv = vec2<f32>(x0, y1); }
        default: { uv = vec2<f32>(x1, y1); }
    }

    let dst_size_f = vec2<f32>(transform.dst_width, transform.dst_height);
    let aspect = dst_size_f.x / dst_size_f.y;
    let sphere_r = 0.15;

    // Flat position: the page's rect where it fits inside the surface, the surface itself where
    // it does not. Clipping gives both without a branch - a page zoomed past the surface clips to
    // 0..1 and is taken as drawn, while a smaller one keeps its own rect and wraps the page rather
    // than the letterbox. uv runs 0..1 over whichever it is, and doubles as the texture coordinate.
    let is_back = transform.is_second > 0.5;
    let clipped = clamp(transform.page_rect, vec4<f32>(0.0), vec4<f32>(1.0));
    let flat_pos = mix(clipped.xy, clipped.zw, uv);
    var flat_ndc = vec2<f32>(flat_pos.x * 2.0 - 1.0, 1.0 - flat_pos.y * 2.0);

    // Sphere position: map UV to sphere surface
    let theta = (uv.x - 0.5) * 3.14159265 + select(0.0, 3.14159265, is_back);
    let phi = (0.5 - uv.y) * 3.14159265;

    // 3D point on sphere
    var sp_x = sin(theta) * cos(phi);
    var sp_y = sin(phi);
    var sp_z = cos(theta) * cos(phi);

    let sx = sp_x * sphere_r * 2.0 / aspect;
    let sy = sp_y * sphere_r * 2.0;
    let sphere_ndc = vec2<f32>(sx, sy);

    // Determine phase and interpolation
    let t = transform.transition;
    var phase = 0.0;
    if (t < 1.0 / 3.0) {
        phase = t * 3.0;
    } else if (t < 2.0 / 3.0) {
        phase = 1.0;
    } else {
        phase = 1.0 - (t - 2.0 / 3.0) * 3.0;
    }

    // For phase 2, use the fully-rotated sphere position
    var target_sphere_ndc = sphere_ndc;
    if (t >= 2.0 / 3.0) {
        // After full PI rotation: rx = sp_x*cos(PI) + sp_z*sin(PI) = -sp_x
        let rotated_x = -sp_x * sphere_r * 2.0 / aspect;
        target_sphere_ndc = vec2<f32>(rotated_x, sy);
    }

    var final_ndc = mix(flat_ndc, target_sphere_ndc, vec2<f32>(phase));

    var sphere_z = sp_z;

    if (t >= 1.0 / 3.0 && t < 2.0 / 3.0) {
        let rot_phase = (t - 1.0 / 3.0) * 3.0;
        let rot_angle = -rot_phase * 3.14159265;
        let rx = sp_x * cos(rot_angle) + sp_z * sin(rot_angle);
        let rz = -sp_x * sin(rot_angle) + sp_z * cos(rot_angle);
        final_ndc = vec2<f32>(rx * sphere_r * 2.0 / aspect, sp_y * sphere_r * 2.0);
        sphere_z = rz;
    }

    var out: VertexOutput;
    out.position = vec4<f32>(final_ndc, 0.0, 1.0);
    out.uv = flat_pos;
    out.sphere_z = sphere_z;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    if (in.uv.x < 0.0 || in.uv.x > 1.0 || in.uv.y < 0.0 || in.uv.y > 1.0) { discard; }

    let t = transform.transition;
    let is_second = transform.is_second > 0.5;

    // Phase 0: only image 1 visible
    // Phase 1: both visible based on sphere_z (front/back)
    // Phase 2: only image 2 visible
    if (t < 1.0 / 3.0 && is_second) { discard; }
    if (t >= 2.0 / 3.0 && !is_second) { discard; }
    if (t >= 1.0 / 3.0 && t < 2.0 / 3.0) {
        if (in.sphere_z < 0.0) { discard; }
    }

    // textureSampleLevel rather than textureSample: the discards above make this non-uniform
    // control flow, where implicit derivatives are not allowed. The cache is single-level, so an
    // explicit LOD of 0 loses nothing. Premultiplied already - see premultipliedOutput.
    return textureSampleLevel(src_tex, src_sampler, in.uv, 0.0);
}`

class TransitionSphereImpl extends Transition {
    override get premultipliedOutput(): boolean {
        return true
    }

    override get code(): string {
        return SPHERE_SHADER
    }

    private samplerOrNull: GPUSampler | null = null
    private readonly scratch = new Float32Array(8)

    private get sphereSampler(): GPUSampler {
        if (!this.samplerOrNull) {
            this.samplerOrNull = this.device.createSampler({
                magFilter: "linear",
                minFilter: "linear",
            })
        }
        return this.samplerOrNull
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

        // One background rect for the whole frame, easing between the two pages' colours.
        const t = frac > 0 ? frac : -frac
        const bg1 = page1.backgroundColor ?? 0xff000000 | 0
        const bg2 = page2.backgroundColor ?? 0xff000000 | 0
        Draw.rectInto(encoder, dst, 0, 0, 1, 1, blendBackgroundColor(bg1, bg2, t))

        if (frac > 0) {
            this.hemisphere(cached2, page2, encoder, dst, frac, 1)
            this.hemisphere(cached1, page1, encoder, dst, frac, 0)
        } else {
            this.hemisphere(cached1, page1, encoder, dst, 1 + frac, 1)
            this.hemisphere(cached2, page2, encoder, dst, 1 + frac, 0)
        }
    }

    private hemisphere(
        cachedView: GPUTextureView | null,
        page: ImagePage,
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        transition: number,
        isSecond: number,
    ) {
        if (!cachedView) return
        const rect = page.wholeRect(dst)
        if (!rect) return

        this.scratch.set([
            rect[0],
            rect[1],
            rect[2],
            rect[3],
            dst.width,
            dst.height,
            transition,
            isSecond,
        ])

        const uniform = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        this.device.queue.writeBuffer(uniform, 0, this.scratch)

        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: dst.createView(), loadOp: "load", storeOp: "store" }],
        })

        const pipeline = this.pipeline
        pass.setPipeline(pipeline)
        pass.setBindGroup(
            0,
            this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniform } },
                    { binding: 1, resource: cachedView },
                    { binding: 2, resource: this.sphereSampler },
                ],
            }),
        )
        pass.draw(SPHERE_VERTEX_COUNT)
        pass.end()
    }
}

export const TransitionSphere = new TransitionSphereImpl()
