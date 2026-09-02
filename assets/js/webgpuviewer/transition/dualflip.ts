import { Offset, alphaOf } from "../util"
import { Draw } from "../draw/draw"
import type { TileRenderer } from "../renderer/tilerenderer"
import type { ImagePage } from "../viewer/imagepage"
import {
    Transition,
    beginClearedPass,
    blendBackgroundColor,
    blitCachedRegion,
    getCachedTexture,
} from "./transition"

/**
 * A book page turn - the port of `transition/TransitionFlip.kt`.
 *
 * The file keeps its own name: `flip.ts` is the `TransitionFlipLeft`/`TransitionFlipRight` pair,
 * which the Kotlin has in files of their own.
 *
 * One leaf lifts off the spine, curls, and lands on the other side. Forward, the leaf shows page 1's
 * right half in front and page 2's left behind, each at its own size; a side with no page is blank
 * in the background colour. The halves that stay put come from the caches, clipped at their spine -
 * see [blitCachedRegion].
 *
 * Geometry is in width fractions from the surface centre, y over the aspect ratio. No depth
 * attachment: height rises with the tangent angle while it stays inside PI, so strips emitted
 * spine-outwards land back to front.
 *
 * One divergence from the Kotlin, in [surfaceFill]: this canvas is transparent.
 */

const UNIFORM_SIZE = 96

/** Total curl at the halfway point, in radians of tangent turn from spine to outer edge. */
const BEND = 0.95

/** Never zero - the arc's radius is length/bend. */
const MIN_BEND = 0.04

/** How much of each end eases back to flat lighting, to match the static halves. */
const LIT_ENDS = 0.15

// Along the leaf only - it does not bend vertically, so rows buy just a shorter diagonal.
const COLS = 64
const ROWS = 2
const SHEET_VERTICES = COLS * ROWS * 6

/** Shadow grid then leaf grid, in one draw - see `vs_main`. */
const VERTICES = SHEET_VERTICES * 2

/** The turning leaf for one frame. */
interface Leaf {
    /** The face it starts on, in page 1's cache: normalised (x1, y1, x2, y2). */
    frontRect: Float32Array
    /** The face it lands on, in page 2's cache. Mirrors [frontRect] when there is none. */
    backRect: Float32Array
    spine: number
    /** +1 resting right of the spine, -1 left. */
    dir: number
    /** Rotation about the spine, 0 (at rest) to PI (landed). */
    phi: number
    /** Tangent turn from spine to outer edge - the curl. [phi] + this <= PI. */
    bend: number
    /** Spine to the far edge of the sheet - both faces fit inside it. */
    len: number
    top: number
    bottom: number
    aspect: number
    /** Whether that face has a cached page to sample; blank if not. */
    hasFront: boolean
    hasBack: boolean
    /** Shading strength, 0 at either end - see [LIT_ENDS]. */
    shading: number
}

function smoothstep(x: number): number {
    const e = Math.min(Math.max(x, 0), 1)
    return e * e * (3 - 2 * e)
}

/** [rect] reflected across the spine - where the leaf's other face has to lie. */
function mirror(rect: Float32Array, spine: number): Float32Array {
    return new Float32Array([2 * spine - rect[2], rect[1], 2 * spine - rect[0], rect[3]])
}

/**
 * Whether the surface gets filled at all - not in the Kotlin, which always fills.
 *
 * A page's background is ARGB 0 unless one was asked for and [blendBackgroundColor] forces its
 * result opaque, so filling outright blacks out a transparent canvas for the length of the turn.
 * The leaf's blank face still takes the blended colour - a sheet is a sheet.
 */
function surfaceFill(page1: ImagePage, page2: ImagePage): boolean {
    const asks = (page: ImagePage) => {
        const color = page.backgroundColor
        return color !== null && alphaOf(color) !== 0
    }
    return asks(page1) || asks(page2)
}

class TransitionFlipImpl extends Transition {
    override get premultipliedOutput(): boolean {
        return true
    }

    private flipSamplerOrNull: GPUSampler | null = null

    private get flipSampler(): GPUSampler {
        if (!this.flipSamplerOrNull) {
            this.flipSamplerOrNull = this.device.createSampler({
                magFilter: "linear",
                minFilter: "linear",
            })
        }
        return this.flipSamplerOrNull
    }

    override render(
        page1: ImagePage,
        page2: ImagePage,
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        frac: number,
        _pos1: Offset,
        _pos2: Offset,
        tiles: TileRenderer,
    ) {
        const cached1 = getCachedTexture(page1, true, encoder, dst.width, dst.height, tiles)
        const cached2 = getCachedTexture(page2, false, encoder, dst.width, dst.height, tiles)

        // Clamped: a fling can carry the offset past a page, and a negative bend inverts the arc.
        const t = Math.min(Math.max(Math.abs(frac), 0), 1)
        // frac > 0 brings page 2 in from the right, as TransitionBasic does: the right leaf turns left.
        const forward = frac > 0
        const spine1 = page1.spineX(dst)
        const spine2 = page2.spineX(dst)

        const background = blendBackgroundColor(
            page1.backgroundColor ?? (0xff000000 | 0),
            page2.backgroundColor ?? (0xff000000 | 0),
            t,
        )

        const pass = beginClearedPass(encoder, dst)
        try {
            if (surfaceFill(page1, page2)) Draw.rect(pass, 0, 0, 1, 1, background)
            // Clipped at each spine: page 1 keeps the side the leaf left, page 2 the one it uncovers.
            if (forward) {
                if (spine1 !== null) blitCachedRegion(pass, cached1, 0, 0, spine1, 1)
                if (spine2 !== null) blitCachedRegion(pass, cached2, spine2, 0, 1, 1)
            } else {
                if (spine1 !== null) blitCachedRegion(pass, cached1, spine1, 0, 1, 1)
                if (spine2 !== null) blitCachedRegion(pass, cached2, 0, 0, spine2, 1)
            }
        } finally {
            pass.end()
        }

        const leaf = this.leaf(page1, page2, dst, t, forward, spine1, spine2, cached1, cached2)
        if (!leaf) return
        // A blank face is never sampled, so the surviving view stands in - [leaf] rules out both.
        const front = cached1 ?? cached2
        const back = cached2 ?? cached1
        if (!front || !back) return

        const leafPass = encoder.beginRenderPass({
            colorAttachments: [{ view: dst.createView(), loadOp: "load", storeOp: "store" }],
        })
        try {
            this.bind(leafPass, leaf, front, back, background)
            leafPass.draw(VERTICES)
        } finally {
            leafPass.end()
        }
    }

    /**
     * The leaf at [t], or null when there is nothing to turn. One sheet big enough for both faces,
     * each drawn on it at its own size - so neither resizes into the other, nor snaps at its end.
     */
    private leaf(
        page1: ImagePage,
        page2: ImagePage,
        dst: GPUTexture,
        t: number,
        forward: boolean,
        spine1: number | null,
        spine2: number | null,
        cached1: GPUTextureView | null,
        cached2: GPUTextureView | null,
    ): Leaf | null {
        // Page 1's hinge: blending toward page 2's would slide the fold across mid-turn.
        const spine = spine1 ?? spine2
        if (spine === null) return null
        // Forward: front is page 1's right half, back is page 2's left. Backward mirrors both.
        const dir = forward ? 1 : -1
        const rawFront = page1.leafRect(dst, !forward)
        const rawBack = page2.leafRect(dst, forward)
        // A side with no page mirrors the other across the spine, to size its blank sheet by.
        const frontRect = rawFront ?? (rawBack !== null ? mirror(rawBack, spine) : null)
        if (frontRect === null) return null
        const backRect = rawBack ?? mirror(frontRect, spine)

        const lenFront = forward ? frontRect[2] - spine : spine - frontRect[0]
        const lenBack = forward ? spine - backRect[0] : backRect[2] - spine
        const len = Math.max(lenFront, lenBack)
        if (len <= 0) return null

        // Flat at both ends, curliest halfway.
        const bend = MIN_BEND + (BEND - MIN_BEND) * Math.sin(Math.PI * t)

        return {
            frontRect: frontRect,
            backRect: backRect,
            spine: spine,
            dir: dir,
            // Held back so the outer edge stops at PI - strip order needs height monotonic.
            phi: Math.min(Math.PI * t, Math.PI - bend),
            bend: bend,
            len: len,
            top: Math.min(frontRect[1], backRect[1]),
            bottom: Math.max(frontRect[3], backRect[3]),
            aspect: dst.width / dst.height,
            hasFront: rawFront !== null && cached1 !== null,
            hasBack: rawBack !== null && cached2 !== null,
            shading: Math.min(smoothstep(t / LIT_ENDS), smoothstep((1 - t) / LIT_ENDS)),
        }
    }

    private readonly scratch = new Float32Array(UNIFORM_SIZE / 4)

    /** Set [pipeline] and this frame's uniforms on [pass]. [blank] paints a face with no page. */
    private bind(
        pass: GPURenderPassEncoder,
        leaf: Leaf,
        front: GPUTextureView,
        back: GPUTextureView,
        blank: number,
    ) {
        this.scratch.set(leaf.frontRect, 0)
        this.scratch.set(leaf.backRect, 4)
        this.scratch.set(
            [
                leaf.spine,
                leaf.dir,
                leaf.phi,
                leaf.bend,
                leaf.len,
                leaf.top,
                leaf.bottom,
                leaf.aspect,
                leaf.hasFront ? 1 : 0,
                leaf.hasBack ? 1 : 0,
                leaf.shading,
                0,
                // Opaque, so premultiplied and straight agree.
                ((blank >> 16) & 0xff) / 255,
                ((blank >> 8) & 0xff) / 255,
                (blank & 0xff) / 255,
                1,
            ],
            8,
        )

        const uniformBuffer = this.device.createBuffer({
            size: UNIFORM_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        this.device.queue.writeBuffer(uniformBuffer, 0, this.scratch)

        const pipeline = this.pipeline
        pass.setPipeline(pipeline)
        pass.setBindGroup(
            0,
            this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniformBuffer } },
                    { binding: 1, resource: front },
                    { binding: 2, resource: back },
                    { binding: 3, resource: this.flipSampler },
                ],
            }),
        )
    }

    /**
     * The cross-section is a circular arc of radius `len / bend` hinged on the spine, its tangent
     * running `phi` to `phi + bend` - so the sheet swings and curls at once. Heights are width
     * fractions like x, keeping the arc round.
     */
    override get code(): string {
        return `
struct Uniforms {
    // The leaf's two faces within their cached surfaces: normalised (x1, y1, x2, y2).
    front_rect: vec4<f32>,
    back_rect: vec4<f32>,
    // spine x, direction (+1 resting right of the spine), turn angle, curl
    geom: vec4<f32>,
    // sheet length, top y, bottom y, surface aspect
    span: vec4<f32>,
    // front textured, back textured, shading strength, unused
    flags: vec4<f32>,
    // What a face with no page behind it is painted, premultiplied.
    blank: vec4<f32>,
}

@group(0) @binding(0) var<uniform> flip: Uniforms;
@group(0) @binding(1) var front_tex: texture_2d<f32>;
@group(0) @binding(2) var back_tex: texture_2d<f32>;
@group(0) @binding(3) var flip_sampler: sampler;

const PI: f32 = 3.14159265;

// Eye distance, in the width fractions the geometry is measured in.
const EYE: f32 = 2.6;

// The key light: centred over the book, [LIGHT_DISTANCE] out from the page, [LIGHT_ABOVE] up, in
// [EYE]'s own width fractions. Nearer than the eye on purpose - a light beyond it magnifies its
// shadow less than the eye magnifies the sheet (1.09 against 1.15), so the shadow lands inside the
// silhouette casting it and never shows. Nearer, it escapes on every side. Height is no substitute:
// dropped straight down, a shadow hides behind a sheet that runs the height of the page.
const LIGHT_DISTANCE: f32 = 1.25;
const LIGHT_ABOVE: f32 = 0.0;

// How fast a shadow fades with the sheet's lift, per leaf length, and how dark it is at contact.
// Gentle: steeper, and it is spent before the curl lifts it clear of the leaf at all.
const SHADOW_FALLOFF: f32 = 1.0;
const SHADOW_DEPTH: f32 = 0.5;

// How far the curl's far edge falls below the page it left - see [leaf_shade].
const CURL_SHADE: f32 = 0.25;

// Penumbra width, as a fraction of the shadow's span and of its height, and how far it spreads per
// leaf length of lift - what softens a rising shadow, since its depth barely thins it.
const SOFT_ALONG: f32 = 0.08;
const SOFT_DOWN: f32 = 0.05;
const SOFT_SPREAD: f32 = 2.5;

fn leaf_radius() -> f32 { return flip.span.x / flip.geom.w; }

/// The tangent angle at arc fraction [s] along the leaf - 0 at the spine, 1 at the outer edge.
fn leaf_angle(s: f32) -> f32 { return flip.geom.z + flip.geom.w * s; }

/// A point on the leaf in centred width fractions, at tangent angle [b] and vertical fraction [v].
fn leaf_point(b: f32, v: f32) -> vec3<f32> {
    let r = leaf_radius();
    let phi = flip.geom.z;
    let y = mix(flip.span.y, flip.span.z, v);
    return vec3<f32>(
        (flip.geom.x - 0.5) + flip.geom.y * r * (sin(b) - sin(phi)),
        (y - 0.5) / flip.span.w,
        r * (cos(phi) - cos(b)),
    );
}

/// One point of the sheet, as far as casting a shadow cares: how far out from the spine, how high.
struct Cast {
    out: f32,
    z: f32,
}

fn cast_at(b: f32) -> Cast {
    let r = leaf_radius();
    let phi = flip.geom.z;
    var c: Cast;
    c.out = r * (sin(b) - sin(phi));
    c.z = r * (cos(phi) - cos(b));
    return c;
}

struct Span {
    lo: Cast,
    hi: Cast,
}

/// What the sheet shadows, as one span across the page - the two points that bound the rest.
///
/// Its strips stop running in footprint order once it leans past vertical: each one then retraces
/// ground the ones before it covered. Cast strip by strip that band takes shadow twice over - two
/// layers of paper block no more light than one - and creases where it turns back. Filling the span
/// its extremes bound covers it once: the hinge, the far edge, and the crest at vertical.
fn shadow_span() -> Span {
    let phi = flip.geom.z;
    let bend = flip.geom.w;

    var lo = cast_at(phi);
    var hi = cast_at(phi + bend);
    if (hi.out < lo.out) {
        let swap = lo;
        lo = hi;
        hi = swap;
    }
    if (phi < 0.5 * PI && phi + bend > 0.5 * PI) {
        let crest = cast_at(0.5 * PI);
        if (crest.out > hi.out) { hi = crest; }
        if (crest.out < lo.out) { lo = crest; }
    }

    var span: Span;
    span.lo = lo;
    span.hi = hi;
    return span;
}

/// Centred width fractions back to normalised surface coordinates, under perspective.
fn project(p: vec3<f32>) -> vec2<f32> {
    let s = EYE / (EYE - p.z);
    return vec2<f32>(0.5 + p.x * s, 0.5 + p.y * s * flip.span.w);
}

/// The lamp - see [LIGHT_DISTANCE]. Fixed in the surface: one carried by the leaf would hold its
/// shadow at the same offset all turn.
fn light_pos() -> vec3<f32> {
    return vec3<f32>(0.0, -LIGHT_ABOVE, LIGHT_DISTANCE);
}

/// Where a point on the leaf lays its shadow on the page. The clamp guards only a leaf risen as
/// high as its own light.
fn shadow_cast(p: vec3<f32>) -> vec2<f32> {
    let light = light_pos();
    let t = light.z / max(light.z - p.z, 0.25 * light.z);
    return light.xy + t * (p.xy - light.xy);
}

/// How dark the shadow is where the point casting it sits [z] above the page.
fn shadow_alpha(z: f32) -> f32 {
    return flip.flags.z * SHADOW_DEPTH * exp(-SHADOW_FALLOFF * max(z, 0.0) / flip.span.x);
}

/// How dark the sheet is at tangent angle [b] - the curl's form, not a light in the world.
///
/// The halves either side are blitted from their caches unshaded, so flat paper is 1.0 by
/// definition and the leaf has to meet that where it joins them. At the spine it is the same
/// unoccluded sheet, so it stays 1.0 - which no Lambert term can manage, the sheet standing
/// vertical there under a light that grazes it. This measures the turn from the hinge instead: 0
/// there, most at the far edge, and continuous across the fold since it never asks which face
/// shows. Eased off at both ends of the turn, so the leaf lands as lit as the half it becomes.
fn leaf_shade(b: f32) -> f32 {
    let turned = 1.0 - cos(b - flip.geom.z);
    return mix(1.0, 1.0 - CURL_SHADE * turned, flip.flags.z);
}

/// The face showing at a point of the sheet - whichever way the surface is turned.
struct Face {
    front: bool,
    /// False past this face's edges, and in the gutter before it starts.
    covers: bool,
    /// False for a side with no page: it draws blank rather than sampling.
    textured: bool,
    /// Surface coordinate, and so the texture coordinate - which lays the face on the sheet at its
    /// own size instead of stretching it over the whole sheet.
    uv: vec2<f32>,
    rect: vec4<f32>,
    /// Which way this face runs from the spine.
    side: f32,
}

fn face_at(s: f32, v: f32, b: f32) -> Face {
    var f: Face;
    f.front = cos(b) > 0.0;
    f.side = select(-flip.geom.y, flip.geom.y, f.front);
    f.uv = vec2<f32>(flip.geom.x + f.side * s * flip.span.x, mix(flip.span.y, flip.span.z, v));
    f.rect = select(flip.back_rect, flip.front_rect, f.front);
    f.textured = select(flip.flags.y, flip.flags.x, f.front) > 0.5;
    f.covers = f.uv.x >= f.rect.x && f.uv.x <= f.rect.z &&
        f.uv.y >= f.rect.y && f.uv.y <= f.rect.w;
    return f;
}

/// Fades the shadow towards every edge - a stand-in penumbra, the end at the spine included: there
/// the sheet meets the page as a fold, not a knife, and an unfeathered band reads as ink.
///
/// In the shadow's own [s] and [v], so it holds however the span was reached. Widens with the
/// caster's height [z] - a contact shadow is crisp, one thrown from a lifted curl broad.
fn shadow_softness(s: f32, v: f32, z: f32) -> f32 {
    let spread = 1.0 + SOFT_SPREAD * max(z, 0.0) / flip.span.x;
    let soft_s = min(SOFT_ALONG * spread, 0.5);
    let soft_v = min(SOFT_DOWN * spread, 0.5);
    return smoothstep(0.0, soft_s, s) * smoothstep(0.0, soft_s, 1.0 - s) *
        smoothstep(0.0, soft_v, v) * smoothstep(0.0, soft_v, 1.0 - v);
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    // Arc fraction along the leaf and vertical fraction down it.
    @location(0) s: f32,
    @location(1) v: f32,
    // The sheet point, carried so the fragment stage need not redo the arc's trig.
    @location(2) world: vec3<f32>,
    // 1 on the shadow half; every vertex of a quad shares it. Not flat - compat mode rejects that.
    @location(3) shadow: f32,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    const COLS: u32 = ${COLS}u;
    const ROWS: u32 = ${ROWS}u;
    const SHEET: u32 = ${SHEET_VERTICES}u;

    // Shadow grid first, leaf over it. Split by index, not two draws - one uniform buffer, not two.
    let shadow = vertex_index < SHEET;
    let i = select(vertex_index - SHEET, vertex_index, shadow);

    let quad_index = i / 6u;
    let vert_in_quad = i % 6u;
    let col = quad_index % COLS;
    let row = quad_index / COLS;

    let s0 = f32(col) / f32(COLS);
    let s1 = f32(col + 1u) / f32(COLS);
    let v0 = f32(row) / f32(ROWS);
    let v1 = f32(row + 1u) / f32(ROWS);

    var sv: vec2<f32>;
    switch (vert_in_quad) {
        case 0u: { sv = vec2<f32>(s0, v0); }
        case 1u: { sv = vec2<f32>(s0, v1); }
        case 2u: { sv = vec2<f32>(s1, v0); }
        case 3u: { sv = vec2<f32>(s1, v0); }
        case 4u: { sv = vec2<f32>(s0, v1); }
        default: { sv = vec2<f32>(s1, v1); }
    }

    var world: vec3<f32>;
    var screen: vec2<f32>;
    if (shadow) {
        // Across the span the sheet shadows rather than along the sheet - see [shadow_span] - so
        // the footprint runs in order and is covered once. Dropped through the light onto the page,
        // landing at z = 0, so no perspective divide.
        let span = shadow_span();
        let y = mix(flip.span.y, flip.span.z, sv.y);
        world = vec3<f32>(
            (flip.geom.x - 0.5) + flip.geom.y * mix(span.lo.out, span.hi.out, sv.x),
            (y - 0.5) / flip.span.w,
            mix(span.lo.z, span.hi.z, sv.x),
        );
        let flat = shadow_cast(world);
        screen = vec2<f32>(0.5 + flat.x, 0.5 + flat.y * flip.span.w);
    } else {
        world = leaf_point(leaf_angle(sv.x), sv.y);
        screen = project(world);
    }

    var out: VertexOutput;
    out.position = vec4<f32>(screen.x * 2.0 - 1.0, 1.0 - screen.y * 2.0, 0.0, 1.0);
    out.s = sv.x;
    out.v = sv.y;
    out.world = world;
    out.shadow = select(0.0, 1.0, shadow);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Premultiplied black, so the shadow multiplies what is under it down rather than tinting it.
    // Not clipped to the sheet's own rect the way a face is: a shadow falls where it falls, and its
    // span is already what bounds it.
    if (in.shadow > 0.5) {
        return vec4<f32>(
            0.0, 0.0, 0.0,
            shadow_alpha(in.world.z) * shadow_softness(in.s, in.v, in.world.z),
        );
    }

    let b = leaf_angle(in.s);
    let face = face_at(in.s, in.v, b);

    if (!face.covers) { discard; }

    var texel = flip.blank;
    if (face.textured) {
        if (face.front) {
            texel = textureSampleLevel(front_tex, flip_sampler, face.uv, 0.0);
        } else {
            texel = textureSampleLevel(back_tex, flip_sampler, face.uv, 0.0);
        }
    }

    // Premultiplied throughout - see premultipliedOutput - so shading scales rgb alone.
    return vec4<f32>(texel.rgb * leaf_shade(b), texel.a);
}
`
    }
}

export const TransitionFlip = new TransitionFlipImpl()
