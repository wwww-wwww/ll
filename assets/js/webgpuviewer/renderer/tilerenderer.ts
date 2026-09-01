import { delay, launch, yieldToEventLoop } from "../util"
import type { ImageSingle } from "../viewer/imagepage"
import type { Image } from "./image"
import { DownscalerBox } from "./downscalerbox"
import type { Filtered } from "./renderpage"
import { RenderPage } from "./renderpage"
import type { Downscaler, Rescaler, Upscaler } from "./rescaler"
import { UpscalerCatmullRom } from "./upscalercatmullrom"
import { WebGpuRenderer } from "./renderer"

/**
 * Solve the (x, y) `RenderPage.render`/`renderFast` need so [image] lands centred at screen
 * position ([targetX], [targetY]) - inverts `Image.prepareForRender`'s placement math for an
 * arbitrary target.
 */
export function solveImagePlacement(
    targetX: number,
    targetY: number,
    imageScale: number,
    image: Image,
    dstWidth: number,
    dstHeight: number,
): [number, number] {
    const x =
        (targetX - dstWidth / 2) / (imageScale * dstWidth) -
        image.x / dstWidth -
        WebGpuRenderer.offsetX
    const y =
        (targetY - dstHeight / 2) / (imageScale * dstHeight) -
        image.y / dstHeight -
        WebGpuRenderer.offsetY
    return [x, y]
}

export const TILE_SIZE = 256

const TILES_PER_BATCH_FALLBACK = 1
const BATCH_TARGET_NS = 4_000_000
const MAX_TILES_PER_BATCH = 8

/**
 * Grace window of extra pages (past "whichever is current") [TileRenderer.draw] keeps a grid for,
 * so leaving a page doesn't force full regeneration on turning right back. Paged path only - the
 * continuous viewer relies on the shared LRU cap instead.
 */
const RETAIN_MARGIN = 2

/** (tx, ty, atlas x, atlas y) as floats - see the blit shader's instance input. */
const INSTANCE_BYTES = 16

/**
 * The atlas is carved into slabs, each subdivided into slots of one tile size. A slab is the unit
 * that changes hands when the preferred size moves, so it is large enough that a class holds few
 * of them and small enough that a half-used one wastes little.
 */
const SLAB_SIZE = 512

/** Smallest preferred tile size worth having - below this the per-tile pass dominates. */
const MIN_TILE_SIZE = 128

/** The sizes [TileRenderer.reconsiderTileSize] chooses between, smallest first. */
const TILE_SIZES = [MIN_TILE_SIZE, 256, SLAB_SIZE]

/** Measurements a size needs before it is allowed to win, or lose, a comparison. */
const TILE_SIZE_SAMPLES = 4

/** How much cheaper per pixel another size must look before the grids are re-cut. */
const TILE_SIZE_MARGIN = 1.15

/** FrameParams: snap, dst_size, clip, then ts and the atlas's side. */
const FRAME_UNIFORM_BYTES = 48

/** What one [TILE_SIZE] tile costs, and the range the derived cache is held to. */
const TILE_BYTES = TILE_SIZE * TILE_SIZE * 4
const MIN_CACHE_BYTES = 16 * 1024 * 1024
const MAX_CACHE_BYTES = 64 * 1024 * 1024

/**
 * Score threshold [TileRenderer.nextRequest] uses to tell a genuinely on-screen tile request from
 * one outside a grid's wanted range (e.g. prewarmed tiles, which leave that range empty).
 */
const OFF_SCREEN_SCORE = 1e6

/**
 * Ring buffer size for [TileRenderer.stencilViewFor] - enough that a rotated stencil texture is
 * never still in flight from a prior frame.
 */
const STENCIL_BUFFER_COUNT = 3

function device(): GPUDevice {
    return WebGpuRenderer.device
}

/** Packed atlas position - both halves are well inside 16 bits at any sane atlas size. */
function pack(x: number, y: number): number {
    return (x << 16) | y
}

function unpackX(origin: number): number {
    return origin >>> 16
}

function unpackY(origin: number): number {
    return origin & 0xffff
}

/**
 * Tile keys are `(tx, ty)` pairs. The Kotlin packs them into a `Long`; JS numbers can't hold two
 * 32-bit halves losslessly under bitwise ops, so they are packed into a 48-bit number instead -
 * plenty for tile indices, which stay within a few thousand of the origin either way.
 */
const KEY_BIAS = 0x800000

function key(tx: number, ty: number): number {
    return (tx + KEY_BIAS) * 0x1000000 + (ty + KEY_BIAS)
}

function keyTx(k: number): number {
    return Math.floor(k / 0x1000000) - KEY_BIAS
}

function keyTy(k: number): number {
    return (k % 0x1000000) - KEY_BIAS
}

/** One cached tile: where in the atlas it sits (packed), and when it was last drawn. */
class Tile {
    lastUsed = 0

    constructor(readonly atlasOrigin: number) { }
}

/** The (tx, ty) index bounds of what a placement wants. */
class GridRange {
    constructor(
        readonly tx0: number,
        readonly tx1: number,
        readonly ty0: number,
        readonly ty1: number,
    ) { }

    holds(tileKey: number): boolean {
        const tx = keyTx(tileKey)
        const ty = keyTy(tileKey)
        return tx >= this.tx0 && tx <= this.tx1 && ty >= this.ty0 && ty <= this.ty1
    }

    same(other: GridRange): boolean {
        return (
            this.tx0 === other.tx0 &&
            this.tx1 === other.tx1 &&
            this.ty0 === other.ty0 &&
            this.ty1 === other.ty1
        )
    }
}

/**
 * Shared placement math for a page's tile grid: the tile region the viewport (plus a one-tile
 * margin) wants, clipped to the page's own extent, and the snapped clip rect the shader clamps
 * blits to.
 */
interface GridPlacement {
    ts: number
    snapX: number
    snapY: number
    clipL: number
    clipT: number
    clipR: number
    clipB: number
    wantL: number
    wantR: number
    wantT: number
    wantB: number
}

/** One grid per whole page - both images of a spread share it, seam baked in. */
class PageTiles {
    readonly tiles = new Map<number, Tile>()
    readonly pending = new Set<number>()

    // Values the current frameUniform contents were derived from, so a frame where the grid
    // didn't move skips the write entirely and encodes nothing but the blit draws.
    writtenSnapX = NaN
    writtenSnapY = NaN
    writtenDstW = NaN
    writtenDstH = NaN
    writtenClipL = NaN
    writtenClipT = NaN
    writtenClipR = NaN
    writtenClipB = NaN
    writtenTs = NaN
    writtenAlpha = NaN

    /** True once the scale has held for two consecutive frames; gates generation. */
    stable = false

    /** Wanted range the stale sweep last ran against. */
    sweptRange: GridRange | null = null

    // One bind group per grid, one instance per tile. Instances change only when a tile is
    // generated or dropped, never as the grid moves - the uniform's snap does that.
    bindGroup: GPUBindGroup | null = null
    instances: GPUBuffer | null = null
    instanceCapacity = 0
    instanceCount = 0
    instancesDirty = true

    /**
     * This page's exact, unrounded vertical offset from the grid's shared anchor - see the
     * continuous `draw` overload. Always 0 for the paged one.
     *
     * Also doubles as a staleness key, compared each call like [scale]: a changed offset at fixed
     * scale means the page's document position shifted, so existing tiles no longer agree with
     * where it sits.
     */
    centerYOffset = 0

    // The strictly visible tile range as of the last draw, in tile coordinates. The worker
    // prioritises against it at pull time, so a pan mid-fill redirects generation without
    // touching the queue.
    txMin = 0
    txMax = -1
    tyMin = 0
    tyMax = -1

    constructor(
        public scale: number,
        readonly page: ImageSingle,
        readonly frameUniform: GPUBuffer,
        /** Cut at this size until the grid is wiped, which is when it adopts a new preferred one. */
        public tileSize: number,
    ) { }

    get destroyed(): boolean {
        return this.page.destroyed
    }

    destroyAll(atlas: TileAtlas | null) {
        this.tiles.forEach(t => atlas?.release(this.tileSize, t.atlasOrigin))
        this.tiles.clear()
        this.pending.clear()
        this.instances?.destroy()
        this.instances = null
        this.instanceCapacity = 0
        this.instanceCount = 0
        this.bindGroup = null
        this.frameUniform.destroy()
    }
}

/**
 * Every tile in one texture, carved into [SLAB_SIZE] slabs. A slab holds slots of a single tile
 * size and returns to the pool once fully free, so sizes mix within one bind group.
 */
class TileAtlas {
    readonly texture: GPUTexture
    readonly view: GPUTextureView

    // Rendered here, then copied into the slot: a render pass needs a whole-texture target, so a
    // tile is drawn into a scratch of its own size and copied. One per size.
    private readonly scratches = new Map<number, GPUTexture>()
    private readonly scratchViews = new Map<number, GPUTextureView>()

    private readonly slabsPerRow: number
    private readonly slabs: (Slab | null)[]

    /** Slabs of each tile size that still have a free slot, most recently used first. */
    private readonly open = new Map<number, Slab[]>()

    constructor(readonly side: number) {
        this.texture = device().createTexture({
            size: { width: side, height: side },
            usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
            format: "rgba8unorm",
        })
        this.view = this.texture.createView()
        this.slabsPerRow = Math.floor(side / SLAB_SIZE)
        this.slabs = new Array(this.slabsPerRow * this.slabsPerRow).fill(null)
    }

    scratch(tileSize: number): GPUTexture {
        let texture = this.scratches.get(tileSize)
        if (!texture) {
            texture = device().createTexture({
                size: { width: tileSize, height: tileSize },
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
                format: "rgba8unorm",
            })
            this.scratches.set(tileSize, texture)
        }
        return texture
    }

    scratchView(tileSize: number): GPUTextureView {
        let view = this.scratchViews.get(tileSize)
        if (!view) {
            view = this.scratch(tileSize).createView()
            this.scratchViews.set(tileSize, view)
        }
        return view
    }

    private openFor(tileSize: number): Slab[] {
        let deque = this.open.get(tileSize)
        if (!deque) {
            deque = []
            this.open.set(tileSize, deque)
        }
        return deque
    }

    /** A packed atlas position, or -1 when full - the caller drops that tile for now. */
    acquire(tileSize: number): number {
        const deque = this.openFor(tileSize)
        while (deque.length > 0) {
            const slab = deque[0]
            if (slab.freeCount > 0) {
                const origin = slab.take()
                if (slab.freeCount === 0) deque.shift()
                return origin
            }
            deque.shift()
        }

        const index = this.slabs.indexOf(null)
        if (index < 0) return -1
        const slab = new Slab(index, tileSize, this.slabsPerRow)
        this.slabs[index] = slab
        const origin = slab.take()
        if (slab.freeCount > 0) deque.unshift(slab)
        return origin
    }

    release(tileSize: number, origin: number) {
        const slab = this.slabs[this.slabIndexOf(origin)]
        if (!slab) return
        slab.give(origin)
        const deque = this.openFor(tileSize)
        if (slab.freeCount === slab.free.length) {
            // Fully free: another size can claim it.
            const at = deque.indexOf(slab)
            if (at >= 0) deque.splice(at, 1)
            this.slabs[slab.index] = null
        } else if (slab.freeCount === 1) {
            deque.unshift(slab)
        }
    }

    private slabIndexOf(origin: number): number {
        return (
            Math.floor(unpackY(origin) / SLAB_SIZE) * this.slabsPerRow +
            Math.floor(unpackX(origin) / SLAB_SIZE)
        )
    }

    /** Move what [scratch] of [tileSize] holds into the slot at [origin]. */
    copyScratchInto(encoder: GPUCommandEncoder, origin: number, tileSize: number) {
        encoder.copyTextureToTexture(
            { texture: this.scratch(tileSize) },
            { texture: this.texture, origin: { x: unpackX(origin), y: unpackY(origin) } },
            { width: tileSize, height: tileSize },
        )
    }

    destroy() {
        this.scratches.forEach(t => t.destroy())
        this.scratches.clear()
        this.scratchViews.clear()
        this.texture.destroy()
    }
}

/** Same-sized slots; [free] holds slot indices within the slab. */
class Slab {
    readonly perRow: number
    readonly free: Int32Array
    freeCount: number
    readonly originX: number
    readonly originY: number

    constructor(
        readonly index: number,
        readonly tileSize: number,
        slabsPerRow: number,
    ) {
        this.perRow = Math.floor(SLAB_SIZE / tileSize)
        this.free = new Int32Array(this.perRow * this.perRow)
        for (let i = 0; i < this.free.length; i++) this.free[i] = i
        this.freeCount = this.free.length
        this.originX = (index % slabsPerRow) * SLAB_SIZE
        this.originY = Math.floor(index / slabsPerRow) * SLAB_SIZE
    }

    take(): number {
        const slot = this.free[--this.freeCount]
        return pack(
            this.originX + (slot % this.perRow) * this.tileSize,
            this.originY + Math.floor(slot / this.perRow) * this.tileSize,
        )
    }

    give(origin: number) {
        const slot =
            Math.floor((unpackY(origin) - this.originY) / this.tileSize) * this.perRow +
            Math.floor((unpackX(origin) - this.originX) / this.tileSize)
        this.free[this.freeCount++] = slot
    }
}

/** One tile of work for the shared worker. */
interface Request {
    state: PageTiles
    tx: number
    ty: number
}

/**
 * A cache of the filtered render, cut into square screen-resolution tiles - the port of
 * `renderer/TileRenderer.kt`. Every tile is a slot in one atlas texture, so a grid draws in a
 * single instanced call.
 *
 * `RenderPage.render` is too expensive every frame; `renderFast` is cheap but unfiltered. Each
 * frame draws the fast path, blits whatever filtered tiles exist on top, and fills in the rest a
 * few at a time.
 *
 * One grid per page, not per image, so a spread's seam bakes into whichever tile straddles it
 * rather than meeting two independently-snapped layers.
 *
 * Tiles live in content space - tile (tx, ty) holds the tile-size pixels right/down of the grid's
 * anchor - so panning survives untouched. A change of scale, or a document shift in the continuous
 * viewer, invalidates the grid, which regenerates once scale has held for two frames.
 *
 * The grid snaps to the nearest screen pixel, making every blit an exact 1:1 texel copy. Bind groups
 * and uniforms are created once at generation, so a blit is setBindGroup + draw; only the per-grid
 * anchor/clip uniform is rewritten, and only on change.
 *
 * Generation runs between frames, the browser having no thread to offer, a few tiles at a time with
 * an await between batches so a queued frame gets the turn back. Pending tiles are pulled
 * on-screen-first, centre-out.
 */
export class TileRenderer {
    constructor(private readonly invalidate: () => void) { }

    /**
     * Screens' worth of tiles to cache - the count itself follows the viewport ([budgetTiles]).
     * 1.5 is what a flat 192 came to at 1440p.
     */
    cacheScreens = 1.5

    // The viewport the last draw saw - what the cache is sized against.
    private viewportWidth = 0
    private viewportHeight = 0

    // budgetTiles() when the atlas was built - one fixed allocation, so the budget from then on.
    private atlasBudgetTiles = 0

    /** [cacheScreens] screens at [TILE_SIZE], ring included, within the cache byte range. */
    private budgetTiles(): number {
        if (this.viewportWidth <= 0 || this.viewportHeight <= 0) {
            return Math.floor(MIN_CACHE_BYTES / TILE_BYTES)
        }
        const cols = Math.ceil(this.viewportWidth / TILE_SIZE) + 2
        const rows = Math.ceil(this.viewportHeight / TILE_SIZE) + 2
        return Math.max(
            Math.floor(MIN_CACHE_BYTES / TILE_BYTES),
            Math.min(
                Math.floor(MAX_CACHE_BYTES / TILE_BYTES),
                Math.trunc(cols * rows * this.cacheScreens),
            ),
        )
    }

    private _preferredTileSize = TILE_SIZE

    /**
     * The size grids are cut at from now on, chosen by [reconsiderTileSize] from measured cost. A
     * grid adopts it on its next draw, through the same wipe a scale change goes through, so this
     * never disturbs one mid-gesture.
     */
    get preferredTileSize(): number {
        return this._preferredTileSize
    }

    set preferredTileSize(value: number) {
        this._preferredTileSize = Math.max(MIN_TILE_SIZE, Math.min(SLAB_SIZE, value))
    }

    private _upscaler: Upscaler = new UpscalerCatmullRom()

    /**
     * How a tile that magnifies the page is resized - see [Rescaler]. [UpscalerCatmullRom]
     * resolves the tile in one step, the way this has always worked; anything with a
     * [Rescaler.factor] above 1 splits it, resolving at scale/factor first and letting the
     * upscaler cover the rest.
     *
     * Tiles only - the live fast path (RenderPage.renderFast) that a pan or pinch draws through is
     * deliberately cheap and is left alone. Assigning wipes every grid, since the tiles already
     * cached were resized by the old rescaler.
     */
    get upscaler(): Upscaler {
        return this._upscaler
    }

    set upscaler(value: Upscaler) {
        if (this._upscaler === value) return
        const previous = this._upscaler
        this._upscaler = value
        this.replaceRescaler(previous)
    }

    private _downscaler: Downscaler = new DownscalerBox()

    /**
     * How a tile that shrinks the page is resized - see [Rescaler]. [DownscalerBox] is the only
     * one, and like [UpscalerCatmullRom] it adds no pass of its own.
     */
    get downscaler(): Downscaler {
        return this._downscaler
    }

    set downscaler(value: Downscaler) {
        if (this._downscaler === value) return
        const previous = this._downscaler
        this._downscaler = value
        this.replaceRescaler(previous)
    }

    /** Drop every tile the outgoing rescaler produced and let go of what it held. */
    private replaceRescaler(previous: Rescaler) {
        this.pages.forEach(st => this.releaseTiles(st))
        previous.cleanup()
        this.invalidate()
    }

    /**
     * True when either rescaler adds passes of its own, so a tile costs far more than
     * RenderPage.render alone and [probeTileSize] cannot reproduce that cost. False for both
     * defaults, which leaves everything downstream unchanged.
     */
    private get staged(): boolean {
        return (
            (this._upscaler.factor > 1 && this._upscaler.supported) ||
            (this._downscaler.factor > 1 && this._downscaler.supported)
        )
    }

    // The pipelines [renderTileContent] draws through, re-derived only when a rescaler is swapped.
    // By identity, since each rescaler class shares one instance of its shader source.
    private filteredCache: Filtered | null = null
    private filteredCacheUp: Upscaler | null = null
    private filteredCacheDown: Downscaler | null = null

    /** The resolves the rescalers in force supply - see [Rescaler.code]. */
    private filtered(): Filtered {
        const up = this._upscaler
        const down = this._downscaler
        let pair = this.filteredCache
        if (!pair || up !== this.filteredCacheUp || down !== this.filteredCacheDown) {
            pair = RenderPage.filtered(up.code, down.code)
            this.filteredCache = pair
            this.filteredCacheUp = up
            this.filteredCacheDown = down
        }
        return pair
    }

    private frame = 0
    private workerActive = false

    private _suspended = false

    /**
     * Pause tile generation.
     *
     * A settled page queues its whole wanted range at once - a hundred or so tiles, each its own
     * encoder, render pass and `submit`. Fine alone; not fine during a page load, where the uploads
     * and tile passes contend for one queue and frames stop presenting however finely the CPU side
     * is chunked. No counterpart in the Kotlin, whose decode is threaded and uploads native.
     *
     * Cached tiles keep being blitted; only generation stops.
     */
    get suspended(): boolean {
        return this._suspended
    }

    set suspended(value: boolean) {
        if (this._suspended === value) return
        this._suspended = value
        // The worker loop exits on its own when suspended, so resuming has to restart it.
        if (!value) this.schedule()
    }

    // Timestamp-query based GPU cost measurement for generateTile's batches - null wherever the
    // adapter didn't have the feature, in which case batch sizing just falls back to
    // TILES_PER_BATCH_FALLBACK forever.
    private _timestampQuerySet: GPUQuerySet | null | undefined = undefined

    private get timestampQuerySet(): GPUQuerySet | null {
        if (this._timestampQuerySet === undefined) {
            this._timestampQuerySet =
                WebGpuRenderer.timestampsSupported ?
                    device().createQuerySet({ type: "timestamp", count: 16 })
                    : null
        }
        return this._timestampQuerySet
    }

    // Recycled: two creates and a destroy per tile was a real slice of a small-tile batch.
    private readonly timestampPool: { resolve: GPUBuffer; result: GPUBuffer }[] = []

    private acquireTimestampBuffers() {
        return (
            this.timestampPool.pop() ?? {
                resolve: device().createBuffer({
                    size: 16,
                    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
                }),
                result: device().createBuffer({
                    size: 16,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
                }),
            }
        )
    }

    private releaseTimestampBuffers(buffers: { resolve: GPUBuffer; result: GPUBuffer }) {
        // A batch never has more in flight than this.
        if (this.timestampPool.length >= MAX_TILES_PER_BATCH) {
            buffers.resolve.destroy()
            buffers.result.destroy()
        } else {
            this.timestampPool.push(buffers)
        }
    }

    // What recording a tile costs on the main thread - encoder, pass, submit - which the pass
    // timestamps don't span. Averaged like tileCostNs; 0 until the first tile lands.
    private tileOverheadNs = 0

    private recordTileOverhead(sampleNs: number) {
        this.tileOverheadNs =
            this.tileOverheadNs <= 0 ? sampleNs : this.tileOverheadNs * 0.8 + sampleNs * 0.2
    }

    /** A tile's whole cost to a batch: its timed pass plus [tileOverheadNs]. */
    private totalTileCostNs(i: number): number {
        return this.tileCostNs[i] + this.tileOverheadNs
    }

    // Exponential moving average of one tile's GPU render-pass duration per entry of TILE_SIZES,
    // in nanoseconds - 0 until that size's first measurement lands.
    private readonly tileCostNs = new Float64Array(TILE_SIZES.length)
    private readonly tileSamples = new Int32Array(TILE_SIZES.length)

    private sizeIndex(tileSize: number): number {
        return TILE_SIZES.indexOf(tileSize)
    }

    private currentTileCostNs(): number {
        const i = this.sizeIndex(this.preferredTileSize)
        return i >= 0 ? this.tileCostNs[i] : 0
    }

    /** How many tiles [schedule] should generate before its next yield. */
    private nextBatchSize(): number {
        const cost = this.currentTileCostNs()
        if (cost <= 0) return TILES_PER_BATCH_FALLBACK
        return Math.max(
            1,
            Math.min(
                MAX_TILES_PER_BATCH,
                Math.trunc(BATCH_TARGET_NS / (cost + this.tileOverheadNs)),
            ),
        )
    }

    /**
     * Fold one timed tile into its size's average and re-pick [preferredTileSize]. A size outside
     * [TILE_SIZES] is left alone, since nothing here can compare it.
     */
    private recordTileCost(tileSize: number, sampleNs: number) {
        const i = this.sizeIndex(tileSize)
        if (i < 0) return
        this.tileCostNs[i] =
            this.tileCostNs[i] <= 0 ? sampleNs : this.tileCostNs[i] * 0.8 + sampleNs * 0.2
        this.tileSamples[i]++
        this.reconsiderTileSize()
    }

    /**
     * A size's cost per pixel - what decides, since the pixels are the work. Counts the per-tile
     * overhead, which is size-independent and so does amortise better on a big tile.
     */
    private costPerPixel(i: number): number {
        return this.totalTileCostNs(i) / (TILE_SIZES[i] * TILE_SIZES[i])
    }

    /**
     * Pick the size whose pixels are cheapest, among those with [TILE_SIZE_SAMPLES] readings and
     * a tile inside [BATCH_TARGET_NS] - one tile is the smallest unit [schedule] can pace, so a
     * tile costing more than a batch's target is itself the hitch. A challenger needs
     * [TILE_SIZE_MARGIN] to win, since switching re-cuts every grid.
     *
     * Frozen while [staged], because the sizes are then not comparable: the size in use is timed
     * generating real tiles through the rescaler, every other size by [probeTileSize] without one.
     * So the size in use reads as expensive, this switches away, and the size it switches to
     * becomes expensive in turn - and every switch re-cuts every grid, which on screen is the
     * high-quality tiles dropping out and back while only the scroll moves.
     */
    private reconsiderTileSize() {
        if (this.staged) return
        const current = this.sizeIndex(this.preferredTileSize)
        if (current < 0 || this.tileSamples[current] < TILE_SIZE_SAMPLES) return

        if (this.totalTileCostNs(current) > BATCH_TARGET_NS && current > 0) {
            this.preferredTileSize = TILE_SIZES[current - 1]
            this.invalidate()
            return
        }

        let best = current
        let bestCost = this.costPerPixel(current)
        for (let i = 0; i < TILE_SIZES.length; i++) {
            if (i === current || this.tileSamples[i] < TILE_SIZE_SAMPLES) continue
            if (this.totalTileCostNs(i) > BATCH_TARGET_NS) continue
            const cost = this.costPerPixel(i)
            if (cost * TILE_SIZE_MARGIN < bestCost) {
                best = i
                bestCost = cost
            }
        }
        if (best === current) return

        // Grids re-cut on their next draw - see drawCore's invalidation.
        this.preferredTileSize = TILE_SIZES[best]
        this.invalidate()
    }

    // Allocated on the first tile: a viewer that never tiles pays nothing, and the viewport it is
    // sized against is known by then.
    private atlasOrNull: TileAtlas | null = null

    private get atlas(): TileAtlas {
        // One large allocation, on the first tile ever needed.
        if (!this.atlasOrNull) this.atlasOrNull = new TileAtlas(this.atlasSide())
        return this.atlasOrNull
    }

    /** Square, whole slabs, big enough for [budgetTiles] tiles of [TILE_SIZE]. */
    private atlasSide(): number {
        const budget = this.budgetTiles()
        this.atlasBudgetTiles = budget
        const perSlab = Math.floor(SLAB_SIZE / TILE_SIZE) * Math.floor(SLAB_SIZE / TILE_SIZE)
        const slabs = Math.floor((budget + perSlab - 1) / perSlab)
        return Math.max(1, Math.ceil(Math.sqrt(slabs))) * SLAB_SIZE
    }

    private newGrid(page: ImageSingle, pageScale: number): PageTiles {
        return new PageTiles(
            pageScale,
            page,
            device().createBuffer({
                size: FRAME_UNIFORM_BYTES,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            }),
            this.preferredTileSize,
        )
    }

    /**
     * Release the grid longest without a draw, to get whole slabs back. Never one on screen: its
     * slots may belong to a pass still being recorded.
     */
    private freeColdestGrid(keep: PageTiles) {
        let victim: PageTiles | null = null
        for (const st of this.pages.values()) {
            if (st !== keep && st.tiles.size > 0 && !st.page.isOnScreen) {
                victim = st
                break
            }
        }
        if (!victim) return
        this.releaseTiles(victim)
        victim.pending.clear()
    }

    /** Hand [st]'s tiles back to the atlas - it keeps none of its own state about them. */
    private releaseTiles(st: PageTiles) {
        const pool = this.atlasOrNull
        if (pool) st.tiles.forEach(t => pool.release(st.tileSize, t.atlasOrigin))
        st.tiles.clear()
        st.instancesDirty = true
        st.sweptRange = null
    }

    /**
     * Access-ordered, like the Kotlin's `LinkedHashMap(16, 0.75f, true)`: [touch] re-inserts so
     * the most recently drawn page is always last, whether or not it was already present - see
     * [RETAIN_MARGIN].
     */
    private readonly pages = new Map<ImageSingle, PageTiles>()

    private touch(page: ImageSingle, create: () => PageTiles): PageTiles {
        const existing = this.pages.get(page)
        if (existing) {
            this.pages.delete(page)
            this.pages.set(page, existing)
            return existing
        }
        const created = create()
        this.pages.set(page, created)
        return created
    }

    private readonly frameScratch = new Float32Array(FRAME_UNIFORM_BYTES / 4)

    // Nearest: tiles are blitted 1:1 at integer pixel positions, so this is an exact copy.
    private _blitSampler: GPUSampler | null = null

    private get blitSampler(): GPUSampler {
        if (!this._blitSampler) {
            this._blitSampler = device().createSampler({
                magFilter: "nearest",
                minFilter: "nearest",
            })
        }
        return this._blitSampler
    }

    // Explicit (not auto-inferred) so it can be shared across blitPipeline and the stencil-write
    // twin - an auto pipeline layout is unique to the pipeline it was inferred for, so a bind
    // group made against one pipeline's auto layout is invalid on the other, even though both
    // share the exact same shader and bindings. A grid's bind group is created once and reused
    // across both pipelines, so it must be built against this.
    private _blitBindGroupLayout: GPUBindGroupLayout | null = null

    private get blitBindGroupLayout(): GPUBindGroupLayout {
        if (!this._blitBindGroupLayout) {
            this._blitBindGroupLayout = device().createBindGroupLayout({
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                        buffer: { type: "uniform" },
                    },
                    {
                        binding: 1,
                        visibility: GPUShaderStage.FRAGMENT,
                        texture: { sampleType: "float" },
                    },
                    {
                        binding: 2,
                        visibility: GPUShaderStage.FRAGMENT,
                        sampler: { type: "filtering" },
                    },
                ],
            })
        }
        return this._blitBindGroupLayout
    }

    private buildBlitPipeline(depthStencil?: GPUDepthStencilState): GPURenderPipeline {
        const module = device().createShaderModule({ code: BLIT_SHADER })
        return device().createRenderPipeline({
            layout: device().createPipelineLayout({ bindGroupLayouts: [this.blitBindGroupLayout] }),
            vertex: {
                module,
                entryPoint: "vs_main",
                buffers: [
                    {
                        arrayStride: INSTANCE_BYTES,
                        stepMode: "instance",
                        attributes: [{ format: "float32x4", offset: 0, shaderLocation: 0 }],
                    },
                ],
            },
            fragment: {
                module,
                entryPoint: "fs_main",
                targets: [
                    {
                        // Tiles hold RenderPage's output, which is premultiplied, so One rather
                        // than SrcAlpha.
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
            ...(depthStencil ? { depthStencil } : {}),
        })
    }

    private _blitPipeline: GPURenderPipeline | null = null

    /** Plain blit, no stencil attachment. */
    private get blitPipeline(): GPURenderPipeline {
        if (!this._blitPipeline) this._blitPipeline = this.buildBlitPipeline()
        return this._blitPipeline
    }

    private _blitPipelineStencilWrite: GPURenderPipeline | null = null

    /**
     * As [blitPipeline], but always writes 1 into the stencil attachment wherever it draws - for
     * the live-render callers, which mask `RenderPage.renderFast`'s per-pixel work against
     * exactly this: a tile pixel drawn here needs no further shading underneath it, so a pixel
     * `RenderPage` would otherwise redraw stays skipped once this stencil value marks it done.
     */
    private get blitPipelineStencilWrite(): GPURenderPipeline {
        if (!this._blitPipelineStencilWrite) {
            this._blitPipelineStencilWrite = this.buildBlitPipeline({
                format: "stencil8",
                depthWriteEnabled: false,
                depthCompare: "always",
                stencilFront: { compare: "always", passOp: "replace" },
                stencilBack: { compare: "always", passOp: "replace" },
                stencilWriteMask: 0xff,
            })
        }
        return this._blitPipelineStencilWrite
    }

    // Ring-buffered, not one shared texture: reusing a single stencil texture every frame would
    // force the GPU to serialize each frame's clear/write against the previous frame's, still in
    // flight - silently undoing the swapchain's own buffering and showing up as tiles trailing
    // the current pan/scroll position.
    private readonly stencilTextures: (GPUTexture | null)[] = new Array(STENCIL_BUFFER_COUNT).fill(
        null,
    )
    private readonly stencilViews: (GPUTextureView | null)[] = new Array(STENCIL_BUFFER_COUNT).fill(
        null,
    )
    private stencilWidth = 0
    private stencilHeight = 0

    /**
     * Stencil-only attachment matching [dst]'s size, shared by every live-render pass this frame
     * so the stencil-write blit can mark tile-covered pixels and `RenderPage`'s masked variants
     * can skip re-shading them.
     */
    stencilViewFor(dst: GPUTexture): GPUTextureView {
        if (this.stencilWidth !== dst.width || this.stencilHeight !== dst.height) {
            this.stencilWidth = dst.width
            this.stencilHeight = dst.height
            for (let i = 0; i < STENCIL_BUFFER_COUNT; i++) {
                this.stencilTextures[i]?.destroy()
                const texture = device().createTexture({
                    usage: GPUTextureUsage.RENDER_ATTACHMENT,
                    size: { width: dst.width, height: dst.height },
                    format: "stencil8",
                })
                this.stencilTextures[i] = texture
                this.stencilViews[i] = texture.createView()
            }
        }
        return this.stencilViews[this.frame % STENCIL_BUFFER_COUNT]!
    }

    /**
     * Advance the frame counter and drop tiles for any page the app has since evicted. Called
     * once at the top of every rendered frame, including ones that don't draw tiles at all (e.g.
     * a page transition), so a destroyed page's textures are freed right away.
     */
    newFrame() {
        this.frame++
        if (this.pages.size === 0) return
        for (const [page, st] of [...this.pages]) {
            if (st.destroyed) {
                st.destroyAll(this.atlasOrNull)
                this.pages.delete(page)
            }
        }
    }

    /**
     * Left/right screen-pixel extent of [page] from its own anchor (x=0), in [pageScale] units.
     *
     * Not symmetric halves of the page width for a spread: each side extends outward by its *own*
     * width, so the anchor sits at the seam rather than the centre of the combined footprint.
     */
    private pageHorizontalExtent(page: ImageSingle, pageScale: number): [number, number] {
        const [leftWidth, rightWidth] = page.horizontalExtent()
        return [pageScale * leftWidth, pageScale * rightWidth]
    }

    private pagedAnchor(
        page: ImageSingle,
        dst: GPUTexture,
        x: number,
        y: number,
        scale: number,
    ): { pageScale: number; anchorX: number; anchorY: number; pinned: boolean } {
        // Pin the grid to the animation's target while actually scale-animating home, so drawCore
        // wipes it once instead of every interpolated frame. Gated on isScaleAnimating, not just
        // the target being homeScale, since a pure-position animateTo at a constant homeScale
        // never sets that flag - pinning then would just freeze the grid for nothing.
        const goingHome = page.isScaleAnimating && page.animationTargetScale === page.homeScale
        const effectivePageX = goingHome ? (page.animationTargetX ?? page.x) : page.x
        const effectivePageY = goingHome ? (page.animationTargetY ?? page.y) : page.y
        const effectivePageScale = goingHome ? page.homeScale : page.scale
        const pageScale = effectivePageScale * scale
        const anchorX =
            dst.width / 2 + pageScale * ((effectivePageX + x + WebGpuRenderer.offsetX) * dst.width)
        const anchorY =
            dst.height / 2 +
            pageScale * ((effectivePageY + y + WebGpuRenderer.offsetY) * dst.height)
        return { pageScale, anchorX, anchorY, pinned: goingHome }
    }

    private gridPlacement(
        page: ImageSingle,
        dst: GPUTexture,
        anchorX: number,
        anchorY: number,
        centerYOffset: number,
        pageScale: number,
        tileSize: number,
    ): GridPlacement | null {
        const ts = tileSize
        const [leftHalf, rightHalf] = this.pageHorizontalExtent(page, pageScale)
        const halfH = (pageScale * page.height) / 2
        if (leftHalf + rightHalf <= 0 || halfH <= 0) return null

        const wantL = Math.max(-anchorX - ts, -leftHalf)
        const wantR = Math.min(dst.width - anchorX + ts, rightHalf)
        const wantT = Math.max(-anchorY - ts, centerYOffset - halfH)
        const wantB = Math.min(dst.height - anchorY + ts, centerYOffset + halfH)

        const snapX = Math.round(anchorX)
        const snapY = Math.round(anchorY)

        return {
            ts,
            snapX,
            snapY,
            clipL: snapX - leftHalf,
            clipT: snapY + centerYOffset - halfH,
            clipR: snapX + rightHalf,
            clipB: snapY + centerYOffset + halfH,
            wantL,
            wantR,
            wantT,
            wantB,
        }
    }

    private wantedTileRange(gp: GridPlacement): GridRange {
        const ts = gp.ts
        return new GridRange(
            Math.floor(gp.wantL / ts),
            Math.ceil(gp.wantR / ts) - 1,
            Math.floor(gp.wantT / ts),
            Math.ceil(gp.wantB / ts) - 1,
        )
    }

    /**
     * Every (tx, ty) in [r], visible or not - one definition shared by [drawCore] and
     * [availableTileKeys] so they can't drift apart. Visibility is a separate per-tile question.
     */
    private forEachTile(r: GridRange, action: (txi: number, tyi: number) => void) {
        for (let tyi = r.ty0; tyi <= r.ty1; tyi++) {
            for (let txi = r.tx0; txi <= r.tx1; txi++) action(txi, tyi)
        }
    }

    /** True if tile ([txi], [tyi]) of [gp]'s grid actually overlaps [dst]'s visible bounds. */
    private tileVisible(gp: GridPlacement, dst: GPUTexture, txi: number, tyi: number): boolean {
        const ts = gp.ts
        const px = gp.snapX + txi * ts
        const py = gp.snapY + tyi * ts
        const visL = Math.max(gp.clipL, 0)
        const visT = Math.max(gp.clipT, 0)
        const visR = Math.min(gp.clipR, dst.width)
        const visB = Math.min(gp.clipB, dst.height)
        return px < visR && px + ts > visL && py < visB && py + ts > visT
    }

    private continuousAnchor(
        page: ImageSingle,
        dst: GPUTexture,
        cameraDocY: number,
        docTop: number,
        viewerOffsetX: number,
        scale: number,
    ): { pageScale: number; anchorX: number; anchorY: number; centerYOffset: number } | null {
        if (page.width <= 0) return null
        const pageScaleAtZoom1 = dst.width / page.width
        const pageScale = pageScaleAtZoom1 * scale
        const anchorX =
            dst.width / 2 + scale * (viewerOffsetX * dst.width + WebGpuRenderer.offsetX * dst.width)
        const anchorY =
            dst.height / 2 - scale * cameraDocY + scale * WebGpuRenderer.offsetY * dst.height
        const pageHeightDoc = page.height * pageScaleAtZoom1
        const centerYOffset = scale * (docTop + pageHeightDoc / 2)
        return { pageScale, anchorX, anchorY, centerYOffset }
    }

    /**
     * The set of (tx, ty) grid keys [page]'s tile cache currently has cached and visible within
     * [dst] - lets a caller like a transition track exactly what it's already blitted and detect
     * when something new lands. Null if the page isn't drawable.
     */
    availableTileKeys(page: ImageSingle, dst: GPUTexture): Set<number> | null {
        if (page.destroyed || !page.highQuality || page.isAnimated) return null
        if (!page.hasUploadedImage) return null

        const st = this.pages.get(page)
        if (!st) return null
        const a = this.pagedAnchor(page, dst, 0, 0, 1)
        const gp = this.gridPlacement(page, dst, a.anchorX, a.anchorY, 0, a.pageScale, st.tileSize)
        if (!gp) return null
        if (gp.wantL >= gp.wantR || gp.wantT >= gp.wantB) return new Set()

        const keys = new Set<number>()
        this.forEachTile(this.wantedTileRange(gp), (txi, tyi) => {
            if (this.tileVisible(gp, dst, txi, tyi)) {
                const tkey = key(txi, tyi)
                if (st.tiles.has(tkey)) keys.add(tkey)
            }
        })
        return keys
    }

    /**
     * Ensure [page]'s tile grid exists and enqueue its missing tiles, without blitting anything -
     * for getting a page sharp before it's on screen (the paged viewer's next page). Always at
     * the page's own home position, since it has no live pan/zoom yet.
     *
     * Deliberately leaves the visible range at its empty default, so [nextRequest] always ranks
     * this grid's tiles as "off-screen", behind whichever page is genuinely being drawn.
     */
    prewarm(page: ImageSingle, dst: GPUTexture) {
        if (page.destroyed || !page.highQuality || page.isAnimated) return
        if (!page.hasUploadedImage) return

        this.viewportWidth = dst.width
        this.viewportHeight = dst.height

        const a = this.pagedAnchor(page, dst, 0, 0, 1)
        const st = this.touch(page, () => this.newGrid(page, a.pageScale))

        if (st.scale !== a.pageScale || st.tileSize !== this.preferredTileSize) {
            this.releaseTiles(st)
            st.pending.clear()
            st.scale = a.pageScale
            st.tileSize = this.preferredTileSize
            st.stable = false
            this.invalidate()
        } else {
            st.stable = true
        }
        if (!st.stable) return

        const gp = this.gridPlacement(page, dst, a.anchorX, a.anchorY, 0, a.pageScale, st.tileSize)
        if (!gp) return
        if (gp.wantL >= gp.wantR || gp.wantT >= gp.wantB) return

        const wanted = this.wantedTileRange(gp)

        // A prewarmed tile's bind group references this same frame uniform, but unlike drawCore
        // this grid is never drawn on screen to write it - without this, a page that's only ever
        // been prewarmed blits with a never-written clip rect, which reads as solid black.
        this.writeFrameUniformIfChanged(
            st,
            dst,
            gp.snapX,
            gp.snapY,
            gp.clipL,
            gp.clipT,
            gp.clipR,
            gp.clipB,
            page.fade,
        )

        let added = false
        this.forEachTile(wanted, (txi, tyi) => {
            const tkey = key(txi, tyi)
            if (!st.tiles.has(tkey)) {
                st.pending.add(tkey)
                added = true
            }
        })
        if (added) this.schedule()
    }

    /**
     * Blit [page]'s cached tiles and enqueue the missing ones - the paged viewer's placement, via
     * its own page-relative (x, y).
     */
    draw(
        pass: GPURenderPassEncoder,
        page: ImageSingle,
        dst: GPUTexture,
        x: number,
        y: number,
        scale: number,
    ): boolean {
        const a = this.pagedAnchor(page, dst, x, y, scale)
        const covered = this.drawCore(
            pass,
            page,
            dst,
            a.anchorX,
            a.anchorY,
            0,
            a.pageScale,
            page.isScaleAnimating,
            true,
            true,
        )
        // Never "covered" off a pinned grid: it sits at the animation's target, so the live draw
        // is the only thing showing the page where it is mid-animation.
        return covered && !a.pinned
    }

    /**
     * Blit [page]'s cached tiles and enqueue the missing ones - the continuous viewer's
     * placement, via [cameraDocY] (the camera's document position) and [docTop] (this page's
     * own, both in screen pixels at zoom 1).
     *
     * Rounds only the shared *camera* anchor, leaving each page's own offset from it exact -
     * unlike the paged path, several pages can draw through here in the same frame, and
     * independently rounding each one's own anchor could leave adjacent grids disagreeing by a
     * pixel at their shared seam (`round(a) + b` isn't generally `round(a + b)`).
     */
    drawContinuous(
        pass: GPURenderPassEncoder,
        page: ImageSingle,
        dst: GPUTexture,
        cameraDocY: number,
        docTop: number,
        viewerOffsetX: number,
        scale: number,
        suppressGeneration: boolean,
    ): boolean {
        const a = this.continuousAnchor(page, dst, cameraDocY, docTop, viewerOffsetX, scale)
        if (!a) return false
        return this.drawCore(
            pass,
            page,
            dst,
            a.anchorX,
            a.anchorY,
            a.centerYOffset,
            a.pageScale,
            suppressGeneration,
            false,
            true,
        )
    }

    /** Shared blit-and-enqueue core for both [draw] paths. */
    private drawCore(
        pass: GPURenderPassEncoder,
        page: ImageSingle,
        dst: GPUTexture,
        anchorX: number,
        anchorY: number,
        centerYOffset: number,
        pageScale: number,
        suppressGeneration: boolean,
        applyRetainWindow: boolean,
        useStencilMask: boolean = false,
    ): boolean {
        if (page.destroyed || !page.highQuality || page.isAnimated) return false
        if (!page.hasUploadedImage) return false

        this.viewportWidth = dst.width
        this.viewportHeight = dst.height

        const st = this.touch(page, () => this.newGrid(page, pageScale))

        if (applyRetainWindow) {
            // touch() just moved page to the end of this access-ordered map - trim the front
            // (least recently drawn) down to the grace window. A page turn animates via a
            // transition's own cache, never this one, so anything evicted here isn't on screen.
            while (this.pages.size > RETAIN_MARGIN) {
                const eldest = this.pages.keys().next().value as ImageSingle
                this.pages.get(eldest)!.destroyAll(this.atlasOrNull)
                this.pages.delete(eldest)
            }
        }

        if (
            st.scale !== pageScale ||
            st.centerYOffset !== centerYOffset ||
            st.tileSize !== this.preferredTileSize
        ) {
            // A changed centerYOffset at fixed scale means a placeholder corrected its guessed
            // height - invalidate the same way a scale change does. A changed preferred size
            // rides the same path: this is the one moment a grid can be re-cut for free.
            this.releaseTiles(st)
            st.pending.clear()
            st.scale = pageScale
            st.tileSize = this.preferredTileSize
            st.stable = false
            this.invalidate()
        } else {
            // Two frames landing on the same scale isn't enough proof of settling while a
            // gesture/animation is still actively driving it.
            st.stable = !suppressGeneration
        }
        st.centerYOffset = centerYOffset

        const gp = this.gridPlacement(
            page,
            dst,
            anchorX,
            anchorY,
            centerYOffset,
            pageScale,
            st.tileSize,
        )
        if (!gp) {
            st.pending.clear()
            return false
        }
        // Off screen: nothing to draw, so nothing for tiles to be missing either.
        if (gp.wantL >= gp.wantR || gp.wantT >= gp.wantB) {
            st.pending.clear()
            return true
        }

        const ts = TILE_SIZE

        // In tile coordinates, unlike wantT/wantB - not offset by centerYOffset, since a tile's
        // blit position is snapY + ty*ts regardless of which page it belongs to.
        st.txMin = Math.floor(-anchorX / ts)
        st.txMax = Math.ceil((dst.width - anchorX) / ts) - 1
        st.tyMin = Math.floor(-anchorY / ts)
        st.tyMax = Math.ceil((dst.height - anchorY) / ts) - 1

        this.writeFrameUniformIfChanged(
            st,
            dst,
            gp.snapX,
            gp.snapY,
            gp.clipL,
            gp.clipT,
            gp.clipR,
            gp.clipB,
            page.fade,
        )

        const wanted = this.wantedTileRange(gp)

        // Bookkeeping only: the blit is one instanced draw below, and the shader clamps each tile
        // to the clip rect. Coverage still asks tileVisible - a missing tile nobody sees is fine.
        let covered = true
        this.forEachTile(wanted, (txi, tyi) => {
            const tkey = key(txi, tyi)
            const tile = st.tiles.get(tkey)
            if (tile) {
                tile.lastUsed = this.frame
            } else {
                if (st.stable) st.pending.add(tkey)
                if (covered && this.tileVisible(gp, dst, txi, tyi)) covered = false
            }
        })

        this.drawInstanced(pass, st, useStencilMask)

        // Drop what fell outside the wanted range, else a page scrolling past keeps accumulating
        // tiles. Only when the range moved - a scroll crosses a tile boundary every tile-size
        // pixels, so most frames skip both walks.
        if (!st.sweptRange?.same(wanted)) {
            st.sweptRange = wanted
            for (const k of [...st.pending]) if (!wanted.holds(k)) st.pending.delete(k)
            for (const [k, t] of [...st.tiles]) {
                if (!wanted.holds(k) && t.lastUsed < this.frame - 1) {
                    this.atlasOrNull?.release(st.tileSize, t.atlasOrigin)
                    st.tiles.delete(k)
                    st.instancesDirty = true
                }
            }
        }

        if (st.pending.size > 0) this.schedule()
        return covered
    }

    /**
     * Blit [st]'s cached tiles as one instanced draw. A frame that only moved the grid uploads
     * nothing - that lives in the uniform.
     */
    private drawInstanced(pass: GPURenderPassEncoder, st: PageTiles, useStencilMask: boolean) {
        if (st.instancesDirty) this.uploadInstances(st)
        const instances = st.instances
        if (!instances) return
        if (st.instanceCount === 0) return

        if (useStencilMask) {
            pass.setPipeline(this.blitPipelineStencilWrite)
            pass.setStencilReference(1)
        } else {
            pass.setPipeline(this.blitPipeline)
        }
        if (!st.bindGroup) st.bindGroup = this.gridBindGroup(st)
        pass.setBindGroup(0, st.bindGroup)
        pass.setVertexBuffer(0, instances)
        pass.draw(6, st.instanceCount)
    }

    /**
     * Blit exactly [keys] - for a caller that just generated tiles into a pass that already drew
     * the rest. Its own buffer, since a destroyed one stays alive until its commands retire.
     */
    private drawTiles(pass: GPURenderPassEncoder, st: PageTiles, keys: number[]) {
        const present = keys
            .map(tkey => [tkey, st.tiles.get(tkey)] as const)
            .filter((e): e is [number, Tile] => e[1] !== undefined)
        if (present.length === 0) return

        const data = new Float32Array(present.length * 4)
        present.forEach(([tkey, tile], i) => {
            tile.lastUsed = this.frame
            data[i * 4] = keyTx(tkey)
            data[i * 4 + 1] = keyTy(tkey)
            data[i * 4 + 2] = unpackX(tile.atlasOrigin)
            data[i * 4 + 3] = unpackY(tile.atlasOrigin)
        })

        const instances = device().createBuffer({
            size: present.length * INSTANCE_BYTES,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
        device().queue.writeBuffer(instances, 0, data)

        pass.setPipeline(this.blitPipeline)
        if (!st.bindGroup) st.bindGroup = this.gridBindGroup(st)
        pass.setBindGroup(0, st.bindGroup)
        pass.setVertexBuffer(0, instances)
        pass.draw(6, present.length)
        instances.destroy()
    }

    /** One bind group per grid: its own uniform, the shared atlas, the shared sampler. */
    private gridBindGroup(st: PageTiles): GPUBindGroup {
        return device().createBindGroup({
            layout: this.blitBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: st.frameUniform } },
                { binding: 1, resource: this.atlas.view },
                { binding: 2, resource: this.blitSampler },
            ],
        })
    }

    /**
     * Rewrite [st]'s instance data - grid coordinate and atlas position per tile. Called from the
     * draw, so a batch landing several tiles uploads once.
     */
    private uploadInstances(st: PageTiles) {
        st.instancesDirty = false
        st.instanceCount = st.tiles.size
        if (st.instanceCount === 0) return

        if (st.instanceCapacity < st.instanceCount) {
            // Rounded up so filling in tile by tile doesn't reallocate on every one.
            const capacity = Math.ceil(st.instanceCount / 64) * 64
            st.instances?.destroy()
            st.instances = device().createBuffer({
                size: capacity * INSTANCE_BYTES,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            })
            st.instanceCapacity = capacity
        }

        const data = new Float32Array(st.instanceCount * 4)
        let i = 0
        for (const [tkey, tile] of st.tiles) {
            data[i * 4] = keyTx(tkey)
            data[i * 4 + 1] = keyTy(tkey)
            data[i * 4 + 2] = unpackX(tile.atlasOrigin)
            data[i * 4 + 3] = unpackY(tile.atlasOrigin)
            i++
        }
        device().queue.writeBuffer(st.instances!, 0, data)
    }

    /**
     * Time one throwaway tile at an unmeasured size, so [reconsiderTileSize] has something to
     * compare. Null when there is nothing to probe - including without timestamp queries, where
     * no size can be measured and [preferredTileSize] stays where it started.
     */
    private probeTileSize(): Promise<void> | null {
        // Nothing to choose between while [reconsiderTileSize] is frozen, and this would measure
        // the wrong thing anyway: it renders the plain way, with no rescaler in the middle.
        if (this.staged) return null
        const queries = this.timestampQuerySet
        if (!queries) return null
        const index = TILE_SIZES.findIndex(
            (size, i) => size !== this.preferredTileSize && this.tileSamples[i] < TILE_SIZE_SAMPLES,
        )
        if (index < 0) return null
        const tileSize = TILE_SIZES[index]

        // The most recently drawn grid: the page on screen is the cost that matters.
        let st: PageTiles | null = null
        for (const candidate of this.pages.values()) {
            if (candidate.stable && !candidate.destroyed && candidate.page.hasUploadedImage) {
                st = candidate
            }
        }
        if (!st) return null

        const pool = this.atlas
        const timing = this.acquireTimestampBuffers()
        const encoder = device().createCommandEncoder()
        const pass = encoder.beginRenderPass(
            this.clearedColorPass(pool.scratchView(tileSize), {
                querySet: queries,
                beginningOfPassWriteIndex: 0,
                endOfPassWriteIndex: 1,
            }),
        )
        try {
            // The grid's anchor tile - the middle of the page, as representative as this gets.
            this.renderTileContent(st, 0, 0, tileSize, pass, pool.scratch(tileSize))
        } finally {
            pass.end()
        }

        encoder.resolveQuerySet(queries, 0, 2, timing.resolve, 0)
        encoder.copyBufferToBuffer(timing.resolve, 0, timing.result, 0, 16)
        device().queue.submit([encoder.finish()])

        return this.measureTileGpuTime(timing, tileSize)
    }

    /**
     * Start the generation worker if it isn't running.
     *
     * The Kotlin runs this on the render thread without the render mutex, so a suspend between
     * batches lets a queued frame through. Here the awaits do that directly: the loop hands the
     * event loop back after every batch, so a pending `requestAnimationFrame` runs before the
     * next one starts. Batch size comes from [nextBatchSize], re-read every batch as the cost
     * measurements accumulate.
     */
    private schedule() {
        if (this.workerActive) return
        if (this.suspended) return
        this.workerActive = true
        launch(async () => {
            try {
                while (true) {
                    if (this.suspended) break
                    const batchSize = this.nextBatchSize()
                    let generated = 0
                    const measurements: Promise<void>[] = []
                    while (generated < batchSize) {
                        const req = this.nextRequest()
                        if (!req) break
                        try {
                            const started = performance.now()
                            const measurement = this.generate(req)
                            if (measurement) {
                                measurements.push(measurement)
                                // Only a tile that really submitted - a no-op would drag the
                                // average toward nothing.
                                this.recordTileOverhead((performance.now() - started) * 1e6)
                            }
                            generated++
                        } catch (e) {
                            console.error("TileRenderer: tile render failed", e)
                        }
                    }
                    if (generated === 0) {
                        // Drained: timing a size we don't use costs nothing here.
                        const probe = this.probeTileSize()
                        if (!probe) break
                        await probe
                        continue
                    }
                    this.invalidate()
                    if (measurements.length > 0) await Promise.all(measurements)
                    else await delay(5)
                    await yieldToEventLoop()
                }
            } finally {
                this.workerActive = false
            }
        })
    }

    /**
     * Pull the highest-priority pending tile: on-screen first, then everything else (prewarmed
     * tiles or a stability-losing grid's leftovers).
     */
    private nextRequest(): Request | null {
        let bestPriority = Number.POSITIVE_INFINITY
        let bestState: PageTiles | null = null
        let bestKey = 0

        const priorityOf = (st: PageTiles, k: number) => {
            const tx = keyTx(k)
            const ty = keyTy(k)
            const centerTx = (st.txMin + st.txMax) * 0.5
            const centerTy = (st.tyMin + st.tyMax) * 0.5
            const outX = Math.max(Math.max(st.txMin - tx, tx - st.txMax), 0)
            const outY = Math.max(Math.max(st.tyMin - ty, ty - st.tyMax), 0)
            const cx = tx - centerTx
            const cy = ty - centerTy
            return Math.max(outX, outY) * OFF_SCREEN_SCORE + cx * cx + cy * cy
        }

        for (const st of this.pages.values()) {
            if (st.pending.size === 0) continue
            if (st.destroyed || !st.stable) {
                st.pending.clear()
                continue
            }
            for (const pkey of st.pending) {
                const priority = priorityOf(st, pkey)
                if (priority < bestPriority) {
                    bestPriority = priority
                    bestState = st
                    bestKey = pkey
                }
            }
        }

        if (!bestState) return null
        bestState.pending.delete(bestKey)
        return { state: bestState, tx: keyTx(bestKey), ty: keyTy(bestKey) }
    }

    /** Generates [req], returning its GPU timing measurement if this tile started one. */
    private generate(req: Request): Promise<void> | null {
        const st = req.state
        if (st.destroyed || !st.stable) return null
        return this.generateTileNow(st, req.tx, req.ty)
    }

    /** Generate [st]'s tile at ([tx], [ty]) right now if it isn't already cached. */
    private generateTileNow(st: PageTiles, tx: number, ty: number): Promise<void> | null {
        // Which way this tile resizes decides which rescaler gets a say.
        const rescaler: Rescaler = st.scale >= 1 ? this._upscaler : this._downscaler
        // First, so a rescaler whose factor varies with the zoom has settled on one.
        rescaler.plan(st.scale, st.tileSize)

        // [Rescaler.appliesAt] keeps a rescaler off a tile with less than a whole run of resizing
        // to give it. What it declines resolves in one step, as always.
        const use =
            rescaler.factor > 1 &&
            rescaler.supported &&
            rescaler.appliesAt(st.scale) &&
            rescaler.fits(st.tileSize)

        // The tile as the first step sees it, plus the rescaler's halo. Resized, that is the tile
        // with factor*halo to spare each side, which [Rescaler.resolve] cuts off.
        const inner = rescaler.firstStepSpan(st.tileSize)
        const size = inner + 2 * rescaler.halo
        // A null here means the rescaler just gave up - fall through rather than lose the tile.
        const source = use ? rescaler.input(size) : null
        const sourceView = rescaler.inputView

        if (!source || !sourceView) {
            return this.generateTile(
                st,
                tx,
                ty,
                false,
                () => { },
                (pass, texture) => this.renderTileContent(st, tx, ty, st.tileSize, pass, texture),
            )
        }

        return this.generateTile(
            st,
            tx,
            ty,
            true,
            (encoder, timestamps) => {
                const pass = encoder.beginRenderPass(this.clearedColorPass(sourceView, timestamps))
                try {
                    this.renderTileContent(
                        st,
                        tx,
                        ty,
                        inner,
                        pass,
                        source,
                        rescaler.firstStepScale(st.scale),
                        rescaler.halo,
                    )
                } finally {
                    pass.end()
                }
                rescaler.encode(encoder, size)
            },
            pass => rescaler.resolve(pass),
        )
    }

    /**
     * Render a page's tile, drawing every one of its images into the same pass so a tile
     * straddling their seam comes out with both already in place.
     *
     * Positions each image via [solveImagePlacement], the same inversion of
     * `Image.prepareForRender`'s placement the fast path already uses. The target passed in is
     * this image's ordinary full-frame placement minus the tile's own origin, so solving against
     * a tile-square destination places exactly the crop this tile is responsible for.
     */
    private renderTileContent(
        st: PageTiles,
        tx: number,
        ty: number,
        tileSize: number,
        pass: GPURenderPassEncoder,
        texture: GPUTexture,
        scale: number = st.scale,
        inset = 0,
    ) {
        // [tileSize] is in this destination's pixels, so it already carries [scale];
        // [centerYOffset] is in the grid's and has to be brought across. [inset] widens the
        // destination without moving the tile within it.
        const ts = tileSize
        const s = scale
        const centerY = st.centerYOffset * (scale / st.scale)
        const dst = ts + 2 * inset
        const filtered = this.filtered()
        st.page.forEachImage((image, srcOffsetX) => {
            if (image.mipmaps.length > 0) {
                // In raw (unscaled) pixels since solveImagePlacement scales by s itself.
                const targetX = -tx * ts + inset + s * (srcOffsetX + image.x)
                const targetY = centerY - ty * ts + inset + s * image.y
                const [x, y] = solveImagePlacement(targetX, targetY, s, image, dst, dst)
                RenderPage.render(pass, image, texture, x, y, s, filtered)
            }
        })
    }

    /**
     * Shared setup for [renderFullyTiled]/[blitAvailableTiles]: draws whatever's cached into
     * [dst] and queues anything missing, returning the grid's state - or null if [page] has no
     * drawable images.
     */
    private drawGridForFullPage(
        pass: GPURenderPassEncoder,
        page: ImageSingle,
        dst: GPUTexture,
    ): PageTiles | null {
        if (page.destroyed || !page.highQuality || page.isAnimated) return null
        if (!page.hasUploadedImage) return null

        const a = this.pagedAnchor(page, dst, 0, 0, 1)
        this.drawCore(pass, page, dst, a.anchorX, a.anchorY, 0, a.pageScale, false, false)

        const st = this.pages.get(page)
        if (!st) return null

        // A scale (or centerYOffset) change wipes the grid and marks it unstable within that same
        // drawCore call - which also means its want/pending pass ran before stability was
        // granted, so nothing got queued. drawCore's two-call gate exists to avoid re-wiping
        // every frame while a gesture actively drives scale, but this caller has no next call to
        // benefit from that - it must finish now regardless. Re-running once more (same
        // anchor/scale, so no further wipe) grants stability immediately.
        if (!st.stable) {
            this.drawCore(pass, page, dst, a.anchorX, a.anchorY, 0, a.pageScale, false, false)
        }

        return st
    }

    /**
     * Render [page]'s full tile grid into [dst], generating any tile the worker hasn't reached
     * yet right here rather than leaving it queued - for callers that can't show less than fully
     * complete. [blitAvailableTiles] is the partial/progressive counterpart.
     */
    renderFullyTiled(pass: GPURenderPassEncoder, page: ImageSingle, dst: GPUTexture): boolean {
        const st = this.drawGridForFullPage(pass, page, dst)
        if (!st) return false
        if (st.pending.size === 0) return true

        const toGenerate = [...st.pending]
        st.pending.clear()
        toGenerate.forEach(tkey => this.generateTileNow(st, keyTx(tkey), keyTy(tkey)))

        // Only what just landed: premultiplied-over, so drawing a tile twice differs from once.
        this.drawTiles(pass, st, toGenerate)
        return true
    }

    /**
     * Blit whatever's already cached into [dst], queuing anything missing for the background
     * worker rather than force-generating it.
     */
    blitAvailableTiles(pass: GPURenderPassEncoder, page: ImageSingle, dst: GPUTexture): boolean {
        return this.drawGridForFullPage(pass, page, dst) !== null
    }

    /**
     * Render one tile at ([tx], [ty]) into [st] via [render], then store it. Returns the GPU
     * timing measurement's promise where timestamp queries exist.
     */
    private generateTile(
        st: PageTiles,
        tx: number,
        ty: number,
        staged: boolean,
        prepare: (
            encoder: GPUCommandEncoder,
            timestamps: GPURenderPassTimestampWrites | undefined,
        ) => void,
        render: (pass: GPURenderPassEncoder, texture: GPUTexture) => void,
    ): Promise<void> | null {
        const k = key(tx, ty)
        if (st.tiles.has(k)) return null
        this.evict()

        const pool = this.atlas
        // Slabs belong to one size at a time, so a just-changed size can find them all spoken for
        // while the budget says there is room - free a grid and try once more.
        let origin = pool.acquire(st.tileSize)
        if (origin < 0) {
            this.freeColdestGrid(st)
            origin = pool.acquire(st.tileSize)
        }
        // Still nothing - the worker comes back to this tile.
        if (origin < 0) return null

        const queries = this.timestampQuerySet
        if (!queries) {
            const encoder = device().createCommandEncoder()
            // Before the pass opens: a compute pass cannot nest inside a render pass.
            prepare(encoder, undefined)
            const pass = encoder.beginRenderPass(
                this.clearedColorPass(pool.scratchView(st.tileSize)),
            )
            try {
                render(pass, pool.scratch(st.tileSize))
            } finally {
                pass.end()
            }
            pool.copyScratchInto(encoder, origin, st.tileSize)
            device().queue.submit([encoder.finish()])
            const tile = new Tile(origin)
            tile.lastUsed = this.frame
            st.tiles.set(k, tile)
            st.instancesDirty = true
            return null
        }

        const timing = this.acquireTimestampBuffers()
        const encoder = device().createCommandEncoder()

        // A rescaler's passes run before this one and would otherwise go unmeasured - which
        // matters, since [nextBatchSize] divides a frame's budget by this number and would queue
        // eight of a tile that reads as free. So a staged tile puts the opening timestamp on
        // whatever pass [prepare] opens first, leaving only the closing one here; the GPU runs
        // everything between the two. An omitted index is WebGPU's "no write", the JS spelling of
        // the sentinel the Kotlin passes.
        //
        // Per tile, not per renderer: a rescaler declines any tile below its [Rescaler.factor],
        // and those have no first pass to carry the opening write. Getting that wrong leaves query
        // 0 unwritten and the elapsed time read off stale memory.
        if (staged) prepare(encoder, { querySet: queries, beginningOfPassWriteIndex: 0 })
        else prepare(encoder, undefined)

        const pass = encoder.beginRenderPass(
            this.clearedColorPass(pool.scratchView(st.tileSize), {
                querySet: queries,
                ...(staged ? {} : { beginningOfPassWriteIndex: 0 }),
                endOfPassWriteIndex: 1,
            }),
        )
        try {
            render(pass, pool.scratch(st.tileSize))
        } finally {
            pass.end()
        }

        pool.copyScratchInto(encoder, origin, st.tileSize)
        encoder.resolveQuerySet(queries, 0, 2, timing.resolve, 0)
        encoder.copyBufferToBuffer(timing.resolve, 0, timing.result, 0, 16)

        device().queue.submit([encoder.finish()])
        const tile = new Tile(origin)
        tile.lastUsed = this.frame
        st.tiles.set(k, tile)
        st.instancesDirty = true

        return this.measureTileGpuTime(timing, st.tileSize)
    }

    private async measureTileGpuTime(
        timing: { resolve: GPUBuffer; result: GPUBuffer },
        tileSize: number,
    ) {
        const result = timing.result
        try {
            // The Kotlin has to pump the instance's event queue while waiting; the browser drives
            // its own, so mapAsync's promise is enough.
            await result.mapAsync(GPUMapMode.READ, 0, 16)
        } catch (e) {
            // Still in flight, possibly - not safe to hand back.
            timing.resolve.destroy()
            result.destroy()
            throw e
        }
        const timestamps = new BigInt64Array(result.getMappedRange(0, 16).slice(0))
        result.unmap()
        this.releaseTimestampBuffers(timing)
        const start = timestamps[0]
        const end = timestamps[1]
        if (end > start) this.recordTileCost(tileSize, Number(end - start))
    }

    private clearedColorPass(
        view: GPUTextureView,
        timestampWrites?: GPURenderPassTimestampWrites,
    ): GPURenderPassDescriptor {
        return {
            colorAttachments: [
                { view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } },
            ],
            ...(timestampWrites ? { timestampWrites } : {}),
        }
    }

    /**
     * Write [st]'s frame uniform - snapped anchor, [dst]'s size, and a clip rect - if any of them
     * actually changed since the last write.
     */
    private writeFrameUniformIfChanged(
        st: PageTiles,
        dst: GPUTexture,
        snapX: number,
        snapY: number,
        clipL: number,
        clipT: number,
        clipR: number,
        clipB: number,
        alpha: number,
    ) {
        const dstW = dst.width
        const dstH = dst.height
        const ts = st.tileSize
        if (
            st.writtenSnapX === snapX &&
            st.writtenSnapY === snapY &&
            st.writtenDstW === dstW &&
            st.writtenDstH === dstH &&
            st.writtenClipL === clipL &&
            st.writtenClipT === clipT &&
            st.writtenClipR === clipR &&
            st.writtenClipB === clipB &&
            st.writtenTs === ts &&
            st.writtenAlpha === alpha
        ) {
            return
        }

        // Byte layout the shader declares: snap and dst_size as vec2s, clip as a vec4 (hence at
        // offset 16), then the three scalars.
        this.frameScratch.set([
            snapX,
            snapY,
            dstW,
            dstH,
            clipL,
            clipT,
            clipR,
            clipB,
            ts,
            this.atlas.side,
            alpha,
        ])
        device().queue.writeBuffer(st.frameUniform, 0, this.frameScratch)
        st.writtenSnapX = snapX
        st.writtenSnapY = snapY
        st.writtenDstW = dstW
        st.writtenDstH = dstH
        st.writtenClipL = clipL
        st.writtenClipT = clipT
        st.writtenClipR = clipR
        st.writtenClipB = clipB
        st.writtenTs = ts
        st.writtenAlpha = alpha
    }

    /** What the budgeted tiles come to - the area every tile size is held to, whatever its own. */
    private get maxTileBytes(): number {
        return (this.atlasOrNull ? this.atlasBudgetTiles : this.budgetTiles()) * TILE_BYTES
    }

    private tileBytes(st: PageTiles): number {
        return st.tileSize * st.tileSize * 4
    }

    /**
     * Evict least-recently-used tiles down to [maxTileBytes], best-effort.
     *
     * Tiles used this frame or last are never touched: a freed slot is handed straight back out,
     * and rewriting one a recorded pass reads would draw the wrong content. If everything is that
     * fresh the cap overshoots, bounded like the wanted set by the viewport.
     */
    private evict() {
        let total = 0
        for (const st of this.pages.values()) total += st.tiles.size * this.tileBytes(st)
        if (total < this.maxTileBytes) return

        const candidates: [PageTiles, number, Tile][] = []
        for (const st of this.pages.values()) {
            for (const [k, t] of st.tiles) {
                if (t.lastUsed < this.frame - 1) candidates.push([st, k, t])
            }
        }
        candidates.sort((a, b) => a[2].lastUsed - b[2].lastUsed)
        let i = 0
        while (total >= this.maxTileBytes && i < candidates.length) {
            const [st, k, t] = candidates[i]
            st.tiles.delete(k)
            st.instancesDirty = true
            this.atlasOrNull?.release(st.tileSize, t.atlasOrigin)
            total -= this.tileBytes(st)
            i++
        }
    }

    /**
     * Free every tile. Not a permanent shutdown - the surface can be recreated with the same
     * viewer state afterward, and rendering simply refills the cache.
     */
    cleanup() {
        // A rescaler's textures can be mid-tile when the view is torn down.
        this._upscaler.cleanup()
        this._downscaler.cleanup()
        this.pages.forEach(st => st.destroyAll(this.atlasOrNull))
        this.pages.clear()
        this.atlasOrNull?.destroy()
        this.atlasOrNull = null
        this.timestampPool.forEach(t => {
            t.resolve.destroy()
            t.result.destroy()
        })
        this.timestampPool.length = 0
        this.stencilTextures.forEach(t => t?.destroy())
        this.stencilTextures.fill(null)
        this.stencilViews.fill(null)
        this.stencilWidth = 0
        this.stencilHeight = 0
    }
}

const BLIT_SHADER = `
struct FrameParams {
    // Snapped screen-pixel position of the grid's centre; the tile grid hangs off it.
    snap: vec2<f32>,
    dst_size: vec2<f32>,
    // The grid's rect in screen pixels that blits are clipped to - see the class doc.
    clip: vec4<f32>,
    // This grid's tile size and the atlas's - per grid, so neither can be a constant.
    ts: f32,
    atlas_size: f32,
    // Page-wide opacity, so a fading page's tiles fade with the rest of it.
    alpha: f32,
}

@group(0) @binding(0) var<uniform> frame_params: FrameParams;
@group(0) @binding(1) var src_tex: texture_2d<f32>;
@group(0) @binding(2) var src_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

// Per instance: grid coordinate, then position in the atlas.
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32, @location(0) tile: vec4<f32>) -> VertexOutput {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), // Top-left
        vec2<f32>(0.0, 1.0), // Bottom-left
        vec2<f32>(1.0, 0.0), // Top-right
        vec2<f32>(1.0, 0.0), // Top-right
        vec2<f32>(0.0, 1.0), // Bottom-left
        vec2<f32>(1.0, 1.0)  // Bottom-right
    );

    let pos = corners[vertex_index];
    let ts = frame_params.ts;

    // Clamping the corners to the clip rect shrinks the quad and its uv window in step, so
    // whatever survives is still a 1:1 texel copy. Offscreen overhang is left to NDC clipping.
    let origin = frame_params.snap + tile.xy * ts;
    let p = clamp(origin + pos * ts, frame_params.clip.xy, frame_params.clip.zw);

    var out: VertexOutput;
    out.position = vec4<f32>(
        p.x / frame_params.dst_size.x * 2.0 - 1.0,
        1.0 - p.y / frame_params.dst_size.y * 2.0,
        0.0, 1.0
    );
    // Into the atlas: this tile's slot plus whatever of the tile survived the clamp.
    out.uv = (tile.zw + (p - origin)) / frame_params.atlas_size;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // 1:1 at integer positions with a nearest sampler: an exact copy of the tile's texels,
    // already premultiplied by RenderPage - so the fade is a plain scale of the whole vec4.
    return textureSample(src_tex, src_sampler, in.uv) * frame_params.alpha;
}
`
