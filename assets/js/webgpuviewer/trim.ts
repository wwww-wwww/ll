import { Rect, linearToSrgb } from "./util"

/**
 * Port of `cpp/trim.cpp` plus `Trim.findAllCpu`/`findCpu`/`detectBackgroundCpu`.
 *
 * The Kotlin also carries compute-shader versions of both passes ([Trim]'s `findInContext` /
 * `detectBackgroundInContext`). Those exist for callers that already have an uploaded texture,
 * and they pay for a GPU readback the render thread has to park on. The CPU path reads the
 * decoded pixels before upload and needs no round trip, which is exactly what `Image` uses - so
 * that is what is ported here.
 *
 * Pixel layout is RGBA8, row-major, tightly packed: byte 0 is red, byte 3 is alpha. Channels are
 * read individually, so the identity does not depend on any word-order assumption.
 */

const CHANNELS = 4

// ---------------------------------------------------------------------------
// Trim
// ---------------------------------------------------------------------------

/**
 * Foreground test for one background colour, matching `is_foreground` in the WGSL trim shaders.
 *
 * The shader composites the pixel over the background before comparing:
 *   diff = |rgb * a + bg * (1 - a) - bg| = a * |rgb - bg|
 * so the blend collapses to a single multiply by alpha. Everything is kept in 0..255 units to
 * avoid normalising every pixel: the shader's `a01 * |c01 - bg01| > threshold` scales to
 * `a * |c - bg255| > threshold * 255 * 255`.
 */
class ColorTest {
    readonly bg255: [number, number, number]
    readonly thresholdScaled: number
    /**
     * Fully opaque pixels dominate real pages, and for those the alpha multiply drops out,
     * leaving a comparison that depends only on the byte value - so it can be a table.
     */
    readonly opaqueForeground: [Uint8Array, Uint8Array, Uint8Array]

    constructor(r: number, g: number, b: number, threshold: number) {
        this.bg255 = [r * 255, g * 255, b * 255]
        this.thresholdScaled = threshold * 255 * 255

        const opaqueThreshold = threshold * 255
        this.opaqueForeground = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)]
        for (let ch = 0; ch < 3; ++ch) {
            const table = this.opaqueForeground[ch]
            const bg = this.bg255[ch]
            for (let c = 0; c < 256; ++c) {
                table[c] = Math.abs(c - bg) > opaqueThreshold ? 1 : 0
            }
        }
    }
}

function isForeground(test: ColorTest, pixels: Uint8Array, idx: number): boolean {
    const a = pixels[idx + 3]
    if (a === 255) {
        return (
            (test.opaqueForeground[0][pixels[idx]] |
                test.opaqueForeground[1][pixels[idx + 1]] |
                test.opaqueForeground[2][pixels[idx + 2]]) !==
            0
        )
    }
    const t = test.thresholdScaled
    return (
        a * Math.abs(pixels[idx] - test.bg255[0]) > t ||
        a * Math.abs(pixels[idx + 1] - test.bg255[1]) > t ||
        a * Math.abs(pixels[idx + 2] - test.bg255[2]) > t
    )
}

/**
 * Bounding box of the foreground pixels.
 *
 * Seeded the way the shader seeds its result buffer - min at the image extent, max at zero - so
 * an image with no foreground at all produces the same `(width, height, 0, 0)` the GPU path
 * produces, and the callers that already handle that degenerate result keep working.
 */
class Bounds {
    minX: number
    minY: number
    maxX = 0
    maxY = 0

    constructor(width: number, height: number) {
        this.minX = width
        this.minY = height
    }
}

/**
 * Accumulate bounds for every colour over rows `[y0, y1)`.
 *
 * Colours are the inner loop so a row is walked while it is still in cache. Within a row, the
 * scan runs inward from both ends and stops at the first hit: a page with margins costs two short
 * scans, and only a row that is entirely background has to be read end to end (there is no way to
 * prove it empty otherwise).
 *
 * The C++ splits the image into bands across up to eight threads. There is no equivalent here
 * without moving the whole pass into a worker - `Image` already runs this off the frame path, and
 * splitting it across workers would mean copying the pixels to each one.
 */
function scanBand(
    pixels: Uint8Array,
    width: number,
    y0: number,
    y1: number,
    tests: ColorTest[],
    bounds: Bounds[],
) {
    for (let y = y0; y < y1; ++y) {
        const row = y * width * CHANNELS

        for (let ci = 0; ci < tests.length; ++ci) {
            const test = tests[ci]
            const bb = bounds[ci]

            let first = -1
            for (let x = 0; x < width; ++x) {
                if (isForeground(test, pixels, row + x * CHANNELS)) {
                    first = x
                    break
                }
            }
            if (first < 0) continue // Row is entirely background for this colour.

            let last = first
            for (let x = width - 1; x > first; --x) {
                if (isForeground(test, pixels, row + x * CHANNELS)) {
                    last = x
                    break
                }
            }

            if (first < bb.minX) bb.minX = first
            if (last > bb.maxX) bb.maxX = last
            if (y < bb.minY) bb.minY = y
            if (y > bb.maxY) bb.maxY = y
        }
    }
}

/**
 * One [Rect] per colour in [colors] (`[r, g, b]` in 0..1), in input order.
 *
 * All colours are resolved in a single pass over the image instead of one dispatch each.
 */
export function findAllCpu(
    pixels: Uint8Array,
    width: number,
    height: number,
    colors: number[][],
    threshold: number,
): Rect[] {
    if (colors.length === 0) throw new Error("colors must not be empty")
    if (!colors.every(c => c.length >= 3)) {
        throw new Error("each color must have at least 3 elements [r, g, b]")
    }

    if (width <= 0 || height <= 0 || pixels.length < width * height * CHANNELS) {
        console.warn(`findAllCpu: rejected ${width}x${height}, using full bounds`)
        return colors.map(() => new Rect(0, 0, width, height))
    }

    const tests = colors.map(c => new ColorTest(c[0], c[1], c[2], threshold))
    const bounds = colors.map(() => new Bounds(width, height))

    scanBand(pixels, width, 0, height, tests, bounds)

    // Same max -> exclusive-edge conversion the GPU readback does.
    return bounds.map(
        b => new Rect(b.minX, b.minY, Math.min(b.maxX + 1, width), Math.min(b.maxY + 1, height)),
    )
}

/** The tightest trim across [colors]. */
export function findCpu(
    pixels: Uint8Array,
    width: number,
    height: number,
    colors: number[][],
    threshold: number,
): Rect {
    const rects = findAllCpu(pixels, width, height, colors, threshold)
    let best: Rect | null = null
    for (const r of rects) {
        if (best === null || r.width() * r.height() < best.width() * best.height()) best = r
    }
    return best ?? new Rect(0, 0, width, height)
}

// ---------------------------------------------------------------------------
// Background detection
// ---------------------------------------------------------------------------

const srgbToLinearLut = new Float64Array(256)
for (let i = 0; i < 256; ++i) {
    const c = i / 255
    srgbToLinearLut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

const MIN_COVERAGE = 0.9
const COLOR_MATCH_TOLERANCE = 0.05

/** One edge of the image, as a strided walk over [pixels]. */
interface EdgeLine {
    base: number
    strideBytes: number
    count: number
}

interface EdgeResult {
    solid: boolean
    isWhite: boolean
    /** Meaningful only when solid and not white. */
    linearMean: [number, number, number]
    /** Meaningful only when solid - higher is more confident. */
    coverage: number
}

const NOT_SOLID: EdgeResult = { solid: false, isWhite: false, linearMean: [0, 0, 0], coverage: 0 }

function classifyEdge(pixels: Uint8Array, line: EdgeLine): EdgeResult {
    if (line.count === 0) return NOT_SOLID

    const sum = [0, 0, 0]
    for (let i = 0; i < line.count; ++i) {
        const px = line.base + i * line.strideBytes
        for (let ch = 0; ch < 3; ++ch) sum[ch] += srgbToLinearLut[pixels[px + ch]]
    }
    const inv = 1 / line.count
    const mean = [sum[0] * inv, sum[1] * inv, sum[2] * inv]

    const tol = COLOR_MATCH_TOLERANCE
    let closeToMean = 0
    let closeToWhite = 0
    const inlierSum = [0, 0, 0]

    for (let i = 0; i < line.count; ++i) {
        const px = line.base + i * line.strideBytes
        const lin = [0, 0, 0]
        let nearMean = true
        let nearWhite = true
        for (let ch = 0; ch < 3; ++ch) {
            lin[ch] = srgbToLinearLut[pixels[px + ch]]
            if (Math.abs(lin[ch] - mean[ch]) > tol) nearMean = false
            if (Math.abs(lin[ch] - 1) > tol) nearWhite = false
        }
        if (nearMean) {
            ++closeToMean
            for (let ch = 0; ch < 3; ++ch) inlierSum[ch] += lin[ch]
        }
        if (nearWhite) ++closeToWhite
    }

    const meanCoverage = closeToMean * inv
    const whiteCoverage = closeToWhite * inv

    if (whiteCoverage >= MIN_COVERAGE) {
        return { solid: true, isWhite: true, linearMean: [0, 0, 0], coverage: whiteCoverage }
    }
    if (meanCoverage >= MIN_COVERAGE) {
        const inlierInv = 1 / closeToMean
        return {
            solid: true,
            isWhite: false,
            linearMean: [
                inlierSum[0] * inlierInv,
                inlierSum[1] * inlierInv,
                inlierSum[2] * inlierInv,
            ],
            coverage: meanCoverage,
        }
    }
    return NOT_SOLID
}

/**
 * The background colour implied by the image edges, as 0xAARRGGBB, or opaque white when no edge
 * is a solid colour. [threshold] is accepted for parity with the Kotlin signature and, as in the
 * C++, plays no part - the edge classifier has its own coverage and tolerance constants.
 */
export function detectBackgroundCpu(
    pixels: Uint8Array,
    width: number,
    height: number,
    _threshold: number = 0.05,
): number {
    if (width <= 0 || height <= 0) return 0xffffffff | 0
    if (pixels.length < width * height * CHANNELS) return 0xffffffff | 0

    const stride = width * CHANNELS
    const edges: EdgeLine[] = [
        { base: 0, strideBytes: stride, count: height }, // left
        { base: (width - 1) * CHANNELS, strideBytes: stride, count: height }, // right
        { base: 0, strideBytes: CHANNELS, count: width }, // top
        { base: (height - 1) * stride, strideBytes: CHANNELS, count: width }, // bottom
    ]

    let whiteCount = 0
    let nonWhiteCount = 0
    const linearSum = [0, 0, 0]

    for (const edge of edges) {
        const result = classifyEdge(pixels, edge)
        if (!result.solid) continue
        if (result.isWhite) {
            whiteCount++
            continue
        }
        nonWhiteCount++
        for (let ch = 0; ch < 3; ++ch) linearSum[ch] += result.linearMean[ch]
    }

    if (nonWhiteCount > 0) {
        const inv = 1 / nonWhiteCount
        const channel = (i: number) =>
            Math.max(0, Math.min(255, Math.floor(linearToSrgb(linearSum[i] * inv) * 255 + 0.5)))
        return 0xff000000 | (channel(0) << 16) | (channel(1) << 8) | channel(2) | 0
    }

    if (whiteCount > 0) return 0xffffffff | 0

    return 0xffffffff | 0
}
