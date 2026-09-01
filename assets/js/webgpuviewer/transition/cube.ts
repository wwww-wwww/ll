import { Offset } from "../util"
import { Draw } from "../draw/draw"
import type { TileRenderer } from "../renderer/tilerenderer"
import type { ImagePage } from "../viewer/imagepage"
import { Transition, getCachedTexture } from "./transition"

/**
 * Port of `TransitionCube` and `TransitionCubeOuter` - the page turn as a rotating cube.
 *
 * The outgoing page is the front face, the incoming one the side. Each renders flat into a cached
 * screen-sized texture, which a face then maps onto a rotating quad - so the flat render happens once
 * per transition and only the rotation is per-frame.
 *
 * A face is the whole cached surface, so it is screen-shaped rather than page-shaped, unlike the
 * flips and the sphere. Each also gets a background column behind it, spanning its projected width
 * and the surface's full height.
 *
 * [TransitionCubeOuter] drives the same faces through the opposite rotation, borrowing this one's
 * shader and face drawing entirely.
 */

const HALF_PI = Math.PI / 2
const FOV = 4
const FACE_DEPTH = FOV / (FOV - 1)

// ---------------------------------------------------------------------------
// 4x4 matrices, column-major - index is col * 4 + row, as WGSL expects.
// ---------------------------------------------------------------------------

type Mat4 = Float32Array

function mat4(...values: number[]): Mat4 {
    return new Float32Array(values)
}

function rotateY(angle: number): Mat4 {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    return mat4(c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1)
}

function translate(x: number, y: number, z: number): Mat4 {
    return mat4(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1)
}

function scale(x: number, y: number, z: number): Mat4 {
    return mat4(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1)
}

function multiply(a: Mat4, b: Mat4): Mat4 {
    const result = new Float32Array(16)
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0
            for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k]
            result[col * 4 + row] = sum
        }
    }
    return result
}

/** Perspective projection: `output.w = z + fov`, so the NDC divide is `xy / w`. */
const PROJECTION = mat4(FOV, 0, 0, 0, 0, FOV, 0, 0, 0, 0, 1, 1, 0, 0, 0, FOV)

const CUBE_SHADER = `
struct Uniforms {
    transform_mat: mat4x4<f32>,
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

    // The matrix maps the unit quad to clip space, perspective via W. The unit quad is the cached
    // surface, so the face is screen-shaped - the matrix is built from the surface's dimensions and
    // its vertical scale cancels against the screen aspect.
    //
    // uv doubles as the texture coordinate, since the face spans the whole surface.
    let local_pos = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
    let transformed = transform.transform_mat * local_pos;

    var out: VertexOutput;
    out.position = vec4<f32>(transformed.xy / transformed.w, 0.0, 1.0);
    out.uv = uv;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    if (in.uv.x < 0.0 || in.uv.x > 1.0 || in.uv.y < 0.0 || in.uv.y > 1.0) { discard; }

    // Back-face culling via UV winding
    let dudx = dpdx(in.uv);
    let dudy = dpdy(in.uv);
    if (dudx.x * dudy.y - dudx.y * dudy.x < 0.0) { discard; }

    // textureSampleLevel rather than textureSample: the discards above make this non-uniform
    // control flow, where implicit derivatives are not allowed. The cache is single-level, so an
    // explicit LOD of 0 loses nothing. Premultiplied already - see premultipliedOutput.
    return textureSampleLevel(src_tex, src_sampler, in.uv, 0.0);
}`

/** Tessellated 32x32 grid, six vertices per quad. */
const CUBE_VERTEX_COUNT = 32 * 32 * 6

class TransitionCubeImpl extends Transition {
    override get premultipliedOutput(): boolean {
        return true
    }

    override get code(): string {
        return CUBE_SHADER
    }

    private samplerOrNull: GPUSampler | null = null

    private get faceSampler(): GPUSampler {
        if (!this.samplerOrNull) {
            this.samplerOrNull = this.device.createSampler({
                magFilter: "linear",
                minFilter: "linear",
            })
        }
        return this.samplerOrNull
    }

    /**
     * Face transform for one side of the cube.
     *
     * [faceWidth]/[faceHeight] size the face so its content is undistorted. They are the cached
     * surface's dimensions, so the vertical scale cancels against [screenAspect] and the face comes
     * out screen-shaped.
     */
    buildFaceMatrix(
        rotAngle: number,
        screenAspect: number,
        faceWidth: number,
        faceHeight: number,
        isSide: boolean,
    ): Mat4 {
        const faceScaleMat = scale(
            FACE_DEPTH,
            (faceHeight / faceWidth) * screenAspect * FACE_DEPTH,
            1,
        )
        const baseMat =
            isSide ?
                multiply(rotateY(HALF_PI), multiply(translate(0, 0, FACE_DEPTH), faceScaleMat))
                : multiply(translate(0, 0, FACE_DEPTH), faceScaleMat)
        return multiply(PROJECTION, multiply(rotateY(-rotAngle), baseMat))
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

        const t = frac > 0 ? frac : 1 + frac

        // Rotation runs the whole way across, with no held stages at either end. At 0 the front
        // face is exactly flat and full-screen, and at 90 degrees the side face is - which is what
        // FACE_DEPTH is chosen for - so there is nothing to ease into or out of.
        const rotAngle = t * HALF_PI
        const screenAspect = dst.width / dst.height

        // frac > 0: page1 is front (rotating away), page2 is side (rotating in). frac < 0 swaps.
        const frontPage = frac > 0 ? page1 : page2
        const sidePage = frac > 0 ? page2 : page1
        const frontFace = frac > 0 ? cached1 : cached2
        const sideFace = frac > 0 ? cached2 : cached1

        // A face is the whole cached surface, so both use the surface's dimensions.
        const frontMat = this.buildFaceMatrix(rotAngle, screenAspect, dst.width, dst.height, false)
        const sideMat = this.buildFaceMatrix(rotAngle, screenAspect, dst.width, dst.height, true)

        // Both faces load rather than clear, so the second doesn't erase the first, and the cube
        // never covers the whole surface. Without a clear first, the area around it shows whatever
        // getCurrentTexture's rotating buffer held several frames ago.
        Draw.clear(encoder, dst, 0)

        // Back to front, for correct overlap.
        if (t < 0.5) {
            this.drawFace(sideFace, sidePage, encoder, dst, sideMat)
            this.drawFace(frontFace, frontPage, encoder, dst, frontMat)
        } else {
            this.drawFace(frontFace, frontPage, encoder, dst, frontMat)
            this.drawFace(sideFace, sidePage, encoder, dst, sideMat)
        }
    }

    /**
     * Render [page] flat into its cache slot, then map it onto a face by [matrix]. Shared with
     * [TransitionCubeOuter]. [isPage1] picks the slot, so the two pages need different values or
     * they evict each other every frame.
     */
    face(
        page: ImagePage,
        isPage1: boolean,
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        matrix: Mat4,
        tiles: TileRenderer,
    ) {
        const cached = getCachedTexture(page, isPage1, encoder, dst.width, dst.height, tiles)
        this.drawFace(cached, page, encoder, dst, matrix)
    }

    private drawFace(
        cachedView: GPUTextureView | null,
        page: ImagePage,
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        matrix: Mat4,
    ) {
        if (!cachedView) return

        // Background behind the face, spanning its projected width and full height. The face
        // carries the page's own background, but only across the page's band and rotated with it.
        //
        // Project the face's edges for that width. Column-major, so index is col * 4 + row;
        // local_pos is (x, y, 0, 1) and neither x nor w takes a y term, so only columns 0 and 3
        // matter.
        const leftW = -matrix[3] + matrix[15]
        const rightW = matrix[3] + matrix[15]
        const leftX = (-matrix[0] + matrix[12]) / leftW
        const rightX = (matrix[0] + matrix[12]) / rightW
        const background = page.backgroundColor
        if (background !== null) {
            Draw.rectInto(encoder, dst, (leftX + 1) / 2, 0, (rightX + 1) / 2, 1, background)
        }

        const uniform = this.device.createBuffer({
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        this.device.queue.writeBuffer(uniform, 0, matrix)

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
                    { binding: 2, resource: this.faceSampler },
                ],
            }),
        )
        pass.draw(CUBE_VERTEX_COUNT)
        pass.end()
    }
}

export const TransitionCube = new TransitionCubeImpl()

/**
 * Port of `TransitionCubeOuter` - the cube rotating the other way, seen from outside.
 *
 * Same faces and shader as [TransitionCube]. What differs: the rotation direction, which page
 * takes which face, and faces pushed back so the cube reads as a solid object, not a box interior.
 */
class TransitionCubeOuterImpl extends Transition {
    /**
     * As [TransitionCubeImpl.buildFaceMatrix], but pushed back by `5 * FACE_DEPTH` and rescaled so
     * the face still fills NDC at rest.
     *
     * The scale solves `s * FOV / (pushBack - s + FOV) = 1`, i.e. `s = (pushBack + FOV) / (FOV + 1)`
     * - which is what keeps the flat face exactly page-sized despite the extra distance.
     */
    private buildFaceMatrix(
        rotAngle: number,
        screenAspect: number,
        faceWidth: number,
        faceHeight: number,
        isSide: boolean,
    ): Mat4 {
        const pushBack = 5 * FACE_DEPTH
        const s = (pushBack + FOV) / (FOV + 1)
        const faceScaleMat = scale(s, (faceHeight / faceWidth) * screenAspect * s, 1)
        const baseMat =
            isSide ?
                multiply(rotateY(HALF_PI), multiply(translate(0, 0, -s), faceScaleMat))
                : multiply(translate(0, 0, -s), faceScaleMat)
        const mat = multiply(translate(0, 0, pushBack), multiply(rotateY(-rotAngle), baseMat))
        return multiply(PROJECTION, mat)
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
        // Rotates opposite to TransitionCube, hence the inverted parameter.
        const t = frac < 0 ? -frac : 1 - frac
        const rotAngle = t * HALF_PI
        const screenAspect = dst.width / dst.height

        // The inverted rotation swaps which page takes which face.
        const frontIsPage1 = frac < 0
        const frontPage = frontIsPage1 ? page1 : page2
        const sidePage = frontIsPage1 ? page2 : page1

        const frontMat = this.buildFaceMatrix(rotAngle, screenAspect, dst.width, dst.height, false)
        const sideMat = this.buildFaceMatrix(rotAngle, screenAspect, dst.width, dst.height, true)

        // The cube never covers the whole surface, and getCurrentTexture hands back a rotating set
        // of buffers, so without a clear the area around it shows a frame from several ago.
        Draw.clear(encoder, dst, 0)

        if (t < 0.5) {
            TransitionCube.face(sidePage, !frontIsPage1, encoder, dst, sideMat, tiles)
            TransitionCube.face(frontPage, frontIsPage1, encoder, dst, frontMat, tiles)
        } else {
            TransitionCube.face(frontPage, frontIsPage1, encoder, dst, frontMat, tiles)
            TransitionCube.face(sidePage, !frontIsPage1, encoder, dst, sideMat, tiles)
        }
    }
}

export const TransitionCubeOuter = new TransitionCubeOuterImpl()
