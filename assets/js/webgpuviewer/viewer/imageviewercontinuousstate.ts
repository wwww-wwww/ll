import {
    AnimationSpec,
    Job,
    STIFFNESS_MEDIUM,
    STIFFNESS_MEDIUM_LOW,
    animate,
    coerceIn,
    spring,
} from "../util"
import { Draw } from "../draw/draw"
import { RenderPage } from "../renderer/renderpage"
import { WebGpuRenderer } from "../renderer/renderer"
import { solveImagePlacement } from "../renderer/tilerenderer"
import { ImagePage, ImageSingle, RenderPageBase } from "./imagepage"
import { ImageViewerState } from "./imageviewerstate"

export const MAX_VISIBLE_PAGES = 4

/** Settle distance for a scroll spring: below half a device pixel nothing more is visible. */
export const SCROLL_THRESHOLD_PX = 0.5

/** One page visible this frame, with the document-space top [captureRenderState] found it at. */
interface VisiblePage {
    page: ImagePage
    docTop: number
    pageHeight: number
}

interface ContinuousRenderSnapshot {
    pages: VisiblePage[]
    scale: number
    offsetX: number
    /** Document position (see `anchorDocY`) currently at the viewport's vertical centre. */
    cameraDocY: number
    /** [isScaleAnimating] or [isFlinging] - either means "don't generate tiles right now". */
    suppressGeneration: boolean
}

/**
 * The continuous (webtoon) viewer's state and frame loop - the port of
 * `viewer/ImageViewerContinuousState.kt`.
 *
 * Pages stack vertically and scroll as one document, fitted to the viewer's width, rather than
 * each owning the viewport as in the paged mode. So the transform lives here, on the viewer, not
 * on each page: [scale] and [offsetX] apply to everything, and [scrollY] is the position within
 * the current page.
 *
 * The Kotlin guards the scroll state with a lock, since its gestures and render thread are
 * separate. There is one thread here, so the lock has no counterpart - but the invariant it
 * protected still holds: nothing outside [scrollBy] may write [scrollY] and `anchorDocY` together.
 */
export class ImageViewerContinuousState extends ImageViewerState {
    constructor() {
        super(true)
    }

    scale = 1

    offsetX = 0

    private _minZoomWidthFraction = 1

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
    get minZoomWidthFraction(): number {
        return this._minZoomWidthFraction
    }

    set minZoomWidthFraction(value: number) {
        const clamped = coerceIn(value, 0.01, 1)
        if (clamped === this._minZoomWidthFraction) return
        this._minZoomWidthFraction = clamped
        if (this.scale < clamped) this.scale = clamped
        this.invalidate()
    }

    /** Lowest [scale] a gesture may settle at - see [minZoomWidthFraction]. */
    get minScale(): number {
        return this._minZoomWidthFraction
    }

    /** Follows [minScale], so a double tap off the zoom-out floor still doubles what is on screen. */
    get doubleTapScale(): number {
        return this.minScale * 2
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

    private _scrollY = 0

    /**
     * Position within the page [getPage] answers 0 with, in page-space pixels at zoom 1. Written
     * only by [scrollBy] and the clamp below it, which are what walk page boundaries and hold the
     * document's end - the Kotlin's `private set`.
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
        const pageWidth = page.width
        if (pageWidth <= 0) return page.height
        return page.height * (this.width / pageWidth)
    }

    /** Height page 0 was last measured at, to carry the position across a decode correcting it. */
    private currentPageHeight: number | null = null

    /**
     * The page read through, reported when it changes: the deepest one whose bottom has reached
     * the viewport's, or that covers its top. Where [onPageChange] means "reached this page's
     * top", this means "read past it". Observation only - nothing here moves the scroll.
     */
    onPageScrolledThrough: ((page: ImagePage) => void) | null = null

    private lastScrolledThrough: ImagePage | null = null

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
        if (!this.getPage(0)) return
        this.slideOffset = 0

        this._scrollY += deltaPixels

        // Backwards, while the position sits above the top of the current page.
        while (this.scrollY < 0) {
            if (this.getPage(-1) === null) {
                this._scrollY = 0
                break
            }
            this.onPageChange?.(-1)
            const newPage = this.getPage(0)
            if (!newPage) return
            const newHeight = this.getPageHeight(newPage)
            this.anchorDocY -= newHeight
            this.currentPageHeight = newHeight
            // No height to hold a position inside, so rest at its top rather than leave the
            // position above it, which the next scroll would read as another step back.
            if (newHeight <= 0) {
                this._scrollY = 0
                break
            }
            this._scrollY += newHeight
        }

        // Forwards, while it sits past the bottom. Stops at the last page rather than stepping off
        // the end, which would leave the position short instead of clamping.
        for (; ;) {
            const page = this.getPage(0)
            if (!page) return
            const pageHeight = this.getPageHeight(page)
            if (this.scrollY <= pageHeight || pageHeight <= 0) break
            if (this.getPage(1) === null) {
                this._scrollY = pageHeight
                break
            }
            this.onPageChange?.(1)
            this.anchorDocY += pageHeight
            const newPage = this.getPage(0)
            if (!newPage) return
            this.currentPageHeight = this.getPageHeight(newPage)
            this._scrollY -= pageHeight
        }

        this.clampToDocumentEnd()
    }

    /**
     * Furthest [scrollY] may go: the last page's bottom stops at the viewport's, never above it.
     * Null when the document does not end within the pages this mode draws, so nothing to clamp.
     * Negative when the end falls above page 0's own top - see [clampToDocumentEnd].
     */
    private maxScrollY(): number | null {
        const viewportHeight = this.height / this.scale
        let bottom = 0
        for (let i = 0; i <= MAX_VISIBLE_PAGES; i++) {
            const page = this.getPage(i)
            if (!page) return bottom - viewportHeight
            const pageHeight = this.getPageHeight(page)
            if (pageHeight <= 0) break
            bottom += pageHeight
            // Enough content below to fill the viewport, whatever follows it.
            if (bottom - viewportHeight > this.scrollY) break
        }
        return null
    }

    /**
     * Hold [scrollY] at the end of the document, which the walks above can overshoot. A last page
     * shorter than the viewport ends above page 0's own top, and [scrollY] cannot hold a negative -
     * the backward walk reads that as "step to the page above" - so step back to a page that can.
     */
    private clampToDocumentEnd() {
        for (; ;) {
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
            this.onPageChange?.(-1)
            const newPage = this.getPage(0)
            if (!newPage) return
            const newHeight = this.getPageHeight(newPage)
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
        this.scrollBy(docY - this.documentY)
    }

    /** Move to the top of the page [getPage] now answers 0 with, after the app jumps pages. */
    resetScroll() {
        this._scrollY = 0
        // A different page now: its own height is the baseline, not the page left behind.
        this.currentPageHeight = null
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
     * [spec] defaults to a spring settling within half a pixel. The Kotlin asks for 0.002 here,
     * which is the threshold for a 0..1 progress animation, not for one measured in pixels: on a
     * ~120px notch it spent 336ms covering 99% of the distance and another 350ms drifting the last
     * sub-pixel. That tail is invisible but not free - `animationJob` stays non-null through it, so
     * WebGpuRenderer.animating holds texture uploads off for twice as long as the movement lasts.
     */
    animateScroll(
        deltaPixels: number,
        spec: AnimationSpec = spring(STIFFNESS_MEDIUM_LOW, SCROLL_THRESHOLD_PX),
    ) {
        const carried =
            this.scrollJob !== null && this.animationJob === this.scrollJob ?
                this.scrollRemaining
                : 0

        this.animationJob?.cancel()

        const total = carried + deltaPixels
        this.scrollRemaining = total
        let lastValue = 0
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
        })
    }

    protected override captureRenderState(): unknown {
        const screenH = this.height

        const page0 = this.getPage(0)
        if (page0) {
            const pageHeight = this.getPageHeight(page0)
            // A decode correcting a placeholder's height holds the same fraction of the page: at
            // its top nothing moves, near its bottom the pages below stay put. Both heights have
            // to be measured, and an unmeasured one is not a baseline to correct against later.
            const previous = this.currentPageHeight
            if (previous !== null && previous > 0 && pageHeight > 0) {
                this._scrollY *= pageHeight / previous
            }
            if (pageHeight > 0) this.currentPageHeight = pageHeight
            // A decode shortening the document under a position already at its end: only
            // [scrollBy] used to notice, on the next scroll, as a jump.
            this.clampToDocumentEnd()
        }

        // After the clamp, which can step the page at 0 back.
        const y0 = page0 ? -this.scrollY + this.slideOffset : 0

        // Document position at the viewport's centre - the point both the fast path and
        // TileRenderer's continuous overload zoom around, so they agree on where a page belongs.
        const cameraDocY = this.anchorDocY - y0 + 0.5 * screenH

        const pages: VisiblePage[] = []

        // Visible band in unscaled page space. Zoom is centred on the screen, so the viewport
        // covers screenH / scale of page space around the screen centre.
        const visTop = 0.5 * screenH - screenH / (2 * this.scale)
        const screenBot = 0.5 * screenH + screenH / (2 * this.scale)
        // +1 tile of margin, matching TileRenderer's own prefetch ring, so a boundary tile just
        // past the viewport has its page already discovered.
        const visBot = screenBot + this.tiles.preferredTileSize / this.scale

        // Read past, not merely reached - see [onPageScrolledThrough]. No height, no reading.
        const isScrolledThrough = (top: number, pageHeight: number) =>
            pageHeight > 0 && (top + pageHeight <= screenBot || top < visTop)

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
            const pageHeight = this.getPageHeight(page)
            docTopBack -= pageHeight
            yTop -= pageHeight
            // Walking up, so the first match is the deepest one above page 0.
            if (scrolledThrough === null && isScrolledThrough(yTop, pageHeight)) {
                scrolledThrough = page
            }
            // Walked upward, so each goes in front of the last - top to bottom, as the forward
            // walk below appends.
            if (page.isDecoded) pages.unshift({ page, docTop: docTopBack, pageHeight })
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
            const pageHeight = this.getPageHeight(page)

            // Walking down, so a later match replaces whatever the backward walk found.
            if (isScrolledThrough(y, pageHeight)) scrolledThrough = page

            if (y + pageHeight > visTop && page.isDecoded) pages.push({ page, docTop, pageHeight })

            // A zero-height page never advances y, so stop rather than ask for pages forever.
            if (pageHeight <= 0) break

            prevHeight = pageHeight
            y += pageHeight
            i++
        }

        this.onScreenPages = pages.map(p => p.page)
        this._pagesBelow = below
        this._pagesAbove = above

        // By identity: a page that stays the deepest one read through is reported once.
        if (scrolledThrough !== null && scrolledThrough !== this.lastScrolledThrough) {
            this.lastScrolledThrough = scrolledThrough
            this.onPageScrolledThrough?.(scrolledThrough)
        }

        const snapshot: ContinuousRenderSnapshot = {
            pages,
            scale: this.scale,
            offsetX: this.offsetX,
            cameraDocY,
            suppressGeneration: this.isScaleAnimating || this.isFlinging,
        }
        return snapshot
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
            // screen. The Kotlin returns here instead - its surface is not a swap chain.
            Draw.clear(encoder, texture, 0)
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
            this.renderPass(encoder, texture, pass => {
                for (const vp of s.pages) {
                    const page = vp.page
                    if (!(page instanceof ImageSingle)) continue
                    // The snapshot was captured before this pass; the page can have been evicted
                    // since, in which case its images' buffers are gone and drawing one throws.
                    if (page.destroyed || !page.isDecoded || page.width <= 0) continue

                    const pageScale = dstW / page.width

                    // Tiles first, marking the stencil; the sampler below shades only what is
                    // left, and nothing at all once the draw reports full coverage. Animated pages
                    // never get tiles, so they skip the call outright.
                    const covered =
                        !page.isAnimated &&
                        this.tiles.drawContinuous(
                            pass,
                            page,
                            texture,
                            s.cameraDocY,
                            vp.docTop,
                            s.offsetX,
                            s.scale,
                            s.suppressGeneration,
                        )

                    if (!covered) {
                        const imageScale = pageScale * s.scale
                        page.forEachImage((image, srcOffsetX) => {
                            if (image.mipmaps.length === 0) return
                            const docCenterX = pageScale * (srcOffsetX + image.x)
                            const docCenterY = vp.docTop + 0.5 * vp.pageHeight + pageScale * image.y
                            const [x, y] = solveImagePlacement(
                                anchorX + s.scale * docCenterX,
                                anchorY + s.scale * docCenterY,
                                imageScale,
                                image,
                                dstW,
                                dstH,
                            )
                            // Content not worth linear-light correctness ([ImageSingle.highQuality])
                            // gets the plain sampler - it never reaches the tile cache either.
                            // Animated pages are never highQuality but want the fast sampler
                            // regardless, swapping images every frame. Both are stencil-tested
                            // against the tile draw above, skipping pixels it already covered.
                            //
                            // The page's fade rides in as the alpha multiplier rather than the
                            // Kotlin's separate veil pass - see [ImagePage.fade].
                            RenderPage.renderFast(
                                pass,
                                image,
                                texture,
                                x,
                                y,
                                imageScale,
                                page.isAnimated || page.highQuality,
                                true,
                                page.fade,
                            )
                        })
                    }
                }
            })
        } else {
            Draw.clear(encoder, texture, 0)
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
            const targetY = anchorY + s.scale * (vp.docTop + 0.5 * vp.pageHeight)

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
