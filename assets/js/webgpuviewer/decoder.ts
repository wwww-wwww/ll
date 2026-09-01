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

export interface DecodedImage {
    width: number
    height: number
    levels: DecodedLevel[]
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

async function handle(request) {
    const controller = new AbortController()
    inFlight.set(request.id, controller)
    try {
        const blob = await download(request, controller.signal)

        // The fetch overlaps whatever is on screen; the decode waits for a still frame. See the
        // "needPixels" note at the top of decoder.ts.
        await permission(request.id, controller.signal)
        if (controller.signal.aborted) throw new Error("aborted")

        const decoded = await decodeToLevels(blob, request.tileSize)

        self.postMessage(
            {
                id: request.id,
                type: "done",
                width: decoded.width,
                height: decoded.height,
                levels: decoded.levels,
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
        inFlight.delete(request.id)
    }
}

// Fetch the page, posting the byte fraction as it arrives.
async function download(request, signal) {
    const response = await fetch(request.url, { signal })
    if (!response.ok) throw new Error("HTTP " + response.status + " " + response.statusText)

    // Content-Length is what makes progress a real fraction; absent for a chunked or compressed
    // response, where there is nothing to report until the body is complete.
    const total = Number(response.headers.get("content-length") || 0)
    const body = response.body
    if (!body || !isFinite(total) || total <= 0) return response.blob()

    const reader = body.getReader()
    const chunks = []
    let received = 0
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        self.postMessage({
            id: request.id,
            type: "progress",
            value: Math.min(received / total, 1),
        })
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

// Decode once, then read every level out of it - each drawn from the original, not the level above,
// so no resampling error accumulates.
async function decodeToLevels(blob, tileSize) {
    // colorSpaceConversion "none" skips the ICC transform to sRGB: a wide-gamut page renders with
    // its raw values, which for scanned manga is worth the decode time saved.
    const source = await createImageBitmap(blob, {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
    })
    let handedOver = false
    try {
        const width = source.width
        const height = source.height
        if (width <= 0 || height <= 0) throw new Error("image has no dimensions")

        const pixels = canReadBack()
        const levels = []
        let scale = 1
        while (true) {
            const w = Math.max(1, Math.floor(width * scale))
            const h = Math.max(1, Math.floor(height * scale))
            const level = { w: w, h: h, scale: scale }
            if (pixels) {
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
        if (!handedOver) source.close()
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

interface Pending {
    resolve: (image: DecodedImage) => void
    reject: (reason: unknown) => void
    onProgress?: (value: number) => void
}

export class ImageDecoder {
    private worker: Worker
    private readonly pending = new Map<number, Pending>()
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
            const url = URL.createObjectURL(
                new Blob([WORKER_SOURCE], { type: "text/javascript" }),
            )
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
        type: "progress" | "needPixels" | "done" | "error" | "aborted"
        value?: number
        message?: string
        width?: number
        height?: number
        levels?: DecodedLevel[]
    }) {
        // No entry means this arrived after an abort. Buffers are plain memory; a surface is a
        // handle that is ours now, so it needs releasing.
        const entry = this.pending.get(message.id)
        if (!entry) {
            if (message.type === "done") {
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
            case "done":
                this.pending.delete(message.id)
                entry.resolve({
                    width: message.width!,
                    height: message.height!,
                    levels: message.levels!,
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
     * Fetch and decode [url] into per-level pixel buffers, mipped down to [tileSize].
     *
     * [onProgress] receives the download fraction, 0..1. Aborting [signal] rejects with
     * [DecodeAborted] and tells the worker to drop the transfer.
     */
    decode(
        url: string,
        tileSize: number,
        onProgress?: (value: number) => void,
        signal?: AbortSignal,
    ): Promise<DecodedImage> {
        if (this.dead) return Promise.reject(new Error("decode worker unavailable"))

        const id = this.nextId++

        // Absolute, because the worker's base is the `blob:` URL it was made from, and a blob URL
        // is not hierarchical - `/page/4186/12` has nothing to resolve against and `fetch` rejects
        // it. Only this side has the document's base. `baseURI`, not `location.href`, so a <base>
        // tag resolves the way its own markup would.
        const absolute = new URL(url, document.baseURI).href

        return new Promise<DecodedImage>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, onProgress })

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

            this.worker.postMessage({ type: "decode", id, url: absolute, tileSize })
        })
    }
}

/** Release any surface in [levels] - for a result nobody is going to upload. */
export function closeLevels(levels: DecodedLevel[]) {
    levels.forEach(level => level.bitmap?.close())
}
