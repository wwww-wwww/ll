/**
 * Whether the viewer is presenting HDR, and the texture format that follows from it.
 *
 * Two independent questions, and conflating them is the mistake to avoid. [supportedByDevice] is
 * fixed once a surface exists and is what the *decoder* keys off, because tone mapping at decode
 * is irreversible and a decoded page outlives whatever is on screen. [presentFormat] follows the
 * content, so an SDR-only stretch of a session costs what it always did.
 *
 * A `GPUCanvasContext` declares its own extended range at `configure()` (`format: "rgba16float"`
 * with `toneMapping: { mode: "extended" }`), so whatever configures the canvas reads
 * [presentFormat] and [desiredHeadroomRatio] from here and configures once.
 *
 * No browser API reports a panel's HDR/SDR brightness ratio, so [presentPeak] is always the
 * configured ceiling, never narrowed to what the panel offers.
 */
export class Hdr {
    private constructor() { }

    private static readonly RESOLVE_TIMEOUT_MS = 2000

    // ---- capability ----

    /**
     * Necessary but not sufficient: a browser hands out a float canvas on a panel with no HDR at
     * all, where it costs double the bandwidth to show the same picture. Hence [displaySupported],
     * which is independent of it.
     */
    private static surfaceSupported: boolean | null = null

    private static displaySupported: boolean | null = null

    private static resolved: Promise<boolean> | null = null
    private static resolvedDone: ((value: boolean) => void) | null = null

    static get supportedByDevice(): boolean {
        return Hdr.surfaceSupported === true && Hdr.displaySupported === true
    }

    /**
     * `(dynamic-range: high)` is the whole of what a browser exposes about the panel - no ratio,
     * no nit value, just a boolean. Call once a canvas exists.
     */
    static attachDisplay() {
        if (typeof matchMedia !== "function") {
            Hdr.displaySupported = false
            Hdr.publishIfResolved()
            return
        }
        try {
            Hdr.displaySupported = matchMedia("(dynamic-range: high)").matches
        } catch (e) {
            console.warn("Hdr: could not read display HDR capability", e)
            Hdr.displaySupported = false
        }
        Hdr.publishIfResolved()
    }

    /**
     * Kept from the first canvas to answer; a later one on the same device reports the same.
     *
     * There is no `GPUSurface.getCapabilities` to ask - a canvas context either accepts
     * `configure({ format: "rgba16float", toneMapping: { mode: "extended" } })` or throws, so a
     * disposable canvas is configured just to find out. Real work happens on [context] instead
     * once this has already resolved true.
     */
    static resolve(device: GPUDevice) {
        if (Hdr.surfaceSupported !== null) return

        Hdr.surfaceSupported = Hdr.probeSurfaceSupport(device)
        console.info("Hdr: surface support =", Hdr.surfaceSupported)
        Hdr.publishIfResolved()
    }

    private static probeSurfaceSupport(device: GPUDevice): boolean {
        if (typeof OffscreenCanvas === "undefined") return false
        try {
            const canvas = new OffscreenCanvas(1, 1)
            const context = canvas.getContext("webgpu") as GPUCanvasContext | null
            if (!context) return false
            context.configure({
                device,
                format: "rgba16float",
                // Chrome's extended-range canvas config - "toneMapping" is not yet in the
                // WebGPU types, hence the cast.
                ...({ toneMapping: { mode: "extended" } } as object),
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
                alphaMode: "premultiplied",
            } as GPUCanvasConfiguration)
            context.unconfigure()
            return true
        } catch (e) {
            console.warn("Hdr: could not configure a float canvas - staying in SDR", e)
            return false
        }
    }

    private static publishIfResolved() {
        if (Hdr.surfaceSupported !== null && Hdr.displaySupported !== null) Hdr.resolvedDone?.(Hdr.supportedByDevice)
    }

    /**
     * [supportedByDevice], waiting for a canvas rather than answering false because none has
     * arrived yet. The decode path can reach an image first, and answering wrong bakes
     * irreversible SDR into the early pages of a session.
     *
     * False after [RESOLVE_TIMEOUT_MS], which is also what a caller that never calls
     * [attachDisplay]/[resolve] gets.
     */
    static async awaitSupportedByDevice(): Promise<boolean> {
        if (Hdr.surfaceSupported !== null && Hdr.displaySupported !== null) return Hdr.supportedByDevice

        if (!Hdr.resolved) {
            Hdr.resolved = new Promise<boolean>(resolve => {
                Hdr.resolvedDone = resolve
            })
        }

        const timeout = new Promise<boolean>(resolve => {
            setTimeout(() => {
                console.warn(`Hdr: no canvas after ${Hdr.RESOLVE_TIMEOUT_MS}ms - decoding as SDR`)
                resolve(false)
            }, Hdr.RESOLVE_TIMEOUT_MS)
        })

        return Promise.race([Hdr.resolved, timeout])
    }

    // ---- peak / headroom ----

    /** Raising it trades highlight compression for brightness on a panel that can take it. */
    static maxPeakValue = 4

    /**
     * A ceiling, not a target: content below it keeps its own peak, so a 500-nit image stays a
     * 500-nit image. Only what the panel cannot show is compressed. Always the ceiling itself -
     * see the class doc.
     */
    static get presentPeak(): number {
        const ceiling = Hdr.maxPeakValue
        if (!Number.isFinite(ceiling)) return 1
        return Hdr.sane(ceiling)
    }

    /**
     * `1.0` - no compression - is what content already inside [presentPeak] gets.
     *
     * Log space rather than a clamp, as libultrahdr and the browsers do it, so highlights
     * compress smoothly instead of flattening at a ceiling.
     *
     * Both HDR paths come through here - a gain map weighted as it is applied, PQ and HLG
     * rescaled afterwards - so the two cannot drift apart.
     *
     * [minStops] generalises this to a gain map whose floor (`minContentBoost`) isn't 1.0.
     */
    static peakWeight(maxStops: number, minStops = 0): number {
        if (maxStops <= minStops) return 1
        const d = Math.min(Math.max(Math.log2(Hdr.presentPeak), minStops), maxStops)
        return Math.min(Math.max((d - minStops) / (maxStops - minStops), 0), 1)
    }

    // ---- content tracking ----

    /**
     * Weak, so a claim cannot outlive its image. An image whose page was turned away from before
     * its decode finished is dropped without anyone releasing it, and a strong claim would then
     * pin HDR on for the rest of the session.
     */
    private static readonly liveHdrClaims: { ref: WeakRef<object>; headroomStops: number }[] = []

    static get presentFormat(): GPUTextureFormat {
        return Hdr.supportedByDevice && Hdr.liveHdrCount > 0 && Hdr.hdrRecentlyDrawn
            ? "rgba16float"
            : "rgba8unorm"
    }

    /**
     * Rendered frames drawing no HDR image before presentation drops back to SDR.
     *
     * A claim says an image is *loaded*; being drawn says it is on screen. Presentation follows
     * the second, because a claim is only as reliable as the chain of teardown paths that releases
     * it - a page a cache never got round to evicting kept HDR on for the whole session.
     *
     * Counted in frames, not wall clock: an idle loop draws nothing, and a clock would expire
     * while a static HDR page sat on screen, then clip it on the next unrelated redraw.
     */
    private static readonly HDR_IDLE_FRAMES = 120

    private static framesWithoutHdr = 0

    /** Whether the past frame drew HDR, so [latchFrameFormat] knows if it has to poll. */
    private static hdrDrawn = false

    private static get hdrRecentlyDrawn(): boolean {
        return Hdr.framesWithoutHdr < Hdr.HDR_IDLE_FRAMES
    }

    /**
     * Called from the draw path for every HDR image actually drawn. [image]/[headroomStops], when
     * given, re-establish a claim missing without release - e.g. a cached image redrawn without
     * going through [retainHdrImage] again.
     */
    static noteHdrDrawn(image?: object, headroomStops = 0) {
        Hdr.hdrDrawn = true
        Hdr.framesWithoutHdr = 0
        if (image) Hdr.reclaimIfMissing(image, headroomStops)
    }

    private static reclaimIfMissing(image: object, headroomStops: number) {
        Hdr.pruneClaims()
        if (Hdr.liveHdrClaims.some(c => c.ref.deref() === image)) return
        Hdr.liveHdrClaims.push({ ref: new WeakRef(image), headroomStops })
        Hdr.markPresentationDirty()
        console.info("Hdr: HDR claim re-established for image drawn without one")
    }

    private static get liveHdrCount(): number {
        Hdr.pruneClaims()
        return Hdr.liveHdrClaims.length
    }

    /** Read every frame by way of [presentFormat], so leaks self-correct. */
    private static pruneClaims() {
        const before = Hdr.liveHdrClaims.length
        for (let i = Hdr.liveHdrClaims.length - 1; i >= 0; i--) {
            if (!Hdr.liveHdrClaims[i].ref.deref()) Hdr.liveHdrClaims.splice(i, 1)
        }
        const dropped = before - Hdr.liveHdrClaims.length
        if (dropped > 0) console.warn(`Hdr: ${dropped} HDR claim(s) collected without release`)
    }

    /**
     * The render loop is invalidate-driven, and only whatever configures the canvas re-declares
     * it - so content changing the answer has to wake it. Eviction is the case that matters: it
     * lands after a page turn's last frame, with the loop already parked.
     */
    static requestFrame: (() => void) | null = null

    private static presentationDirty = false

    private static markPresentationDirty() {
        Hdr.presentationDirty = true
        Hdr.requestFrame?.()
    }

    static get presenting(): boolean {
        return Hdr.presentFormat === "rgba16float"
    }

    /**
     * [presentFormat] latched for the current frame, and what every render target allocates
     * against. Decode work moves [presentFormat] mid-frame, and a target that outlives the change
     * is a use-after-free. Latch at the start of a frame, before anything sized against it.
     */
    static frameFormat: GPUTextureFormat = "rgba8unorm"

    /**
     * Take [presentFormat] for the frame about to be drawn; true when it moved. Frame boundary
     * only - nothing may still hold a resource allocated against the previous value.
     */
    static latchFrameFormat(): boolean {
        const drew = Hdr.hdrDrawn
        Hdr.hdrDrawn = false
        if (drew) Hdr.framesWithoutHdr = 0
        else if (Hdr.framesWithoutHdr < Hdr.HDR_IDLE_FRAMES) Hdr.framesWithoutHdr++

        const next = Hdr.presentFormat

        // Presenting HDR but nothing drew it: the loop is invalidate-driven, so it has to be
        // polled to reach the deadline. Only while idle - a frame that drew HDR implies the next
        // one is already coming, and polling then would render continuously for as long as an
        // HDR page is open.
        if (!drew && next === "rgba16float") Hdr.requestFrame?.()
        if (next === Hdr.frameFormat) return false
        Hdr.frameFormat = next
        return true
    }

    /** Call as soon as a decode finishes, so the canvas waits for the next frame. */
    static retainHdrImage(image: object, headroomStops: number) {
        Hdr.pruneClaims()
        Hdr.liveHdrClaims.push({ ref: new WeakRef(image), headroomStops })
        const count = Hdr.liveHdrClaims.length

        // Loaded is not drawn, but it is about to be, and its first frame would otherwise land in
        // an 8-bit target.
        Hdr.framesWithoutHdr = 0
        Hdr.markPresentationDirty()
        if (count === 1) {
            console.info(`Hdr: first HDR image loaded - HDR present, headroom ratio ${Hdr.desiredHeadroomRatio}`)
        }
    }

    static releaseHdrImage(image: object) {
        // By identity: by value would drop some other image's claim of the same headroom, and
        // every image compressed to the ceiling shares one.
        for (let i = Hdr.liveHdrClaims.length - 1; i >= 0; i--) {
            if (Hdr.liveHdrClaims[i].ref.deref() === image) Hdr.liveHdrClaims.splice(i, 1)
        }
        Hdr.pruneClaims()
        Hdr.markPresentationDirty()
        if (Hdr.liveHdrClaims.length === 0) console.info("Hdr: last HDR image freed - back to SDR present")
    }

    /**
     * [liveHdrClaims] would otherwise outlive any one viewer, being module-level state. Call when
     * a renderer starts, the one point where the true count is known to be zero.
     */
    static resetContent() {
        Hdr.framesWithoutHdr = 0
        Hdr.hdrDrawn = false
        const stranded = Hdr.liveHdrClaims.length
        Hdr.liveHdrClaims.length = 0
        Hdr.markPresentationDirty()
        if (stranded > 0) console.warn(`Hdr: ${stranded} HDR image(s) never released - count reset`)
    }

    static consumePresentationDirty(): boolean {
        if (!Hdr.presentationDirty) return false
        Hdr.presentationDirty = false
        return true
    }

    // ---- presentation ----

    /** Only guards against nonsense metadata; the compositor clamps to the panel regardless. */
    private static readonly MAX_HEADROOM_RATIO = 64

    /** Overrides [desiredHeadroomRatio] when set, for a caller that wants to pin the ratio. */
    static headroomRatioOverride: number | null = null

    /**
     * The same [presentPeak] the content was scaled to, so declared and drawn agree by
     * construction - what `configure()`'s `toneMapping` extended-range request should ask for.
     * Declaring the content's own headroom asked for 49x on a PQ grade.
     */
    static get desiredHeadroomRatio(): number {
        if (Hdr.headroomRatioOverride !== null) return Hdr.sane(Hdr.headroomRatioOverride)
        return Hdr.sane(Math.min(Hdr.liveHdrPeak, Hdr.presentPeak))
    }

    /**
     * The brightest live claim, as a multiple of SDR white; 1 when nothing HDR is loaded.
     *
     * Asked for rather than [presentPeak] because a compositor given a ratio dims SDR content to
     * afford it - so asking for four stops while the loaded images only reach one costs
     * brightness across the whole screen for headroom nothing draws into.
     */
    private static get liveHdrPeak(): number {
        Hdr.pruneClaims()
        let stops = 0
        for (const claim of Hdr.liveHdrClaims) {
            if (claim.ref.deref() && claim.headroomStops > stops) stops = claim.headroomStops
        }
        return stops > 0 && Number.isFinite(stops) ? Math.pow(2, stops) : 1
    }

    /** [MAX_HEADROOM_RATIO] only guards nonsense metadata; the finite check is the load-bearing half. */
    private static sane(ratio: number): number {
        return Number.isFinite(ratio) ? Math.min(Math.max(ratio, 1), Hdr.MAX_HEADROOM_RATIO) : 1
    }
}
