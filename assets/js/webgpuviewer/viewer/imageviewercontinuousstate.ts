import {
    AnimationSpec,
    Job,
    Rect,
    STIFFNESS_MEDIUM,
    STIFFNESS_MEDIUM_LOW,
    animate,
    closeTo,
    coerceIn,
    invokeSafe,
    spring,
} from "../util"
import { Draw } from "../draw/draw"
import { RenderPage } from "../renderer/renderpage"
import { WebGpuRenderer } from "../renderer/renderer"
import { solveImagePlacement } from "../renderer/tilerenderer"
import { ImagePage, ImageSingle, RenderPageBase } from "./imagepage"
import { ImageViewerState } from "./imageviewerstate"

export const MAX_VISIBLE_PAGES = 24

/** Settle distance for a scroll spring: below half a device pixel nothing more is visible. */
export const SCROLL_THRESHOLD_PX = 0.5

/** Caps a page walk against a provider that never reports null/zero-height. */
const MAX_PAGE_WALK = 10_000

/** Screens NaN/Infinity. */
function isSane(n: number): boolean {
    return Number.isFinite(n)
}

/**
 * One page visible this frame, at the document-space slot top [captureRenderState] found.
 * [pageHeight] is the slot (content + gap), [contentHeight] the page drawn at its top.
 */
interface VisiblePage {
    page: ImagePage
    docTop: number
    pageHeight: number
    contentHeight: number
    /** As [getPageHeight] measured it, so the draw places what the layout sized. */
    crop: Rect | null
}

/**
 * A [ImageViewerContinuousState.documentY] plus enough to re-find it after a fresh set of pages
 * replaces the ones it was taken against - [pageIndexHint]/[fractionWithinPage] re-derive the
 * place by page index instead of the raw, now-meaningless number.
 */
export interface ContinuousPosition {
    documentY: number
    scale: number
    offsetX: number
    pageIndexHint: number
    fractionWithinPage: number
}

interface ContinuousRenderSnapshot {
    pages: VisiblePage[]
    scale: number
    offsetX: number
    /** Document position (see `anchorDocY`) currently at the viewport's vertical centre. */
    cameraDocY: number
    /** [isScaleAnimating] or [isFlinging] - either means "don't generate tiles right now". */
    suppressGeneration: boolean
    backgroundColor: number
    readThrough: ImagePage | null
}

/**
 * The continuous (webtoon) viewer's state and frame loop.
 *
 * Pages stack vertically and scroll as one document, fitted to the viewer's width, rather than
 * each owning the viewport as in the paged mode. So the transform lives here, on the viewer, not
 * on each page: [scale] and [offsetX] apply to everything, and [scrollY] is the position within
 * the current page.
 *
 * Invariant: nothing outside [scrollBy] may write [scrollY] and `anchorDocY` together.
 */
export class ImageViewerContinuousState extends ImageViewerState {
    constructor() {
        super(true)
    }

    private _scale = 1

    get scale(): number {
        return this._scale
    }

    set scale(value: number) {
        if (!isSane(value)) return
        this._scale = value
    }

    private _offsetX = 0

    get offsetX(): number {
        return this._offsetX
    }

    set offsetX(value: number) {
        if (!isSane(value)) return
        this._offsetX = value
    }

    private _backgroundColor = 0

    /** 0xAARRGGBB clear color behind the pages - see `Draw.clear`/`renderPass`'s `clearColor`. */
    get backgroundColor(): number {
        return this._backgroundColor
    }

    set backgroundColor(value: number) {
        if (value === this._backgroundColor) return
        this._backgroundColor = value
        this.invalidate()
    }

    private _homeScale = 1

    /**
     * How much of the viewport width a page fills when fully zoomed out, from 0 to 1. The default 1
     * zooms out to exactly the full width; 0.6 stops with the page at 60% of it and margin either
     * side.
     *
     * Only the zoom-out floor moves. A page is still laid out and measured against the full width -
     * [getPageHeight] and the whole document coordinate space are unchanged - so this decides how
     * far out a pinch may go, not how tall anything is.
     *
     * Clamped away from 0, which is not a scale anything can be drawn at. Setting it lifts a [scale]
     * that is now below the floor, so it takes effect without waiting for a gesture.
     */
    get homeScale(): number {
        return this._homeScale
    }

    set homeScale(value: number) {
        const clamped = coerceIn(value, 0.01, 1)
        if (clamped === this._homeScale) return
        this._homeScale = clamped
        if (this.scale < clamped) this.scale = clamped
        this.invalidate()
    }

    private _minScale = 0

    /** Lowest [scale] a gesture may settle at - [homeScale] unless set to something else. */
    get minScale(): number {
        return this._minScale > 0 ? this._minScale : this.homeScale
    }

    set minScale(value: number) {
        this._minScale = value
    }

    get atHomeScale(): boolean {
        return closeTo(this.scale, this.homeScale)
    }

    /** Follows [homeScale], so a double tap off the zoom-out floor still doubles what is on screen. */
    get doubleTapScale(): number {
        return this.homeScale * 2
    }

    get maxScale(): number {
        return Math.max(this.doubleTapScale * 2, 4)
    }

    /**
     * True while gestures are actively driving zoom (pinch, drag, fling, snap-back). Gates every
     * visible page's tile grid the way [ImagePage.isScaleAnimating] gates the paged viewer's.
     */
    isScaleAnimating = false

    /**
     * True while a plain (non-zoom) fling is scrolling. Generating a filtered tile is real GPU
     * work, so doing it while the camera moves under its own momentum both wastes the work - the
     * content is about to scroll away - and shows up as frame lag. Separate from
     * [isScaleAnimating] because different gestures drive them and either can be true alone.
     */
    isFlinging = false

    /**
     * True while a drag is actively panning (not yet released into a fling). With [isFlinging],
     * marks real scroll that [onViewport] reports against.
     */
    isPanning = false

    private _scrollY = 0

    /**
     * Position within the page [getPage] answers 0 with, in page-space pixels at zoom 1. Written
     * only by [scrollBy] and the clamp below it, which are what walk page boundaries and hold the
     * document's end.
     */
    get scrollY(): number {
        return this._scrollY
    }

    /**
     * Visual-only slide, animated to 0 by [animateSlideIn]. Kept out of [scrollY], which would
     * walk into the page before it and report a page change of its own.
     */
    private slideOffset = 0

    /**
     * Layout height of [page] in screen pixels.
     *
     * Measured the same way decoded or not: a placeholder carrying the real aspect ratio has to
     * occupy exactly the space its decoded self will, or the pages below jump when it decodes. The
     * guard is only for pages with no width to fit against, which have no ratio to scale by.
     *
     * Only an [ImageSingle] (which [ImageSpread] also is) fits the viewer's full width - this
     * mode's reading convention for raster content. A [RenderPageBase]'s width/height are the
     * author's deliberate choice, not something to stretch, so it is reserved and drawn at its
     * native size - see the matching pageScale in [renderSnapshot].
     */
    getPageHeight(page: ImagePage): number {
        if (!(page instanceof ImageSingle)) return page.height
        const crop = this.cropOf(page)
        const pageWidth = crop?.width() ?? page.width
        if (pageWidth <= 0 || this.width <= 0) return page.height
        return (crop?.height() ?? page.height) * (this.width / pageWidth)
    }

    private _cropBorders = false

    /**
     * Cut each page to its measured trim: the trim fills the width, its slot is the trim's
     * height, and nothing outside it draws. Unlike the paged viewer, no zoom is involved.
     */
    get cropBorders(): boolean {
        return this._cropBorders
    }

    set cropBorders(value: boolean) {
        if (this._cropBorders === value) return
        this._cropBorders = value
        this.currentPageHeight = null
        this.invalidate()
    }

    /** The part of [page] drawn, in its own pixels; null for all of it. */
    private cropOf(page: ImageSingle): Rect | null {
        if (!this._cropBorders) return null
        const trim = page.image?.trim
        if (!trim) return null
        return trim.width() > 0 && trim.height() > 0 ?
            new Rect(trim.left, trim.top, trim.right, trim.bottom)
            : null
    }

    private cropFor(page: ImagePage): Rect | null {
        return page instanceof ImageSingle ? this.cropOf(page) : null
    }

    private _pageGap = 0

    /**
     * Empty space after each page, 0 to 1 viewport heights - part of the page slot (see
     * [getPageSlotHeight]), not a separate element, so the first page still starts flush at the top.
     */
    get pageGap(): number {
        return this._pageGap
    }

    set pageGap(value: number) {
        const clamped = coerceIn(value, 0, 1)
        if (!isSane(clamped) || clamped === this._pageGap) return
        this._pageGap = clamped
        this.currentPageHeight = null
        this.invalidate()
    }

    /** [pageGap] in document-space pixels. 0 until the surface has a height to measure against. */
    private get pageGapPx(): number {
        return this.pageGap * this.height
    }

    /**
     * Height [page] reserves in document space: [getPageHeight] plus [pageGapPx]. This, not
     * [getPageHeight], is what document space is built from.
     */
    getPageSlotHeight(page: ImagePage): number {
        return this.getPageHeight(page) + this.pageGapPx
    }

    /** Slot height page 0 was last measured at, to carry the position across a decode. */
    private currentPageHeight: number | null = null

    /** Set by [savePosition], applied by [captureRenderState] once a page is actually available. */
    private pendingRestore: ContinuousPosition | null = null

    /** Set while [restorePosition] walks pages, so its intermediate steps don't reach the app. */
    private isRestoring = false

    /**
     * `readThrough` is the deepest page whose bottom has reached the viewport's; where
     * [onPageChange] means "reached this page", this means "read past it" - so the document's
     * last page reads through exactly when its bottom comes on screen. Reported every frame, not
     * on a change: an edge that loses a race is lost for good, so diff it yourself if that
     * matters. Observation only - it never moves the scroll.
     */
    onViewport: ((readThrough: ImagePage | null) => void) | null = null

    /**
     * Pages the last frame reached below and above the current one. What the viewport actually
     * shows depends on the zoom, so a caller's decode window has to follow this rather than a
     * fixed count - a page on screen has to be decoded, not merely reserved.
     */
    private _pagesBelow = 0
    private _pagesAbove = 0

    get pagesBelow(): number {
        return this._pagesBelow
    }

    get pagesAbove(): number {
        return this._pagesAbove
    }

    /**
     * Document-space top of whatever page sits at [scrollY] == 0, in screen pixels at zoom 1.
     *
     * The only state the continuous coordinate space persists across frames: every other visible
     * page's position is re-derived each frame from this one value (see [captureRenderState]'s
     * walk) rather than stored per page. A page's identity is not stable across a decode - the app
     * hands over a new object - so anything kept on the page would be lost exactly when a
     * placeholder corrects to its real height. Written only by [scrollBy], using the height of
     * whichever page is actually being crossed.
     */
    private anchorDocY = 0

    /**
     * Scroll by [deltaPixels], moving the current page as many times as the delta covers.
     *
     * A single fling frame can cross more than one page when pages are short, so both walks loop.
     * Each also stops on a zero-height page, which would never advance the position and would spin
     * here forever.
     */
    scrollBy(deltaPixels: number) {
        if (!isSane(deltaPixels)) return
        if (!this.getPage(0)) return
        this.slideOffset = 0

        this._scrollY += deltaPixels

        // Backwards, above the current page top.
        let guard = 0
        while (this.scrollY < 0 && guard++ < MAX_PAGE_WALK) {
            if (this.getPage(-1) === null) {
                this._scrollY = 0
                break
            }
            if (!this.isRestoring) invokeSafe(this.onPageChange, -1)
            const newPage = this.getPage(0)
            if (!newPage) return
            const newHeight = this.getPageSlotHeight(newPage)
            this.anchorDocY -= newHeight
            this.currentPageHeight = newHeight
            // Nothing to hold a position inside, so rest at its top - left above it, the next
            // scroll reads it as another step back.
            if (newHeight <= 0) {
                this._scrollY = 0
                break
            }
            this._scrollY += newHeight
        }

        // Forwards, while it sits past the bottom. Stops at the last page rather than stepping off
        // the end.
        guard = 0
        for (; guard++ < MAX_PAGE_WALK;) {
            const page = this.getPage(0)
            if (!page) return
            const pageHeight = this.getPageSlotHeight(page)
            if (this.scrollY <= pageHeight || pageHeight <= 0) break
            if (this.getPage(1) === null) {
                this._scrollY = pageHeight
                break
            }
            if (!this.isRestoring) invokeSafe(this.onPageChange, 1)
            this.anchorDocY += pageHeight
            const newPage = this.getPage(0)
            if (!newPage) return
            this.currentPageHeight = this.getPageSlotHeight(newPage)
            this._scrollY -= pageHeight
        }

        this.clampToDocumentEnd()
    }

    private get safeScale(): number {
        return isSane(this.scale) && this.scale > 0 ? this.scale : 1
    }

    /** Page-space height of the viewport. Runs from page-space 0 - the camera is top-anchored. */
    private get bandHeight(): number {
        return this.height / this.safeScale
    }

    /**
     * Furthest [scrollY] may go: the last page's bottom stops at the viewport's, or - zoomed out
     * past what [MAX_VISIBLE_PAGES] can measure - the last drawn page's does. Null when there is
     * provably content enough below.
     * Negative when the end falls above page 0's own top - see [clampToDocumentEnd].
     *
     * Measured to the last page's content, excluding its trailing [pageGap] - nothing to scroll to.
     */
    private maxScrollY(): number | null {
        const bottomEdge = this.bandHeight
        let slotTop = 0
        for (let i = 0; i <= MAX_VISIBLE_PAGES; i++) {
            const page = this.getPage(i)
            if (!page) return Math.max(0, slotTop - this.pageGapPx) - bottomEdge
            const contentHeight = this.getPageHeight(page)
            if (contentHeight <= 0) return null
            // Enough content below to fill the viewport, whatever follows it.
            if (slotTop + contentHeight - bottomEdge > this.scrollY) return null
            slotTop += contentHeight + this.pageGapPx
        }
        // Zoomed out past what MAX_VISIBLE_PAGES can measure. Bound by the last page it reaches,
        // not "no bound": past that is only blank, and unbounded scrolls off and snaps back once
        // the end comes into range.
        return Math.max(0, slotTop - this.pageGapPx) - bottomEdge
    }

    /**
     * Hold [scrollY] at the end of the document, which the walks above can overshoot. A last page
     * shorter than the viewport ends above page 0's own top, and [scrollY] cannot hold a negative -
     * the backward walk reads that as "step to the page above" - so step back to a page that can.
     */
    private clampToDocumentEnd() {
        let guard = 0
        for (; guard++ < MAX_PAGE_WALK;) {
            const max = this.maxScrollY()
            if (max === null || this.scrollY <= max) return
            if (max >= 0) {
                this._scrollY = max
                return
            }
            // Nothing above to measure from, so the document's top is as far as this goes.
            if (this.getPage(-1) === null) {
                this._scrollY = 0
                return
            }
            if (!this.isRestoring) invokeSafe(this.onPageChange, -1)
            const newPage = this.getPage(0)
            if (!newPage) return
            const newHeight = this.getPageSlotHeight(newPage)
            this.anchorDocY -= newHeight
            this.currentPageHeight = newHeight
            // No height yet to hold it either, so rest at its top.
            if (newHeight <= 0) {
                this._scrollY = 0
                return
            }
            // The same document position, measured off the page now at 0.
            this._scrollY = max + newHeight
        }
    }

    /**
     * Document-space position of the viewport's top, in page-space pixels at zoom 1. Where the
     * reader is in a form that survives a page crossing, which [scrollY] on its own does not - so
     * it is what to remember a position by, and [scrollTo] what to put it back with.
     */
    get documentY(): number {
        return this.anchorDocY + this.scrollY
    }

    /** Put the viewport's top at [docY] - see [documentY]. */
    scrollTo(docY: number) {
        if (!isSane(docY)) return
        this.scrollBy(docY - this.documentY)
    }

    /** Move to the top of the page [getPage] now answers 0 with, after the app jumps pages. */
    resetScroll() {
        this._scrollY = 0
        // A different page now: its own height is the baseline, not the page left behind.
        this.currentPageHeight = null
        this.pendingRestore = null
    }

    /** Capture where the viewport is right now, to hand to [restorePosition] later. */
    savePosition(): ContinuousPosition {
        const docY = this.anchorDocY + this.scrollY
        const page = this.getPage(0)
        const pageHeight = page ? this.getPageSlotHeight(page) : 0
        const fraction = pageHeight > 0 ? coerceIn(this.scrollY / pageHeight, 0, 1) : 0
        return {
            documentY: docY,
            scale: this.scale,
            offsetX: this.offsetX,
            pageIndexHint: this.getCurrentPageIndex(),
            fractionWithinPage: fraction,
        }
    }

    /** Put the viewport back at [pos]. Deferred to [captureRenderState] if no page exists yet. */
    restorePosition(pos: ContinuousPosition) {
        if (!isSane(pos.documentY) || !isSane(pos.scale) || !isSane(pos.offsetX)) return
        if (!this.getPage(0)) {
            this.pendingRestore = pos
            return
        }
        this.applyRestore(pos)
    }

    private applyRestore(pos: ContinuousPosition) {
        this.isRestoring = true
        try {
            this.scale = coerceIn(pos.scale, this.minScale, this.maxScale)
            const targetDocY = this.resolveDocumentYForRestore(pos)
            this.scrollBy(targetDocY - this.documentY)
            const maxOffsetX = this.maxOffsetX(this.scale)
            this.offsetX = coerceIn(pos.offsetX, -maxOffsetX, maxOffsetX)
            this.pendingRestore = null
        } finally {
            this.isRestoring = false
        }
        this.invalidate()
    }

    /** [pos]'s page/fraction hint when it resolves, its raw documentY otherwise. */
    private resolveDocumentYForRestore(pos: ContinuousPosition): number {
        if (pos.pageIndexHint >= 0) {
            const resolved = this.documentYForPageIndex(pos.pageIndexHint, pos.fractionWithinPage)
            if (resolved !== null) return resolved
        }
        return pos.documentY
    }

    /** The page index [getPage] would need to answer 0 with to reach [documentY] - see [ContinuousPosition]. */
    getCurrentPageIndex(): number {
        const docY = this.anchorDocY + this.scrollY
        let y = this.anchorDocY
        let idx = 0
        let guard = 0
        while (guard++ < MAX_PAGE_WALK) {
            const page = this.getPage(idx)
            if (!page) break
            const h = this.getPageSlotHeight(page)
            if (h <= 0) break
            if (docY < y + h) return idx
            y += h
            idx++
        }
        return 0
    }

    /**
     * Document-space position [fraction] of the way down page [pageIndex] (relative to the page
     * [getPage] answers 0 with), or null if walking there runs off the pages available.
     */
    private documentYForPageIndex(pageIndex: number, fraction: number): number | null {
        const clampedFraction = coerceIn(fraction, 0, 1)
        let docY = this.anchorDocY
        if (pageIndex === 0) {
            const page = this.getPage(0)
            if (!page) return null
            return docY + this.getPageSlotHeight(page) * clampedFraction
        }
        if (pageIndex > 0) {
            for (let i = 0; i < pageIndex; i++) {
                const p = this.getPage(i)
                if (!p) return null
                docY += this.getPageSlotHeight(p)
            }
            const target = this.getPage(pageIndex)
            if (!target) return null
            return docY + this.getPageSlotHeight(target) * clampedFraction
        }
        for (let i = pageIndex; i < 0; i++) {
            const p = this.getPage(i)
            if (!p) return null
            docY -= this.getPageSlotHeight(p)
        }
        const target = this.getPage(pageIndex)
        if (!target) return null
        return docY + this.getPageSlotHeight(target) * clampedFraction
    }

    /** Slide the current page into place after a jump - [direction] 1 when it came from below. */
    animateSlideIn(direction: number) {
        this.animationJob?.cancel()
        const job: Job = animate(
            (direction * this.height) / 2,
            0,
            spring(STIFFNESS_MEDIUM_LOW, 0.5),
            value => {
                this.slideOffset = value
                this.invalidate()
            },
        )
        this.animationJob = job
        job.promise.then(() => {
            // Not if replaced: a newer animation has already set its own slide.
            if (this.animationJob !== job) return
            this.slideOffset = 0
            this.invalidate()
        })
    }

    /** Widest [offsetX] may go at [scale] before the page's edge pulls inside the viewport. */
    maxOffsetX(scale: number): number {
        return Math.max(0, (scale - 1) / (2 * scale))
    }

    /**
     * The scale a running [animateZoom] is heading for, null once settled. What a repeated input
     * accumulates onto - see [animateZoom].
     */
    animationTargetScale: number | null = null

    private zoomJob: Job | null = null

    /**
     * Spring [scale] to [targetScale], holding the point ([originX], [originY]) - both measured
     * from the viewport's centre as a fraction of its size - still on screen throughout.
     *
     * The counterpart of `ImagePage.animateTo` for the one transform this viewer has, and there
     * for the same reason: a wheel has no pinch, so its zoom has to animate to read as a gesture
     * rather than a jump, and it has to cancel whatever is in flight so a fling does not drag the
     * document out from under the cursor.
     *
     * The anchor is held incrementally, each frame moving by what that frame changed. It
     * telescopes to the same total as the closed form the paged viewer uses, and unlike it the
     * vertical half can go through [scrollBy] - which is the only thing that may cross a page
     * boundary, and a zoom near one does.
     */
    animateZoom(
        targetScale: number,
        originX: number,
        originY: number,
        spec: AnimationSpec = spring(STIFFNESS_MEDIUM),
    ) {
        this.animationJob?.cancel()

        const startScale = this.scale
        this.animationTargetScale = targetScale
        this.isScaleAnimating = true

        const job: Job = animate(0, 1, spec, t => {
            // Weighted, so the last frame lands exactly on [targetScale] - see the note in
            // `ImagePage.animateTo`.
            const newScale = (1 - t) * startScale + t * targetScale
            const diff = 1 / newScale - 1 / this.scale
            // Clamped as it goes, not snapped back afterwards: a wheel has no end of gesture to
            // snap back at, and zooming out past the point where there is anything to pan would
            // otherwise leave the document off-centre for good.
            const limit = this.maxOffsetX(newScale)
            this.offsetX = coerceIn(this.offsetX + originX * diff, -limit, limit)
            this.scrollBy(-originY * diff * this.height)
            this.scale = newScale
            this.invalidate()
        })
        this.animationJob = job
        this.zoomJob = job
        job.promise.then(() => {
            // Against the zoom slot, not `animationJob`: a plain fling taking that slot means this
            // zoom is abandoned and nothing else will clear [isScaleAnimating], which suppresses
            // tile generation for as long as it stays true.
            if (this.zoomJob !== job) return
            this.animationTargetScale = null
            this.isScaleAnimating = false
        })
    }

    /** The scroll animation, and how much of its distance it has yet to apply. */
    private scrollJob: Job | null = null
    private scrollRemaining = 0

    /**
     * Spring the document by [deltaPixels], accumulating onto whatever a running scroll has not
     * applied yet.
     *
     * Without the accumulation each call would restart from 0 and drop the previous one's remaining
     * distance, so three wheel notches in quick succession would scroll barely further than one -
     * the same trap the paged viewer's wheel zoom has with its pending target.
     *
     * Only a scroll's own remainder counts. Any other animation taking the slot - a fling, a
     * slide-in - means the position it was heading for is no longer wanted.
     *
     * [spec] defaults to a spring settling within half a pixel. A 0.002 threshold (right for a 0..1
     * progress animation, not one in pixels) spent 336ms covering 99% of a ~120px notch and another
     * 350ms drifting the last sub-pixel. That tail is invisible but not free - `animationJob`
     * stays non-null through it, so WebGpuRenderer.animating holds texture uploads off for twice as
     * long as the movement lasts.
     */
    animateScroll(
        deltaPixels: number,
        spec: AnimationSpec = spring(STIFFNESS_MEDIUM_LOW, SCROLL_THRESHOLD_PX),
    ) {
        if (!isSane(deltaPixels)) return
        const carried =
            this.scrollJob !== null && this.animationJob === this.scrollJob ?
                this.scrollRemaining
                : 0

        this.animationJob?.cancel()

        const total = carried + deltaPixels
        this.scrollRemaining = total
        let lastValue = 0
        this.isFlinging = true
        const job: Job = animate(0, total, spec, value => {
            this.scrollBy(value - lastValue)
            lastValue = value
            this.scrollRemaining = total - value
            this.invalidate()
        })
        this.animationJob = job
        this.scrollJob = job
        job.promise.then(() => {
            if (this.scrollJob === job) this.scrollRemaining = 0
            if (this.animationJob === job) {
                this.isFlinging = false
                this.invalidate()
            }
        })
    }

    protected override captureRenderState(): unknown {
        const snapshot = this.captureLocked()
        if (this.isFlinging || this.isPanning) invokeSafe(this.onViewport, snapshot.readThrough)
        return snapshot
    }

    private captureLocked(): ContinuousRenderSnapshot {
        const screenH = this.height

        const pending = this.pendingRestore
        if (pending && this.getPage(0)) this.applyRestore(pending)

        const page0 = this.getPage(0)
        if (page0) {
            const pageHeight = this.getPageSlotHeight(page0)
            // A decode correcting a placeholder's height holds the same fraction of the page: at
            // its top nothing moves, near its bottom the pages below stay put. Both heights have
            // to be measured, and an unmeasured one is not a baseline to correct against later.
            const previous = this.currentPageHeight
            const ratio =
                previous !== null && previous > 0 && pageHeight > 0 && pageHeight !== previous ?
                    pageHeight / previous
                    : null
            const wasPinned =
                ratio !== null && (() => {
                    const max = this.maxScrollY()
                    return max !== null && this.scrollY >= max
                })()
            if (ratio !== null) this._scrollY *= ratio
            if (pageHeight > 0) this.currentPageHeight = pageHeight
            // A decode shortening the document under a position already at its end: only
            // [scrollBy] used to notice, on the next scroll, as a jump.
            this.clampToDocumentEnd()
            if (wasPinned) {
                const max = this.maxScrollY()
                if (max !== null && max >= 0 && this.scrollY < max) this._scrollY = max
            }
        }

        // After the clamp, which can step the page at 0 back.
        const y0 = page0 ? -this.scrollY + this.slideOffset : 0

        const s = this.safeScale

        // The point both the fast path and TileRenderer's continuous overload zoom around, so
        // they agree on where a page belongs.
        const cameraDocY = this.anchorDocY - y0 + (0.5 * screenH) / s

        const pages: VisiblePage[] = []
        // Undecoded ones too: [pages] skips them, and their decode's invalidate must still land.
        const visible: ImagePage[] = []

        // Visible band in unscaled page space, from page 0's top - see cameraDocY.
        const visTop = 0
        const screenBot = screenH / s
        // +1 tile of margin, matching TileRenderer's own prefetch ring, so a boundary tile just
        // past the viewport has its page already discovered.
        const visBot = screenBot + this.tiles.preferredTileSize / s

        // Read past, not merely reached - see [onViewport]. The bottom edge alone: a page
        // covering the viewport's top is one being read, and matching it too would report it over
        // the finished pages below. Against content, not the slot, or the trailing gap keeps the
        // last page from ever reporting - the end lands its bottom on screenBot.
        const isScrolledThrough = (top: number, contentHeight: number) =>
            contentHeight > 0 && top + contentHeight <= screenBot + 0.5

        let scrolledThrough: ImagePage | null = null

        // Backward: pages above page 0, needed once zoomed out enough that visTop goes negative -
        // the visible band reaching above where page 0 starts. Mirrors the forward walk below.
        let yTop = y0
        let iBack = -1
        let docTopBack = this.anchorDocY
        let above = 0
        while (yTop > visTop && iBack >= -MAX_VISIBLE_PAGES) {
            const page = this.getPage(iBack)
            if (!page) break
            above = -iBack
            const contentHeight = this.getPageHeight(page)
            const pageHeight = contentHeight + this.pageGapPx
            docTopBack -= pageHeight
            yTop -= pageHeight
            // Walking up, so the first match is the deepest one above page 0.
            if (scrolledThrough === null && isScrolledThrough(yTop, contentHeight)) {
                scrolledThrough = page
            }
            visible.push(page)
            // Walked upward, so each goes in front of the last - top to bottom, as the forward
            // walk below appends.
            if (page.isDecoded) {
                pages.unshift({
                    page,
                    docTop: docTopBack,
                    pageHeight,
                    contentHeight,
                    crop: this.cropFor(page),
                })
            }
            if (pageHeight <= 0) break
            iBack--
        }

        // Forward until the viewport (plus margin) is covered or MAX_VISIBLE_PAGES is reached,
        // whichever comes first - zoomed out far enough, or with short enough pages, the
        // document-space bound alone would keep walking past it.
        //
        // Purely local: nothing is written back to a page, so only `anchorDocY` has to survive
        // across frames for this to stay correct.
        let y = y0
        let i = 0
        let docTop = this.anchorDocY
        let prevHeight = 0
        let hasPrev = false
        let below = 0
        while (y < visBot && i <= MAX_VISIBLE_PAGES) {
            const page = this.getPage(i)
            if (!page) break
            below = i
            // Anchored to the previous page in this walk, never frozen: an undecoded page's height
            // is a guess, so re-deriving it every frame self-corrects once it decodes.
            if (hasPrev) docTop += prevHeight
            hasPrev = true
            const contentHeight = this.getPageHeight(page)
            const pageHeight = contentHeight + this.pageGapPx

            // Walking down, so a later match replaces whatever the backward walk found.
            if (isScrolledThrough(y, contentHeight)) scrolledThrough = page

            if (y + pageHeight > visTop) {
                visible.push(page)
                if (page.isDecoded) {
                    pages.push({ page, docTop, pageHeight, contentHeight, crop: this.cropFor(page) })
                }
            }

            // A zero-height page never advances y, so stop rather than ask for pages forever.
            if (pageHeight <= 0) break

            prevHeight = pageHeight
            y += pageHeight
            i++
        }

        this.onScreenPages = visible
        this._pagesBelow = below
        this._pagesAbove = above

        if (scrolledThrough === null) {
            const last = this.getPage(-1)
            if (last && this.getPageHeight(last) > 0) scrolledThrough = last
        }

        return {
            pages,
            scale: this.scale,
            offsetX: this.offsetX,
            cameraDocY,
            suppressGeneration: this.isScaleAnimating || this.isFlinging,
            backgroundColor: this.backgroundColor,
            readThrough: scrolledThrough,
        }
    }

    /**
     * Limits [pass] to [vp]'s content band, where a cropped page's margins would otherwise land
     * on its neighbours. False when none of it is on screen.
     */
    private scissorToSlot(
        pass: GPURenderPassEncoder,
        anchorX: number,
        anchorY: number,
        vp: VisiblePage,
        scale: number,
        dstW: number,
        dstH: number,
    ): boolean {
        const l = coerceIn(Math.round(anchorX - (scale * dstW) / 2), 0, Math.trunc(dstW))
        const r = coerceIn(Math.round(anchorX + (scale * dstW) / 2), 0, Math.trunc(dstW))
        const t = coerceIn(Math.round(anchorY + scale * vp.docTop), 0, Math.trunc(dstH))
        const b = coerceIn(
            Math.round(anchorY + scale * (vp.docTop + vp.contentHeight)),
            0,
            Math.trunc(dstH),
        )
        if (r <= l || b <= t) return false
        pass.setScissorRect(l, t, r - l, b - t)
        return true
    }

    protected override renderSnapshot(
        encoder: GPUCommandEncoder,
        texture: GPUTexture,
        snapshot: unknown,
    ) {
        const s = snapshot as ContinuousRenderSnapshot
        this.tiles.newFrame()
        if (s.pages.length === 0) {
            // Nothing to draw, but the texture still has to be written: `getCurrentTexture`
            // rotates buffers, so submitting no commands leaves a frame from several ago on
            // screen.
            Draw.clear(encoder, texture, s.backgroundColor)
            return
        }

        // [ImageSingle] pages batch into one shared pass - they never overlap vertically, so one
        // clear plus one draw per image writes each pixel once. A [RenderPageBase] cannot join that
        // batch, having no image or tile to draw, so it goes afterwards through its own
        // renderLoaded. renderLoaded loads rather than clears, since the texture is shared with
        // every other visible page - which relies on something having cleared it first. The
        // ImageSingle batch's pass does that when there is one; when every visible page is a
        // RenderPageBase, [Draw.clear] does it instead, so such a page never paints over stale
        // content from an earlier frame.
        const hasImagePage = s.pages.some(vp => vp.page instanceof ImageSingle)

        const dstW = texture.width
        const dstH = texture.height
        // Screen position of document space's origin - mirrors TileRenderer's continuous anchor
        // exactly, so the fast path, the tile cache and the render pages below all agree.
        const anchorX = dstW / 2 + s.scale * (s.offsetX * dstW + WebGpuRenderer.offsetX * dstW)
        const anchorY = dstH / 2 - s.scale * s.cameraDocY + s.scale * WebGpuRenderer.offsetY * dstH

        if (hasImagePage) {
            this.renderPass(encoder, texture, s.backgroundColor, pass => {
                for (const vp of s.pages) {
                    const page = vp.page
                    if (!(page instanceof ImageSingle)) continue
                    // The snapshot was captured before this pass; the page can have been evicted
                    // since, in which case its images' buffers are gone and drawing one throws.
                    if (page.destroyed || !page.isDecoded || page.width <= 0) continue

                    // A crop fills the width, and the page's own centre sits off the crop's.
                    const crop = vp.crop
                    const pageScale = dstW / (crop?.width() ?? page.width)
                    const shiftX =
                        crop ? pageScale * (page.width / 2 - (crop.left + crop.right) / 2) : 0
                    const shiftY =
                        crop ? pageScale * (page.height / 2 - (crop.top + crop.bottom) / 2) : 0
                    if (
                        crop &&
                        !this.scissorToSlot(pass, anchorX, anchorY, vp, s.scale, dstW, dstH)
                    ) continue

                    // Tiles first, marking the stencil; the sampler below shades only what is
                    // left, and nothing at all once the draw reports full coverage.
                    const covered = this.tiles.drawContinuous(
                        pass,
                        page,
                        texture,
                        s.cameraDocY,
                        vp.docTop,
                        vp.contentHeight,
                        s.offsetX,
                        s.scale,
                        s.suppressGeneration,
                        crop,
                    )

                    if (!covered) {
                        page.forEachImage((image, srcOffsetX, sideScale) => {
                            if (image.mipmaps.length === 0) return
                            const imageScale = pageScale * s.scale * sideScale
                            const docCenterX =
                                shiftX + pageScale * (srcOffsetX + sideScale * image.x)
                            const docCenterY =
                                vp.docTop +
                                0.5 * vp.contentHeight +
                                shiftY +
                                pageScale * sideScale * image.y
                            const [x, y] = solveImagePlacement(
                                anchorX + s.scale * docCenterX,
                                anchorY + s.scale * docCenterY,
                                imageScale,
                                image,
                                dstW,
                                dstH,
                            )
                            // Stencil-tested against the tile draw above, skipping pixels it
                            // already covered.
                            //
                            // The page's fade rides in as the alpha multiplier - see
                            // [ImagePage.fade].
                            RenderPage.renderFast(
                                pass,
                                image,
                                texture,
                                x,
                                y,
                                imageScale,
                                true,
                                true,
                                page.fade,
                            )
                        })
                    }
                    if (crop) pass.setScissorRect(0, 0, texture.width, texture.height)
                }
            })
        } else {
            Draw.clear(encoder, texture, s.backgroundColor)
        }

        for (const vp of s.pages) {
            const page = vp.page
            if (page instanceof ImageSingle) continue
            // Only ImageSingle overrides isDecoded away from RenderPageBase's fixed "has drawable
            // content" default, and captureRenderState's isDecoded filter already excluded
            // anything else (a DummyPage, say).
            if (!(page instanceof RenderPageBase) || page.destroyed) continue

            // RenderPageBase.render's x/y/scale are already fractions of dst (screen) size, not of
            // this page's own declared width/height - see getPageHeight: unlike an image page,
            // this one is never stretched to the viewer's width. So the only screen scale in play
            // is the pinch zoom times the page's own, and folding in a dstW/page.width factor here
            // would scale its content by that ratio for nothing. page.x/page.y stay out of the
            // position for the same reason: they are in that dst-fraction unit, not docTop's
            // document pixels, so the two cannot be added.
            const renderScale = s.scale * page.scale
            const targetY = anchorY + s.scale * (vp.docTop + 0.5 * vp.contentHeight)

            page.renderLoaded(
                encoder,
                (anchorX - dstW / 2) / (renderScale * dstW),
                (targetY - dstH / 2) / (renderScale * dstH),
                renderScale,
                texture,
            )
        }
    }
}
