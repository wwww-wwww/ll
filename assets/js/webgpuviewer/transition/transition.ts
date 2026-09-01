import { Offset, linearToSrgb, srgbToLinear } from "../util"
import type { TileRenderer } from "../renderer/tilerenderer"
import { WebGpuRenderer } from "../renderer/renderer"
import type { ImagePage } from "../viewer/imagepage"

/**
 * Page-turn animations and the two-slot render cache they sample - the port of
 * `transition/Transition.kt`.
 *
 * A turn only animates the offset, so each page is rendered into a cache texture once and every
 * later frame is a cache hit plus a 1:1 blit. [getCachedTexture] keys on the page's own transform
 * and frame version, and layers in tiles as the background worker lands them.
 *
 * A transition is a subclass with its own `code`: two cached textures and a shader.
 */
export abstract class Transition {
    /** WGSL for a shader-driven transition. Subclasses that blit directly leave it empty. */
    get code(): string {
        return ""
    }

    protected get device(): GPUDevice {
        return WebGpuRenderer.device
    }

    /**
     * True when [code]'s fragment stage already returns premultiplied alpha.
     *
     * Anything sampling a cached page texture does: the cache was written premultiplied, so
     * re-multiplying on the way out would darken every edge. Those shaders need `one` as the colour
     * source factor, not the `src-alpha` that suits straight-alpha texels.
     */
    protected get premultipliedOutput(): boolean {
        return false
    }

    private _pipeline: GPURenderPipeline | null = null

    protected get pipeline(): GPURenderPipeline {
        if (!this._pipeline) {
            const module = this.device.createShaderModule({ code: this.code })
            this._pipeline = this.device.createRenderPipeline({
                layout: "auto",
                vertex: { module, entryPoint: "vs_main" },
                fragment: {
                    module,
                    entryPoint: "fs_main",
                    targets: [
                        {
                            format: "rgba8unorm",
                            blend: {
                                color: {
                                    srcFactor: this.premultipliedOutput ? "one" : "src-alpha",
                                    dstFactor: "one-minus-src-alpha",
                                    operation: "add",
                                },
                                alpha: {
                                    srcFactor: "one",
                                    dstFactor: "one-minus-src-alpha",
                                    operation: "add",
                                },
                            },
                        },
                    ],
                },
                primitive: { topology: "triangle-list" },
            })
        }
        return this._pipeline
    }

    abstract render(
        page1: ImagePage,
        page2: ImagePage,
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        frac: number,
        pos1: Offset,
        pos2: Offset,
        tiles: TileRenderer,
    ): void
}

// ---------------------------------------------------------------------------
// Shared cache
// ---------------------------------------------------------------------------

const BLIT_SHADER = `
struct Uniforms {
    offset: vec2<f32>,
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

    // Apply offset to position
    let offset_pos = pos + uniforms.offset;

    var out: VertexOutput;
    out.position = vec4<f32>(offset_pos.x * 2.0 - 1.0, 1.0 - offset_pos.y * 2.0, 0.0, 1.0);
    out.uv = pos;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(src_tex, src_sampler, in.uv);
}
`

function device(): GPUDevice {
    return WebGpuRenderer.device
}

let blitPipeline: GPURenderPipeline | null = null

function getBlitPipeline(): GPURenderPipeline {
    if (blitPipeline) return blitPipeline
    const module = device().createShaderModule({ code: BLIT_SHADER })
    blitPipeline = device().createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs_main" },
        fragment: {
            module,
            entryPoint: "fs_main",
            targets: [
                {
                    format: "rgba8unorm",
                    blend: {
                        color: {
                            srcFactor: "one",
                            dstFactor: "one-minus-src-alpha",
                            operation: "add",
                        },
                        alpha: {
                            srcFactor: "one",
                            dstFactor: "one-minus-src-alpha",
                            operation: "add",
                        },
                    },
                },
            ],
        },
        primitive: { topology: "triangle-list" },
    })
    return blitPipeline
}

let blitSampler: GPUSampler | null = null

function getBlitSampler(): GPUSampler {
    if (!blitSampler) blitSampler = device().createSampler()
    return blitSampler
}

/** One cache slot: a full-surface texture plus the page identity it was rendered from. */
class CacheSlot {
    texture: GPUTexture | null = null
    view: GPUTextureView | null = null

    page: ImagePage | null = null
    x = 0
    y = 0
    scale = 0
    frameVersion = -1

    /**
     * Which tile keys [getCachedTexture] has actually blitted into this slot - compared against
     * `TileRenderer.availableTileKeys` to know exactly when it needs another incremental blit,
     * instead of a "done yet" boolean that has to agree with the tile renderer's own draw.
     */
    blittedKeys: Set<number> = new Set()

    /** Textures pending destruction (deferred to avoid use-after-free). */
    pendingDestroy: GPUTexture | null = null

    invalidate() {
        this.page = null
        this.blittedKeys = new Set()
    }

    hit(page: ImagePage): boolean {
        return (
            this.page === page &&
            this.x === page.x &&
            this.y === page.y &&
            this.scale === page.scale &&
            this.frameVersion === page.frameVersion
        )
    }

    record(page: ImagePage) {
        this.page = page
        this.x = page.x
        this.y = page.y
        this.scale = page.scale
        this.frameVersion = page.frameVersion
    }
}

const slot1 = new CacheSlot()
const slot2 = new CacheSlot()

let cacheWidth = 0
let cacheHeight = 0

function ensureTextures(width: number, height: number) {
    // Destroy old pending textures (safe now - at least one frame has passed).
    slot1.pendingDestroy?.destroy()
    slot2.pendingDestroy?.destroy()
    slot1.pendingDestroy = null
    slot2.pendingDestroy = null

    if (cacheWidth === width && cacheHeight === height) return

    // Defer destruction of the old textures.
    slot1.pendingDestroy = slot1.texture
    slot2.pendingDestroy = slot2.texture

    for (const slot of [slot1, slot2]) {
        slot.texture = device().createTexture({
            size: { width, height },
            format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
        slot.view = slot.texture.createView()
        slot.invalidate()
    }

    cacheWidth = width
    cacheHeight = height
}

/**
 * Blend [bg1] toward [bg2] by [t] in linear space - 50% between white and black should be linear
 * grey, not the lighter result a straight sRGB-byte lerp gives. [TransitionFade]'s own shader mix
 * matches this rate.
 */
export function blendBackgroundColor(bg1: number, bg2: number, t: number): number {
    const channel = (shift: number) => {
        const c1 = srgbToLinear(((bg1 >> shift) & 0xff) / 255)
        const c2 = srgbToLinear(((bg2 >> shift) & 0xff) / 255)
        const blended = linearToSrgb(c1 + (c2 - c1) * t)
        return Math.max(0, Math.min(255, Math.trunc(blended * 255)))
    }
    return 0xff000000 | (channel(16) << 16) | (channel(8) << 8) | channel(0) | 0
}

/** Invalidate the transition cache. Keeps textures allocated for reuse. */
export function invalidateCache() {
    slot1.invalidate()
    slot2.invalidate()
}

/**
 * Called once a page turn settles on [newCurrentPage]. Slot 2 is often already a valid render of
 * it - prewarmed while it was still the *next* page - so this swaps it into slot 1 instead of
 * discarding it. Falls back to a full wipe when neither slot matches.
 */
export function rotateCacheOnPageChange(newCurrentPage: ImagePage) {
    if (slot1.hit(newCurrentPage)) {
        slot2.invalidate()
        return
    }
    if (slot2.hit(newCurrentPage)) {
        const t = slot1.texture
        slot1.texture = slot2.texture
        slot2.texture = t
        const v = slot1.view
        slot1.view = slot2.view
        slot2.view = v
        slot1.page = slot2.page
        slot1.x = slot2.x
        slot1.y = slot2.y
        slot1.scale = slot2.scale
        slot1.frameVersion = slot2.frameVersion
        slot1.blittedKeys = slot2.blittedKeys
        slot2.invalidate()
        return
    }
    slot1.invalidate()
    slot2.invalidate()
}

/**
 * Cached texture view for a page, rendering into it as needed instead of requiring full tile
 * coverage up front:
 *  - Identity unchanged and the page never gets tiles, or matches what's tracked as blitted -
 *    return as-is.
 *  - Identity unchanged but something new is available - a `load` pass layers it on and that
 *    becomes the tracked set.
 *  - Identity changed - a `clear` pass and a full seed from scratch.
 *
 * Tracked key sets rather than a derived "fully covered" boolean, so this cannot desync from what
 * the tile renderer blits. Never forces generation: what is missing fills in later. Null only if the
 * page is undecoded.
 */
export function getCachedTexture(
    page: ImagePage,
    isPage1: boolean,
    encoder: GPUCommandEncoder,
    dstWidth: number,
    dstHeight: number,
    tiles: TileRenderer,
): GPUTextureView | null {
    if (page.destroyed || !page.isDecoded) return null

    ensureTextures(dstWidth, dstHeight)
    const slot = isPage1 ? slot1 : slot2
    const texture = slot.texture!
    const view = slot.view!
    const blittedKeys = slot.blittedKeys
    // Never a hit for an animated page - it swaps images every frame, so every call needs a fresh
    // clear + seed to blit whatever frame is current right now, rather than relying on
    // frameVersion happening to have ticked.
    const identityMatches = !page.isAnimated && slot.hit(page)

    // Null for a page that never gets tiles - not highQuality, animated, or not an image page at
    // all - in which case there's nothing further to compare against blittedKeys.
    const available = page.newlyAvailableTileKeys(tiles, texture)

    if (identityMatches && (available === null || setsEqual(available, blittedKeys))) {
        return view
    }

    // renderIntoCache opens its own pass (load or clear, matching identityMatches).
    page.renderIntoCache(encoder, texture, tiles, identityMatches)

    // [available] is still accurate after the render: renderIntoCache only blits what's already
    // cached and queues what's missing for the background worker - generation itself is async, so
    // the grid can't have gained anything in between. Reusing it here instead of re-walking the
    // grid halves this call's cost.
    slot.blittedKeys = available ?? new Set()
    if (!identityMatches) slot.record(page)

    return view
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
    if (a.size !== b.size) return false
    for (const v of a) if (!b.has(v)) return false
    return true
}

/**
 * Open one cleared pass on [dst] for a transition's whole frame - the background columns and each
 * blit used to open and close their own, costing an attachment load/store apiece; sharing one
 * pass across all of them instead is just as correct, since none of them read back what an
 * earlier one in the same frame wrote.
 */
export function beginClearedPass(
    encoder: GPUCommandEncoder,
    dst: GPUTexture,
): GPURenderPassEncoder {
    return encoder.beginRenderPass({
        colorAttachments: [
            {
                view: dst.createView(),
                loadOp: "clear",
                storeOp: "store",
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
            },
        ],
    })
}

const blitScratch = new Float32Array(2)

/** Blit a cached texture into [pass] with an offset. Draws nothing if [cachedView] is null. */
export function blitCached(
    pass: GPURenderPassEncoder,
    cachedView: GPUTextureView | null,
    offsetX: number,
    offsetY: number,
) {
    if (!cachedView) return

    blitScratch[0] = offsetX
    blitScratch[1] = offsetY

    const uniformBuffer = device().createBuffer({
        size: 8,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    device().queue.writeBuffer(uniformBuffer, 0, blitScratch)

    const pipeline = getBlitPipeline()
    pass.setPipeline(pipeline)
    pass.setBindGroup(
        0,
        device().createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: cachedView },
                { binding: 2, resource: getBlitSampler() },
            ],
        }),
    )
    pass.draw(6)
}
