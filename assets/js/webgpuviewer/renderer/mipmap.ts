import { FrameBudget, yieldToEventLoop } from "../util"
import { WebGpuRenderer } from "./renderer"

/**
 * One mip level, cut into square tiles - the port of `renderer/Mipmap.kt`.
 *
 * A page can be far larger than `maxTextureDimension2D`, so a level is never one texture: it is a
 * [tilesCols] x [tilesRows] grid of at most [tilesize] each. [getQuad] answers the fixed 2x2
 * window the filtered shader binds; [tilesInRect] answers everything a viewport overlaps, for the
 * fast path that draws each tile in its own call.
 */
export class Mipmap {
    private textures: GPUTexture[] = []
    private textureViews: GPUTextureView[] = []
    private tiles: GPUTexture[] = []
    private tileViews: GPUTextureView[] = []

    private cachedQuad: Quad | null = null

    private constructor(
        readonly width: number,
        readonly height: number,
        readonly scale: number,
        readonly tilesCols: number,
        readonly tilesRows: number,
        readonly tilesize: number,
    ) { }

    private static get device(): GPUDevice {
        return WebGpuRenderer.device
    }

    // --- Tile texture pool ----------------------------------------------------------------
    //
    // A page allocates a tile texture per level and destroys it on eviction - two ~12MB allocations
    // per page, for as long as someone keeps reading, and pages are nearly always the same shape.
    //
    // Reuse is as safe as allocating: a tile is fully overwritten before its image is reachable from
    // any page, exactly as a fresh texture is. Only stale rather than blank pixels sit in it during
    // the upload, and nothing samples it until then.

    private static readonly pool = new Map<string, GPUTexture[]>()
    private static pooledBytes = 0

    // By bytes, not count: a tile runs from thumbnail to 16MB, so a count either hoards hundreds of
    // megabytes of GPU memory or cannot hold one page.
    private static readonly POOL_MAX_BYTES = 64 * 1024 * 1024

    private static poolKey(width: number, height: number): string {
        return `${width}x${height}`
    }

    private static takeTexture(width: number, height: number): GPUTexture {
        const key = Mipmap.poolKey(width, height)
        const waiting = Mipmap.pool.get(key)
        const reused = waiting?.pop()
        if (reused) {
            Mipmap.pooledBytes -= width * height * 4
            // No empty bucket per shape the reader passed through.
            if (waiting!.length === 0) Mipmap.pool.delete(key)
            return reused
        }
        return Mipmap.device.createTexture({
            size: { width, height },
            format: "rgba8unorm",
            usage:
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_DST |
                GPUTextureUsage.RENDER_ATTACHMENT,
        })
    }

    /** Keep [texture] for the next page of the same shape, or destroy it if the pool is full. */
    private static giveTexture(texture: GPUTexture) {
        const bytes = texture.width * texture.height * 4
        if (Mipmap.pooledBytes + bytes > Mipmap.POOL_MAX_BYTES) {
            texture.destroy()
            return
        }
        const key = Mipmap.poolKey(texture.width, texture.height)
        let waiting = Mipmap.pool.get(key)
        if (!waiting) {
            waiting = []
            Mipmap.pool.set(key, waiting)
        }
        waiting.push(texture)
        Mipmap.pooledBytes += bytes
    }

    /**
     * Drop every pooled texture, for a viewer torn down or a device replaced. Otherwise the pool
     * outlives the viewer that filled it, and a lost device's texture reaches its replacement.
     */
    static clearPool() {
        for (const waiting of Mipmap.pool.values()) waiting.forEach(t => t.destroy())
        Mipmap.pool.clear()
        Mipmap.pooledBytes = 0
    }

    /**
     * Build a level from [pixels] (RGBA8, tightly packed) and upload it.
     *
     * Yields between chunks, so it must run outside the render lock ([WebGpuRenderer.unlocked])
     * for those yields to be worth anything. Returned only once every chunk has landed, so no caller
     * can sample a half-filled texture.
     */
    static async create(
        pixels: Uint8Array,
        width: number,
        height: number,
        scale: number,
        tilesize: number,
    ): Promise<Mipmap> {
        const mipmap = new Mipmap(
            width,
            height,
            scale,
            Math.ceil(width / tilesize),
            Math.ceil(height / tilesize),
            tilesize,
        )
        try {
            await mipmap.upload(pixels)
        } catch (e) {
            // Yielding makes the upload interruptible, so a half-built level can exist. Free what
            // landed before rethrowing: the caller never sees this instance.
            mipmap.cleanup()
            throw e
        }
        return mipmap
    }

    /**
     * Build a level from an already-decoded [source] and upload it, tile by tile.
     *
     * Why it exists: `Mipmap.create`'s `writeTexture` wants a CPU array, which means
     * `getImageData` on the way in - tens of megabytes per page on the only thread there is.
     * `copyExternalImageToTexture` takes the decoded image directly and crops it itself, so the
     * pixels never touch JS.
     *
     * Yields between tiles, like [create], so it must run outside the render lock.
     */
    static async createFromSource(
        source: ImageBitmap,
        width: number,
        height: number,
        scale: number,
        tilesize: number,
    ): Promise<Mipmap> {
        const mipmap = new Mipmap(
            width,
            height,
            scale,
            Math.ceil(width / tilesize),
            Math.ceil(height / tilesize),
            tilesize,
        )
        try {
            await mipmap.uploadFrom(source)
        } catch (e) {
            mipmap.cleanup()
            throw e
        }
        return mipmap
    }

    /**
     * As [upload], copying each tile straight out of [source].
     *
     * One call per tile. `origin` and `size` do slice both sides, so this can be cut into strips -
     * it was, at 128KB apiece, leaving the worst frame interval unchanged at 83ms and page latency a
     * hundredfold worse. Upload volume is not what delays presentation, so the copy stays whole and
     * [WebGpuRenderer.pacedUpload] schedules *when* instead.
     */
    private async uploadFrom(source: ImageBitmap) {
        const device = Mipmap.device

        for (let r = 0; r < this.tilesRows; r++) {
            const tileHeight = Math.min((r + 1) * this.tilesize, this.height) - r * this.tilesize
            const y = r * this.tilesize
            for (let c = 0; c < this.tilesCols; c++) {
                const x = c * this.tilesize
                const tileWidth = Math.min((c + 1) * this.tilesize, this.width) - c * this.tilesize

                const texture = Mipmap.takeTexture(tileWidth, tileHeight)

                await WebGpuRenderer.pacedUpload(() =>
                    device.queue.copyExternalImageToTexture(
                        { source, origin: { x, y } },
                        { texture },
                        { width: tileWidth, height: tileHeight },
                    ),
                )

                this.textures.push(texture)
                this.textureViews.push(texture.createView())
            }
        }

        this.buildQuadSlots()
    }

    /** A level wrapping an already-uploaded texture - one tile, no grid. */
    static fromTexture(texture: GPUTexture, scale: number, tilesize: number): Mipmap {
        const mipmap = new Mipmap(texture.width, texture.height, scale, 1, 1, tilesize)
        mipmap.adoptSingle(texture)
        return mipmap
    }

    /** An empty, writable level - what a `Render` page draws into. */
    static blank(width: number, height: number): Mipmap {
        const mipmap = new Mipmap(width, height, 1, 1, 1, 4096)
        mipmap.adoptSingle(
            Mipmap.device.createTexture({
                size: { width, height },
                format: "rgba8unorm",
                usage:
                    GPUTextureUsage.TEXTURE_BINDING |
                    GPUTextureUsage.COPY_DST |
                    GPUTextureUsage.RENDER_ATTACHMENT |
                    GPUTextureUsage.STORAGE_BINDING,
            }),
        )
        return mipmap
    }

    private adoptSingle(texture: GPUTexture) {
        this.textures.push(texture)
        const view = texture.createView()
        this.textureViews.push(view)
        for (let i = 0; i < 4; i++) {
            this.tiles.push(texture)
            this.tileViews.push(view)
        }
        this.cachedQuad = new Quad(this.tiles, this.tileViews, 0, 0)
    }

    /**
     * Rough size of one `writeTexture` call. Unlike the bitmap path this is bounded by this thread -
     * a 2000x3000 page in one call is ~24MB of memcpy - so: big enough that per-call overhead is
     * noise, small enough to fit a frame.
     */
    private static readonly UPLOAD_CHUNK_BYTES = 1 << 20

    /** Allocate the tile textures and copy [pixels] into them a chunk at a time. */
    private async upload(pixels: Uint8Array) {
        const device = Mipmap.device
        const rowsPerChunk = Math.max(1, Math.floor(Mipmap.UPLOAD_CHUNK_BYTES / (this.width * 4)))
        const budget = new FrameBudget()

        for (let r = 0; r < this.tilesRows; r++) {
            const tileHeight = Math.min((r + 1) * this.tilesize, this.height) - r * this.tilesize
            const y = r * this.tilesize
            for (let c = 0; c < this.tilesCols; c++) {
                const x = c * this.tilesize
                const tileWidth = Math.min((c + 1) * this.tilesize, this.width) - c * this.tilesize

                // An allocation cannot be divided, so it gets its own turn rather than landing
                // on the back of the chunk just uploaded.
                await yieldToEventLoop()
                const texture = Mipmap.takeTexture(tileWidth, tileHeight)

                let row = 0
                while (row < tileHeight) {
                    const rows = Math.min(rowsPerChunk, tileHeight - row)

                    device.queue.writeTexture(
                        { texture, origin: { x: 0, y: row } },
                        pixels,
                        {
                            offset: ((y + row) * this.width + x) * 4,
                            bytesPerRow: this.width * 4,
                            rowsPerImage: this.height,
                        },
                        { width: tileWidth, height: rows },
                    )

                    row += rows
                    await budget.next()
                }

                this.textures.push(texture)
                this.textureViews.push(texture.createView())
            }
        }

        this.buildQuadSlots()
    }

    /**
     * Seed the fixed 2x2 window, cached outright when the level fits in one: such a grid has only
     * one possible window, so [getQuad] never picks.
     */
    private buildQuadSlots() {
        for (let r = 0; r < 2; r++) {
            const row = Math.min(r, this.tilesRows - 1) * this.tilesCols
            for (let c = 0; c < 2; c++) {
                const i = row + Math.min(c, this.tilesCols - 1)
                this.tiles.push(this.textures[i])
                this.tileViews.push(this.textureViews[i])
            }
        }

        if (this.tilesCols <= 2 && this.tilesRows <= 2) {
            this.cachedQuad = new Quad(this.tiles, this.tileViews, 0, 0)
        }
    }

    cleanup() {
        this.cachedQuad = null
        this.lastQuad = null
        this.lastQuadTX = -1
        this.lastQuadTY = -1
        this.tileUniforms?.forEach(b => b?.destroy())
        this.tileUniforms = null
        this.textureViews.length = 0
        this.tileViews.length = 0
        this.textures.forEach(t => Mipmap.giveTexture(t))
        this.textures.length = 0
        this.tiles.length = 0
    }

    /** Rewrite every tile from [pixels] - for a level whose content changes in place. */
    update(pixels: Uint8Array) {
        const device = Mipmap.device
        let i = 0

        for (let r = 0; r < this.tilesRows; r++) {
            const tileHeight = Math.min((r + 1) * this.tilesize, this.height) - r * this.tilesize
            const y = r * this.tilesize
            for (let c = 0; c < this.tilesCols; c++) {
                const x = c * this.tilesize
                const tileWidth = Math.min((c + 1) * this.tilesize, this.width) - c * this.tilesize

                device.queue.writeTexture(
                    { texture: this.textures[i++] },
                    pixels,
                    {
                        offset: (y * this.width + x) * 4,
                        bytesPerRow: this.width * 4,
                        rowsPerImage: this.height,
                    },
                    { width: tileWidth, height: tileHeight },
                )
            }
        }
    }

    /**
     * One small uniform buffer per physical tile, created on first use and rewritten every frame it
     * is drawn. Never shared: `writeBuffer` calls all land before any later command buffer executes,
     * so one buffer would let the last tile drawn in a frame win for all of them.
     */
    private tileUniforms: (GPUBuffer | null)[] | null = null

    private tileUniformFor(index: number): GPUBuffer {
        let arr = this.tileUniforms
        if (!arr) {
            arr = new Array(this.textures.length).fill(null)
            this.tileUniforms = arr
        }
        let buffer = arr[index]
        if (!buffer) {
            buffer = Mipmap.device.createBuffer({
                size: 32,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            })
            arr[index] = buffer
        }
        return buffer
    }

    /**
     * Every tile overlapping [left]..[right] by [top]..[bottom], in mipmap pixels. Unlike [getQuad],
     * which always hands back exactly 2x2, this lets a caller draw tiles separately.
     */
    tilesInRect(left: number, top: number, right: number, bottom: number): TileRect[] {
        const l = Math.max(0, Math.min(left, this.width))
        const t = Math.max(0, Math.min(top, this.height))
        const r = Math.max(0, Math.min(right, this.width))
        const b = Math.max(0, Math.min(bottom, this.height))
        if (l >= r || t >= b) return []

        const clampCol = (v: number) => Math.max(0, Math.min(v, this.tilesCols - 1))
        const clampRow = (v: number) => Math.max(0, Math.min(v, this.tilesRows - 1))

        const c0 = clampCol(Math.trunc(l / this.tilesize))
        const c1 = clampCol(Math.trunc((r - 1) / this.tilesize))
        const row0 = clampRow(Math.trunc(t / this.tilesize))
        const row1 = clampRow(Math.trunc((b - 1) / this.tilesize))

        const result: TileRect[] = []
        for (let row = row0; row <= row1; row++) {
            for (let col = c0; col <= c1; col++) {
                const idx = row * this.tilesCols + col
                result.push({
                    texture: this.textures[idx],
                    view: this.textureViews[idx],
                    x: col * this.tilesize,
                    y: row * this.tilesize,
                    uniform: this.tileUniformFor(idx),
                })
            }
        }
        return result
    }

    // Cached, so panning within one tile region allocates nothing.
    private lastQuadTX = -1
    private lastQuadTY = -1
    private lastQuad: Quad | null = null

    /** The 2x2 window centred on ([centerX], [centerY]) in this level's pixels. */
    getQuad(centerX: number, centerY: number): Quad {
        if (this.cachedQuad) return this.cachedQuad

        const cX = centerX
        const cY = centerY

        const c = Math.trunc(cX / this.tilesize)
        let tX: number
        if (c >= this.tilesCols - 1) {
            tX = this.tilesCols - 2
        } else if (c <= 0) {
            tX = 0
        } else {
            const xCenterRight =
                c + 1 === this.tilesCols - 1 ?
                    ((this.tilesCols - 1) * this.tilesize + this.width) * 0.5
                    : (c + 1.5) * this.tilesize
            tX = cX - (c - 0.5) * this.tilesize < xCenterRight - cX ? c - 1 : c
        }
        tX = Math.max(0, Math.min(tX, this.tilesCols - 1))

        const r = Math.trunc(cY / this.tilesize)
        let tY: number
        if (r >= this.tilesRows - 1) {
            tY = this.tilesRows - 2
        } else if (r <= 0) {
            tY = 0
        } else {
            const yCenterBottom =
                r + 1 === this.tilesRows - 1 ?
                    ((this.tilesRows - 1) * this.tilesize + this.height) * 0.5
                    : (r + 1.5) * this.tilesize
            tY = cY - (r - 0.5) * this.tilesize < yCenterBottom - cY ? r - 1 : r
        }
        tY = Math.max(0, Math.min(tY, this.tilesRows - 1))

        if (this.lastQuad && this.lastQuadTX === tX && this.lastQuadTY === tY) return this.lastQuad

        const r0 = Math.min(tY, this.tilesRows - 1) * this.tilesCols
        const r1 = Math.min(tY + 1, this.tilesRows - 1) * this.tilesCols
        const c0 = Math.min(tX, this.tilesCols - 1)
        const c1 = Math.min(tX + 1, this.tilesCols - 1)

        const t00 = this.textures[r0 + c0]
        const quad = new Quad(
            [this.textures[r0 + c0], this.textures[r0 + c1], this.textures[r1 + c0], this.textures[r1 + c1]],
            [
                this.textureViews[r0 + c0],
                this.textureViews[r0 + c1],
                this.textureViews[r1 + c0],
                this.textureViews[r1 + c1],
            ],
            tX * t00.width,
            tY * t00.height,
        )
        this.lastQuadTX = tX
        this.lastQuadTY = tY
        this.lastQuad = quad
        return quad
    }
}

export class Quad {
    constructor(
        readonly tiles: GPUTexture[],
        readonly tileViews: GPUTextureView[],
        readonly x: number,
        readonly y: number,
    ) { }
}

/**
 * One tile overlapping a queried rect, at its pixel offset in the mipmap. [uniform] is its own
 * persistent placement buffer - see [Mipmap.tileUniformFor].
 */
export interface TileRect {
    texture: GPUTexture
    view: GPUTextureView
    x: number
    y: number
    uniform: GPUBuffer
}

// Pooled textures belong to the device that made them.
WebGpuRenderer.onDeviceLost(() => Mipmap.clearPool())
