import {
    AnimationSpec,
    Job,
    Offset,
    STIFFNESS_MEDIUM_LOW,
    alphaOf,
    animate,
    closeTo,
    coerceIn,
    colorToFloats,
    delay,
    launch,
    orZero,
    spring,
    tween,
} from "../util"
import { Draw } from "../draw/draw"
import { TextOptions, drawText } from "../draw/text"
import type { Image } from "../renderer/image"
import { RenderPage } from "../renderer/renderpage"
import type { TileRenderer } from "../renderer/tilerenderer"
import { WebGpuRenderer } from "../renderer/renderer"
import type { ImageViewerState } from "./imageviewerstate"

/** Default [ImagePage.fadeIn] length. */
export const FADE_MILLIS = 200

/**
 * A page in the viewer, with shared transform (x, y, scale), pan/zoom-to-fit bounds, and
 * animation - the port of `viewer/ImagePage.kt`.
 *
 * [ImageSingle] is the ordinary single-page case; [ImageSpread] composes two side by side for a
 * dual-page spread. [DummyPage] is a placeholder with known dimensions but no content.
 * [RenderPageBase] draws its own content instead of blitting an image.
 */
export class ImagePage {
    /** True once page content has been decoded/is otherwise ready to draw. */
    get isDecoded(): boolean {
        return false
    }

    private _destroyed = false

    /** True once [cleanup] has run and the page's resources are gone or going. */
    get destroyed(): boolean {
        return this._destroyed
    }

    /** True while an animation frame loop owns the current frame. Only ever true for images. */
    get isAnimated(): boolean {
        return false
    }

    /**
     * Incremented each time this page's drawn content changes - an animated frame, or a
     * [RenderPageBase]'s `invalidate`. Read by a transition to spot a stale cache slot.
     */
    get frameVersion(): number {
        return 0
    }

    scale = 1
    x = 0
    y = 0

    setPos(x: number = this.x, y: number = this.y, scale: number = this.scale) {
        if (this.x === x && this.y === y && this.scale === scale) return
        this.x = x
        this.y = y
        this.scale = scale
        this.onInvalidate?.()
    }

    /**
     * Draws this page's content instead of blitting an image. Given the raw [encoder], not an open
     * pass, so a page that doesn't need the tile cache's stencil masking can open its own. Must
     * clear [dst] itself, as this default does: `getCurrentTexture` rotates buffers, so leaving it
     * alone shows stale content from several frames back.
     */
    renderWith(
        encoder: GPUCommandEncoder,
        x: number,
        y: number,
        scale: number,
        dst: GPUTexture,
    ) {
        Draw.clear(encoder, dst, 0)
    }

    /**
     * Draws this page's current live content into [dst] - the paged viewer's per-frame
     * (non-transition) path.
     *
     * Returns true if the page is now fully covered by sharp tiles, so the viewer knows it's safe
     * to prewarm the next page - always false here, since only an image page has a tile cache.
     */
    drawLive(encoder: GPUCommandEncoder, dst: GPUTexture, tiles: TileRenderer): boolean {
        this.renderWith(encoder, 0, 0, 1, dst)
        return false
    }

    /** As [drawLive], but seeding a transition's cache slot instead of the screen. */
    renderCacheSeed(encoder: GPUCommandEncoder, tex: GPUTexture, tiles: TileRenderer) {
        this.renderWith(encoder, 0, 0, 1, tex)
    }

    /**
     * Tile keys newly available to blit since the last call, or null if this page is never tiled.
     */
    newlyAvailableTileKeys(tiles: TileRenderer, tex: GPUTexture): Set<number> | null {
        return null
    }

    /**
     * Renders this page into a transition's cache slot. [identityMatches] false means a fresh
     * slot (seed from scratch, clear); true means an unchanged one that just needs whatever's
     * newly available layered on (load).
     */
    renderIntoCache(
        encoder: GPUCommandEncoder,
        tex: GPUTexture,
        tiles: TileRenderer,
        identityMatches: boolean,
    ) {
        this.renderCacheSeed(encoder, tex, tiles)
    }

    /**
     * This page's own rect within a flat render of it into [dst], as normalised
     * `(x1, y1, x2, y2)` surface coordinates - for a warp transition to map the page's actual
     * rect rather than treating it as screen-shaped.
     */
    pageRect(dst: GPUTexture): Float32Array | null {
        return null
    }

    /**
     * The colour a transition should blend/fade toward for this page as a whole. Null (nothing to
     * fill/blend toward) by default.
     */
    get backgroundColor(): number | null {
        return null
    }

    /**
     * Draws this page's per-image background colour as separate columns at [offsetX]/[offsetY]
     * within its own cached-surface slide. A no-op for a page with no images.
     */
    drawBackgroundColumns(
        pass: GPURenderPassEncoder,
        dst: GPUTexture,
        offsetX: number,
        offsetY: number,
    ) { }

    get width(): number {
        return 0
    }

    get height(): number {
        return 0
    }

    /** As [width]/[height], but after trim - defaults to the untrimmed size. */
    get trimWidth(): number {
        return this.width
    }

    get trimHeight(): number {
        return this.height
    }

    /** True if this page uses half-screen layout (dual page or single LEFT/RIGHT). */
    get isHalfWidth(): boolean {
        return false
    }

    /** Left/right edges [minX]/[maxX] pan between: trim's edges once [trimmed], else raw span. */
    protected xEdges(trimmed: boolean): [number, number] {
        return [0, this.width]
    }

    /**
     * As [xEdges], for top/bottom - null (not the raw fallback) so [nudgedYBounds] can tell real
     * trim edges (margin worth protecting) from the raw image's own (safe to pan past).
     */
    protected yEdges(trimmed: boolean): [number, number] | null {
        return null
    }

    animationJob: Job | null = null
    animationTargetX: number | null = null
    animationTargetY: number | null = null
    animationTargetScale: number | null = null

    /**
     * True while [scale] is being animated - by [animateTo] or externally (e.g. fling-zoom
     * decay). Gates the tile cache, which otherwise can't tell a settled scale from a spring
     * that's merely repeating a value for a frame mid-flight.
     */
    isScaleAnimating = false

    /**
     * True while a plain (non-zoom) pan fling is actively decaying. Checked by the gesture layer
     * so a tap landing while a fling from the previous gesture is still gliding doesn't also fire
     * `onTap` - the tap itself has no motion, so nothing else would tell the two apart.
     */
    isFlinging = false

    private _parent: ImageViewerState | null = null

    get parent(): ImageViewerState | null {
        return this._parent
    }

    set parent(value: ImageViewerState | null) {
        this._parent = value
        this.applyHome()
    }

    /**
     * True until this page has snapped to its home transform.
     *
     * The Kotlin snaps eagerly in the `parent` setter, since Android knows the surface size before
     * any page attaches. Here the `ResizeObserver` fires a frame *after* the element connects, so a
     * page attached in between computes [homeScale] against a zero viewport and lands on its 0.01
     * fallback - rendered at 1% of its size. [attach] retries every frame instead, so the snap
     * happens on the first frame the viewport is real.
     */
    private homePending = true

    /** Snap to home, once there is a viewport to compute it against. */
    private applyHome() {
        if (!this.homePending) return
        const parent = this._parent
        if (!parent || parent.width <= 0 || parent.viewportHeight <= 0) return
        this.homePending = false
        // Only if nothing has moved it since - the guard the Kotlin's setter applies.
        if (this.x !== 0 || this.y !== 0 || this.scale !== 1) return
        this.x = this.homeX
        this.y = this.homeY
        this.scale = this.homeScale
    }

    /**
     * Re-snap to home, for a viewport resized after this page settled.
     *
     * [homeScale] recomputes from the viewport on every read unless set explicitly, so only
     * [x]/[y]/[scale] go stale - a page fitted to the old size keeps that fit. The caller decides
     * when it is worth doing; Mihon wipes its whole page cache on the equivalent event.
     */
    resetHome() {
        this.homePending = true
        this.x = 0
        this.y = 0
        this.scale = 1
        this.applyHome()
        this.onInvalidate?.()
    }

    onInvalidate: (() => void) | null = null

    private _fade = 1

    /**
     * How far this page has faded in: 1 fully shown, 0 fully transparent.
     *
     * The Kotlin veils the page with its own [backgroundColor] at `1 - fade` alpha, which fades
     * nothing when that background is transparent. This scales the page's own alpha instead - the
     * same `bg*(1-f) + img*f` where a background exists, since [renderBackground] still draws at
     * full alpha underneath, and an actual fade where it does not. The multiply is in the tile
     * shaders; see `RenderPage.drawTile`.
     */
    get fade(): number {
        return this._fade
    }

    private fadeJob: Job | null = null
    private fadeMillis = FADE_MILLIS
    private fadeStartMillis = 0

    /** Waiting to be attached: a decode installs the page, the next frame attaches it. */
    private fadePending = false

    /**
     * Fade this page in instead of having it appear at once - for one swapped in behind a
     * placeholder that was on screen. Needs a [backgroundColor] to fade from, and runs on the
     * clock from here, so a fade nobody watches is over by the time it is reached.
     */
    fadeIn(durationMillis: number = FADE_MILLIS) {
        if (this.destroyed) return
        this.fadeMillis = durationMillis
        this.fadeStartMillis = performance.now()
        this._fade = 0
        this.fadePending = true
        this.startFade()
    }

    /** Pick the fade up wherever the clock has got to, or skip it if that is already past. */
    private startFade() {
        if (!this.fadePending) return
        if (!this._parent) return
        this.fadePending = false
        this.fadeJob?.cancel()

        const elapsed = performance.now() - this.fadeStartMillis
        if (elapsed >= this.fadeMillis) {
            this._fade = 1
            return
        }
        const from = elapsed / this.fadeMillis
        this._fade = from

        this.fadeJob = animate(from, 1, tween(this.fadeMillis - elapsed), value => {
            this._fade = value
            // invalidate(), not onInvalidate: its frameVersion bump re-seeds a transition's
            // cached copy, which would otherwise hold the veil at whatever it was seeded with.
            this.invalidate()
        })
    }

    /** True while the viewer is drawing this page, itself or as a side of a spread. */
    get isOnScreen(): boolean {
        return this._parent?.isOnScreen(this) === true
    }

    /** True when drawing this page draws [other] - itself, or a side [ImageSpread] overrides in. */
    covers(other: ImagePage): boolean {
        return this === other
    }

    /**
     * Adopts this page into [parent]'s viewer. [ImageSpread] passes it on to its sides, which the
     * viewer never fetches itself but which still need a way back to the screen.
     */
    attach(parent: ImageViewerState, onInvalidate: () => void) {
        if (this._parent !== parent) this.parent = parent
        if (this.onInvalidate !== onInvalidate) this.onInvalidate = onInvalidate
        // Retried every frame until it takes - see [applyHome].
        this.applyHome()
        if (this.fadePending) this.startFade()
    }

    /** Redraws this page, if it is on screen to redraw. */
    invalidate() {
        if (this.isOnScreen) this.onInvalidate?.()
    }

    private get parentWidth(): number {
        return this._parent?.width ?? 0
    }

    private get parentHeight(): number {
        return this._parent?.viewportHeight ?? 0
    }

    /**
     * [isHalfWidth]'s fit scale: each side of a spread can be a differently sized image, so
     * [ImageSpread] overrides this to fit each one independently rather than the combined span.
     */
    protected halfWidthScale(halfWidth: number, parentHeight: number): number {
        return Math.max(0.01, Math.min(halfWidth / this.width, parentHeight / this.height))
    }

    get atHome(): boolean {
        return closeTo(this.x, this.homeX) && closeTo(this.y, this.homeY) && this.atHomeScale
    }

    get atHomeScale(): boolean {
        return closeTo(this.scale, this.homeScale)
    }

    private _homeScale = -1

    /** Explicit override; -1 (the default) means "derive from the viewport". */
    set homeScale(value: number) {
        this._homeScale = value
    }

    get homeScale(): number {
        if (this._homeScale > 0) return this._homeScale

        if (this.parentWidth <= 0 || this.parentHeight <= 0) return 0.01

        if (this.isHalfWidth) {
            // Half-width layout: each image fits in half screen, no trim.
            return this.halfWidthScale(this.parentWidth / 2, this.parentHeight)
        }

        // Single page: fit trim to full screen.
        const w = this.trimWidth
        const h = this.trimHeight
        if (w <= 0 || h <= 0) return 0.01
        return Math.max(0.01, Math.min(this.parentWidth / w, this.parentHeight / h))
    }

    private _homeX = 0

    set homeX(value: number) {
        this._homeX = value
    }

    get homeX(): number {
        if (this._homeX !== 0) return this._homeX
        const scale = this.homeScale
        return coerceIn(this.maxX(scale), this.minX(scale), this.maxX(scale))
    }

    private _homeY = 0

    set homeY(value: number) {
        this._homeY = value
    }

    get homeY(): number {
        if (this._homeY !== 0) return this._homeY
        const scale = this.homeScale
        return coerceIn(this.maxY(scale), this.minY(scale), this.maxY(scale))
    }

    private _minScale = 0

    set minScale(value: number) {
        this._minScale = value
    }

    get minScale(): number {
        if (this._minScale > 0) return this._minScale
        if (this.parentWidth <= 0 || this.parentHeight <= 0) return 0.01

        if (this.isHalfWidth) {
            return this.halfWidthScale(this.parentWidth / 2, this.parentHeight)
        }

        return Math.max(
            0.01,
            Math.min(this.parentWidth / this.width, this.parentHeight / this.height),
        )
    }

    private _maxScale = 0

    set maxScale(value: number) {
        this._maxScale = value
    }

    get maxScale(): number {
        return this._maxScale > 0 ? this._maxScale : Math.max(this.doubleTapScale * 2, 2)
    }

    private _doubleTapScale = 0

    set doubleTapScale(value: number) {
        this._doubleTapScale = value
    }

    get doubleTapScale(): number {
        return this._doubleTapScale !== 0 ?
            this._doubleTapScale
            : Math.max(this.minScale, this.homeScale) * 2
    }

    // BOUNDS:
    // cutout ignore:
    //  with trim:
    //      >= homeScale: viewport pan over trimmed content
    //      < homeScale: viewport pan over untrimmed content
    //  without trim: viewport pan over content
    //
    // cutout avoid:
    //  with trim: as above, over the cut viewport
    //  if content is fully visible: nudge below cutout
    //
    // cutout shift:
    //  with trim: as above, over the cut viewport
    //  if content is fully visible: center in cut viewport

    /**
     * As [xBounds] but never collapsed (min > max when there's slack). [nudgedYBounds] needs the
     * true floor - the collapsed center sits below it, letting panning reveal past it.
     */
    private rawBounds(
        size: number,
        nearEdge: number,
        farEdge: number,
        parentSize: number,
        scale: number,
    ): [number, number] {
        const maxV = (0.5 * size - nearEdge) / parentSize - 0.5 / scale
        const minV = (0.5 * size - farEdge) / parentSize + 0.5 / scale
        return [minV, maxV]
    }

    /** [minX]/[maxX] together, computing [homeScale] and [rawBounds] only once per call. */
    private xBounds(scale: number): [number, number] {
        const parent = this._parent
        if (!parent) return [0, 0]
        const [left, right] = this.xEdges(scale >= this.homeScale)
        const [minV, maxV] = this.rawBounds(this.width, left, right, parent.width, scale)
        if (minV > maxV) {
            // [maxV, minV] is every x showing the content whole - a lone spread side zoomed past
            // its half would otherwise stay pinned to the seam, hanging off screen.
            const rest = coerceIn(this.restingX(scale), maxV, minV)
            return [rest, rest]
        }
        return [minV, maxV]
    }

    /**
     * Where the page rests horizontally once its content fits the viewport - the middle of
     * [xEdges]'s span, so the content sits centred.
     *
     * [ImageSpread] overrides it to rest on the seam instead. That is what keeps a lone left/right
     * side in its own half; centring the span would pull it to the middle, indistinguishable from
     * a page with no partner.
     */
    protected restingX(scale: number): number {
        const parent = this._parent
        if (!parent) return 0
        const [near, far] = this.xEdges(scale >= this.homeScale)
        return (0.5 * this.width - 0.5 * (near + far)) / parent.width
    }

    minX(scale: number): number {
        return this.xBounds(scale)[0]
    }

    maxX(scale: number): number {
        return this.xBounds(scale)[1]
    }

    /**
     * "Ignore": [xBounds]'s plain collapse-when-it-fits.
     *
     * "Avoid"/"shift": near/top bound pushed further by the *full* cutout so the cut viewport
     * (real viewport minus the cutout) can pan over all the content - unless still fully visible
     * there even after the push, which collapses to one rest point instead of a pointless range:
     * "shift" always rests centered in the cut viewport (half the push, since shrinking the
     * viewport only moves its center by half); "avoid" only nudges - just far enough to clear the
     * cutout - and only when the plain whole-screen-centered rest would actually overlap it.
     */
    private nudgedYBounds(scale: number): [number, number] {
        const parent = this._parent
        if (!parent) return [0, 0]
        const trimmed = scale >= this.homeScale
        const [top, bottom] = this.yEdges(trimmed) ?? [0, this.height]
        const [floor, natMax] = this.rawBounds(this.height, top, bottom, parent.height, scale)
        const slack = floor > natMax
        const center = (floor + natMax) / 2

        if (!parent.avoidCutout || parent.cutoutTopPx <= 0 || parent.height <= 0) {
            return slack ? [center, center] : [floor, natMax]
        }

        const fullPush =
            this.isHalfWidth && !trimmed ? 0 : parent.cutoutTopPx / (scale * parent.height)
        const pushed = natMax + fullPush

        if (slack) {
            // "pushed" is exactly the rest position where the near edge sits flush against the
            // cutout - so center < pushed means the plain centered rest would sit under it.
            const overlapsCutout = center < pushed
            if (!parent.alwaysAvoidCutout && !overlapsCutout) return [center, center]
            const rest = parent.alwaysAvoidCutout ? center + fullPush / 2 : pushed
            if (rest < floor) return [rest, rest]
        }
        return [floor, pushed]
    }

    minY(scale: number): number {
        return this.nudgedYBounds(scale)[0]
    }

    maxY(scale: number): number {
        return this.nudgedYBounds(scale)[1]
    }

    home() {
        this.animateTo({ targetScale: this.homeScale })
    }

    animateTo(options: {
        origin?: Offset | null
        targetX?: number
        targetY?: number
        targetScale?: number
        /** Defaults to the viewer's usual spring - wheel zoom wants a snappier one. */
        spec?: AnimationSpec
    } = {}) {
        const origin = options.origin ?? null
        const targetX = options.targetX ?? this.homeX
        const targetY = options.targetY ?? this.homeY

        this.animationJob?.cancel()

        const startScale = this.scale
        const startX = this.x
        const startY = this.y

        const targetScale = coerceIn(
            options.targetScale ?? this.scale,
            this.minScale,
            this.maxScale,
        )

        const minX = this.minX(targetScale)
        const maxX = this.maxX(targetScale)
        const minY = this.minY(targetScale)
        const maxY = this.maxY(targetScale)

        const scaleChanging = targetScale !== startScale
        const diffEnd = scaleChanging ? 1 / targetScale - 1 / startScale : 1

        const endX =
            origin && scaleChanging ? coerceIn(startX + (origin.x - 0.5) * diffEnd, minX, maxX)
                : origin ? coerceIn(this.x, minX, maxX)
                    : targetX
        const endY =
            origin && scaleChanging ? coerceIn(startY + (origin.y - 0.5) * diffEnd, minY, maxY)
                : origin ? coerceIn(this.y, minY, maxY)
                    : targetY

        if (!this._parent) {
            this.setPos(endX, endY, targetScale)
            return
        }

        this.animationTargetX = endX
        this.animationTargetY = endY
        this.animationTargetScale = targetScale
        if (scaleChanging) this.isScaleAnimating = true

        // The animate job itself, not a wrapper around it: cancelling `animationJob` has to stop
        // the frame callbacks, and a wrapper's cancel would only unblock its own await.
        const job = animate(0, 1, options.spec ?? spring(STIFFNESS_MEDIUM_LOW, 0.002), value => {
            const currentScale = startScale + (targetScale - startScale) * value
            const c =
                scaleChanging ? coerceIn((1 / currentScale - 1 / startScale) / diffEnd, 0, 1)
                    : value

            this.setPos(
                orZero(startX + (endX - startX) * c),
                orZero(startY + (endY - startY) * c),
                currentScale,
            )
        })
        this.animationJob = job
        job.promise.finally(() => {
            // Only if this animation is still the current one - a newer animateTo has already
            // installed its own targets by the time a cancelled one settles.
            if (this.animationJob !== job) return
            this.animationTargetX = null
            this.animationTargetY = null
            this.animationTargetScale = null
            this.isScaleAnimating = false
        })
    }

    cleanup() {
        if (this._destroyed) return
        this._destroyed = true

        this.animationJob?.cancel()
        this.animationJob = null
        this.fadeJob?.cancel()
        this.fadeJob = null
        this.fadePending = false
    }

    /** Alias for [cleanup]. */
    destroy() {
        this.cleanup()
    }
}

/** Placeholder page with dimensions but no image data. */
export class DummyPage extends ImagePage {
    constructor(
        private readonly _width: number,
        private readonly _height: number,
    ) {
        super()
    }

    override get width(): number {
        return this._width
    }

    override get height(): number {
        return this._height
    }
}

/**
 * A page whose content is supplied by an overridden [render] instead of a decoded image - for
 * progress indicators or other app-drawn content with its own shader. Called instead of blitting
 * a texture wherever this page would otherwise be drawn into the regular view or a transition's
 * cache texture.
 *
 * Opens one pass per [render] call (no stencil attachment - nothing here needs the tile cache's
 * masking), shared by every [rect]/[circle] call inside it rather than each opening its own.
 *
 * [renderWith] clears that pass's destination first - right whenever this page owns the whole
 * thing. [renderLoaded] is the one exception: the continuous viewer draws several pages into one
 * shared screen texture, so clearing would blank every other visible page too.
 *
 * Override [backgroundColor] to fill a background before [render] runs.
 */
export class RenderPageBase extends ImagePage {
    constructor(
        private readonly _width: number,
        private readonly _height: number,
    ) {
        super()
    }

    override get width(): number {
        return this._width
    }

    override get height(): number {
        return this._height
    }

    // Always has drawable content via render(), unlike DummyPage - needed so a transition's cache
    // doesn't skip this page as if it were undecoded.
    override get isDecoded(): boolean {
        return true
    }

    // Unlike the base default (a fixed "home" position, right for DummyPage - it has nothing
    // pan-worthy anyway), this page's own render() gets its *live* pan/zoom transform, so its
    // drawn content can track a drag/pinch the way an image page's would.
    override drawLive(
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        tiles: TileRenderer,
    ): boolean {
        this.renderWith(encoder, this.x, this.y, this.scale, dst)
        return false
    }

    override renderCacheSeed(
        encoder: GPUCommandEncoder,
        tex: GPUTexture,
        tiles: TileRenderer,
    ) {
        this.renderWith(encoder, this.x, this.y, this.scale, tex)
    }

    // render() treats dst as entirely its own canvas - so unlike an image page, whose real
    // content only ever occupies part of dst, this page's rect within a flat render of it IS the
    // whole thing, just panned/zoomed by its own live x/y/scale. Without this, the warp
    // transitions - which bail out on a null pageRect rather than treating it as screen-shaped -
    // would never draw this page at all.
    override pageRect(dst: GPUTexture): Float32Array {
        return new Float32Array([
            0.5 + this.scale * (this.x - 0.5),
            0.5 + this.scale * (this.y - 0.5),
            0.5 + this.scale * (this.x + 0.5),
            0.5 + this.scale * (this.y + 0.5),
        ])
    }

    // Set right before calling render(), and only valid for the duration of that call - rect and
    // circle read it instead of taking a pass parameter, since there's only ever one pass open
    // per render() call.
    private pass!: GPURenderPassEncoder

    /** Draws this page's content. Use [rect]/[circle] to draw into the open pass. */
    render(dst: GPUTexture, x: number, y: number, scale: number) { }

    private _renderVersion = 0

    /** Bumped by [invalidate], so a page turn sees the drawn content change. */
    override get frameVersion(): number {
        return this._renderVersion
    }

    override invalidate() {
        this._renderVersion++
        super.invalidate()
    }

    protected rect(x1: number, y1: number, x2: number, y2: number, color: number) {
        Draw.rect(this.pass, x1, y1, x2, y2, color)
    }

    /**
     * Fills this page's own footprint with [color] - unlike [rect]'s raw dst-relative `[0,1]`
     * coordinates (which always cover the entire dst), this is sized and positioned from this
     * page's own declared width/height plus the same x/y/scale [render] received. Matters once
     * dst is shared with other pages (the continuous viewer) instead of being this page's own.
     */
    protected fillPage(
        dst: GPUTexture,
        x: number,
        y: number,
        scale: number,
        color: number,
    ) {
        const halfWidthFrac = (scale * this.width) / (2 * dst.width)
        const halfHeightFrac = (scale * this.height) / (2 * dst.height)
        const cx = 0.5 + scale * x
        const cy = 0.5 + scale * y
        this.rect(
            cx - halfWidthFrac,
            cy - halfHeightFrac,
            cx + halfWidthFrac,
            cy + halfHeightFrac,
            color,
        )
    }

    protected circle(cx: number, cy: number, radius: number, color: number) {
        Draw.circle(this.pass, cx, cy, radius, color)
    }

    /**
     * Draws [text] centred vertically on [y], in [dst]'s pixels. The pass this page opened has no
     * stencil attachment, so the unmasked pipeline is the right one here.
     */
    protected text(
        dst: GPUTexture,
        text: string,
        x: number,
        y: number,
        size: number,
        color: number,
        options: TextOptions = {},
    ) {
        drawText(this.pass, dst, text, x, y, size, color, options)
    }

    override renderWith(
        encoder: GPUCommandEncoder,
        x: number,
        y: number,
        scale: number,
        dst: GPUTexture,
    ) {
        // Clears and draws in the same pass, rather than a separate clear pass first. [dst] is
        // this call's own, so nothing else on screen depends on whatever was already there.
        this.openPassAndRender(encoder, x, y, scale, dst, true)
    }

    /**
     * As [renderWith], but loads [dst] instead of clearing it - the continuous viewer uses this,
     * since there [dst] is one screen texture shared by several visible pages at once. [render]
     * is responsible for painting over every pixel of its own footprint here.
     */
    renderLoaded(
        encoder: GPUCommandEncoder,
        x: number,
        y: number,
        scale: number,
        dst: GPUTexture,
    ) {
        this.openPassAndRender(encoder, x, y, scale, dst, false)
    }

    // Background fill driven by backgroundColor (null by default; override it to opt in) instead
    // of a dedicated property, since that's the exact same hook every transition already reads
    // for this page's letterbox colour - one override covers both without the two disagreeing.
    private openPassAndRender(
        encoder: GPUCommandEncoder,
        x: number,
        y: number,
        scale: number,
        dst: GPUTexture,
        clear: boolean,
    ) {
        const bg = this.backgroundColor
        const [r, g, b, a] = bg !== null ? colorToFloats(bg) : [0, 0, 0, 0]

        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: dst.createView(),
                    loadOp: clear ? "clear" : "load",
                    storeOp: "store",
                    clearValue: { r, g, b, a },
                },
            ],
        })
        this.pass = pass
        try {
            // clear=true already painted the whole dst this colour via clearValue above - a
            // page-scoped fillPage on top would be redundant. clear=false (the shared-texture
            // continuous pass) has no clear to fall back on, so paint the footprint here. A fully
            // transparent background has nothing to paint either way.
            if (!clear && bg !== null && alphaOf(bg) > 0) this.fillPage(dst, x, y, scale, bg)
            this.render(dst, x, y, scale)
        } finally {
            pass.end()
        }
    }
}

/**
 * A page backed by a single decoded image, read straight off [currentImage]. [ImageSpread]
 * extends this to compose two side by side, overriding each member that needs both; pass setup,
 * tile cache and background fade math are shared as-is.
 */
export class ImageSingle extends ImagePage {
    constructor(readonly image: Image | null) {
        super()
    }

    /**
     * If true, this page owns its image and will clean it up. If false, it's borrowed - see
     * [ImageSpread], which composes existing pages without taking ownership of their images.
     */
    ownsImage = true

    private _highQuality = true

    /**
     * When false, this page skips the tile cache entirely and its fast path renders with
     * `linear = false` - for content not worth either path's extra correctness or sharpness, such
     * as an app-drawn transition/error bitmap.
     */
    get highQuality(): boolean {
        return this._highQuality
    }

    set highQuality(value: boolean) {
        this._highQuality = value
    }

    override get width(): number {
        return this.image?.width ?? 0
    }

    override get height(): number {
        return this.image?.height ?? 0
    }

    override get trimWidth(): number {
        const im = this.image
        return im ? (im.trim?.width() ?? im.width) : 0
    }

    override get trimHeight(): number {
        const im = this.image
        return im ? (im.trim?.height() ?? im.height) : 0
    }

    protected override xEdges(trimmed: boolean): [number, number] {
        if (!trimmed) return [0, this.width]
        const trim = this.image?.trim
        if (!trim) return [0, this.width]
        return [trim.left, trim.right]
    }

    protected override yEdges(trimmed: boolean): [number, number] | null {
        if (!trimmed) return null
        const trim = this.image?.trim
        if (!trim) return null
        return [trim.top, trim.bottom]
    }

    private animationLoop: Job | null = null
    private frames: [Image, number][] | null = null
    private currentFrameImage: Image | null = null

    /** True while an animation frame loop owns [currentImage]. The tile cache skips these. */
    override get isAnimated(): boolean {
        return this.frames !== null
    }

    private _frameVersion = 0

    override get frameVersion(): number {
        return this._frameVersion
    }

    /** Current image for rendering (may change during animation). */
    get currentImage(): Image | null {
        return this.currentFrameImage ?? this.image
    }

    /**
     * Runs [action] for each image drawn right now, with its pixel offset from the page anchor -
     * [currentImage] at 0 here, both sides for an [ImageSpread]. For callers that place images
     * with their own math (the tile cache, the continuous viewer) instead of [renderPage].
     */
    forEachImage(action: (image: Image, offsetX: number) => void) {
        const im = this.currentImage
        if (im) action(im, 0)
    }

    /** True once at least one of this page's images has been uploaded and can be drawn. */
    get hasUploadedImage(): boolean {
        return (this.currentImage?.mipmaps.length ?? 0) > 0
    }

    override get isDecoded(): boolean {
        return this.currentImage !== null
    }

    /**
     * Left/right extent from this page's own anchor, in raw pixels at scale 1 - symmetric halves
     * of [width] by default; [ImageSpread] overrides for its asymmetric seam-based shape.
     */
    horizontalExtent(): [number, number] {
        const half = this.width / 2
        return [half, half]
    }

    override invalidate() {
        this._frameVersion++
        super.invalidate()
    }

    /** Starts an animated-frame loop over `[image, durationMillis]` pairs. */
    startAnimationLoop(frames: [Image, number][]) {
        this.animationLoop?.cancel()
        this.frames = frames
        this.currentFrameImage = frames[0]?.[0] ?? null

        this.animationLoop = launch(async job => {
            let frameIndex = 0
            while (true) {
                job.ensureActive()
                const frame = this.frames?.[frameIndex]
                if (!frame) break
                const [img, duration] = frame
                this.currentFrameImage = img
                // Keeps running off screen - frames stay in step with their durations, and
                // invalidate() asks for a redraw only while there is one to ask for.
                this.invalidate()
                await delay(Math.max(duration, 0))
                frameIndex = (frameIndex + 1) % (this.frames?.length ?? 1)
            }
        })
    }

    override renderWith(
        encoder: GPUCommandEncoder,
        x: number,
        y: number,
        scale: number,
        dst: GPUTexture,
    ) {
        // Clears and draws in the same pass, rather than a separate clear pass first. No stencil
        // attachment - this fallback never needs the tile cache's masking.
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: dst.createView(),
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                },
            ],
        })
        try {
            this.renderPage(pass, dst, x, y, scale, false, false)
        } finally {
            pass.end()
        }
    }

    /** Opens a clearing pass on [dst], with a stencil attachment for the tile cache's masking. */
    private beginLivePass(
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        tiles: TileRenderer,
    ): GPURenderPassEncoder {
        return encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: dst.createView(),
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                },
            ],
            depthStencilAttachment: {
                view: tiles.stencilViewFor(dst),
                stencilLoadOp: "clear",
                stencilStoreOp: "discard",
                stencilClearValue: 0,
            },
        })
    }

    /** Opens a clearing pass on [tex], no stencil - a transition's cache is never masked. */
    private beginCachePass(
        encoder: GPUCommandEncoder,
        tex: GPUTexture,
    ): GPURenderPassEncoder {
        return encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: tex.createView(),
                    loadOp: "clear",
                    storeOp: "store",
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                },
            ],
        })
    }

    /**
     * Animated frames always want the fast path regardless of [highQuality] (never worth a tile
     * cache that would just churn every frame); a non-[highQuality], non-animated page falls back
     * to the plain [renderWith]; everything else goes through the tile cache, backfilling with
     * [renderPage] wherever it isn't covered yet.
     */
    override drawLive(
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        tiles: TileRenderer,
    ): boolean {
        if (this.isAnimated) {
            const pass = this.beginLivePass(encoder, dst, tiles)
            try {
                this.renderBackground(pass, dst, 0, 0, 1)
                this.renderPage(pass, dst, 0, 0, 1, true, true, this.fade)
            } finally {
                pass.end()
            }
            return false
        }

        if (!this.highQuality) return super.drawLive(encoder, dst, tiles)

        const pass = this.beginLivePass(encoder, dst, tiles)
        try {
            // Background always drawn live first (its fades are position-dependent, never from a
            // stale tile) so it stays underneath everything else. Tiles draw next, marking every
            // pixel they cover in the stencil buffer; renderPage then only shades what's left
            // uncovered instead of the whole viewport, since the tile blit already produced the
            // right pixel wherever it drew.
            this.renderBackground(pass, dst, 0, 0, 1)
            const covered = tiles.draw(pass, this, dst, 0, 0, 1)
            if (!covered) this.renderPage(pass, dst, 0, 0, 1, true, true, this.fade)
            return covered
        } finally {
            pass.end()
        }
    }

    override renderCacheSeed(
        encoder: GPUCommandEncoder,
        tex: GPUTexture,
        tiles: TileRenderer,
    ) {
        if (this.isAnimated) {
            const pass = this.beginCachePass(encoder, tex)
            try {
                this.renderPage(pass, tex, 0, 0, 1, true, false, this.fade)
            } finally {
                pass.end()
            }
            return
        }

        if (!this.highQuality) {
            super.renderCacheSeed(encoder, tex, tiles)
            return
        }

        const pass = this.beginCachePass(encoder, tex)
        try {
            // A fade re-seeds the cache every frame (frameVersion), which is what lets a page
            // fade in mid-turn at all - the alpha is baked into the slot the transition blits.
            this.renderPage(pass, tex, 0, 0, 1, true, false, this.fade)
            tiles.blitAvailableTiles(pass, this, tex)
        } finally {
            pass.end()
        }
    }

    override newlyAvailableTileKeys(
        tiles: TileRenderer,
        tex: GPUTexture,
    ): Set<number> | null {
        return !this.highQuality || this.isAnimated ? null : tiles.availableTileKeys(this, tex)
    }

    override renderIntoCache(
        encoder: GPUCommandEncoder,
        tex: GPUTexture,
        tiles: TileRenderer,
        identityMatches: boolean,
    ) {
        if (!identityMatches) {
            this.renderCacheSeed(encoder, tex, tiles)
            return
        }
        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: tex.createView(), loadOp: "load", storeOp: "store" }],
        })
        try {
            tiles.blitAvailableTiles(pass, this, tex)
        } finally {
            pass.end()
        }
    }

    override pageRect(dst: GPUTexture): Float32Array | null {
        const image = this.currentImage
        if (!image) return null
        if (image.mipmaps.length === 0) return null
        return image.placement(dst, this.x, this.y, this.scale)
    }

    override get backgroundColor(): number | null {
        return this.currentImage?.backgroundColor ?? null
    }

    override drawBackgroundColumns(
        pass: GPURenderPassEncoder,
        dst: GPUTexture,
        offsetX: number,
        offsetY: number,
    ) {
        const image = this.currentImage
        if (!image) return
        if (image.mipmaps.length === 0) return
        // One image, so its column is the whole width - see [backgroundSpansFullWidth].
        Draw.rect(pass, offsetX, offsetY, offsetX + 1, offsetY + 1, image.backgroundColor)
    }

    /**
     * Draw this page into [pass], one bilinear tap per pixel. [linear]/[masked] pick the same 4
     * pipelines as the image-level `RenderPage.renderFast`. Background handling is derived from
     * the pair rather than its own parameter: masked+linear skips it (that caller already drew it
     * via [renderBackground]), masked-only folds it into the masked draw, unmasked always draws a
     * plain one alongside.
     */
    renderPage(
        pass: GPURenderPassEncoder,
        dst: GPUTexture,
        x: number,
        y: number,
        scale: number,
        linear: boolean = true,
        masked: boolean = true,
        alpha: number = 1,
    ) {
        const variant = RenderPage.variantFor(linear, masked)
        this.forEachPlacedImage(dst, x, y, scale, (image, rect, placeX, placeY, placeScale) => {
            if (!linear || !masked) {
                this.drawImageBackground(pass, image, rect, scale, masked)
            }
            for (const tile of image.prepareTilesForRender(dst, placeX, placeY, placeScale)) {
                RenderPage.drawTile(pass, dst, tile, variant, alpha)
            }
        })
    }

    /**
     * Draw just this page's per-image background colour, skipping the image itself - for the
     * masked path, which draws this first (so it stays underneath the tile blit and
     * [renderPage]), or as the whole draw once the tile cache already covers the image itself.
     * The background's alpha depends on live pan/scale, so it's drawn every frame regardless of
     * tile coverage.
     */
    renderBackground(
        pass: GPURenderPassEncoder,
        dst: GPUTexture,
        x: number,
        y: number,
        scale: number,
    ) {
        this.forEachPlacedImage(dst, x, y, scale, (image, rect) => {
            this.drawImageBackground(pass, image, rect, scale, true)
        })
    }

    /**
     * Draws [image]'s fading background rect. Alpha fades with distance from home/min scale or
     * the page's pan bounds, so it only shows near the edges of the zoom/pan range where the
     * image itself doesn't fill the viewport.
     */
    private drawImageBackground(
        pass: GPURenderPassEncoder,
        image: Image,
        rect: Float32Array,
        scale: number,
        maskedBackground: boolean,
    ) {
        const parent = this.parent
        const minScale = this.minScale
        const homeScale = this.homeScale
        const currentScale = this.scale * scale

        const fadeDistancePixels = 200
        const imageSize = Math.max(this.width, this.height)

        const proximity = (anchorScale: number) => {
            if (anchorScale <= 0) return 0
            const deltaPixels = Math.abs(imageSize * (currentScale - anchorScale))
            return coerceIn(1 - deltaPixels / fadeDistancePixels, 0, 1)
        }

        const boundProximity = (
            value: number,
            lo: number,
            hi: number,
            pixelsPerUnit: number,
        ) => {
            let overflow: number
            if (value < lo) overflow = lo - value
            else if (value > hi) overflow = value - hi
            else return 1
            return coerceIn(1 - (overflow * pixelsPerUnit) / fadeDistancePixels, 0, 1)
        }

        const boundsProximityAt = (anchorScale: number) => {
            if (!parent || anchorScale <= 0) return 0
            const pixelsPerUnitX = parent.width * anchorScale
            const pixelsPerUnitY = parent.height * anchorScale
            return Math.min(
                boundProximity(
                    this.x,
                    this.minX(anchorScale),
                    this.maxX(anchorScale),
                    pixelsPerUnitX,
                ),
                boundProximity(
                    this.y,
                    this.minY(anchorScale),
                    this.maxY(anchorScale),
                    pixelsPerUnitY,
                ),
            )
        }

        const bgAlpha =
            parent ?
                currentScale > minScale ? boundsProximityAt(currentScale)
                    : Math.max(
                        Math.min(proximity(homeScale), boundsProximityAt(homeScale)),
                        Math.min(proximity(minScale), boundsProximityAt(minScale)),
                    )
                : 1

        const bg = image.backgroundColor
        const a = Math.trunc((((bg >>> 24) & 0xff)) * bgAlpha)
        if (a <= 0) return

        const x1 = this.backgroundSpansFullWidth ? 0 : rect[0]
        const x2 = this.backgroundSpansFullWidth ? 1 : rect[2]
        // Alpha only. Both pipelines already blend with SrcAlpha, so scaling rgb applied the fade
        // twice and took the crossfade through black on the way.
        const bgColor = ((a << 24) | (bg & 0xffffff)) | 0
        if (maskedBackground) RenderPage.drawMaskedRect(pass, x1, 0, x2, 1, bgColor)
        else Draw.rect(pass, x1, 0, x2, 1, bgColor)
    }

    /**
     * True when the background colour paints the whole viewport rather than just the image's
     * rect - always so with one image, which has no neighbouring column to bleed into.
     */
    get backgroundSpansFullWidth(): boolean {
        return true
    }

    /** Walks this page's image(s) via [forEachImage], placing each for [action] to draw against. */
    private forEachPlacedImage(
        dst: GPUTexture,
        x: number,
        y: number,
        scale: number,
        action: (
            image: Image,
            rect: Float32Array,
            placeX: number,
            placeY: number,
            placeScale: number,
        ) => void,
    ) {
        // The snapshot is captured before the frame is recorded, so the page may have been
        // evicted since - its images' buffers are gone, and touching one throws.
        if (this.destroyed) return

        this.forEachImage((img, srcOffsetX) => {
            if (img.mipmaps.length > 0) {
                const placeX = this.x + x + srcOffsetX / dst.width
                const placeY = this.y + y
                const placeScale = this.scale * scale
                action(img, img.placement(dst, placeX, placeY, placeScale), placeX, placeY, placeScale)
            }
        })
    }

    override cleanup() {
        if (this.destroyed) return
        super.cleanup()

        this.animationLoop?.cancel()
        this.animationLoop = null

        // Only clean the image if we own it.
        if (!this.ownsImage) {
            this.frames = null
            this.currentFrameImage = null
            return
        }

        const framesToClean = this.frames
        this.frames = null
        this.currentFrameImage = null

        // Frames include the image; otherwise clean it directly.
        const imagesToClean = framesToClean?.map(f => f[0]) ?? (this.image ? [this.image] : [])

        if (imagesToClean.length > 0) {
            // Eviction fires exactly when the viewer reaches a new page, so freeing a page's
            // textures competes with the frames that are drawing the new one. Yield between
            // images and stay off the render lock, for the same reason uploads do. A destroyed
            // texture stays alive until the command buffers referencing it retire, so a frame
            // already in flight is unaffected.
            launch(async () => {
                try {
                    await WebGpuRenderer.unlocked(async () => {
                        for (const image of imagesToClean) {
                            image.cleanup()
                            await Promise.resolve()
                        }
                    })
                } catch (e) {
                    console.error("ImagePage: cleanup error", e)
                }
            })
        }
    }
}

/**
 * Two pages drawn side by side, sharing one pan/zoom transform and one tile grid, so the seam
 * bakes into whichever tile straddles it instead of meeting two independently-snapped layers.
 * Either side may be null, e.g. a cover with no partner.
 *
 * Composes existing pages rather than owning decoded images: drawing and animation delegate to
 * whichever side is live. Never cleans up [left]/[right] - whoever built them owns that.
 *
 * A side may also be a [RenderPageBase]. It has no image to place, so it sits out [forEachImage]
 * and the tile grid and is drawn into its half afterwards - see [drawRenderSides].
 */
export class ImageSpread extends ImageSingle {
    constructor(
        readonly left: ImagePage | null,
        readonly right: ImagePage | null,
    ) {
        super(null)
    }

    /** Either side as an [ImageSingle] - null for a render side, which has no image. */
    private get leftSingle(): ImageSingle | null {
        return this.left instanceof ImageSingle ? this.left : null
    }

    private get rightSingle(): ImageSingle | null {
        return this.right instanceof ImageSingle ? this.right : null
    }

    /** Runs [action] for each present side, with its pixel offset from the seam. */
    private forEachSide(action: (side: ImagePage, offsetX: number) => void) {
        if (this.left) action(this.left, -0.5 * this.left.width)
        if (this.right) action(this.right, 0.5 * this.right.width)
    }

    override get highQuality(): boolean {
        return (this.leftSingle?.highQuality ?? true) && (this.rightSingle?.highQuality ?? true)
    }

    override set highQuality(value: boolean) {
        if (this.leftSingle) this.leftSingle.highQuality = value
        if (this.rightSingle) this.rightSingle.highQuality = value
    }

    override get isAnimated(): boolean {
        return this.left?.isAnimated === true || this.right?.isAnimated === true
    }

    override get frameVersion(): number {
        return (this.left?.frameVersion ?? 0) + (this.right?.frameVersion ?? 0)
    }

    /** No image of its own - [left]/[right] hold them, and [forEachImage] walks both. */
    override get currentImage(): Image | null {
        return null
    }

    /**
     * Each side sits half its own width out from the seam (the page anchor). A render side has no
     * image to place and paints itself instead - see [drawRenderSides].
     */
    override forEachImage(action: (image: Image, offsetX: number) => void) {
        const l = this.leftSingle?.currentImage
        if (l) action(l, -0.5 * l.width)
        const r = this.rightSingle?.currentImage
        if (r) action(r, 0.5 * r.width)
    }

    override get hasUploadedImage(): boolean {
        return (
            this.leftSingle?.hasUploadedImage === true ||
            this.rightSingle?.hasUploadedImage === true
        )
    }

    override get isDecoded(): boolean {
        return this.left?.isDecoded === true || this.right?.isDecoded === true
    }

    /** Two columns meeting at the seam, so neither may paint over the other half. */
    override get backgroundSpansFullWidth(): boolean {
        return this.left === null || this.right === null
    }

    override drawLive(
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        tiles: TileRenderer,
    ): boolean {
        const covered = super.drawLive(encoder, dst, tiles)
        this.drawRenderSides(encoder, dst)
        return covered
    }

    override renderCacheSeed(
        encoder: GPUCommandEncoder,
        tex: GPUTexture,
        tiles: TileRenderer,
    ) {
        super.renderCacheSeed(encoder, tex, tiles)
        this.drawRenderSides(encoder, tex)
    }

    /** [frameVersion] is the sides' sum, so this page's own has nothing to bump. */
    override invalidate() {
        this.left?.invalidate()
        this.right?.invalidate()
        if (this.isOnScreen) this.onInvalidate?.()
    }

    override covers(other: ImagePage): boolean {
        return this === other || this.left === other || this.right === other
    }

    override attach(parent: ImageViewerState, onInvalidate: () => void) {
        super.attach(parent, onInvalidate)
        this.left?.attach(parent, onInvalidate)
        this.right?.attach(parent, onInvalidate)
    }

    /** True when either side paints itself rather than blitting a decoded image. */
    private get hasRenderSide(): boolean {
        return this.left instanceof RenderPageBase || this.right instanceof RenderPageBase
    }

    /**
     * A render side repaints every frame, so [ImageSingle]'s incremental tile blit would leave it
     * stale for the whole transition. Reseed the slot outright instead.
     */
    override renderIntoCache(
        encoder: GPUCommandEncoder,
        tex: GPUTexture,
        tiles: TileRenderer,
        identityMatches: boolean,
    ) {
        super.renderIntoCache(encoder, tex, tiles, identityMatches && !this.hasRenderSide)
    }

    /**
     * Draws each render side into its own half of [dst], after the image sides.
     *
     * Needs a pass of its own, since a pass cannot nest inside the one the image sides just drew
     * through. It loads rather than clears: [dst] already holds the other side by now.
     */
    private drawRenderSides(encoder: GPUCommandEncoder, dst: GPUTexture) {
        // As forEachPlacedImage: the page can have been evicted since the snapshot was taken.
        if (this.destroyed) return
        this.forEachSide((side, offsetX) => {
            if (side instanceof RenderPageBase) {
                side.renderLoaded(encoder, this.x + offsetX / dst.width, this.y, this.scale, dst)
            }
        })
    }

    override pageRect(dst: GPUTexture): Float32Array | null {
        let found: Float32Array | null = null
        this.forEachSide((side, offsetX) => {
            if (found) return
            const image = side instanceof ImageSingle ? side.currentImage : null
            if (image && image.mipmaps.length > 0) {
                found = image.placement(dst, this.x + offsetX / dst.width, this.y, this.scale)
            }
        })
        return found
    }

    override get backgroundColor(): number | null {
        return this.left?.backgroundColor ?? this.right?.backgroundColor ?? null
    }

    override drawBackgroundColumns(
        pass: GPURenderPassEncoder,
        dst: GPUTexture,
        offsetX: number,
        offsetY: number,
    ) {
        this.forEachSide((side, srcOffsetX) => {
            const color = side.backgroundColor
            if (color !== null) {
                const [x1, x2] = this.sideColumn(side, srcOffsetX, dst)
                Draw.rect(pass, offsetX + x1, offsetY, offsetX + x2, offsetY + 1, color)
            }
        })
    }

    /**
     * [side]'s left/right edges within [dst], normalised - the whole width when it is the only
     * side. An image side goes through `Image.placement` so its own `Image.x` counts; a render
     * side has no such offset and gets the same formula without it.
     */
    private sideColumn(
        side: ImagePage,
        srcOffsetX: number,
        dst: GPUTexture,
    ): [number, number] {
        if (this.backgroundSpansFullWidth) return [0, 1]
        const placeX = this.x + srcOffsetX / dst.width
        const image = side instanceof ImageSingle ? side.currentImage : null
        if (image) {
            const rect = image.placement(dst, placeX, this.y, this.scale)
            return [rect[0], rect[2]]
        }
        const center = 0.5 + this.scale * (placeX + WebGpuRenderer.offsetX)
        const half = (this.scale * 0.5 * side.width) / dst.width
        return [center - half, center + half]
    }

    override horizontalExtent(): [number, number] {
        return [this.left?.width ?? 0, this.right?.width ?? 0]
    }

    /** Total width (sum of both sides' widths). */
    override get width(): number {
        return (this.left?.width ?? 0) + (this.right?.width ?? 0)
    }

    /** Total height (max of both sides' heights). */
    override get height(): number {
        return Math.max(this.left?.height ?? 0, this.right?.height ?? 0)
    }

    /**
     * Visible width after trim. Inner edges are ignored - a seam is never trimmed - and a render
     * side has no trim at all, so it contributes its full width.
     */
    override get trimWidth(): number {
        const li = this.leftSingle?.image
        const ri = this.rightSingle?.image
        const leftW = li ? li.width - (li.trim?.left ?? 0) : (this.left?.width ?? 0)
        const rightW = ri ? (ri.trim?.right ?? ri.width) : (this.right?.width ?? 0)
        return leftW + rightW
    }

    /** Visible height after trim (max of trim heights). */
    override get trimHeight(): number {
        return Math.max(this.left?.trimHeight ?? 0, this.right?.trimHeight ?? 0)
    }

    override get isHalfWidth(): boolean {
        return true
    }

    /**
     * The sides hang off the seam - the anchor, at width/2 - by their own widths, so the span
     * runs `width/2 - left width` to `width/2 + right width`. That equals `0..width` only when
     * both sides are present and equally wide; otherwise it sits off-centre by the difference.
     * Reporting `0..width` regardless let a zoomed-in lone side pan half a page past its own end,
     * and cut off half a page early on the other.
     */
    protected override xEdges(trimmed: boolean): [number, number] {
        const [leftWidth, rightWidth] = this.horizontalExtent()
        const anchor = this.width / 2
        return [anchor - leftWidth, anchor + rightWidth]
    }

    /** Rests with the seam on the viewport centre. */
    protected override restingX(scale: number): number {
        return 0
    }

    protected override yEdges(trimmed: boolean): [number, number] | null {
        if (!trimmed) return null
        const images = [this.leftSingle?.image, this.rightSingle?.image].filter(
            (i): i is Image => !!i,
        )
        if (images.length === 0) return null
        if (images.every(i => i.trim === null)) return null
        const trimTop = Math.min(...images.map(i => i.trim?.top ?? 0))
        const trimBottom = Math.max(...images.map(i => i.trim?.bottom ?? i.height))
        return [trimTop, trimBottom]
    }

    /**
     * Each side fit to its own half independently, since the two can differ in size - unlike the
     * base default, which fits the combined span.
     */
    protected override halfWidthScale(halfWidth: number, parentHeight: number): number {
        const sides = [this.left, this.right].filter(
            (s): s is ImagePage => !!s && s.width > 0 && s.height > 0,
        )
        if (sides.length === 0) return 0.01
        return Math.max(
            0.01,
            Math.min(...sides.map(s => Math.min(halfWidth / s.width, parentHeight / s.height))),
        )
    }
}
