/**
 * Page decoding on a worker thread.
 *
 * The upload cannot move: a `GPUDevice` belongs to its own realm and textures are not transferable,
 * so a worker's device could hand nothing back. The fetch, its byte progress, the decode and the
 * mip pyramid all can.
 *
 * **Pixels, not `ImageBitmap`s.** A transferred `ImageBitmap` is deserialised before any handler
 * runs, so importing a page-sized surface appeared in neither thread's timings while blocking the
 * main thread 71ms mean / 82ms max per page - the whole stutter. Being atomic, no pacing of the
 * upload could help. An `ArrayBuffer` transfer is a pointer handoff and `writeTexture` chunks.
 * Reading pixels back cost 59ms a page until `willReadFrequently` kept it off the GPU - see
 * toPixels.
 *
 * **Buffers are pooled here, not on the main thread.** A page is ~15MB, and Firefox malloc's large
 * `ArrayBuffer`s outside the JS heap with their bytes driving GC, so one per page forces major
 * collections. [ImageDecoder.recycle] hands them back, leaving the main thread neither allocating
 * nor freeing a large buffer; only the readback allocates, on this side.
 *
 * **The decode waits its turn.** The decode and readback run wholly in the worker, and the main
 * thread still stalls ~85ms per page while they do - Firefox does part of that work there wherever
 * it is called from. So the worker asks permission ("needPixels") after the fetch, and the main
 * thread grants it once nothing is animating. The fetch, the long pole, still overlaps freely.
 *
 * The worker source is inlined: it imports nothing, and a blob URL avoids a build-config change and
 * resolving a digested asset path. The body is a string and so untypechecked; the protocol is not.
 */

import { WebGpuRenderer } from "./renderer/renderer"

/**
 * One mip level, decoded. Exactly one of [bytes] and [bitmap] is set.
 *
 * Pixels are the path worth having, but the readback needs a 2D context on an `OffscreenCanvas`. A
 * worker without one falls back to the surface: ~70ms of main thread per page, against all of it if
 * the decode goes back to the main thread.
 */
export interface DecodedLevel {
    w: number
    h: number
    scale: number
    /** Tightly packed, non-premultiplied RGBA - what `Mipmap.create` wants. */
    bytes?: ArrayBuffer
    /** The decoded surface - what `Mipmap.createFromSource` wants. */
    bitmap?: ImageBitmap
}

/** Where the worker spent its time on one page, in ms. */
export interface DecodeTimings {
    download: number
    /** Parked until the main thread was still - see "needPixels". */
    wait: number
    decode: number
    engine: "wasm" | "wasm-threaded" | "browser"
    /** Progressive steps shown while the page downloaded, and when the first one was ready. */
    previews: number
    firstPreview: number
}

/** A progressive step: the whole image so far, of which only [dirty] (x, y, w, h) is new. */
export interface PartialFrame {
    width: number
    height: number
    dirty: [number, number, number, number]
    /** Tightly packed, non-premultiplied RGBA. */
    pixels: ArrayBuffer
}

export interface DecodedImage {
    width: number
    height: number
    levels: DecodedLevel[]
    timings?: DecodeTimings
    /**
     * Set when this is the first frame of an animation the worker is holding the decoder of, to be
     * played with [ImageDecoder.nextFrame] and let go with [ImageDecoder.releaseAnimation].
     */
    animation?: { id: number; firstDuration: number }
}

/** One frame of an animation: the whole canvas, tightly packed non-premultiplied RGBA. */
export interface AnimationPixels {
    pixels: ArrayBuffer
    /** Display time in ms. */
    duration: number
}

/** Raised when a decode was cancelled rather than failing. */
export class DecodeAborted extends Error {
    constructor() {
        super("decode aborted")
        this.name = "AbortError"
    }
}

const WORKER_SOURCE = `
const inFlight = new Map()

// Pixel buffers returned by the main thread, ready to be handed out again.
//
// Capped by bytes, not count: a page is ~12MB, so "eight buffers" is ~96MB held for the life of the
// tab. The cap need only cover the working set - decodeConcurrency pages and their levels.
const pool = []
const POOL_MAX_BYTES = 48 * 1024 * 1024
let pooledBytes = 0

function takeBuffer(need) {
    // Smallest that fits, so a 12MB buffer is not spent on a thumbnail.
    let best = -1
    for (let i = 0; i < pool.length; i++) {
        if (pool[i].byteLength < need) continue
        if (best < 0 || pool[i].byteLength < pool[best].byteLength) best = i
    }
    if (best < 0) return new ArrayBuffer(need)
    const buffer = pool.splice(best, 1)[0]
    pooledBytes -= buffer.byteLength
    return buffer
}

function giveBuffer(buffer) {
    // One larger than the whole cap would evict everything else for nothing.
    if (buffer.byteLength > POOL_MAX_BYTES) return
    while (pooledBytes + buffer.byteLength > POOL_MAX_BYTES && pool.length > 0) {
        pooledBytes -= pool.shift().byteLength
    }
    pool.push(buffer)
    pooledBytes += buffer.byteLength
}

// Decodes waiting for the main thread's go-ahead, by request id.
const waiting = new Map()

function permission(id, signal) {
    return new Promise(resolve => {
        if (signal.aborted) {
            resolve()
            return
        }
        waiting.set(id, resolve)
        self.postMessage({ id: id, type: "needPixels" })
    })
}

function release(id) {
    const resolve = waiting.get(id)
    if (resolve) {
        waiting.delete(id)
        resolve()
    }
}

self.onmessage = event => {
    const request = event.data
    if (request.type === "proceed") {
        release(request.id)
        return
    }
    if (request.type === "recycle") {
        for (let i = 0; i < request.buffers.length; i++) giveBuffer(request.buffers[i])
        return
    }
    if (request.type === "frame") {
        sendFrame(request.id)
        return
    }
    if (request.type === "release") {
        releaseAnimation(request.id)
        return
    }
    if (request.type === "abort") {
        const controller = inFlight.get(request.id)
        if (controller) controller.abort()
        inFlight.delete(request.id)
        // A decode parked on permission would wait for a "proceed" that is never coming.
        release(request.id)
        return
    }
    handle(request)
}

// Animations the main thread is playing, by request id: the decoder is kept open past the first
// frame, with the second already decoded (to tell it was animated) waiting in [ahead].
const animations = new Map()

// Whether [decoder], just past its first whole frame, is an animation: its second frame, decoded
// to tell, or null for a still.
function secondFrame(decoder) {
    if (!decoder.hasNext) return null
    try {
        return decoder.decodeNext()
    } catch (e) {
        return null
    }
}

function releaseAnimation(id) {
    const animation = animations.get(id)
    if (!animation) return
    animations.delete(id)
    try {
        animation.decoder.close()
        animation.decoder.delete()
    } catch (e) {
        // Already gone.
    }
}

// The next frame of an animation, looping back to the first once the last has shown. A file that
// names a loop count (0 is forever) stops after that many runs; null ends the animation.
function nextAnimationFrame(id) {
    const animation = animations.get(id)
    if (!animation) return null
    let frame = animation.ahead
    animation.ahead = null
    if (!frame) {
        const decoder = animation.decoder
        if (!decoder.hasNext) {
            animation.runs++
            const loops = decoder.loopCount
            if (loops !== 0 && animation.runs >= loops) return null
            decoder.rewind()
        }
        frame = decoder.decodeNext()
    }
    if (frame.halfFloat || !frame.pixels) return null
    if (frame.pixels.byteLength !== animation.width * animation.height * 4) return null
    return frame
}

function sendFrame(id) {
    let frame = null
    try {
        frame = nextAnimationFrame(id)
    } catch (e) {
        console.warn("ImageDecoder: animation frame failed", e)
    }
    if (!frame) {
        self.postMessage({ id: id, type: "frame", end: true })
        return
    }
    self.postMessage(
        { id: id, type: "frame", pixels: frame.pixels.buffer, duration: frame.duration },
        [frame.pixels.buffer],
    )
}

async function handle(request) {
    const controller = new AbortController()
    inFlight.set(request.id, controller)
    let session = null
    try {
        const started = performance.now()
        // The wasm decoder takes the bytes as they arrive, so a progressive image can be shown
        // part way down. Not worth the copies unless the main thread will show them.
        const module = request.wasm && request.preview ? await loadWasm(request.wasm) : null
        session = module ? streamer(request, module, started) : null
        const blob = await download(request, controller.signal, session)
        const downloaded = performance.now()

        // The fetch overlaps whatever is on screen; a decode that stalls the main thread waits for
        // a still frame. See the "needPixels" note at the top of decoder.ts. The wasm decoder runs
        // wholly in this worker, so it never asks.
        let waited = 0
        const permit = async () => {
            const asked = performance.now()
            await permission(request.id, controller.signal)
            waited = performance.now() - asked
            if (controller.signal.aborted) throw new Error("aborted")
        }

        // The frame the stream ended on, if it got that far; otherwise decoded afresh from the blob.
        let decoded = null
        if (session) {
            try {
                const frame = session.finish()
                if (frame) {
                    // The decoder goes with the frame: an animation keeps it.
                    decoded = await finishWasm(request, session.take(), frame)
                }
            } catch (e) {
                console.warn("ImageDecoder: streamed decode failed, decoding the whole file", e)
            }
        }
        if (!decoded) decoded = await decodeToLevels(blob, request, permit)
        const timings = {
            download: downloaded - started,
            wait: waited,
            decode: performance.now() - downloaded - waited,
            engine: decoded.engine,
            previews: session ? session.previews : 0,
            firstPreview: session ? session.firstPreview : 0,
        }

        self.postMessage(
            {
                id: request.id,
                type: "done",
                width: decoded.width,
                height: decoded.height,
                levels: decoded.levels,
                timings: timings,
                animation: decoded.animation,
            },
            decoded.levels.map(level => level.bytes || level.bitmap),
        )
    } catch (e) {
        if (controller.signal.aborted) {
            self.postMessage({ id: request.id, type: "aborted" })
        } else {
            self.postMessage({
                id: request.id,
                type: "error",
                message: (e && e.message) || "Failed to load image",
            })
        }
    } finally {
        if (session) session.dispose()
        inFlight.delete(request.id)
    }
}

// Fetch the page, posting the byte fraction as it arrives.
async function download(request, signal, session) {
    const response = await fetch(request.url, { signal })
    if (!response.ok) throw new Error("HTTP " + response.status + " " + response.statusText)

    // Content-Length is what makes progress a real fraction; absent for a chunked or compressed
    // response, where there is nothing to report until the body is complete.
    const total = Number(response.headers.get("content-length") || 0)
    const body = response.body
    const known = isFinite(total) && total > 0
    if (!body || (!known && !session)) return response.blob()

    const reader = body.getReader()
    const chunks = []
    let received = 0
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        if (session) session.feed(value)
        if (known) {
            self.postMessage({
                id: request.id,
                type: "progress",
                value: Math.min(received / total, 1),
            })
        }
    }
    return new Blob(chunks, { type: response.headers.get("content-type") || "" })
}

// Whether this worker can read pixels back. Probed once, for real: a context that exists but throws
// on getImageData would fail every page.
let readbackOk = undefined
function canReadBack() {
    if (readbackOk === undefined) {
        try {
            const probe = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })
            probe.getImageData(0, 0, 1, 1)
            readbackOk = true
        } catch (e) {
            readbackOk = false
        }
    }
    return readbackOk
}

// The wasm decoder, loaded once. The threaded build needs SharedArrayBuffer, which a page only has
// when cross-origin isolated; otherwise the single-threaded build does the same job.
let wasmModule = null
let wasmBroken = false
let wasmThreaded = false
async function loadWasm(urls) {
    if (wasmBroken) return null
    if (!wasmModule) {
        wasmThreaded = self.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined"
        console.log(
            "ImageDecoder: loading the " + (wasmThreaded ? "threaded" : "single-threaded") +
                " wasm decoder (crossOriginIsolated=" + self.crossOriginIsolated + ")",
        )
        wasmModule = import(wasmThreaded ? urls.threaded : urls.single).then(m => m.default())
    }
    try {
        return await wasmModule
    } catch (e) {
        // Not worth retrying every page: the browser decoder takes over for good.
        wasmBroken = true
        console.warn("ImageDecoder: wasm decoder unavailable, using the browser decoder", e)
        return null
    }
}

// Decode with the wasm decoder, or null where it can't (not loaded, HDR output, a layout the
// pipeline doesn't take) and the browser decoder should have a go instead.
async function decodeWithWasm(blob, request) {
    const module = await loadWasm(request.wasm)
    if (!module) return null

    const bytes = new Uint8Array(await blob.arrayBuffer())
    const decoder = module.ImageDecoder.open(bytes, true)
    let frame
    try {
        frame = decoder.decodeNext()
    } catch (e) {
        decoder.close()
        decoder.delete()
        throw e
    }
    return finishWasm(request, decoder, frame)
}

// The levels for [frame], the first whole one of [decoder] - which this takes over: closed here
// unless the image turns out to be an animation, which keeps it open for [sendFrame].
async function finishWasm(request, decoder, frame) {
    let keep = false
    try {
        // Only a page of one file animates, and only where the main thread will play it.
        const ahead = request.animate ? secondFrame(decoder) : null
        // An animation swaps whole images, so it has no use for smaller levels.
        const decoded = await levelsFromFrame(
            frame,
            ahead ? Number.MAX_SAFE_INTEGER : request.tileSize,
        )
        if (!decoded) return null
        decoded.engine = wasmThreaded ? "wasm-threaded" : "wasm"
        if (ahead) {
            animations.set(request.id, {
                decoder: decoder,
                ahead: ahead,
                runs: 0,
                width: frame.width,
                height: frame.height,
            })
            keep = true
            decoded.animation = { id: request.id, firstDuration: frame.duration }
        }
        return decoded
    } finally {
        if (!keep) {
            decoder.close()
            decoder.delete()
        }
    }
}

// The pyramid for a decoded wasm [frame], or null where it can't be used (nothing decoded, HDR
// output, a layout the pipeline doesn't take) and the browser decoder should have a go.
async function levelsFromFrame(frame, tileSize) {
    if (!frame || !frame.pixels || frame.halfFloat) return null

    const width = frame.width
    const height = frame.height
    // Tightly packed non-premultiplied RGBA is what Mipmap.create takes as it is.
    if (width <= 0 || height <= 0 || frame.pixels.byteLength !== width * height * 4) return null

    // Smaller levels are only made for a page too big for one tile.
    let source = null
    if (width > tileSize || height > tileSize) {
        source = await createImageBitmap(
            new ImageData(new Uint8ClampedArray(frame.pixels.buffer), width, height),
            { premultiplyAlpha: "none", colorSpaceConversion: "none" },
        )
    }
    const out = await levelsFrom(source, width, height, tileSize, frame.pixels.buffer)
    out.engine = wasmThreaded ? "wasm-threaded" : "wasm"
    return out
}

// [permit] resolves once the main thread is still - only the browser decoder waits on it.
// Longest between two decodes of what has arrived: each progressive step copies a whole image out
// of wasm, so doing it per chunk would cost more than the download.
const PREVIEW_BATCH_MS = 150

// Feeds a download into a wasm decoder as it arrives and posts each progressive step as a "partial"
// message. [finish] gives the final frame, or null if streaming gave up and the whole file should
// be decoded afresh.
function streamer(request, module, started) {
    let decoder = null
    let failed = false
    let whole = null
    let fedAt = 0
    let previewing = true
    const session = {
        previews: 0,
        firstPreview: 0,
        feed(chunk) {
            if (failed || whole) return
            try {
                if (!decoder) decoder = module.ImageDecoder.open(chunk, false)
                else decoder.pushData(chunk)
                const now = performance.now()
                if (now - fedAt < PREVIEW_BATCH_MS || !decoder.width) return
                fedAt = now
                // HDR is not tone mapped here, and a gain map needs float textures.
                if (decoder.isHdr || decoder.hdrKind === 1) previewing = false
                if (!previewing) return

                let frame
                try {
                    frame = decoder.decodeNext()
                } catch (e) {
                    if (e && /Need more data/.test(e.message)) return
                    throw e
                }
                if (!frame.partial) {
                    whole = frame
                    return
                }
                const bytes = frame.pixels
                if (!frame.changed || frame.halfFloat || !bytes) return
                if (bytes.byteLength !== frame.width * frame.height * 4) return
                session.previews++
                if (!session.firstPreview) session.firstPreview = performance.now() - started
                self.postMessage(
                    {
                        id: request.id,
                        type: "partial",
                        width: frame.width,
                        height: frame.height,
                        dirty: [frame.dirtyX, frame.dirtyY, frame.dirtyWidth, frame.dirtyHeight],
                        pixels: bytes.buffer,
                    },
                    [bytes.buffer],
                )
            } catch (e) {
                // Whatever went wrong, the whole-file decode is the way out.
                failed = true
                console.warn("ImageDecoder: streaming decode gave up", e)
            }
        },
        finish() {
            if (failed || !decoder) return null
            try {
                if (whole) return whole
                decoder.markComplete()
                while (true) {
                    const frame = decoder.decodeNext()
                    if (!frame.partial) return frame
                }
            } catch (e) {
                console.warn("ImageDecoder: streaming decode gave up", e)
                return null
            }
        },
        // The decoder, handed over: [dispose] no longer closes it.
        take() {
            const taken = decoder
            decoder = null
            return taken
        },
        dispose() {
            if (!decoder) return
            try {
                decoder.close()
                decoder.delete()
            } catch (e) {
                // Already gone.
            }
            decoder = null
        },
    }
    return session
}

async function decodeToLevels(blob, request, permit) {
    const tileSize = request.tileSize
    if (request.wasm) {
        try {
            const decoded = await decodeWithWasm(blob, request)
            if (decoded) return decoded
        } catch (e) {
            if (e && e.message === "aborted") throw e
            console.warn("ImageDecoder: wasm decode failed, using the browser decoder", e)
        }
    }

    await permit()

    // colorSpaceConversion "none" skips the ICC transform to sRGB: a wide-gamut page renders with
    // its raw values, which for scanned manga is worth the decode time saved.
    const source = await createImageBitmap(blob, {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
    })
    if (source.width <= 0 || source.height <= 0) {
        source.close()
        throw new Error("image has no dimensions")
    }
    const out = await levelsFrom(source, source.width, source.height, tileSize, null)
    out.engine = "browser"
    return out
}

// Read every level out of [source] - each drawn from the original, not the level above, so no
// resampling error accumulates. [firstBytes], when given, already is level 0 and [source] may be
// null if nothing smaller is needed.
async function levelsFrom(source, width, height, tileSize, firstBytes) {
    let handedOver = false
    try {
        const pixels = canReadBack()
        const levels = []
        let scale = 1
        while (true) {
            const w = Math.max(1, Math.floor(width * scale))
            const h = Math.max(1, Math.floor(height * scale))
            const level = { w: w, h: h, scale: scale }
            if (scale === 1 && firstBytes) {
                level.bytes = firstBytes
            } else if (pixels) {
                level.bytes = toPixels(source, w, h)
            } else if (scale === 1) {
                // Level 0 is the decode itself; handing it over means not closing it here.
                level.bitmap = source
                handedOver = true
            } else {
                level.bitmap = await createImageBitmap(source, {
                    resizeWidth: w,
                    resizeHeight: h,
                    resizeQuality: "high",
                    premultiplyAlpha: "none",
                    colorSpaceConversion: "none",
                })
            }
            levels.push(level)
            if (w <= tileSize && h <= tileSize) break
            scale /= 2
        }

        return { width: width, height: height, levels: levels }
    } finally {
        if (source && !handedOver) source.close()
    }
}

// Draw [source] at w x h and read the pixels back, tightly packed and non-premultiplied.
//
// willReadFrequently is what makes this affordable. Without it the canvas may be GPU-backed and
// getImageData becomes a synchronous readback through the process that presents frames - 59ms a
// page. With it the canvas stays in system memory and both calls are plain CPU work.
function toPixels(source, w, h) {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) throw new Error("no 2d context in worker")
    // A 2D canvas premultiplies and getImageData undoes it, costing a semi-transparent pixel some
    // precision. Scans are opaque, and the shaders want non-premultiplied input.
    ctx.drawImage(source, 0, 0, w, h)
    // Into a pooled buffer, possibly larger than this level needs - w/h say how much counts. One
    // memcpy here keeps the main thread out of the allocator entirely.
    const need = w * h * 4
    const out = takeBuffer(need)
    new Uint8Array(out, 0, need).set(ctx.getImageData(0, 0, w, h).data)
    return out
}
`

/**
 * Where the worker loads the wasm decoders from, absolute for the same reason as the page URLs.
 * Served from `priv/static/wasm`.
 */
function wasmUrls() {
    const base = new URL("/wasm/", document.baseURI).href
    return {
        single: `${base}imagedecoder-nothreads-wasm/imagedecoder-nothreads.js`,
        threaded: `${base}imagedecoder-wasm/imagedecoder.js`,
    }
}

interface Pending {
    resolve: (image: DecodedImage) => void
    reject: (reason: unknown) => void
    onProgress?: (value: number) => void
    onPartial?: (frame: PartialFrame) => void
}

export class ImageDecoder {
    private worker: Worker
    private readonly pending = new Map<number, Pending>()
    private readonly frameWaiters = new Map<number, (frame: AnimationPixels | null) => void>()
    private nextId = 1

    /**
     * Set once the worker has failed, after which every request is refused immediately.
     *
     * A request to a dead worker gets no reply ever, so the caller's `await` never settles, its
     * `finally` never runs, and `Viewer.endLoad` is never reached - leaving tile generation
     * suspended for the session and every later page untiled. Failing fast routes the caller to the
     * in-place path it already handles.
     */
    private dead = false

    private constructor(worker: Worker) {
        this.worker = worker
        worker.onmessage = event => this.receive(event.data)
        worker.onerror = e => {
            console.error("ImageDecoder: worker error", e.message)
            // Nothing in flight can complete now; fail them all so callers fall back.
            this.dead = true
            const failed = [...this.pending.values()]
            this.pending.clear()
            this.frameWaiters.forEach(resolve => resolve(null))
            this.frameWaiters.clear()
            failed.forEach(p => p.reject(new Error(e.message || "decode worker failed")))
        }
    }

    private static instance: ImageDecoder | null | undefined

    /**
     * The shared decoder, or null where a worker can't be created - a hardened CSP without
     * `worker-src blob:` is the realistic case. Callers fall back to decoding in place.
     */
    static shared(): ImageDecoder | null {
        if (ImageDecoder.instance !== undefined) return ImageDecoder.instance
        try {
            const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }))
            const worker = new Worker(url)
            // The worker holds its own reference once constructed.
            URL.revokeObjectURL(url)
            ImageDecoder.instance = new ImageDecoder(worker)
        } catch (e) {
            console.warn("ImageDecoder: no worker available, decoding on the main thread", e)
            ImageDecoder.instance = null
        }
        return ImageDecoder.instance
    }

    private receive(message: {
        id: number
        type: "progress" | "needPixels" | "partial" | "frame" | "done" | "error" | "aborted"
        value?: number
        message?: string
        width?: number
        height?: number
        levels?: DecodedLevel[]
        timings?: DecodeTimings
        dirty?: [number, number, number, number]
        pixels?: ArrayBuffer
        duration?: number
        end?: boolean
        animation?: { id: number; firstDuration: number }
    }) {
        // A frame answers [nextFrame], not a decode - the decode's own entry is long gone.
        if (message.type === "frame") {
            const waiting = this.frameWaiters.get(message.id)
            this.frameWaiters.delete(message.id)
            waiting?.(
                message.end || !message.pixels ?
                    null
                    : { pixels: message.pixels, duration: message.duration ?? 0 },
            )
            return
        }

        // No entry means this arrived after an abort. Buffers are plain memory; a surface is a
        // handle that is ours now, so it needs releasing.
        const entry = this.pending.get(message.id)
        if (!entry) {
            if (message.type === "done") {
                // Nobody will play it either.
                if (message.animation) this.releaseAnimation(message.id)
                closeLevels(message.levels ?? [])
                // Nobody will upload these, but every aborted page would otherwise cost the pool
                // a buffer for good.
                this.recycle(message.levels ?? [])
            }
            return
        }

        switch (message.type) {
            case "needPixels":
                // Granted once nothing is animating, capped so a page cannot be held forever.
                // Nothing is awaited here; the worker stays parked until the reply arrives.
                void WebGpuRenderer.whenStill().then(() => {
                    if (this.pending.has(message.id)) {
                        this.worker.postMessage({ type: "proceed", id: message.id })
                    }
                })
                break
            case "progress":
                entry.onProgress?.(message.value ?? 0)
                break
            case "partial":
                entry.onPartial?.({
                    width: message.width!,
                    height: message.height!,
                    dirty: message.dirty!,
                    pixels: message.pixels!,
                })
                break
            case "done":
                this.pending.delete(message.id)
                entry.resolve({
                    width: message.width!,
                    height: message.height!,
                    levels: message.levels!,
                    timings: message.timings,
                    animation: message.animation,
                })
                break
            case "aborted":
                this.pending.delete(message.id)
                entry.reject(new DecodeAborted())
                break
            case "error":
                this.pending.delete(message.id)
                entry.reject(new Error(message.message ?? "Failed to load image"))
                break
        }
    }

    /**
     * Hand every pixel buffer in [levels] back to the worker's pool, after the upload is done with
     * them. Transferring detaches the buffer, so levels are emptied as they go and a second call is
     * a no-op rather than a throw.
     */
    recycle(levels: DecodedLevel[]) {
        if (this.dead) return
        const buffers: ArrayBuffer[] = []
        for (const level of levels) {
            if (level.bytes && level.bytes.byteLength > 0) buffers.push(level.bytes)
            level.bytes = undefined
        }
        if (buffers.length === 0) return
        this.worker.postMessage({ type: "recycle", buffers }, buffers)
    }

    /**
     * The next frame of the animation [id] (from [DecodedImage.animation]), looping, or null once
     * it has ended or the worker is gone.
     */
    nextFrame(id: number): Promise<AnimationPixels | null> {
        if (this.dead) return Promise.resolve(null)
        return new Promise(resolve => {
            // One at a time per animation, which is how the page plays it.
            this.frameWaiters.get(id)?.(null)
            this.frameWaiters.set(id, resolve)
            this.worker.postMessage({ type: "frame", id })
        })
    }

    /** Let the worker close the decoder an animation was keeping. */
    releaseAnimation(id: number) {
        this.frameWaiters.get(id)?.(null)
        this.frameWaiters.delete(id)
        if (!this.dead) this.worker.postMessage({ type: "release", id })
    }

    /**
     * Fetch and decode [url] into per-level pixel buffers, mipped down to [tileSize].
     *
     * [onProgress] receives the download fraction, 0..1. [onPartial], when given, receives each
     * progressive step of an image that decodes as it arrives. [animate] lets a multi-frame image
     * keep its decoder in the worker for [nextFrame]. Aborting [signal] rejects with
     * [DecodeAborted] and tells the worker to drop the transfer.
     */
    decode(
        url: string,
        tileSize: number,
        onProgress?: (value: number) => void,
        signal?: AbortSignal,
        onPartial?: (frame: PartialFrame) => void,
        animate = false,
    ): Promise<DecodedImage> {
        if (this.dead) return Promise.reject(new Error("decode worker unavailable"))

        const id = this.nextId++

        // Absolute, because the worker's base is the `blob:` URL it was made from, and a blob URL
        // is not hierarchical - `/page/4186/12` has nothing to resolve against and `fetch` rejects
        // it. Only this side has the document's base. `baseURI`, not `location.href`, so a <base>
        // tag resolves the way its own markup would.
        const absolute = new URL(url, document.baseURI).href

        return new Promise<DecodedImage>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, onProgress, onPartial })

            signal?.addEventListener(
                "abort",
                () => {
                    if (!this.pending.has(id)) return
                    this.pending.delete(id)
                    // "abort" also releases a decode parked on permission - see release() - so
                    // this cannot leave one waiting for a proceed that never comes.
                    this.worker.postMessage({ type: "abort", id })
                    reject(new DecodeAborted())
                },
                { once: true },
            )

            this.worker.postMessage({
                type: "decode",
                id,
                url: absolute,
                tileSize,
                wasm: wasmUrls(),
                preview: onPartial !== undefined,
                animate,
            })
        })
    }
}

/** Release any surface in [levels] - for a result nobody is going to upload. */
export function closeLevels(levels: DecodedLevel[]) {
    levels.forEach(level => level.bitmap?.close())
}
