import { Offset, coerceAtLeast, coerceAtMost } from "../util"
import { Draw } from "../draw/draw"
import type { TileRenderer } from "../renderer/tilerenderer"
import type { ImagePage } from "../viewer/imagepage"
import { Transition, blendBackgroundColor, getCachedTexture } from "./transition"

/**
 * Port of `TransitionFlipLeft` and `TransitionFlipRight` - the outgoing page folds back across an
 * angled crease.
 *
 * Each page is rendered flat into a cached screen-sized texture first, then the shader folds that
 * texture, so the flat render happens once per transition while only the fold is per-frame.
 *
 * The fold works in page-relative coordinates and reflects across the page's rect within the cache
 * - see `ImagePage.pageRect` - so a page narrower or shorter than the surface folds as itself,
 * rather than as a screen-sized sheet.
 *
 * The crease angle comes from the drag itself: the vertical travel between where the gesture
 * started and where it is now tilts the fold, so dragging from a corner creases diagonally.
 */

/** Tessellated 32x16 grid, six vertices per quad - finer across the fold than along it. */
const FLIP_VERTEX_COUNT = 32 * 16 * 6

function flipShader(fromLeft: boolean): string {
    // The two directions differ only in these three expressions: which side of the crease folds,
    // and which way the arc bends. Sharing the source keeps them from drifting apart.
    const mirror = fromLeft ? "" : "        uv.x = 1.0 - uv.x;\n"
    const foldPos = fromLeft ? "(1.0 - flip) * max_dist" : "flip * max_dist"
    const folds = fromLeft ? "dist > fold_pos" : "dist < fold_pos"
    const arcLen = fromLeft ? "dist - fold_pos" : "fold_pos - dist"
    const arcSign = fromLeft ? "+" : "-"
    const tailSign = fromLeft ? "-" : "+"

    return `
struct Uniforms {
    // The page's rect inside the cached surface: (x1, y1, x2, y2), normalised.
    page_rect: vec4<f32>,
    page_flip: f32,
    fold_angle: f32,
    padding0: f32,
    padding1: f32,
}

@group(0) @binding(0) var<uniform> transform: Uniforms;
@group(0) @binding(1) var src_tex: texture_2d<f32>;
@group(0) @binding(2) var src_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    const COLS: u32 = 32u;
    const ROWS: u32 = 16u;
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

${mirror}
    // uv runs 0..1 over the page, so the flat quad spans the page's rect within the surface and
    // the texture coordinate is that same position. Keeping uv page-relative is what makes the
    // fold below page-shaped rather than screen-shaped.
    let rect_min = transform.page_rect.xy;
    let rect_max = transform.page_rect.zw;
    let flat_pos = mix(rect_min, rect_max, uv);

    var ndc_x = flat_pos.x * 2.0 - 1.0;
    var ndc_y = 1.0 - flat_pos.y * 2.0;

    // Page fold effect: page folds back at an angled crease
    if (transform.page_flip != 0.0) {
        let flip = transform.page_flip;
        let norm_x = uv.x;
        let norm_y = uv.y;

        // Angled fold line: normal direction
        let fold_angle = transform.fold_angle;
        let nx = cos(fold_angle);
        let ny = sin(fold_angle);

        // Distance along fold normal from origin
        let max_dist = nx + abs(ny);
        let fold_pos = ${foldPos};
        let dist = norm_x * nx + norm_y * ny;

        // The page's rect in NDC, which the reflection below is expressed in.
        let page_left = rect_min.x * 2.0 - 1.0;
        let page_width_ndc = (rect_max.x - rect_min.x) * 2.0;
        let page_top = 1.0 - rect_min.y * 2.0;
        let page_height_ndc = (rect_max.y - rect_min.y) * 2.0;

        if (${folds}) {
            let arc_len = ${arcLen};
            let radius = 0.15;
            let fold_len = 3.14159265 * radius;

            var folded_dist: f32;
            if (arc_len < fold_len) {
                let theta = arc_len / radius;
                folded_dist = fold_pos ${arcSign} radius * sin(theta);
            } else {
                folded_dist = fold_pos ${tailSign} (arc_len - fold_len);
            }

            // Reflect position across fold line
            let delta = folded_dist - dist;
            let new_norm_x = norm_x + delta * nx;
            let new_norm_y = norm_y + delta * ny;

            ndc_x = page_left + new_norm_x * page_width_ndc;
            ndc_y = page_top - new_norm_y * page_height_ndc;
        }
    }

    var out: VertexOutput;
    out.position = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
    out.uv = flat_pos;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // The cache holds premultiplied alpha, so pass it straight through - see premultipliedOutput.
    return textureSample(src_tex, src_sampler, in.uv);
}`
}

class TransitionFlip extends Transition {
    constructor(private readonly fromLeft: boolean) {
        super()
    }

    override get premultipliedOutput(): boolean {
        return true
    }

    override get code(): string {
        return flipShader(this.fromLeft)
    }

    private samplerOrNull: GPUSampler | null = null
    private readonly scratch = new Float32Array(8)

    private get foldSampler(): GPUSampler {
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

        // The crease tilts with how far the drag has travelled vertically relative to
        // horizontally. Clamped to one side of flat, opposite for each direction, so the fold
        // never creases the wrong way.
        const dy = pos2.y - pos1.y
        const dx = pos2.x - pos1.x
        const sign = dx < 0 ? -1 : 1
        const raw = (sign * Math.atan2(dy, Math.abs(dx))) / 2
        const foldAngle = this.fromLeft ? coerceAtLeast(raw, 0) : coerceAtMost(raw, 0)

        // One background rect for the whole frame, easing between the two pages' colours.
        const t = frac > 0 ? frac : -frac
        const bg1 = page1.backgroundColor ?? (0xff000000 | 0)
        const bg2 = page2.backgroundColor ?? (0xff000000 | 0)
        Draw.rectInto(encoder, dst, 0, 0, 1, 1, blendBackgroundColor(bg1, bg2, t))

        // The page that is not folding is drawn flat (`0`) underneath the one that is.
        if (this.fromLeft) {
            if (frac > 0) {
                this.fold(cached2, page2, encoder, dst, 0, foldAngle)
                this.fold(cached1, page1, encoder, dst, frac, foldAngle)
            } else {
                this.fold(cached1, page1, encoder, dst, 0, foldAngle)
                this.fold(cached2, page2, encoder, dst, 1 + frac, foldAngle)
            }
        } else {
            if (frac > 0) {
                this.fold(cached1, page1, encoder, dst, 0, foldAngle)
                this.fold(cached2, page2, encoder, dst, 1 - frac, foldAngle)
            } else {
                this.fold(cached2, page2, encoder, dst, 0, foldAngle)
                this.fold(cached1, page1, encoder, dst, -frac, foldAngle)
            }
        }
    }

    private fold(
        cachedView: GPUTextureView | null,
        page: ImagePage,
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        frac: number,
        foldAngle: number,
    ) {
        if (!cachedView) return
        const rect = page.pageRect(dst)
        if (!rect) return

        this.scratch.set([rect[0], rect[1], rect[2], rect[3], frac, foldAngle, 0, 0])

        const uniform = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        this.device.queue.writeBuffer(uniform, 0, this.scratch)

        const pass = encoder.beginRenderPass({
            colorAttachments: [
                { view: dst.createView(), loadOp: "load", storeOp: "store" },
            ],
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
                    { binding: 2, resource: this.foldSampler },
                ],
            }),
        )
        pass.draw(FLIP_VERTEX_COUNT)
        pass.end()
    }
}

export const TransitionFlipLeft = new TransitionFlip(true)
export const TransitionFlipRight = new TransitionFlip(false)
