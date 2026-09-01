import { Rect, argb } from "../util"
import { decodeToPixels, resize } from "../imageutil"
import { detectBackgroundCpu, findAllCpu } from "../trim"
import { DecodedImage, closeLevels } from "../decoder"
import { Mipmap, Quad } from "./mipmap"
import { WebGpuRenderer } from "./renderer"

export const BUFFER_SIZE = 96

/**
 * Side of one mip-level tile, in source pixels.
 *
 * Distinct from `TileRenderer`'s own `TILE_SIZE`, which is a *screen*-space tile in the sharp-tile
 * cache. This one bounds how large a single texture gets.
 *
 * Kept at the Kotlin's 2048. It was briefly halved on the theory that a 16MB `createTexture` was
 * an unsplittable multi-frame block - profiling says otherwise: allocation measures 0.04ms at the
 * worst, because the driver defers the real allocation until first use. With that premise gone
 * there is no reason to deviate, and 2048 means fewer textures and fewer per-frame draw calls in
 * `prepareTilesForRender`.
 */
export const MIPMAP_TILE_SIZE = 2048

export interface ImageOptions {
    createMipMaps?: boolean
    /** `[r, g, b]` triples in 0..1. Trim is skipped entirely when absent or empty. */
    trimColors?: number[][] | null
    trimThreshold?: number
    /** Overrides both trim's inference and the edge probe. */
    backgroundColor?: number | null
}

/**
 * A decoded page image and its mip pyramid - the port of `renderer/Image.kt`.
 *
 * Placement lives here rather than in the shader wrapper: [placement] answers where the image
 * lands for callers that only want geometry, [prepareForRender] resolves a mip level and one 2x2
 * window for the filtered path, and [prepareTilesForRender] resolves every tile the viewport
 * overlaps for the fast path.
 */
export class Image {
    x = 0
    y = 0

    backgroundColor: number = 0xffffffff | 0

    /** Trim bounds detected from image content, or null if not trimmed. */
    trim: Rect | null = null

    readonly mipmaps: Mipmap[] = []

    private _buffer: GPUBuffer | null

    private constructor(
        readonly width: number,
        readonly height: number,
    ) {
        this._buffer = WebGpuRenderer.device.createBuffer({
            size: BUFFER_SIZE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
        })
    }

    get buffer(): GPUBuffer {
        if (!this._buffer) throw new Error("Image buffer accessed after cleanup")
        return this._buffer
    }

    /**
     * Build an [Image] from an already-decoded [bitmap], without the pixels ever entering JS.
     *
     * **This is the path to prefer on the web**, and it is a real departure from the Kotlin.
     *
     * The Kotlin builds its mip pyramid with a CPU box filter (`ImageUtil.resize`) and uploads
     * through `writeTexture`. It can: that filter is NEON-optimised C++ on a background thread. The
     * TypeScript equivalent measures 75-175ms of *blocking* work per page, plus a `getImageData`
     * copy of tens of megabytes to get the pixels in the first place - and it lands exactly on a
     * page turn, which is a dozen dropped frames.
     *
     * The browser already has both operations natively and off the main thread, so this uses them:
     * `createImageBitmap`'s resize for each level, and `copyExternalImageToTexture` to upload. No
     * JS pixel loop, no readback.
     *
     * Trim and background detection still need the pixels, so [decodeToPixels] runs only when one
     * of them is actually asked for.
     */
    static async fromBitmap(bitmap: ImageBitmap, options: ImageOptions = {}): Promise<Image> {
        const { width, height } = bitmap
        if (width <= 0 || height <= 0) throw new Error("Image dimensions must be positive")

        const {
            createMipMaps = true,
            trimColors = null,
            trimThreshold = 0.05,
            backgroundColor = null,
        } = options

        const image = new Image(width, height)

        // The one case that still wants CPU pixels. Skipped entirely otherwise, which is what
        // keeps the default path off the main thread.
        const needsPixels =
            (trimColors !== null && trimColors.length > 0) || backgroundColor === null
        if (needsPixels) {
            image.analyse(
                decodeToPixels(bitmap, width, height),
                width,
                height,
                trimColors,
                trimThreshold,
                backgroundColor,
            )
        } else {
            image.backgroundColor = backgroundColor
        }

        // Each level is resized from the original rather than from the level above: one
        // off-thread call apiece, and no accumulated resampling error down the chain.
        const levels: { source: ImageBitmap; w: number; h: number; scale: number; own: boolean }[] =
            [{ source: bitmap, w: width, h: height, scale: 1, own: false }]

        if (createMipMaps) {
            let scale = 1
            while (width * scale > MIPMAP_TILE_SIZE || height * scale > MIPMAP_TILE_SIZE) {
                scale /= 2
                const w = Math.floor(width * scale)
                const h = Math.floor(height * scale)
                if (w <= 0 || h <= 0) break
                levels.push({
                    source: await createImageBitmap(bitmap, {
                        resizeWidth: w,
                        resizeHeight: h,
                        resizeQuality: "high",
                    }),
                    w,
                    h,
                    scale,
                    own: true,
                })
            }
        }

        // No render lock: Mipmap.createFromSource yields between tiles so queued frames get the
        // thread back. Safe since the image isn't reachable from any page yet.
        await WebGpuRenderer.unlocked(async () => {
            try {
                for (const level of levels) {
                    image.mipmaps.push(
                        await Mipmap.createFromSource(
                            level.source,
                            level.w,
                            level.h,
                            level.scale,
                            MIPMAP_TILE_SIZE,
                        ),
                    )
                }
            } catch (e) {
                console.error("Renderer: error creating image", e)
                image.mipmaps.forEach(m => m.cleanup())
                image.mipmaps.length = 0
                throw e
            } finally {
                // The originals belong to the caller; the resized levels are ours.
                levels.forEach(level => {
                    if (level.own) level.source.close()
                })
            }
        })

        return image
    }

    /**
     * Build an [Image] from what the decode worker produced - the fast path.
     *
     * The worker did the decoding and resizing; this only uploads. Levels arrive as transferred
     * pixel buffers, so the upload is [Mipmap.create]'s chunked `writeTexture` - see `decoder.ts`
     * for why bytes rather than an `ImageBitmap`.
     *
     * [backgroundColor] comes from the caller: inferring it means walking the pixels, the work the
     * worker exists to avoid. Trim or the edge probe go through [fromBitmap].
     */
    static async fromDecoded(
        decoded: DecodedImage,
        backgroundColor: number,
        tileSize: number = MIPMAP_TILE_SIZE,
    ): Promise<Image> {
        const image = new Image(decoded.width, decoded.height)
        image.backgroundColor = backgroundColor

        await WebGpuRenderer.unlocked(async () => {
            try {
                for (const level of decoded.levels) {
                    image.mipmaps.push(
                        level.bytes ?
                            await Mipmap.create(
                                // Bounded: a pooled buffer can be larger than this level.
                                new Uint8Array(level.bytes, 0, level.w * level.h * 4),
                                level.w,
                                level.h,
                                level.scale,
                                tileSize,
                            )
                            : await Mipmap.createFromSource(
                                level.bitmap!,
                                level.w,
                                level.h,
                                level.scale,
                                tileSize,
                            ),
                    )
                }
            } catch (e) {
                console.error("Renderer: error creating image", e)
                image.mipmaps.forEach(m => m.cleanup())
                image.mipmaps.length = 0
                throw e
            } finally {
                // No-op on the pixel path; releases the surfaces on the fallback one.
                closeLevels(decoded.levels)
            }
        })

        return image
    }

    /**
     * Decode [source] and build an [Image] from it, through the CPU pixel path.
     *
     * Kept for a caller holding an `<img>` or a canvas rather than an `ImageBitmap` - prefer
     * [fromBitmap], which avoids the pixel round trip entirely.
     */
    static async fromSource(
        source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
        options: ImageOptions = {},
    ): Promise<Image> {
        const width = "naturalWidth" in source ? source.naturalWidth || source.width : source.width
        const height =
            "naturalHeight" in source ? source.naturalHeight || source.height : source.height
        return Image.create(decodeToPixels(source, width, height), width, height, options)
    }

    /**
     * Resolve [trim] and [backgroundColor] from CPU pixels - the front half of [create], shared
     * with [fromBitmap] so both reach the same answers.
     */
    private analyse(
        pixels: Uint8Array,
        width: number,
        height: number,
        trimColors: number[][] | null,
        trimThreshold: number,
        backgroundColor: number | null,
    ) {
        if (trimColors && !trimColors.every(c => c.length >= 3)) {
            throw new Error("each trimColor must have at least 3 elements [r, g, b]")
        }

        let backgroundFromTrim = false

        const trimWith = trimColors && trimColors.length > 0 ? trimColors : null
        if (trimWith) {
            // Find trim for each color and pick the smallest rect.
            const rects = findAllCpu(pixels, width, height, trimWith, trimThreshold)
            let bestIndex = -1
            for (let i = 0; i < rects.length; i++) {
                const area = rects[i].width() * rects[i].height()
                if (bestIndex < 0 || area < rects[bestIndex].width() * rects[bestIndex].height()) {
                    bestIndex = i
                }
            }

            if (bestIndex >= 0) {
                this.trim = rects[bestIndex]
                // Set background color from the winning trim color.
                if (backgroundColor === null) {
                    const c = trimWith[bestIndex]
                    this.backgroundColor = argb(
                        0xff,
                        Math.trunc(c[0] * 255),
                        Math.trunc(c[1] * 255),
                        Math.trunc(c[2] * 255),
                    )
                    backgroundFromTrim = true
                }
            }
        }

        // Probing the edges is only worth a pass when neither the caller nor trim has already
        // named a background colour.
        if (backgroundColor !== null) {
            this.backgroundColor = backgroundColor
        } else if (!backgroundFromTrim) {
            this.backgroundColor = detectBackgroundCpu(pixels, width, height, trimThreshold)
        }
    }

    /**
     * Build an [Image] from tightly packed RGBA8 [pixels] - the direct port of the Kotlin's
     * constructor.
     *
     * Trim and background detection run before any upload, so neither has to park on a GPU
     * readback - the reason the Kotlin prefers `Trim`'s CPU pass over its compute shaders here.
     * Mip levels are built by repeated halving, then uploaded without the render lock: the image
     * is not reachable from any page yet, and [Mipmap.create] yields between chunks so queued
     * frames get the thread back.
     *
     * The halving is the expensive part on the web - see [fromBitmap], which is what the viewer
     * actually uses. This stays for a caller that genuinely starts from pixels.
     */
    static async create(
        pixels: Uint8Array,
        width: number,
        height: number,
        options: ImageOptions = {},
    ): Promise<Image> {
        if (width <= 0 || height <= 0) throw new Error("Image dimensions must be positive")

        const {
            createMipMaps = true,
            trimColors = null,
            trimThreshold = 0.05,
            backgroundColor = null,
        } = options

        const image = new Image(width, height)
        image.analyse(pixels, width, height, trimColors, trimThreshold, backgroundColor)

        const levels: { pixels: Uint8Array; w: number; h: number; scale: number }[] = [
            { pixels, w: width, h: height, scale: 1 },
        ]

        if (createMipMaps) {
            let currentPixels = pixels
            let textureWidth = width
            let textureHeight = height
            let scale = 1

            while (width * scale > MIPMAP_TILE_SIZE || height * scale > MIPMAP_TILE_SIZE) {
                scale /= 2
                const newWidth = Math.floor(width * scale)
                const newHeight = Math.floor(height * scale)
                if (newWidth <= 0 || newHeight <= 0) break

                currentPixels = resize(currentPixels, textureWidth, textureHeight)
                levels.push({ pixels: currentPixels, w: newWidth, h: newHeight, scale })
                textureWidth = newWidth
                textureHeight = newHeight
            }
        }

        // No render lock: Mipmap.create yields between upload chunks so queued frames get the
        // thread back. Safe since the image isn't reachable from any page yet.
        await WebGpuRenderer.unlocked(async () => {
            try {
                for (const level of levels) {
                    image.mipmaps.push(
                        await Mipmap.create(
                            level.pixels,
                            level.w,
                            level.h,
                            level.scale,
                            MIPMAP_TILE_SIZE,
                        ),
                    )
                }
            } catch (e) {
                console.error("Renderer: error creating image", e)
                image.mipmaps.forEach(m => m.cleanup())
                image.mipmaps.length = 0
                throw e
            }
        })

        return image
    }

    /** An empty, writable image - what a `Render` page draws into. */
    static blank(width: number, height: number): Image {
        const image = new Image(width, height)
        image.mipmaps.push(Mipmap.blank(width, height))
        return image
    }

    cleanup() {
        this.mipmaps.forEach(m => m.cleanup())
        this.mipmaps.length = 0
        this._buffer?.destroy()
        this._buffer = null
    }

    /**
     * Where this image's full extent lands in [dst], as normalised `(x1, y1, x2, y2)` surface
     * coordinates - the same placement [prepareForRender] resolves to, but without going through
     * a mip level or [Mipmap.getQuad]. For callers that only want geometry (a background rect, a
     * page's `pageRect`) with no reason to touch mip/tile selection.
     */
    placement(dst: GPUTexture, x: number, y: number, scale: number): Float32Array {
        const adjustedX = x + this.x / dst.width + WebGpuRenderer.offsetX
        const adjustedY = y + this.y / dst.height + WebGpuRenderer.offsetY
        const x1 = 0.5 + scale * (adjustedX - (0.5 * this.width) / dst.width)
        const y1 = 0.5 + scale * (adjustedY - (0.5 * this.height) / dst.height)
        return new Float32Array([
            x1,
            y1,
            x1 + (scale * this.width) / dst.width,
            y1 + (scale * this.height) / dst.height,
        ])
    }

    /**
     * The mip level, 2x2 window and placement the filtered shader needs, or null if nothing has
     * been uploaded yet.
     */
    prepareForRender(dst: GPUTexture, x: number, y: number, scale: number): MipMapForDraw | null {
        if (this.mipmaps.length === 0) return null

        let level = Math.max(0, Math.min(Math.floor(Math.log2(1 / scale)), this.mipmaps.length - 1))

        // Scale alone isn't enough: getQuad only promises half a tile either side of the view
        // centre, so the viewport must fit in one tile's texels. A <=2x2 grid binds in one go
        // regardless, so only larger ones need checking.
        while (level < this.mipmaps.length - 1) {
            const m = this.mipmaps[level]
            if (m.tilesCols <= 2 && m.tilesRows <= 2) break

            // Source texels the viewport covers at this level.
            const visibleW = (dst.width * m.scale) / scale
            const visibleH = (dst.height * m.scale) / scale
            if (visibleW <= m.tilesize && visibleH <= m.tilesize) break

            level++
        }

        const mipmap = this.mipmaps[level]

        const adjustedX = x + this.x / dst.width + WebGpuRenderer.offsetX
        const adjustedY = y + this.y / dst.height + WebGpuRenderer.offsetY

        // View centre in this level's pixels: scale the level-0 offset by mipmap.scale before
        // adding the level's half-size, or the window lands up to 2^level too far out.
        const vx = Math.round(-adjustedX * dst.width * mipmap.scale + mipmap.width / 2)
        const vy = Math.round(-adjustedY * dst.height * mipmap.scale + mipmap.height / 2)

        const quad = mipmap.getQuad(vx, vy)

        return {
            mipmap,
            quad,
            x: (0.5 / scale + adjustedX) * mipmap.scale + (quad.x - 0.5 * mipmap.width) / dst.width,
            y:
                (0.5 / scale + adjustedY) * mipmap.scale +
                (quad.y - 0.5 * mipmap.height) / dst.height,
            scale: scale / mipmap.scale,
        }
    }

    /**
     * Every tile needed to cover the current viewport, each already placed for its own draw call
     * - the fast/plain paths' answer to [prepareForRender]'s fixed one-window quad, which can
     * silently drop content once the viewport needs more than that window covers. No coarse-level
     * guard is needed here since any viewport is just whichever tiles it happens to overlap.
     */
    prepareTilesForRender(dst: GPUTexture, x: number, y: number, scale: number): TileForDraw[] {
        if (this.mipmaps.length === 0) return []

        const level = Math.max(
            0,
            Math.min(Math.floor(Math.log2(1 / scale)), this.mipmaps.length - 1),
        )
        const mipmap = this.mipmaps[level]

        const adjustedX = x + this.x / dst.width + WebGpuRenderer.offsetX
        const adjustedY = y + this.y / dst.height + WebGpuRenderer.offsetY

        // Same view-centre derivation as prepareForRender's vx/vy, kept unrounded since this is
        // now just a rect query rather than a single discrete window pick.
        const cx = -adjustedX * dst.width * mipmap.scale + mipmap.width / 2
        const cy = -adjustedY * dst.height * mipmap.scale + mipmap.height / 2
        const halfW = (dst.width * mipmap.scale) / (2 * scale)
        const halfH = (dst.height * mipmap.scale) / (2 * scale)

        return mipmap.tilesInRect(cx - halfW, cy - halfH, cx + halfW, cy + halfH).map(tile => ({
            // Same reconstruction prepareForRender uses for quad.x/quad.y, evaluated at this
            // tile's own offset instead - the formula was already general, it just happened
            // to only ever be evaluated at one window's offset before.
            texture: tile.texture,
            view: tile.view,
            uniform: tile.uniform,
            x: (0.5 / scale + adjustedX) * mipmap.scale + (tile.x - 0.5 * mipmap.width) / dst.width,
            y:
                (0.5 / scale + adjustedY) * mipmap.scale +
                (tile.y - 0.5 * mipmap.height) / dst.height,
            scale: scale / mipmap.scale,
        }))
    }
}

export interface MipMapForDraw {
    mipmap: Mipmap
    quad: Quad
    x: number
    y: number
    scale: number
}

/** One physical tile, already placed for a single draw call - see [Image.prepareTilesForRender]. */
export interface TileForDraw {
    texture: GPUTexture
    view: GPUTextureView
    uniform: GPUBuffer
    x: number
    y: number
    scale: number
}
