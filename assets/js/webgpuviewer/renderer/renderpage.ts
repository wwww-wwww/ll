import { colorToFloats } from "../util"
import type { Image, MipMapForDraw, TileForDraw } from "./image"
import { WebGpuRenderer } from "./renderer"

/**
 * Draws a single image into a render pass - the port of `renderer/RenderPage.kt`. Every path that
 * draws a page's live content comes through here.
 *
 * Two paths, picked per call:
 *  - [render] - the resolve a `Rescaler` supplies, in linear light: Catmull-Rom magnifying, a box
 *    filter minifying, unless `TileRenderer`'s rescalers say otherwise. Sharp and expensive, so
 *    bound to a fixed 2x2-tile window - safe only because its one caller, `TileRenderer`'s tile
 *    generation, always targets a single tile-sized destination.
 *  - [renderFast] - one bilinear tap per pixel, also linear-light via a cheap gamma-2.2
 *    approximation (so a `TileRenderer` tile popping in over it never shows a brightness seam,
 *    close enough that the curve mismatch isn't visible) unless called with `linear = false`,
 *    which skips the sRGB<->linear round trip for non-`highQuality` content where that
 *    correctness isn't worth the cost. Draws every tile the viewport overlaps separately, so the
 *    viewport can be any size or position without a window falling short.
 *
 * Takes a pass rather than an encoder so a whole frame's draws can share one - a pass per image
 * costs an attachment load/store each, which dominates frame cost on tile-based GPUs. Opening and
 * ending the pass is the caller's job.
 */

const BLEND: GPUBlendState = {
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
}

/** One of the shaders, pipeline built on first use. */
export class Variant {
    private _pipeline: GPURenderPipeline | null = null

    constructor(private readonly build: () => GPURenderPipeline) { }

    get pipeline(): GPURenderPipeline {
        if (!this._pipeline) this._pipeline = this.build()
        return this._pipeline
    }
}

function device(): GPUDevice {
    return WebGpuRenderer.device
}

function buildPipeline(code: string, depthStencil?: GPUDepthStencilState): GPURenderPipeline {
    const module = device().createShaderModule({ code })
    return device().createRenderPipeline({
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
}

// ---------------------------------------------------------------------------
// Shader source
// ---------------------------------------------------------------------------

/** Uniforms, texture bindings and the vertex stage's view of the source, shared by both. */
const HEADER = `
struct Uniforms {
    offset: vec2<f32>,
    scale: f32,
    tile_size: f32,
    tiles_width: f32,
    tiles_height: f32,
    dst_width: f32,
    dst_height: f32,
}

@group(0) @binding(0) var<uniform> transform: Uniforms;
@group(0) @binding(1) var src_tex0: texture_2d<f32>;
@group(0) @binding(2) var src_tex1: texture_2d<f32>;
@group(0) @binding(3) var src_tex2: texture_2d<f32>;
@group(0) @binding(4) var src_tex3: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

fn totalDimensions() -> vec2<u32> {
    let w = i32(transform.tiles_width);
    let h = i32(transform.tiles_height);
    if (w <= 0 || h <= 0) {
        return vec2<u32>(0u);
    }

    let dim0 = textureDimensions(src_tex0);
    var width = dim0.x;
    if (w > 1) { width += textureDimensions(src_tex1).x; }

    var height = dim0.y;
    if (h > 1) { height += textureDimensions(src_tex2).y; }

    return vec2<u32>(width, height);
}

// Shared by both fragment variants: the fast path also filters in linear light now, so both need
// the same sRGB<->linear conversion.
fn to_linear_exact(srgb: vec4<f32>) -> vec4<f32> {
    let c = max(srgb.rgb, vec3<f32>(0.0));
    let lower = c / vec3<f32>(12.92);
    let higher = pow((c + vec3<f32>(0.055)) / vec3<f32>(1.055), vec3<f32>(2.4));
    let cond = c <= vec3<f32>(0.04045);
    return vec4(select(higher, lower, cond), srgb.a);
}

fn to_srgb_exact(linear_rgb: vec4<f32>) -> vec4<f32> {
    let c = max(linear_rgb.rgb, vec3<f32>(0.0));
    let lower = c * vec3<f32>(12.92);
    let higher = vec3<f32>(1.055) * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    let cond = c <= vec3<f32>(0.0031308);
    return vec4(select(higher, lower, cond), linear_rgb.a);
}

fn tileLoad(i: i32, pos: vec2<i32>) -> vec4<f32> {
    if (i == 0) { return textureLoad(src_tex0, pos, 0); }
    if (i == 1) { return textureLoad(src_tex1, pos, 0); }
    if (i == 2) { return textureLoad(src_tex2, pos, 0); }
    return textureLoad(src_tex3, pos, 0);
}

// Fetch by position across the whole quad, picking the tile the position falls in. This is what
// makes filtering work at a tile boundary: the four slots are separate textures, so anything
// that resolves within one tile has no access to its neighbour's edge texels.
fn totalLoad(pos: vec2<i32>) -> vec4<f32> {
    let ts = i32(transform.tile_size);
    let tile_x = select(0, 1, pos.x >= ts);
    let tile_y = select(0, 1, pos.y >= ts);
    let idx = tile_y * 2 + tile_x;

    let pos0 = pos - vec2<i32>(tile_x, tile_y) * ts;
    return tileLoad(idx, pos0);
}
`

const VS_MAIN = `
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var uvs = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), // Top-left
        vec2<f32>(0.0, 1.0), // Bottom-left
        vec2<f32>(1.0, 0.0), // Top-right
        vec2<f32>(1.0, 0.0), // Top-right
        vec2<f32>(0.0, 1.0), // Bottom-left
        vec2<f32>(1.0, 1.0)  // Bottom-right
    );

    let uv = uvs[vertex_index];

    let dst_size_f = vec2<f32>(transform.dst_width, transform.dst_height);
    let src_size_f = vec2<f32>(totalDimensions());

    // Calculate destination canvas pixel position
    let pixel_pos = transform.scale * (transform.offset * dst_size_f + uv * src_size_f);

    // Convert pixel coordinate to WebGPU NDC Space:
    // X goes from [-1.0, 1.0] (left to right)
    // Y goes from [1.0, -1.0] (top to bottom)
    let ndc_x = (pixel_pos.x / dst_size_f.x) * 2.0 - 1.0;
    let ndc_y = 1.0 - (pixel_pos.y / dst_size_f.y) * 2.0;

    var out: VertexOutput;
    out.position = vec4<f32>(ndc_x, ndc_y, 0.0, 1.0);
    out.uv = uv;
    return out;
}
`

/**
 * Uniforms, single-texture binding and vertex stage shared by the per-tile draws - no
 * tile_size/tiles_width/tiles_height bookkeeping, since a draw through here is always one tile.
 */
const TILE_HEADER = `
struct TileUniforms {
    offset: vec2<f32>,
    scale: f32,
    dst_width: f32,
    dst_height: f32,
    // Page-wide opacity, for fading a freshly decoded page in. Applied to the already
    // premultiplied output, so scaling the whole vec4 is the correct operation.
    alpha: f32,
}

@group(0) @binding(0) var<uniform> transform: TileUniforms;
@group(0) @binding(1) var src_tex: texture_2d<f32>;

struct TileVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

fn tile_to_linear(srgb: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(pow(max(srgb.rgb, vec3<f32>(0.0)), vec3<f32>(2.2)), srgb.a);
}

fn tile_to_srgb(linear_rgb: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(pow(max(linear_rgb.rgb, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2)), linear_rgb.a);
}
`

const TILE_VS_MAIN = `
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> TileVertexOutput {
    var uvs = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0)
    );

    let uv = uvs[vertex_index];
    let dst_size_f = vec2<f32>(transform.dst_width, transform.dst_height);
    let src_size_f = vec2<f32>(textureDimensions(src_tex));
    let pixel_pos = transform.scale * (transform.offset * dst_size_f + uv * src_size_f);

    var out: TileVertexOutput;
    out.position = vec4<f32>(
        (pixel_pos.x / dst_size_f.x) * 2.0 - 1.0,
        1.0 - (pixel_pos.y / dst_size_f.y) * 2.0,
        0.0, 1.0
    );
    out.uv = uv;
    return out;
}
`

/**
 * Fragment stage for the fast path: one bilinear resolve per pixel, in approximate (gamma-2.2)
 * linear light.
 */
const TILE_SAMPLER_FS = `
@fragment
fn fs_main(in: TileVertexOutput) -> @location(0) vec4<f32> {
    let size = vec2<f32>(textureDimensions(src_tex));
    let pos = in.uv * size;
    let p = pos - 0.5;
    let base = floor(p);

    let max_coord = vec2<i32>(size) - 1;
    let i0 = clamp(vec2<i32>(base), vec2<i32>(0), max_coord);
    let i1 = clamp(vec2<i32>(base) + 1, vec2<i32>(0), max_coord);
    let f = p - base;

    let c00 = tile_to_linear(textureLoad(src_tex, vec2<i32>(i0.x, i0.y), 0));
    let c10 = tile_to_linear(textureLoad(src_tex, vec2<i32>(i1.x, i0.y), 0));
    let c01 = tile_to_linear(textureLoad(src_tex, vec2<i32>(i0.x, i1.y), 0));
    let c11 = tile_to_linear(textureLoad(src_tex, vec2<i32>(i1.x, i1.y), 0));

    let linear_col = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
    let col = tile_to_srgb(linear_col);
    return vec4<f32>(col.rgb * col.a, col.a) * transform.alpha;
}
`

/**
 * Fragment stage for `linear = false`: [TILE_SAMPLER_FS]'s bilinear tap with the sRGB<->linear
 * round trip removed.
 */
const TILE_PLAIN_FS = `
@fragment
fn fs_main(in: TileVertexOutput) -> @location(0) vec4<f32> {
    let size = vec2<f32>(textureDimensions(src_tex));
    let pos = in.uv * size;
    let p = pos - 0.5;
    let base = floor(p);

    let max_coord = vec2<i32>(size) - 1;
    let i0 = clamp(vec2<i32>(base), vec2<i32>(0), max_coord);
    let i1 = clamp(vec2<i32>(base) + 1, vec2<i32>(0), max_coord);
    let f = p - base;

    let c00 = textureLoad(src_tex, vec2<i32>(i0.x, i0.y), 0);
    let c10 = textureLoad(src_tex, vec2<i32>(i1.x, i0.y), 0);
    let c01 = textureLoad(src_tex, vec2<i32>(i0.x, i1.y), 0);
    let c11 = textureLoad(src_tex, vec2<i32>(i1.x, i1.y), 0);

    let col = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
    return vec4<f32>(col.rgb * col.a, col.a) * transform.alpha;
}
`

/**
 * Fragment stage for a magnifying draw: [Upscaler]'s `resolve_magnify`, and the premultiply every
 * draw through here ends with.
 */
const MAGNIFY_MAIN = `
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let col = resolve_magnify(in.uv);
    return vec4<f32>(col.rgb * col.a, col.a);
}
`

/** As [MAGNIFY_MAIN], for a minifying draw: [Downscaler]'s `resolve_minify`. */
const MINIFY_MAIN = `
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // resolve_minify takes src_start, the footprint's position in source pixels, and the
    // footprint's own size - which is how many source pixels one destination pixel covers.
    let src_start = in.uv * vec2<f32>(totalDimensions());
    let col = resolve_minify(src_start, vec2<f32>(1.0 / transform.scale));
    return vec4<f32>(col.rgb * col.a, col.a);
}
`

/**
 * As `Draw.rect`, but with a no-op stencil state declared so it's valid to use inside the
 * viewer's stencil-attached pass - the shared `Draw.rect` pipeline has none, and every other
 * place it's used (transitions, etc.) has no stencil attachment at all, so it can't just gain
 * one here.
 */
const MASKED_RECT_SHADER = `
struct Params {
    rect: vec4<f32>,
    color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
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

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

// Every caller of renderFast is inside the viewer's own render pass, which always attaches
// TileRenderer's stencil buffer (see stencilViewFor) - so samplerVariant's pipeline can carry the
// stencil test directly, skipping a pixel TileRenderer's blit already wrote (stencil == 1)
// instead of shading it a second time.
const samplerVariant = new Variant(() =>
    buildPipeline(TILE_HEADER + TILE_VS_MAIN + TILE_SAMPLER_FS, {
        format: "stencil8",
        depthWriteEnabled: false,
        depthCompare: "always",
        stencilFront: { compare: "not-equal" },
        stencilBack: { compare: "not-equal" },
        stencilReadMask: 0xff,
    }),
)

/** The two resolves in force. [RenderPage.render] picks between them once the mip level is known. */
export interface Filtered {
    readonly magnify: Variant
    readonly minify: Variant
}

/**
 * Pipelines for a pair of rescaler resolves, built on first use and kept.
 *
 * Keyed by the shader text, not the rescaler, and kept apart by direction: two
 * [UpscalerCatmullRom]s share a pipeline, and so does an [UpscalerArtCnn] with either, its own
 * leftover resolve being Catmull-Rom too. Only [TileRenderer] reaches this, and only when its
 * rescalers change, so hashing a few KB of source is not on any hot path.
 */
const magnifyVariants = new Map<string, Variant>()
const minifyVariants = new Map<string, Variant>()

function variant(cache: Map<string, Variant>, code: string, main: string): Variant {
    let found = cache.get(code)
    if (!found) {
        found = new Variant(() => buildPipeline(HEADER + VS_MAIN + code + main))
        cache.set(code, found)
    }
    return found
}

// As samplerVariant, but stencil-free - a transition's cache-seed pass has none, and doesn't need
// one: it fills once, then tiles blit on top in later passes via ordinary blending.
const samplerVariantUnmasked = new Variant(() =>
    buildPipeline(TILE_HEADER + TILE_VS_MAIN + TILE_SAMPLER_FS),
)

// Used by a transition's cache seed for non-highQuality pages, whose pass has no stencil
// attachment at all - must stay stencil-free.
const plainVariant = new Variant(() => buildPipeline(TILE_HEADER + TILE_VS_MAIN + TILE_PLAIN_FS))

// As plainVariant, but declares a no-op stencil state (always passes, never writes) purely so
// it's valid to use within the viewer's stencil-attached pass alongside samplerVariant and
// renderBackground's pipelines - it doesn't itself participate in masking.
const plainVariantMasked = new Variant(() =>
    buildPipeline(TILE_HEADER + TILE_VS_MAIN + TILE_PLAIN_FS, {
        format: "stencil8",
        depthWriteEnabled: false,
        depthCompare: "always",
    }),
)

let maskedRectPipeline: GPURenderPipeline | null = null

function getMaskedRectPipeline(): GPURenderPipeline {
    if (maskedRectPipeline) return maskedRectPipeline
    const module = device().createShaderModule({ code: MASKED_RECT_SHADER })
    maskedRectPipeline = device().createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs_main" },
        fragment: {
            module,
            entryPoint: "fs_main",
            targets: [{ format: "rgba8unorm", blend: BLEND }],
        },
        primitive: { topology: "triangle-list" },
        depthStencil: {
            format: "stencil8",
            depthWriteEnabled: false,
            depthCompare: "always",
        },
    })
    return maskedRectPipeline
}

// ---------------------------------------------------------------------------
// Draw entry points
// ---------------------------------------------------------------------------

const scratch = new Float32Array(8)

function writeUniform(buffer: GPUBuffer, values: number[]) {
    scratch.set(values)
    device().queue.writeBuffer(buffer, 0, scratch, 0, values.length)
}

export const RenderPage = {
    /** The resolves the rescalers in force supply - see [Rescaler.code]. */
    filtered(magnify: string, minify: string): Filtered {
        return {
            magnify: variant(magnifyVariants, magnify, MAGNIFY_MAIN),
            minify: variant(minifyVariants, minify, MINIFY_MAIN),
        }
    },

    /** Draw an image into [pass] with the filtered shader. */
    render(
        pass: GPURenderPassEncoder,
        image: Image,
        dst: GPUTexture,
        x: number,
        y: number,
        scale: number,
        filtered: Filtered,
    ) {
        const res = image.prepareForRender(dst, x, y, scale)
        if (!res) return
        // Decided here rather than per fragment: it is one value for the whole draw, and a shader
        // carrying both resolves needs registers for the union of them. Against the mip level's
        // scale, not the caller's - picking a mip moves the scale the draw resolves at, and moves
        // it toward 1, the very boundary being tested.
        RenderPage.draw(pass, image, dst, res, res.scale < 1 ? filtered.minify : filtered.magnify)
    },

    /** Picks one of the 4 tile pipelines - shared by [renderFast] and a page's own draw. */
    variantFor(linear: boolean, masked: boolean): Variant {
        if (linear && masked) return samplerVariant
        if (linear) return samplerVariantUnmasked
        if (masked) return plainVariantMasked
        return plainVariant
    },

    /**
     * Draw an image into [pass], one bilinear tap per pixel. [linear] picks the linear-light
     * gamma correction over the straight sRGB sampling - pass `false` for non-`highQuality`
     * content. [masked] picks the twin valid inside a stencil-attached pass; pass `false` only
     * when the pass has no stencil attachment.
     */
    renderFast(
        pass: GPURenderPassEncoder,
        image: Image,
        dst: GPUTexture,
        x: number,
        y: number,
        scale: number,
        linear: boolean = true,
        masked: boolean = true,
        alpha: number = 1,
    ) {
        const variant = RenderPage.variantFor(linear, masked)
        for (const tile of image.prepareTilesForRender(dst, x, y, scale)) {
            RenderPage.drawTile(pass, dst, tile, variant, alpha)
        }
    },

    draw(
        pass: GPURenderPassEncoder,
        image: Image,
        dst: GPUTexture,
        res: MipMapForDraw,
        variant: Variant,
    ) {
        writeUniform(image.buffer, [
            res.x,
            res.y,
            res.scale,
            res.mipmap.tilesize,
            res.mipmap.tilesCols,
            res.mipmap.tilesRows,
            dst.width,
            dst.height,
        ])

        const pipeline = variant.pipeline
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: { buffer: image.buffer } },
            ...res.quad.tileViews.map((view, i) => ({ binding: 1 + i, resource: view })),
        ]

        pass.setPipeline(pipeline)
        pass.setBindGroup(
            0,
            device().createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
        )
        pass.draw(6)
    },

    /**
     * Draw one tile from `Image.prepareTilesForRender`, into its own persistent uniform buffer
     * rather than the shared scratch one [draw] uses - see `Mipmap.tileUniformFor`.
     */
    drawTile(
        pass: GPURenderPassEncoder,
        dst: GPUTexture,
        tile: TileForDraw,
        variant: Variant,
        alpha: number = 1,
    ) {
        writeUniform(tile.uniform, [tile.x, tile.y, tile.scale, dst.width, dst.height, alpha])

        const pipeline = variant.pipeline
        pass.setPipeline(pipeline)
        // samplerVariant's stencil test reads against 1 - see TileRenderer's stencil-write blit
        // pipeline, the only thing that ever writes this attachment.
        if (variant === samplerVariant) pass.setStencilReference(1)
        pass.setBindGroup(
            0,
            device().createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: tile.uniform } },
                    { binding: 1, resource: tile.view },
                ],
            }),
        )
        pass.draw(6)
    },

    /** As `Draw.rect`, valid inside a stencil-attached pass. */
    drawMaskedRect(
        pass: GPURenderPassEncoder,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        color: number,
    ) {
        const [r, g, b, a] = colorToFloats(color)
        const buffer = device().createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        writeUniform(buffer, [x1, y1, x2, y2, r, g, b, a])

        const pipeline = getMaskedRectPipeline()
        pass.setPipeline(pipeline)
        pass.setBindGroup(
            0,
            device().createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: { buffer } }],
            }),
        )
        pass.draw(6)
    },
}
