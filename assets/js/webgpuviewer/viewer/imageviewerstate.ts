import {
    Job,
    OFFSET_ZERO,
    Offset,
    animate,
    coerceAtLeast,
    coerceAtMost,
    nextFrame,
    spring,
} from "../util"
import type { Downscaler, Upscaler } from "../renderer/rescaler"
import { TileRenderer } from "../renderer/tilerenderer"
import { FilterChain } from "../filter/filterchain"
import { WebGpuRenderer } from "../renderer/renderer"
import { Mipmap } from "../renderer/mipmap"
import { Transition, invalidateCache, rotateCacheOnPageChange } from "../transition/transition"
import { TransitionBasic, TransitionBasicVerticalInstance } from "../transition/transitions"
import { ImagePage, ImageSingle } from "./imagepage"

interface RenderSnapshot {
    currentPage: ImagePage
    adjacentPage: ImagePage | null
    nextPage: ImagePage | null
    offset: number
    transition: Transition
    firstPos: Offset
    currentPos: Offset
}

/**
 * The paged viewer's state and frame loop - the port of `viewer/ImageViewerState.kt`.
 *
 * Owns the renderer, the tile cache, the page offset a turn animates, and the once-per-display-
 * frame draw loop. Pages come from [fetchPage], indexed relative to the current one.
 */
export class ImageViewerState {
    readonly renderer = new WebGpuRenderer()

    readonly tiles = new TileRenderer(() => this.invalidate())

    /**
     * How a high-quality tile that magnifies the page is resized - see [Rescaler].
     * [UpscalerCatmullRom] by default; [UpscalerArtCnn] runs a doubling network first and leaves
     * whatever zoom is left over to Catmull-Rom. Assigning drops the tiles already generated.
     */
    get upscaler(): Upscaler {
        return this.tiles.upscaler
    }

    set upscaler(value: Upscaler) {
        this.tiles.upscaler = value
    }

    /**
     * How a high-quality tile that shrinks the page is resized - see [Rescaler]. [DownscalerBox]
     * is the only one, and is the default.
     */
    get downscaler(): Downscaler {
        return this.tiles.downscaler
    }

    set downscaler(value: Downscaler) {
        this.tiles.downscaler = value
    }

    /**
     * Post-processing over the finished frame - assign [FilterChain.filters] to run some. Wired to
     * [invalidate] here, so changing a filter's settings redraws by itself.
     */
    readonly filters: FilterChain = this.renderer.filters

    animationJob: Job | null = null

    constructor(
        public isVertical: boolean = false,
        public isReversed: boolean = false,
    ) {
        this.transition = isVertical ? TransitionBasicVerticalInstance : TransitionBasic
        this.filters.onInvalidate = () => this.invalidate()
    }

    get width(): number {
        return this.renderer.width
    }

    get height(): number {
        return this.renderer.height
    }

    /** Top padding in pixels to avoid a display cutout. */
    cutoutTopPx = 0

    get viewportHeight(): number {
        return this.height - (this.avoidCutout ? this.cutoutTopPx : 0)
    }

    /** When true, images are positioned/scaled to avoid the display cutout. */
    avoidCutout = false

    /** When true, always shift below the cutout; when false, only if the image would overlap. */
    alwaysAvoidCutout = false

    private suppressPageChange = false

    private _pageOffset = 0

    get pageOffset(): number {
        return this._pageOffset
    }

    set pageOffset(value: number) {
        let v = value
        let pageDelta = 0

        if (!this.suppressPageChange) {
            while (v >= 1 && this.haveNext) {
                pageDelta += 1
                v -= 1
            }
            while (v <= -1 && this.havePrev) {
                pageDelta -= 1
                v += 1
            }
        }

        if (!this.haveNext) v = coerceAtMost(v, 1)
        if (!this.havePrev) v = coerceAtLeast(v, -1)

        const settling = this._pageOffset !== 0 && v === 0

        this._pageOffset = v

        if (pageDelta !== 0) {
            this.onPageChange?.(this.isReversed ? -pageDelta : pageDelta)
        }

        // Rotate rather than invalidate: onPageChange has already updated whatever backs
        // getPage, so slot 2 often already holds a valid render of this new current page.
        if (settling) {
            const current = this.getPage(0)
            if (current) rotateCacheOnPageChange(current)
            else invalidateCache()
        }
    }

    private setPageOffsetDirect(value: number) {
        this.suppressPageChange = true
        this.pageOffset = value
        this.suppressPageChange = false
    }

    /** Slide a page in from [direction] without a drag having caused it. */
    animatePageTurn(direction: number) {
        this.animationJob?.cancel()
        this.setPageOffsetDirect(direction)
        this.invalidate()
        const job = animate(direction, 0, spring(), value => {
            this.setPageOffsetDirect(value)
            this.invalidate()
        })
        this.animationJob = job
        job.promise.then(() => {
            // Only if this turn is still the current one. A cancelled job's promise still settles,
            // and the Kotlin's `finally` runs inside the coroutine that got cancelled - so it
            // cannot reach a *later* turn's state. Here it can, and snapping the offset back to 0
            // would abort whichever turn replaced this one mid-flight.
            if (this.animationJob !== job) return
            // Otherwise always clear transitionFromPage - getPage provides the right page from
            // here on.
            this.transitionFromPage = null
            this.setPageOffsetDirect(0)
            this.invalidate()
        })
    }

    get havePrev(): boolean {
        return this.getPage(this.isReversed ? 1 : -1) !== null
    }

    get haveNext(): boolean {
        return this.getPage(this.isReversed ? -1 : 1) !== null
    }

    fetchPage: ((index: number) => ImagePage | null) | null = null

    onPageChange: ((delta: number) => void) | null = null
    onTap: ((position: Offset) => void) | null = null
    onLongTap: ((position: Offset) => void) | null = null

    /** Override for the "from" page during far navigation animation. */
    transitionFromPage: ImagePage | null = null

    // Pre-allocated invalidate callback - same for the lifetime of this state.
    private readonly invalidateCallback = () => this.invalidate()

    /**
     * The page [index] steps from current. [isReversed] plays no part here - [fetchPage] and
     * [onPageChange] are what decide what a step actually means.
     */
    getPage(index: number): ImagePage | null {
        const page = this.fetchPage?.(index) ?? null
        page?.attach(this, this.invalidateCallback)
        return page
    }

    /**
     * The pages the last snapshot drew with, which is what `ImagePage.isOnScreen` answers from -
     * a page can then decide for itself whether a redraw is worth asking for.
     */
    protected onScreenPages: ImagePage[] = []

    isOnScreen(page: ImagePage): boolean {
        return this.onScreenPages.some(p => p.covers(page))
    }

    /**
     * Called after the surface changes size. A page's home transform derives from the viewport, so a
     * resize invalidates the fit of anything settled - and the state knows only the pages it
     * fetches, so the decision goes to whoever owns them.
     */
    onViewportChanged: (() => void) | null = null

    /** Attach to [canvas] and start the frame loop. */
    init(canvas: HTMLCanvasElement, width: number, height: number) {
        this.renderer.init(canvas, width, height)
    }

    firstPos: Offset = OFFSET_ZERO
    currentPos: Offset = OFFSET_ZERO

    transition: Transition

    // Anything changed since the last frame drawn - all [collect] needs, however many
    // invalidates said so.
    private dirty = true
    private wake: (() => void) | null = null
    private running = false

    invalidate() {
        this.dirty = true
        this.wake?.()
    }

    /**
     * Draw at most one frame per display frame, for as long as anything is dirty.
     *
     * A frame loop, not a pass per invalidate: a fling step, a fade step, a decode and the tile
     * worker all land in one frame, and drawing each presented the same content several times a
     * vsync. The wake carries no count, so a draw clearing the flag doesn't make that frame's
     * remaining invalidates wait a frame each - which would be half rate, not coalescing.
     */
    async collect() {
        if (this.running) return
        this.running = true
        let drawing: Promise<void> | null = null
        let drawingActive = false

        while (this.running) {
            await nextFrame()
            // Still drawing: leave dirty set for the next frame.
            if (drawingActive) continue
            if (!this.dirty) {
                WebGpuRenderer.animating = false
                await new Promise<void>(resolve => {
                    this.wake = () => {
                        this.wake = null
                        resolve()
                    }
                })
                continue
            }
            // Republished here rather than at each of the seven animation sites: this is the one
            // place that already runs whenever any of them does.
            WebGpuRenderer.animating =
                this.animationJob !== null || this.getPage(0)?.animationJob != null
            this.dirty = false
            // Capture render state before any await, so an invalidate from here belongs to the
            // next frame.
            const snapshot = this.captureRenderState()
            if (!snapshot) continue

            drawingActive = true
            drawing = this.renderer
                .render((encoder, texture) => this.renderSnapshot(encoder, texture, snapshot))
                // Nothing drawn - ask for the frame again.
                .then(drawn => {
                    if (!drawn) this.invalidate()
                })
                .finally(() => {
                    drawingActive = false
                })
            void drawing
        }
    }

    stop() {
        this.running = false
        WebGpuRenderer.animating = false
        this.wake?.()
    }

    /**
     * This frame's render inputs, or null when there is nothing to draw.
     *
     * Typed `unknown` for the same reason the Kotlin types it `Any`: the continuous mode captures a
     * different shape entirely (see `ImageViewerContinuousState`). Each subclass casts in its own
     * [renderSnapshot], so the pairing stays private to the class that owns both halves.
     */
    protected captureRenderState(): unknown {
        const currentPage = this.getPage(0)
        if (!currentPage) return null
        const offset = this.pageOffset
        const adjacentPage =
            offset === 0 ? null
                : this.transitionFromPage !== null ? this.transitionFromPage
                    : offset > 0 ? this.getPage(this.isReversed ? -1 : 1)
                        : this.getPage(this.isReversed ? 1 : -1)
        // Only used to pre-warm the transition cache while at rest, so there's no need to look it
        // up while a turn is already in progress.
        const nextPage = offset === 0 ? this.getPage(1) : null
        this.onScreenPages = adjacentPage ? [currentPage, adjacentPage] : [currentPage]
        return {
            currentPage,
            adjacentPage,
            nextPage,
            offset,
            transition: this.transition,
            firstPos: this.firstPos,
            currentPos: this.currentPos,
        }
    }

    /**
     * Run [block] against a render pass over [texture], ending the pass afterwards either way.
     *
     * Pass ownership sits here rather than inside the transitions, since only the code that knows
     * the whole frame's contents can decide where the pass starts and ends.
     *
     * Always clears: `getCurrentTexture` rotates buffers, so loading would show stale content
     * from several frames ago around the page.
     */
    protected renderPass(
        encoder: GPUCommandEncoder,
        texture: GPUTexture,
        block: (pass: GPURenderPassEncoder) => void,
    ) {
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: texture.createView(),
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                },
            ],
            // Cleared fresh every frame so the tile blit can mark which pixels it just covered
            // and RenderPage's masked draws can skip re-shading them. Discarded afterward:
            // nothing reads it across frames.
            depthStencilAttachment: {
                view: this.tiles.stencilViewFor(texture),
                stencilLoadOp: "clear",
                stencilStoreOp: "discard",
                stencilClearValue: 0,
            },
        })
        try {
            block(pass)
        } finally {
            pass.end()
        }
    }

    protected renderSnapshot(
        encoder: GPUCommandEncoder,
        texture: GPUTexture,
        rawSnapshot: unknown,
    ) {
        const snapshot = rawSnapshot as RenderSnapshot
        this.tiles.newFrame()
        const page = snapshot.currentPage

        if (snapshot.adjacentPage && snapshot.offset !== 0) {
            snapshot.transition.render(
                page,
                snapshot.adjacentPage,
                encoder,
                texture,
                snapshot.offset,
                snapshot.firstPos,
                snapshot.currentPos,
                this.tiles,
            )
            return
        }

        const covered = page.drawLive(encoder, texture, this.tiles)

        // Opportunistic: once the current page's tiles settle, prewarm the next page's too, so a
        // transition into it starts already mostly sharp. Gated on atHome since the cache is
        // keyed by (x, y, scale).
        if (covered && page instanceof ImageSingle && page.atHome) {
            const next = snapshot.nextPage
            if (
                next instanceof ImageSingle &&
                next.highQuality &&
                !next.isAnimated &&
                next.atHome
            ) {
                this.tiles.prewarm(next, texture)
            }
        }
    }

    cleanup() {
        this.stop()
        this.animationJob?.cancel()
        this.tiles.cleanup()
        this.renderer.cleanup()
        // The pool is static: without this a later viewer on a new device gets the old one's
        // textures.
        Mipmap.clearPool()
    }
}
