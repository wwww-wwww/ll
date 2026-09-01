import { Job, closeTo, coerceIn, launch } from "./webgpuviewer/util"
import { DecodeAborted, ImageDecoder, closeLevels } from "./webgpuviewer/decoder"
import { MIPMAP_TILE_SIZE, Image } from "./webgpuviewer/renderer/image"
import { applyDisplayCorrection } from "./webgpuviewer/filter/colormanagement"
import { WebGpuRenderer } from "./webgpuviewer/renderer/renderer"
import { Transition, invalidateCache } from "./webgpuviewer/transition/transition"
import {
    TransitionBasic,
    TransitionBasicVerticalInstance,
    TransitionCube,
    TransitionCubeOuter,
    TransitionDualFlip,
    TransitionFade,
    TransitionFadeWhite,
    TransitionFlipLeft,
    TransitionFlipRight,
    TransitionNone,
    TransitionSphere,
    TransitionStackDown,
    TransitionStackLeft,
    TransitionStackRight,
    TransitionStackUp,
} from "./webgpuviewer/transition/transitions"
import {
    DummyPage,
    ImagePage,
    ImageSingle,
    ImageSpread,
    RenderPageBase,
} from "./webgpuviewer/viewer/imagepage"
import { ImageViewerElement } from "./webgpuviewer/viewer/imageviewer"
import { ImageViewerContinuousState } from "./webgpuviewer/viewer/imageviewercontinuousstate"
import { UpscalerCatmullRom } from "./webgpuviewer"

/**
 * yuriyomi's reader - the port of Mihon's `WebGpuViewer.kt` onto this app's page model.
 *
 * The library underneath (`webgpuviewer/`) is the port of `ca.mpreg.webgpuviewer` and knows
 * nothing about either app: it asks for a page by index and draws whatever it gets. This is the
 * layer that decides *which* pages exist, when they load, and when they are thrown away.
 *
 * What carries over from the Kotlin more or less intact:
 *
 *  - **A bounded window.** Only `preloadBehind + 1 + preloadAhead` pages are ever cached, and
 *    nothing outside it is even fetched - and leaving the window aborts a transfer still in
 *    flight. This is the part yuriyomi was missing: the hook used to set `src` on every `<img>` in
 *    the chapter at mount, so opening a page one started every download at once, uncancellably.
 *  - **LIFO decoding.** [decodeQueue] is drained newest-first, so the page the reader is actually
 *    looking at jumps the queue instead of waiting behind a speculative preload. Unlike the
 *    Kotlin's single decode thread, a few drain at once - see [startWorkers] for why that became
 *    the right call once the work left the main thread.
 *  - **Distance-based eviction.** [evictFarthest] walks outward from the current page and drops
 *    the furthest cached page, never the current one and never what a running turn is animating
 *    away from ([pinnedFrom]).
 *  - **Placeholders that occupy their own half.** Every *file* gets its own [ProgressPage] while
 *    it loads and its own [ErrorPage] if it fails, so a spread's two halves - separate downloads
 *    that finish at different times - report and fail independently, and a spread composes
 *    whatever each side is currently holding rather than waiting for both.
 *  - **Fit modes and wide-page zoom**, from `applyFitModeAnchor`/`applyWideZoomIfNeeded`.
 *  - **Spread pairing** via [SpreadPosition], and navigation by spread rather than by file.
 *
 * What is app-shaped and therefore different: Mihon walks a chapter graph through `prev`/`next`
 * getters, because a page's neighbour can live in another chapter that may not be loaded yet.
 * yuriyomi is handed one chapter's files up front, so the page list is just an array and
 * neighbours are index ± 1. Chapter boundaries are the LiveView hook's business, not this file's.
 */

/** Which half of a spread a page belongs on - see [buildSpreadPage]. */
export const enum SpreadPosition {
    Left = "left",
    Right = "right",
    Single = "single",
}

/**
 * How much of a page's loading ring the download owns, the rest belonging to the decode.
 *
 * The decode - `createImageBitmap`, then the trim scan and mip pyramid in `Image.create` - is real
 * work with no progress signal of its own, so it gets the tail of the ring rather than letting the
 * bytes claim the whole thing and then appearing to stall at 100%.
 */
const DOWNLOAD_SHARE = 0.9

/** True for the rejection an [AbortController] produces, which is a cancellation, not a failure. */
function isAbort(e: unknown): boolean {
    return e instanceof DecodeAborted || (e instanceof DOMException && e.name === "AbortError")
}

/** Page processing state, as `WebGpuViewer.PageState`. */
const enum PageState {
    Idle,
    Queued,
    Loading,
    Decoding,
}

/** How a page's home transform is chosen - `config.imageScaleType`. */
export type FitMode = "fit-screen" | "fit-width" | "fit-height" | "original"

/** Where a zoomed-in page starts horizontally - `ZoomStartPosition`. */
export type ZoomStart = "left" | "right" | "center"

/** Every animation `ReaderPreferences.TransitionAnimation` offers. */
export type TransitionName =
    | "default"
    | "fade"
    | "fade-white"
    | "flip-left"
    | "flip-right"
    | "dual-flip"
    | "stack-up"
    | "stack-down"
    | "stack-left"
    | "stack-right"
    | "cube-inside"
    | "cube-outside"
    | "sphere"
    | "none"

export interface ViewerConfig {
    /** Pages to keep and prefetch ahead of / behind the current one. */
    preloadAhead: number
    preloadBehind: number
    fitMode: FitMode
    zoomStart: ZoomStart
    /** `config.landscapeZoom` - a double-page scan zooms to one half on a portrait screen. */
    landscapeZoom: boolean
    /** `config.imageCropBorders` - trim uniform margins off each page. */
    cropBorders: boolean
    /** `config.automaticBackground` - infer each page's letterbox colour from its own edges. */
    automaticBackground: boolean
    /** When set, and [automaticBackground] is off, every page uses this ARGB colour. */
    backgroundColor: number
    /** `config.navigateToPan` - a tap at the edge pans a zoomed page before turning it. */
    navigateToPan: boolean
    /** Pages decoded at once. See [Viewer.startWorkers]. */
    decodeConcurrency: number
    transition: TransitionName
    /** Right-to-left reading. */
    reversed: boolean
    vertical: boolean
    /**
     * `WebGpuViewer.isContinuous` - pages stack and scroll as one document.
     *
     * Fixed for the life of the element: the state object differs (see [Viewer.setContinuous]) and
     * swapping it after connect would leave the old frame loop running.
     */
    continuous: boolean
    /** Compose spreads out of `order`-paired files. */
    dualPage: boolean
    /**
     * Apply the display's colour transform to the frame - see `filter/colormanagement.ts`. Only
     * does anything on Firefox, and costs a probe the first time it is on.
     *
     * Off here, on in the reader: `chk_3dlut` is what a viewer in the page follows (`bindSetting` in
     * hooks.ts), applied just after the element is built. On here too would start the probe for a
     * reader about to switch it off.
     */
    colorManagement: boolean
}

const DEFAULT_CONFIG: ViewerConfig = {
    preloadAhead: 3,
    preloadBehind: 2,
    fitMode: "fit-screen",
    zoomStart: "center",
    landscapeZoom: false,
    cropBorders: false,
    automaticBackground: false,
    backgroundColor: 0,
    navigateToPan: false,
    // Most of a page's time is spent waiting rather than working, so a few at once fills the
    // preload window far sooner; past a handful the network is the limit anyway.
    decodeConcurrency: 3,
    transition: "dual-flip",
    reversed: false,
    vertical: false,
    continuous: false,
    dualPage: true,
    colorManagement: false,
}

/**
 * One page of the chapter: the files it is made of, whatever [ImagePage] currently stands for it,
 * and where it is in the load/decode pipeline. `WebGpuViewer.ViewerReaderPage`.
 */
class ViewerPage {
    state = PageState.Idle

    /** A [ProgressPage] until the decode lands, then an [ImageSingle]. */
    imagePage: ImagePage

    /** Cached spread when this page is the anchor of one - `ViewerReaderPage.spreadPage`. */
    spreadPage: ImageSpread | null = null

    /**
     * The in-flight transfer per file, so eviction can cancel one that is no longer wanted.
     *
     * Nothing decoded is kept here. The bytes become an [ImageBitmap], the bitmap becomes GPU
     * textures, and the bitmap is closed straight after - see [Viewer.decodeSlot].
     */
    aborts: (AbortController | null)[] = []

    /**
     * The [ProgressPage] standing in for each file, by slot, while it loads.
     *
     * One per file rather than one per page: a spread's two halves are separate downloads that
     * finish at different times, so they get separate rings that fill independently. A single ring
     * across both would have to average two unrelated transfers into one meaningless number.
     */
    progress: (ProgressPage | null)[] = []

    constructor(
        /** Index into the viewer's page list. */
        readonly index: number,
        /** URLs this page draws, in `[left, right]` or `[single]` order. */
        readonly urls: (string | null)[],
        /** First file index this page covers, for the hook's page counter and URL. */
        readonly fileIndex: number,
        /**
         * Which half of a spread this page needs, for pairing. A page holding *both* halves is
         * [SpreadPosition.Single]: it is already whole, so it must not go looking for a partner.
         * [pair] is what separates that case from a genuinely single page.
         */
        readonly spreadPosition: SpreadPosition,
        /** True when this page is a complete two-file spread - a wide scan, in effect. */
        readonly pair: boolean,
        placeholder: ImagePage,
    ) {
        this.imagePage = placeholder
    }

    /**
     * True once this page has nothing left to load. An [ErrorPage] counts: retrying is the host's
     * business, and leaving it false would have the worker spin on it forever.
     */
    get isDecoded(): boolean {
        return this.progress.length === 0 && this.imagePage.isDecoded
    }
}

/**
 * The loading ring shown in a page's place - `WebGpuViewer.ProgressPage`.
 *
 * Sized to its own half when it stands in for one side of a spread, so the ring is scaled for the
 * space it occupies rather than for the whole screen.
 *
 * The background is transparent by default: a page that has not arrived yet should leave whatever
 * is behind the canvas showing, rather than painting a slab over it. The ring itself carries its
 * own contrast.
 */
export class ProgressPage extends RenderPageBase {
    private _progress = 0
    private _background: number

    constructor(
        width: number,
        height: number,
        background: number,
        public foreground: number,
    ) {
        super(width, height)
        this._background = background
        this.minScale = 1
        this.maxScale = 1
        this.homeScale = 1
    }

    get progress(): number {
        return this._progress
    }

    set progress(value: number) {
        this._progress = value
        this.invalidate()
    }

    override get backgroundColor(): number | null {
        return this._background
    }

    override render(dst: GPUTexture, x: number, y: number, scale: number) {
        const cx = dst.width * (0.5 + scale * x)
        const cy = dst.height * (0.5 + scale * y)

        // Off this page's own width, not dst's: a spread half would otherwise draw a ring sized
        // for the whole screen, straight over its partner.
        const full = this.width * 0.5 * scale

        this.circle(cx, cy, full / 2, 0xaaaaaaaa | 0)

        const diameter = full * coerceIn(this._progress, 0, 1)
        if (diameter > 0) this.circle(cx, cy, diameter / 2, this.foreground)
    }
}

/** A failed page, with the reason on it - `WebGpuViewer.ErrorPage`. */
export class ErrorPage extends RenderPageBase {
    private _message: string
    private _background: number

    constructor(
        width: number,
        height: number,
        background: number,
        public foreground: number,
        message: string,
    ) {
        super(width, height)
        this._message = message
        this._background = background
        this.minScale = 1
        this.maxScale = 1
        this.homeScale = 1
    }

    get message(): string {
        return this._message
    }

    set message(value: string) {
        this._message = value
        this.invalidate()
    }

    override get backgroundColor(): number | null {
        return this._background
    }

    override render(dst: GPUTexture, x: number, y: number, scale: number) {
        const dpr = window.devicePixelRatio
        const padding = 24 * dpr
        const size = scale * 16 * dpr

        this.text(
            dst,
            this._message,
            dst.width * (0.5 + scale * x),
            dst.height * (0.5 + scale * y),
            size,
            this.foreground,
            { align: "center", maxWidth: dst.width - 2 * padding },
        )
    }
}

export class Viewer extends ImageViewerElement {
    readonly config: ViewerConfig = { ...DEFAULT_CONFIG }

    /**
     * Colours placeholders paint themselves in - the reader theme, in effect.
     *
     * [progressBackground] is separate from [themeBackground] because the two placeholders want
     * different things: a loading ring should leave the page behind it showing (transparent), while
     * an error message needs something opaque to be legible against.
     */
    themeBackground = 0xff000000 | 0
    themeForeground = 0xffffffff | 0
    progressBackground = 0

    /** Every page of the chapter, in reading-position order. Built by [setPages]. */
    private pageList: ViewerPage[] = []

    /**
     * The window of pages currently held, keyed by page index.
     *
     * Bounded to [cacheSize]: anything outside is evicted and its GPU memory freed, and its `<img>`
     * dropped so the browser can release the decoded bitmap too.
     */
    private readonly pageCache = new Map<number, ViewerPage>()

    /** Pages waiting to decode, drained newest-first - `WebGpuViewer.decodeQueue`. */
    private readonly decodeQueue: ViewerPage[] = []
    /** Drain loops currently running. See [startWorkers] for why there is more than one. */
    private readonly workers = new Set<Job>()

    /**
     * How many slots are mid-load. Tile generation is suspended while this is non-zero.
     *
     * A settled page queues its whole tile range at once - around a hundred render passes - and
     * that is exactly when the next pages are uploading. Letting the two overlap fills the GPU
     * queue and frames stop presenting on time, whatever the CPU side is doing. Sharpening can
     * wait the moment or two a load takes; the fast path is already drawing the page.
     */
    private loading = 0

    private beginLoad() {
        if (this.loading++ === 0) this.state.tiles.suspended = true
    }

    private endLoad() {
        if (--this.loading === 0) this.state.tiles.suspended = false
    }

    /** Current page index into [pageList]. */
    private currentIndex = 0

    /**
     * What a running page turn animates away from, kept out of [evictFarthest]'s reach - a jump
     * preloads enough pages to evict it. Replaced by the next turn's rather than cleared.
     */
    private pinnedFrom: ImagePage | null = null

    onPageChange: ((fileIndex: number) => void) | null = null
    onTap: ((x: number, y: number) => void) | null = null
    onLongTap: ((x: number, y: number) => void) | null = null

    constructor() {
        super()
        this.bindState()
    }

    /**
     * Install this viewer's callbacks on the current state.
     *
     * Called again by [setContinuous], which replaces the state object: these live on the state,
     * so a swap without re-binding leaves `fetchPage` null - and a state that cannot fetch a page
     * draws nothing at all.
     */
    /**
     * The upscaler both states share - see `Rescaler`. One instance, since a rescaler can own GPU
     * intermediates and [bindState] runs again for the continuous state.
     */
    private readonly upscaler = new UpscalerCatmullRom()

    /**
     * Bring the output filter chain in line with [config], from [bindState] and [configure]. The
     * chain belongs to the renderer, so both states share one and this is idempotent - see
     * `ImageViewerState.filters`.
     */
    private applyFilters() {
        applyDisplayCorrection(this.state.filters, () => this.config.colorManagement)
    }

    /**
     * [ViewerConfig.colorManagement], settable on its own: [configure] drops the page cache and
     * re-decodes, which a pass over the finished frame does not need. This redraws and stops
     * there.
     */
    get colorManagement(): boolean {
        return this.config.colorManagement
    }

    set colorManagement(on: boolean) {
        if (this.config.colorManagement === on) return
        this.config.colorManagement = on
        this.applyFilters()
        this.state.invalidate()
    }

    private bindState() {
        this.state.upscaler = this.upscaler

        this.applyFilters()

        // A pure lookup, as in Mihon's own `fetchPage`: admission belongs to [preloadAround].
        //
        // It used to admit through [acquire], which was harmless while only -1/0/+1 were ever
        // asked for. The continuous viewer walks up to MAX_VISIBLE_PAGES either way, so up to nine
        // indices per frame against a five-page window - every frame admitting pages that evict
        // each other, cancelling decodes and releasing pages still on screen. Eviction leaves a
        // fresh placeholder behind (see [release]), so a page outside the window still has
        // something to lay out and draw.
        this.state.fetchPage = delta => {
            const index = this.stepIndex(this.currentIndex, delta)
            if (index === null) return null
            const page = this.pageList[index]
            return page === undefined ? null : this.buildSpreadPage(page)
        }

        this.state.onPageChange = delta => {
            const index = this.stepIndex(this.currentIndex, delta)
            if (index === null) return
            // Synchronous: the state walks getPage() from here, so a stale currentIndex would
            // have the next step cross the same boundary again.
            this.currentIndex = index
            const page = this.pageCache.get(index) ?? this.pageList[index]

            // Everything else is posted. This fires from inside the turn's spring callback, and
            // admitting pages starts a decode - doing that here would land the work in the middle
            // of the frame that is animating. Mihon posts the same tail to its own scope, and for
            // the same reason.
            queueMicrotask(() => {
                if (this.currentIndex !== index) return
                this.preloadAround(index)
                if (page) this.onPageChange?.(page.fileIndex)
            })
        }

        this.state.onTap = position => this.onTap?.(position.x, position.y)
        this.state.onLongTap = position => this.onLongTap?.(position.x, position.y)

        // A resize changes every page's fit. Placeholders are also sized in screen pixels, so
        // they have to be rebuilt rather than just re-homed.
        this.state.onViewportChanged = () => {
            this.pageCache.forEach(page => {
                page.spreadPage?.cleanup()
                page.spreadPage = null
                if (page.progress.length > 0) this.resizePlaceholder(page)
                else page.imagePage.resetHome()
            })
            invalidateCache()
            this.state.invalidate()
        }
    }

    /** Acquires the GPU device before constructing, so the element is usable on return. */
    static async new(continuous: boolean = false): Promise<Viewer> {
        await WebGpuRenderer.initDevice()
        const element = document.createElement("canvas", { is: "webgpu-viewer" }) as Viewer
        if (continuous) element.setContinuous()
        return element
    }

    /**
     * Switch to continuous reading - `WebGpuViewerContinuous`.
     *
     * Before connect, so the swap lands before any loop starts. Also adopts that viewer's own
     * preload window (ahead 3, behind 1: scrolling only ever reveals what is below) and turns dual
     * page off, which is never active for a continuous viewer.
     */
    setContinuous() {
        this.continuousState = new ImageViewerContinuousState()
        this.replaceState(this.continuousState)
        // The callbacks live on the state object, so the new one needs them too.
        this.bindState()
        this.config.continuous = true
        this.config.vertical = true
        this.config.dualPage = false
        this.config.preloadAhead = 3
        this.config.preloadBehind = 1
    }

    /** The continuous state, or null in paged mode - the cast [state] would otherwise need. */
    private continuousState: ImageViewerContinuousState | null = null

    // -----------------------------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------------------------

    /**
     * Adopt [changes] and rebuild.
     *
     * `WebGpuConfig`'s `imagePropertyChangedListener` does the same: anything that changes how a
     * page is decoded or laid out invalidates every cached page, since their images were built
     * under the old settings.
     */
    configure(changes: Partial<ViewerConfig>) {
        Object.assign(this.config, changes)

        // Which mode this is follows the state object, never the other way round: it is fixed
        // before connect (see [setContinuous]), so a caller asking for the other one here would
        // otherwise leave the config describing a viewer that does not exist.
        this.config.continuous = this.continuousState !== null
        if (this.config.continuous) {
            // Not negotiable while continuous: dual page is never active for this mode, and the
            // axis is what the mode is.
            this.config.vertical = true
            this.config.dualPage = false
        }

        this.state.isReversed = this.config.reversed
        this.state.isVertical = this.config.vertical
        this.state.transition = this.transitionFor(this.config.transition)
        this.applyFilters()

        this.dropCache()
        this.preloadAround(this.currentIndex)
        this.state.invalidate()
    }

    private transitionFor(name: TransitionName): Transition {
        switch (name) {
            case "fade":
                return TransitionFade
            case "fade-white":
                return TransitionFadeWhite
            case "flip-left":
                return TransitionFlipLeft
            case "flip-right":
                return TransitionFlipRight
            case "dual-flip":
                return TransitionDualFlip
            case "stack-up":
                return TransitionStackUp
            case "stack-down":
                return TransitionStackDown
            case "stack-left":
                return TransitionStackLeft
            case "stack-right":
                return TransitionStackRight
            case "cube-inside":
                return TransitionCube
            case "cube-outside":
                return TransitionCubeOuter
            case "sphere":
                return TransitionSphere
            case "none":
                return TransitionNone
            default:
                // The slide, matching `TransitionAnimation.DEFAULT`.
                return this.config.vertical ? TransitionBasicVerticalInstance : TransitionBasic
        }
    }

    private get cacheSize(): number {
        return 1 + this.config.preloadAhead + this.config.preloadBehind
    }

    // -----------------------------------------------------------------------------------------
    // Page list
    // -----------------------------------------------------------------------------------------

    /**
     * Replace the chapter's pages.
     *
     * [order] is yuriyomi's own spread grouping, one entry per file: **0 is a right half, 1 is a
     * left half**, 2 is a standalone page. Right-first, because the file list is in reading order
     * and reading is right-to-left - so a spread arrives as 0 then 1. Mihon reads the same
     * information out of each image's EXIF `PageName` tag inside the decoder; here it arrives with
     * the file list, so the pairing is already decided and [SpreadPosition] just records it.
     *
     * Ignored entirely in continuous mode, where there are no spreads: a page fills the viewer's
     * width and the next one follows below it, so a half has nothing to pair with and no half-width
     * slot to sit in. Turning [ViewerConfig.dualPage] off is not enough on its own - that stops
     * [pairsWithNext] composing an [ImageSpread], but the grouping below would still emit
     * [SpreadPosition.Left]/[SpreadPosition.Right] pages with one empty slot, which is what drives
     * the half-width placeholders and the half-page fit.
     *
     * Nothing is fetched here. Only [preloadAround] starts loads, and only within the window.
     */
    setPages(urls: string[], order: number[] | null = null, startFileIndex: number = 0) {
        this.dropCache()
        this.pageList = []

        const grouping = this.config.continuous ? null : order

        if (grouping === null) {
            urls.forEach((url, i) =>
                this.pageList.push(
                    this.makePage(this.pageList.length, [url], i, SpreadPosition.Single),
                ),
            )
        } else {
            const remaining = [...grouping]
            let file = 0
            while (remaining.length > 0) {
                const o = remaining.shift()
                const at = file
                const push = (slots: (string | null)[], position: SpreadPosition) =>
                    this.pageList.push(this.makePage(this.pageList.length, slots, at, position))

                // `urls` per page is always [left slot, right slot], since that is the order
                // ImageSpread takes its sides in and the order they are drawn in. The file list is
                // in *reading* order, which right-to-left means the right half comes first - hence
                // the pair below storing its second file in slot 0.
                if (o === 0) {
                    if (remaining[0] === 1 && this.config.dualPage) {
                        remaining.shift()
                        const right = urls[file++]
                        const left = urls[file++]
                        // Both halves in one page, so it is already whole - see
                        // [ViewerPage.spreadPosition].
                        push([left, right], SpreadPosition.Single)
                    } else {
                        push([null, urls[file++]], SpreadPosition.Right)
                    }
                } else if (o === 1) {
                    push([urls[file++], null], SpreadPosition.Left)
                } else {
                    push([urls[file++]], SpreadPosition.Single)
                }
            }
        }

        this.currentIndex = Math.max(0, this.pageIndexOfFile(startFileIndex))
        invalidateCache()
        this.preloadAround(this.currentIndex)
        this.state.invalidate()
    }

    private makePage(
        index: number,
        urls: (string | null)[],
        fileIndex: number,
        position: SpreadPosition,
    ): ViewerPage {
        const pair = urls.length === 2 && urls[0] !== null && urls[1] !== null
        const page = new ViewerPage(index, urls, fileIndex, position, pair, new DummyPage(1, 1))
        this.resetPlaceholder(page)
        return page
    }

    /**
     * Give [page] a fresh set of loading rings - one per file it is made of.
     *
     * A complete pair gets a spread of two half-width rings, so each half reports its own download
     * and either can be replaced by its decoded image, or its error, without disturbing the other.
     * Anything else is a single ring occupying whatever space that page will.
     */
    private resetPlaceholder(page: ViewerPage) {
        page.progress = page.urls.map(url =>
            url === null ? null : this.newProgressPage(page.pair || !this.isFullWidth(page)),
        )

        if (page.pair) {
            page.imagePage = new ImageSpread(page.progress[0], page.progress[1])
        } else {
            // A lone half keeps its slot, so [buildSpreadPage] still lays it out on the right side.
            page.imagePage = page.progress.find(p => p !== null) ?? new DummyPage(1, 1)
        }
    }

    /**
     * Re-size a still-loading page's rings to the new viewport, keeping their progress.
     *
     * A [ProgressPage] is sized in screen pixels rather than content pixels, so unlike a decoded
     * page it cannot simply be re-homed - it has to be rebuilt at the new size.
     */
    private resizePlaceholder(page: ViewerPage) {
        const progress = page.progress.map(ring => ring?.progress ?? 0)
        const old = page.imagePage
        this.resetPlaceholder(page)
        page.progress.forEach((ring, slot) => {
            if (ring) ring.progress = progress[slot] ?? 0
        })
        old.cleanup()
    }

    /** True when a page occupies the whole viewport rather than one half of a spread. */
    private isFullWidth(page: ViewerPage): boolean {
        return page.spreadPosition === SpreadPosition.Single && !page.pair
    }

    /** A placeholder sized to the space it will occupy - half the screen for a spread side. */
    private newProgressPage(half: boolean): ProgressPage {
        return new ProgressPage(
            Math.max(1, Math.round(half ? (this.state.width || 2) / 2 : this.state.width || 1)),
            Math.max(1, this.state.height),
            this.progressBackground,
            this.themeForeground,
        )
    }

    private newErrorPage(half: boolean, message: string): ErrorPage {
        return new ErrorPage(
            Math.max(1, Math.round(half ? (this.state.width || 2) / 2 : this.state.width || 1)),
            Math.max(1, this.state.height),
            this.themeBackground,
            this.themeForeground,
            message,
        )
    }

    /** The page holding file [fileIndex], or 0 if there is none. */
    pageIndexOfFile(fileIndex: number): number {
        for (let i = this.pageList.length - 1; i >= 0; i--) {
            if (this.pageList[i].fileIndex <= fileIndex) return i
        }
        return 0
    }

    /** File index of the page currently shown - what the hook puts in the URL and the counter. */
    get page(): number {
        return this.pageList[this.currentIndex]?.fileIndex ?? 0
    }

    /**
     * The file index one page (not one file) away in [direction], or null past either end.
     *
     * For a host that navigates by file index but wants to step over a spread's two halves in one
     * go - the "is the next file the same page?" check `hooks.ts` used to do by hand.
     */
    stepFileIndex(direction: number): number | null {
        const index = this.stepIndex(this.currentIndex, Math.sign(direction))
        return index === null ? null : this.pageList[index].fileIndex
    }

    get pageCount(): number {
        return this.pageList.length
    }

    // -----------------------------------------------------------------------------------------
    // Window and cache
    // -----------------------------------------------------------------------------------------

    /** Page index [delta] pages from [from], or null past either end. */
    private stepIndex(from: number, delta: number): number | null {
        const index = from + delta
        if (index < 0 || index >= this.pageList.length) return null
        return index
    }

    /**
     * The cached page at [index], admitting it to the window if it isn't there - `getPage`.
     *
     * Admission is what trims the cache, so the reference for eviction is the page being admitted
     * rather than the current one: a jump lands outside the window and must not evict its own
     * target.
     */
    private acquire(index: number): ViewerPage | null {
        const page = this.pageList[index]
        if (!page) return null

        if (!this.pageCache.has(index)) {
            this.pageCache.set(index, page)
            while (this.pageCache.size > this.cacheSize) {
                if (!this.evictFarthest(index)) break
            }
        }
        return page
    }

    /** True while [pinnedFrom] is drawing [page]'s image, as itself or as a spread side. */
    private isPinned(page: ViewerPage): boolean {
        const pinned = this.pinnedFrom
        if (!pinned) return false
        const image = page.imagePage
        if (pinned === image) return true
        return pinned instanceof ImageSpread && (pinned.left === image || pinned.right === image)
    }

    /**
     * Evict the page furthest from [reference] - `evictFarthestPage`.
     *
     * Never the reference, never the current page, never what a running turn is animating away
     * from. Returns false when nothing was evictable, so a trim loop stops instead of spinning.
     */
    private evictFarthest(reference: number): boolean {
        return this.evictFarthestNow(reference)
    }

    private evictFarthestNow(reference: number): boolean {
        let victim: number | null = null
        let bestDistance = -1

        for (const [index, page] of this.pageCache) {
            if (index === reference || index === this.currentIndex) continue
            if (this.isPinned(page)) continue
            const distance = Math.abs(index - reference)
            if (distance > bestDistance) {
                bestDistance = distance
                victim = index
            }
        }

        if (victim === null) return false

        const page = this.pageCache.get(victim)!
        this.pageCache.delete(victim)

        const queued = this.decodeQueue.indexOf(page)
        if (queued >= 0) this.decodeQueue.splice(queued, 1)
        page.state = PageState.Idle

        this.release(page)
        return true
    }

    /**
     * Give up everything [page] is holding and put it back to a fresh set of loading rings.
     *
     * Shared by eviction and by a config change, which invalidate a page's decoded images for
     * different reasons but leave it in the same state either way.
     */
    private release(page: ViewerPage) {
        page.state = PageState.Idle
        page.spreadPage?.cleanup()
        page.spreadPage = null
        page.imagePage.cleanup()
        this.resetPlaceholder(page)
        // Stop paying for bytes nobody is waiting for any more. This is what an <img> could never
        // do: setting src away from a partly-loaded image does not reliably cancel the request.
        page.aborts.forEach(controller => controller?.abort())
        page.aborts = []
    }

    /** Free every cached page - a config change invalidates all of their decoded images. */
    private dropCache() {
        this.decodeQueue.length = 0
        this.pageCache.forEach(page => this.release(page))
        this.pageCache.clear()
        this.pinnedFrom = null
        invalidateCache()
    }

    /**
     * Admit and queue the window around [index] - `preloadPages`.
     *
     * Priority order matches the Kotlin's: behind first (lowest), then ahead, then the current
     * page and its spread partner last with the priority flag, since the queue is drained from
     * the back.
     */
    private preloadAround(index: number) {
        const { preloadAhead, preloadBehind } = this.config

        for (let i = preloadBehind; i >= 1; i--) {
            const at = this.stepIndex(index, -i)
            if (at !== null) this.enqueue(at, false)
        }
        for (let i = preloadAhead; i >= 1; i--) {
            const at = this.stepIndex(index, i)
            if (at !== null) this.enqueue(at, false)
        }

        // The partner shares the seam, so it is wanted as urgently as the anchor itself.
        const next = this.stepIndex(index, 1)
        if (next !== null && this.pairsWithNext(index)) this.enqueue(next, true)
        this.enqueue(index, true)

        // Only now, with the whole batch queued. Starting a loop from inside [enqueue] instead
        // let it claim a speculative preload before the prioritised entries existed - with one
        // loop that merely delayed them by a page, but with several it meant the page the reader
        // is actually looking at decoded last.
        this.startWorkers()
    }

    /** True when page [index] and the next one make up one spread. */
    private pairsWithNext(index: number): boolean {
        if (!this.config.dualPage) return false
        const page = this.pageList[index]
        const next = this.pageList[index + 1]
        if (!page || !next) return false
        const anchor = this.config.reversed ? SpreadPosition.Right : SpreadPosition.Left
        const partner = this.config.reversed ? SpreadPosition.Left : SpreadPosition.Right
        return page.spreadPosition === anchor && next.spreadPosition === partner
    }

    /** `queueForDecode` - admit the page and put it in the queue, or move it forward. */
    private enqueue(index: number, prioritize: boolean) {
        const page = this.acquire(index)
        if (!page) return
        if (page.isDecoded) return

        switch (page.state) {
            case PageState.Idle: {
                page.state = PageState.Queued
                // The worker takes from the back, so a prioritised page goes there.
                if (prioritize) this.decodeQueue.push(page)
                else this.decodeQueue.unshift(page)
                break
            }
            case PageState.Queued: {
                if (prioritize) {
                    const at = this.decodeQueue.indexOf(page)
                    if (at >= 0) {
                        this.decodeQueue.splice(at, 1)
                        this.decodeQueue.push(page)
                    }
                }
                break
            }
            default:
                // Already being processed.
                break
        }
    }

    // -----------------------------------------------------------------------------------------
    // Decode worker
    // -----------------------------------------------------------------------------------------

    /**
     * Drain the queue, newest request first, up to [ViewerConfig.decodeConcurrency] pages at once.
     *
     * The Kotlin has a single decode thread, and this followed it: with `getImageData` and a JS mip
     * filter on the main thread, running pages concurrently only interleaved their blocking work.
     * None of that is on the main thread any more - profiling puts a page's whole main-thread share
     * at about 6ms - so serialising buys nothing and costs latency. A page is ~210ms of mostly
     * *waiting* (fetch, then an off-thread decode), and six in sequence left the preload window a
     * second and a half behind a reader turning pages quickly.
     *
     * Several loops over one LIFO queue rather than a queue each, so the priority ordering still
     * holds: whichever page the reader is looking at is pulled first, whichever loop gets there.
     *
     * No parking - a loop that finds the queue empty just ends, and [enqueue] starts fresh ones.
     */
    private startWorkers() {
        while (
            this.workers.size < Math.max(1, this.config.decodeConcurrency) &&
            this.decodeQueue.length > 0
        ) {
            const job: Job = launch(async j => {
                try {
                    await this.drain(j)
                } finally {
                    this.workers.delete(job)
                }
            })
            this.workers.add(job)
        }
    }

    private async drain(job: Job) {
        while (!job.cancelled) {
            const page = this.decodeQueue.pop()
            if (!page) return

            page.state = PageState.Decoding

            // Verify the page is still wanted - it may have been evicted while queued.
            if (this.pageCache.get(page.index) !== page || page.isDecoded) {
                page.state = PageState.Idle
                continue
            }

            try {
                await this.decodePage(page)
            } catch (e) {
                // Per-file failures never reach here - decodeSlot turns those into an
                // ErrorPage in that file's own half. This is for anything that went wrong
                // around the slots, which takes the whole page with it.
                console.error(`Viewer: failed to decode page ${page.index}`, e)
                if (this.pageCache.get(page.index) === page && !page.imagePage.destroyed) {
                    const old = page.imagePage
                    page.imagePage = this.newErrorPage(
                        !this.isFullWidth(page),
                        e instanceof Error ? e.message : "Failed to load image",
                    )
                    page.spreadPage = null
                    page.progress = []
                    page.state = PageState.Idle
                    old.cleanup()
                    page.imagePage.attach(this.state, () => this.state.invalidate())
                    this.state.invalidate()
                } else {
                    page.state = PageState.Idle
                }
            }
        }
    }

    /**
     * Load and decode [page] - `decodeReaderPage` plus `startPageLoad`.
     *
     * Setting `src` is what starts the fetch, so it happens here rather than when the page list is
     * built: a page outside the window is never requested at all. `decode()` waits for the browser
     * to produce a bitmap, and progress comes from the element's own load events - the closest
     * thing here to Mihon's `progressFlow`.
     */
    private async decodePage(page: ViewerPage) {
        page.state = PageState.Loading

        // Each file resolves to its own ImagePage - decoded, or an ErrorPage if that one file
        // failed. A pair's halves are separate downloads, so one failing must not take the other
        // down with it, and the one that lands first shows its ring finishing on its own side.
        const halves = await Promise.all(
            page.urls.map((url, slot) => this.decodeSlot(page, url, slot)),
        )

        // Evicted while the fetch was in flight.
        if (this.pageCache.get(page.index) !== page || page.imagePage.destroyed) {
            halves.forEach(half => half?.cleanup())
            page.state = PageState.Idle
            return
        }

        // A lone half keeps its slot, so the spread still lays it out on the correct side.
        const imagePage =
            page.urls.length === 1 ?
                (halves[0] ?? new DummyPage(1, 1))
                : new ImageSpread(halves[0], halves[1])

        const old = page.imagePage
        page.imagePage = imagePage
        page.spreadPage = null
        page.progress = []
        page.state = PageState.Idle

        imagePage.attach(this.state, () => this.state.invalidate())

        // Fit modes are about one image's dimensions, so a spread of two independently-sized
        // halves is left at its own fitted scale.
        if (imagePage instanceof ImageSingle && !(imagePage instanceof ImageSpread)) {
            if (!this.applyWideZoom(imagePage)) this.applyFitMode(imagePage)
        }

        old.cleanup()
        // Fade up from the placeholder's colour, if that placeholder was on screen - one that
        // decoded out of view has nothing left to fade from.
        if (old.isOnScreen) imagePage.fadeIn()

        this.state.invalidate()
    }

    /**
     * Fetch, decode and wrap the file in [slot], reporting into that slot's own loading ring.
     *
     * Returns an [ErrorPage] rather than throwing when this one file fails, so the rest of the
     * page still appears - the whole-page failure path in [startWorker] only catches what happens
     * outside a slot.
     */
    private async decodeSlot(
        page: ViewerPage,
        url: string | null,
        slot: number,
    ): Promise<ImagePage | null> {
        if (url === null) return null

        const half = page.pair || !this.isFullWidth(page)
        const ring = page.progress[slot]
        let bitmap: ImageBitmap | null = null
        let controller: AbortController | null = null

        // Trim and the edge probe are the only passes that need CPU pixels, and the worker exists
        // to keep those off the main thread entirely - so when either is asked for, decoding falls
        // back in place rather than paying to ship pixels across a thread boundary and back.
        const trimColors =
            this.config.cropBorders && this.isFullWidth(page) ?
                [
                    [1, 1, 1],
                    [0, 0, 0],
                ]
                : null
        const needsPixels = trimColors !== null || this.config.automaticBackground
        const decoder = needsPixels ? null : ImageDecoder.shared()

        this.beginLoad()
        try {
            controller = new AbortController()
            page.aborts[slot] = controller

            let image: Image | null = null
            if (decoder) {
                try {
                    const decoded = await decoder.decode(
                        url,
                        MIPMAP_TILE_SIZE,
                        value => {
                            if (ring) ring.progress = DOWNLOAD_SHARE * value
                        },
                        controller!.signal,
                    )
                    if (ring) ring.progress = 1
                    // Evicted while decoding.
                    if (this.pageCache.get(page.index) !== page) {
                        closeLevels(decoded.levels)
                        decoder.recycle(decoded.levels)
                        return null
                    }
                    try {
                        image = await Image.fromDecoded(
                            decoded,
                            this.config.backgroundColor,
                            MIPMAP_TILE_SIZE,
                        )
                    } finally {
                        // The upload is done with them either way - back to the pool, so this thread
                        // never frees a page-sized buffer. See ImageDecoder.recycle.
                        decoder.recycle(decoded.levels)
                    }
                } catch (e) {
                    if (isAbort(e)) throw e
                    // The worker is an optimisation, not a dependency. Anything it can't do -
                    // a blocked fetch, a codec it lacks, a broken environment - falls through to
                    // the in-place path, which fails properly if the page really is unreadable.
                    console.warn(
                        `Viewer: worker decode failed for page ${page.index}, retrying in place`,
                        e,
                    )
                }
            }

            if (!image) {
                bitmap = await this.download(page, url, slot, controller)
                // Aborted, or the page was evicted while the bytes were arriving.
                if (!bitmap) return null
                if (this.pageCache.get(page.index) !== page) return null

                image = await Image.fromBitmap(bitmap, {
                    trimColors,
                    trimThreshold: 0.15,
                    backgroundColor:
                        this.config.automaticBackground ? null : this.config.backgroundColor,
                })
            }

            if (this.pageCache.get(page.index) !== page) {
                image.cleanup()
                return null
            }

            return new ImageSingle(image)
        } catch (e) {
            if (isAbort(e)) return null
            console.error(`Viewer: failed to decode file ${slot} of page ${page.index}`, e)
            return this.newErrorPage(
                half,
                e instanceof Error && e.message ? e.message : "Failed to load image",
            )
        } finally {
            this.endLoad()
            // The pixels live in the GPU textures from here on; the bitmap was only ever the way
            // in. Holding it would roughly double this page's memory for nothing, and a page that
            // comes back after eviction refetches from the HTTP cache anyway.
            bitmap?.close()
            // Only if it is still ours. A page evicted and re-admitted can have a second transfer
            // running by the time this one unwinds, and clearing that one's controller would leave
            // it uncancellable.
            if (page.aborts[slot] === controller) page.aborts[slot] = null
        }
    }

    /**
     * Fetch [url] as bytes, reporting real download progress into slot [slot]'s ring, then decode
     * it to an [ImageBitmap].
     *
     * This is the `startPageLoad` half of Mihon's `decodeReaderPage` - and the reason it is a
     * `fetch` and a stream reader rather than an `<img>`. An `<img>` reports load as a single
     * event, so the ring could only ever jump from nothing to done; reading `response.body` gives
     * the byte counter `page.progressFlow` supplies on Android, and an [AbortController] gives
     * eviction a way to actually cancel a transfer that is no longer wanted.
     *
     * Returns null if the transfer was aborted. `createImageBitmap` does the decode off the main
     * thread, which `<img>.decode()` only promises to try.
     */
    private async download(
        page: ViewerPage,
        url: string,
        slot: number,
        controller: AbortController,
    ): Promise<ImageBitmap | null> {
        const ring = page.progress[slot]

        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)

        // Content-Length is what makes the progress a real fraction. It is absent for a chunked or
        // compressed response - images aren't normally either, but when it happens the ring holds
        // at DECODE_SHARE rather than reporting a number it cannot know.
        const total = Number(response.headers.get("content-length") ?? 0)
        const body = response.body

        let blob: Blob
        if (!body || !Number.isFinite(total) || total <= 0) {
            blob = await response.blob()
            if (ring) ring.progress = DOWNLOAD_SHARE
        } else {
            const reader = body.getReader()
            const chunks: Uint8Array[] = []
            let received = 0
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                chunks.push(value)
                received += value.length
                // The decode is real work too, so the bytes only own the first slice of the ring.
                if (ring) ring.progress = DOWNLOAD_SHARE * Math.min(received / total, 1)
            }
            blob = new Blob(chunks as BlobPart[], {
                type: response.headers.get("content-type") ?? "",
            })
        }

        if (this.pageCache.get(page.index) !== page) return null

        const bitmap = await createImageBitmap(blob)
        if (ring) ring.progress = 1
        return bitmap
    }

    // -----------------------------------------------------------------------------------------
    // Fit modes
    // -----------------------------------------------------------------------------------------

    /**
     * `applyWideZoomIfNeeded` - a double-page scan on a portrait screen starts zoomed to one half
     * rather than shrunk to fit the whole spread.
     */
    private applyWideZoom(page: ImageSingle): boolean {
        if (!this.config.landscapeZoom) return false

        const screenW = this.state.width
        const screenH = this.state.viewportHeight
        if (screenW <= 0 || screenH <= 0) return false

        // Don't zoom if it fits at original scale.
        if (page.trimWidth <= screenW) return false

        const image = page.image
        if (!image) return false

        const aspectRatio = Math.min(page.trimWidth / page.trimHeight, image.width / image.height)

        // Wide page: half the image width is wider than the screen aspect ratio.
        if (aspectRatio <= (2 * screenW) / screenH) return false

        // Positioning needs the parent.
        page.parent = this.state

        // Scale to fit half the image width to the full screen width.
        page.homeScale = screenW / (page.trimWidth / 2)
        page.scale = page.homeScale
        page.x = this.startX(page, page.homeScale)
        page.y = page.homeY

        return true
    }

    /** `applyFitModeAnchor` - fit-width / fit-height / original, and where the page starts. */
    private applyFitMode(page: ImageSingle) {
        const mode = this.config.fitMode
        if (mode === "fit-screen") return

        const screenW = this.state.width
        const screenH = this.state.viewportHeight
        if (screenW <= 0 || screenH <= 0) return

        const w = page.trimWidth
        const h = page.trimHeight
        if (w <= 0 || h <= 0) return

        page.parent = this.state

        const scale =
            mode === "fit-width" ? screenW / w
                : mode === "fit-height" ? screenH / h
                    : 1
        page.homeScale = Math.max(0.01, scale)
        page.scale = page.homeScale

        if (mode === "original" && page.homeScale < page.minScale) {
            page.minScale = page.homeScale
        }

        page.x = this.startX(page, page.homeScale)
        page.y = page.homeY
    }

    private startX(page: ImagePage, scale: number): number {
        switch (this.config.zoomStart) {
            case "left":
                return page.maxX(scale)
            case "right":
                return page.minX(scale)
            default:
                return 0
        }
    }

    // -----------------------------------------------------------------------------------------
    // Spreads
    // -----------------------------------------------------------------------------------------

    /**
     * `buildSpreadPage` - compose [page] with its partner when the two make a spread.
     *
     * Whatever each side is holding takes its half of the seam, decoded or not: an [ImageSpread]
     * draws a self-rendering side into its own half, and a side left out would take the whole
     * viewport instead, hiding its partner with it. The existing spread is reused when both sides
     * are unchanged, which is what preserves its pan/zoom across frames.
     */
    private buildSpreadPage(page: ViewerPage): ImagePage {
        if (!this.config.dualPage) return page.imagePage
        if (page.spreadPosition === SpreadPosition.Single) {
            page.spreadPage = null
            return page.imagePage
        }

        // A page whose own decode produced a spread already holds both halves.
        if (page.imagePage instanceof ImageSpread) return page.imagePage

        const anchor = this.config.reversed ? SpreadPosition.Right : SpreadPosition.Left
        const partnerPosition = this.config.reversed ? SpreadPosition.Left : SpreadPosition.Right

        // Only the anchor side looks for a partner on the next page. A partner-tagged page only
        // reaches here directly when it has no anchor before it - a lone right half at a chapter
        // boundary - so it renders alone on its own side.
        const partner =
            page.spreadPosition === anchor ?
                (() => {
                    const next = this.pageList[page.index + 1]
                    if (!next || next.spreadPosition !== partnerPosition) return null
                    return this.acquire(next.index)?.imagePage ?? null
                })()
                : null

        // Left/right map directly to the spread's slots - independent of reading direction, which
        // only decides which side is the anchor for pairing purposes above.
        const left = page.spreadPosition === SpreadPosition.Left ? page.imagePage : partner
        const right = page.spreadPosition === SpreadPosition.Right ? page.imagePage : partner

        const existing = page.spreadPage
        if (existing && existing.left === left && existing.right === right) return existing

        const spread = new ImageSpread(left, right)
        page.spreadPage = spread
        return spread
    }

    // -----------------------------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------------------------

    invalidate() {
        this.state.invalidate()
    }

    /** Jump to the page holding file [fileIndex], animating the turn if it is adjacent. */
    set_page(fileIndex: number) {
        this.moveToIndex(this.pageIndexOfFile(fileIndex))
    }

    /** `moveToPage` - go to page [index], sliding if the move is one step. */
    moveToIndex(index: number) {
        if (index < 0 || index >= this.pageList.length) return

        const previous = this.currentIndex
        if (previous === index) {
            this.invalidate()
            return
        }

        // Pin before preloading: resolving a target outside the cached window trims the cache,
        // and the page being turned away from has to survive the animation.
        const from = this.pageCache.get(previous)
        this.pinnedFrom = from ? this.buildSpreadPage(from) : null

        this.currentIndex = index
        this.preloadAround(index)
        this.onPageChange?.(this.pageList[index].fileIndex)

        const direction = Math.sign(index - previous)

        // `WebGpuViewerContinuous.moveToPage`/`animateTurn`: the new page starts at its own top,
        // and the jump is announced by sliding it in rather than by a page turn. resetScroll runs
        // even for a jump to the page already showing, which has nothing to slide.
        const continuous = this.continuousState
        if (continuous) {
            continuous.resetScroll()
            invalidateCache()
            if (direction !== 0) continuous.animateSlideIn(direction)
            this.invalidate()
            return
        }

        if (direction !== 0 && this.pinnedFrom) {
            this.state.transitionFromPage = this.pinnedFrom
            this.state.animatePageTurn(this.config.reversed ? direction : -direction)
        } else {
            invalidateCache()
            this.invalidate()
        }
    }

    /** `moveToNext` / `moveRight`. */
    moveRight() {
        this.moveWithPan(1)
    }

    /** `moveToPrevious` / `moveLeft`. */
    moveLeft() {
        this.moveWithPan(-1)
    }

    moveToNext() {
        this.moveRight()
    }

    moveToPrevious() {
        this.moveLeft()
    }

    /**
     * `moveRight`/`moveLeft` - pan a zoomed page by a screenful before turning it, when
     * [ViewerConfig.navigateToPan] is on.
     */
    private moveWithPan(screenDirection: number) {
        // `WebGpuViewerContinuous.scrollByHalfPage` - there is no page to pan, and a turn is just
        // more scrolling.
        const continuous = this.continuousState
        if (continuous) {
            continuous.animateScroll((screenDirection * continuous.height) / 2)
            return
        }

        const page = this.state.getPage(0)
        if (page && this.config.navigateToPan) {
            const minX = page.minX(page.scale)
            const maxX = page.maxX(page.scale)
            const currentX = page.animationJob ? (page.animationTargetX ?? page.x) : page.x
            const x = coerceIn(currentX - screenDirection / page.scale, minX, maxX)

            if (!closeTo(currentX, x)) {
                page.animateTo({ targetX: x, targetY: page.y })
                return
            }
        }

        const step = this.config.reversed ? -screenDirection : screenDirection
        this.moveToIndex(this.currentIndex + step)
    }

    /** `handleKeyEvent`, for whatever the host binds it to. Returns true if it consumed [e]. */
    handleKeyEvent(e: KeyboardEvent): boolean {
        switch (e.key) {
            case "ArrowRight":
                if (e.ctrlKey) this.moveToNext()
                else this.moveRight()
                return true
            case "ArrowLeft":
                if (e.ctrlKey) this.moveToPrevious()
                else this.moveLeft()
                return true
            case "ArrowDown":
            case "PageDown":
            case " ":
                this.moveToNext()
                return true
            case "ArrowUp":
            case "PageUp":
                this.moveToPrevious()
                return true
            default:
                return false
        }
    }

    /** Drop every decoded page - for a chapter change, where the list is replaced anyway. */
    clear() {
        this.dropCache()
        this.pageList = []
        this.currentIndex = 0
    }

    override disconnectedCallback() {
        this.workers.forEach(job => job.cancel())
        this.workers.clear()
        this.dropCache()
        super.disconnectedCallback()
    }
}

customElements.define("webgpu-viewer", Viewer, { extends: "canvas" })
