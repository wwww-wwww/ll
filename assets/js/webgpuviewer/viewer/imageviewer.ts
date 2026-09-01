import {
    Job,
    Offset,
    STIFFNESS_MEDIUM,
    animate,
    animateDecay,
    animateDecay2d,
    coerceIn,
    distance,
    launch,
    orZero,
    spring,
} from "../util"
import { WebGpuRenderer } from "../renderer/renderer"
import { ImagePage } from "./imagepage"
import { ImageViewerState } from "./imageviewerstate"
import { ImageViewerContinuousState, SCROLL_THRESHOLD_PX } from "./imageviewercontinuousstate"
import { handleContinuousGesture } from "./imageviewercontinuous"
import {
    GestureEvent,
    PointerStream,
    VelocityTracker,
    waitForCleanUp,
    waitForDown,
} from "./gestures"

/**
 * The gesture layer and canvas element - the port of `viewer/ImageViewer.kt` and `ImageView.kt`.
 *
 * The Kotlin is a Compose `pointerInput` block: one `awaitEachGesture` that reads the pointer
 * stream top to bottom, branching into tap / double tap / double-tap-drag-zoom / pan-pinch. That
 * shape survives intact here - [PointerStream] supplies the same awaitable event sequence - so
 * the branches below line up with the original one for one.
 *
 * Registered as a customised built-in `<canvas is="webgpu-viewer">`, matching how the existing
 * viewer was constructed.
 */

/** Android's `viewConfiguration` values, which the gesture logic is tuned against. */
const DOUBLE_TAP_TIMEOUT = 300
const LONG_PRESS_TIMEOUT = 500
const TOUCH_SLOP_DP = 8

/** How close to an edge a touch must be to suppress the long press. */
const EDGE_THRESHOLD = 50

/** Zoom per wheel notch, in decades of scale - a notch is about 12%. */
const WHEEL_ZOOM_DECADES = 0.05

/**
 * Viewport fraction one wheel notch scrolls in continuous mode.
 *
 * Roughly what a browser scrolls a page by, which is what the wheel is expected to feel like.
 * Notches accumulate ([ImageViewerContinuousState.animateScroll]), so a spun wheel still covers
 * ground quickly - a large per-notch value only makes a single click overshoot.
 */
const WHEEL_SCROLL_FRACTION = 0.15

/**
 * How many notches [e] is worth, sign included.
 *
 * Magnitude matters now that notches accumulate: a mouse reports one coarse notch per event, a
 * trackpad a stream of small pixel deltas, so counting every event as a full notch would make one
 * two-finger swipe zoom several times further than the same gesture on a mouse.
 *
 * Clamped, so one outsized delta cannot cross the whole zoom range in a step.
 */
function wheelNotches(e: WheelEvent): number {
    const notches =
        e.deltaMode === 1 ?
            e.deltaY // lines
            : e.deltaMode === 2 ?
                e.deltaY * 10 // pages
                : e.deltaY / 100 // pixels - ~100px is one notch in every engine that reports them
    return coerceIn(notches, -3, 3)
}

export class ImageViewerElement extends HTMLCanvasElement {
    private _state: ImageViewerState

    get state(): ImageViewerState {
        return this._state
    }

    private stream!: PointerStream
    private resizeObserver: ResizeObserver | null = null
    private gestureJob: Job | null = null
    private abort: AbortController | null = null

    constructor(isVertical: boolean = false, isReversed: boolean = false) {
        super()
        this._state = new ImageViewerState(isVertical, isReversed)
    }

    /**
     * Swap in a different state - [ImageViewerContinuousState] for continuous reading.
     *
     * Must happen before the element is connected: [connectedCallback] starts the frame loop and
     * the gesture loop against whatever is here, and the old state's loop would keep running.
     * `document.createElement` gives a custom element no constructor arguments, so the mode cannot
     * be decided there.
     */
    protected replaceState(state: ImageViewerState) {
        if (this.isConnected) throw new Error("replaceState after connect")
        this._state = state
    }

    private get touchSlop(): number {
        return TOUCH_SLOP_DP * window.devicePixelRatio
    }

    /** Element-relative position in the same pixel space as `state.width`/`state.height`. */
    private toLocal = (e: PointerEvent): Offset => {
        const rect = this.getBoundingClientRect()
        const dpr = window.devicePixelRatio
        return { x: (e.clientX - rect.x) * dpr, y: (e.clientY - rect.y) * dpr }
    }

    /** Acquire the device, size the surface, and start the frame loop. */
    static async create(
        isVertical: boolean = false,
        isReversed: boolean = false,
    ): Promise<ImageViewerElement> {
        await WebGpuRenderer.initDevice()
        const element = document.createElement("canvas", {
            is: "webgpu-viewer",
        }) as ImageViewerElement
        element.state.isVertical = isVertical
        element.state.isReversed = isReversed
        return element
    }

    connectedCallback() {
        this.abort = new AbortController()
        this.stream = new PointerStream(this.toLocal)

        this.resizeObserver = new ResizeObserver(() => {
            const rect = this.getBoundingClientRect()
            const width = Math.max(1, Math.round(rect.width * window.devicePixelRatio))
            const height = Math.max(1, Math.round(rect.height * window.devicePixelRatio))
            if (width === this.state.width && height === this.state.height) return
            const first = this.state.width === 0 || this.state.height === 0
            this.state.init(this, width, height)
            // Not on the first measurement: nothing has settled against a zero viewport, and
            // ImagePage defers its own home snap until there is one - see ImagePage.applyHome.
            if (!first) this.state.onViewportChanged?.()
            this.state.invalidate()
        })
        this.resizeObserver.observe(this)

        this.installPointerHandlers()
        this.state.collect()
        this.gestureJob = launch(job => this.gestureLoop(job))
    }

    disconnectedCallback() {
        this.resizeObserver?.disconnect()
        this.resizeObserver = null
        this.gestureJob?.cancel()
        this.gestureJob = null
        this.abort?.abort()
        this.abort = null
        this.state.cleanup()
    }

    /** Kind of the last pointer to go down - what [installPointerHandlers] judges a menu by. */
    private lastPointerType = "mouse"

    private installPointerHandlers() {
        const signal = this.abort!.signal

        this.addEventListener(
            "pointerdown",
            e => {
                // Before the button filter, so a right-click still identifies itself.
                this.lastPointerType = e.pointerType
                if (e.button !== 0 && e.pointerType === "mouse") return
                this.setPointerCapture(e.pointerId)
                e.preventDefault()
                // The stylesheets style `canvas.grabbing` with a grab cursor; nothing on the
                // Android side needs this, so it has no counterpart in the Kotlin.
                this.classList.toggle("grabbing", true)
                this.stream.handle(e, "down")
            },
            { signal },
        )
        this.addEventListener("pointermove", e => this.stream.handle(e, "move"), { signal })
        this.addEventListener(
            "pointerup",
            e => {
                if (this.hasPointerCapture(e.pointerId)) this.releasePointerCapture(e.pointerId)
                this.stream.handle(e, "up")
                if (this.stream.pressedCount === 0) this.classList.toggle("grabbing", false)
            },
            { signal },
        )
        this.addEventListener(
            "pointercancel",
            e => {
                this.stream.handle(e, "cancel")
                if (this.stream.pressedCount === 0) this.classList.toggle("grabbing", false)
            },
            { signal },
        )
        // Right-click gets the browser's own menu: a right button never enters the gesture stream
        // (see pointerdown above), so there is nothing to interrupt.
        //
        // Touch and pen stay suppressed - a long press also raises `contextmenu`, and that gesture
        // belongs to onLongTap. `contextmenu` is a MouseEvent with no pointerType, so the guard
        // reads the kind of pointer that opened it.
        this.addEventListener(
            "contextmenu",
            e => {
                if (this.lastPointerType !== "mouse") e.preventDefault()
            },
            { signal },
        )
        this.addEventListener("wheel", e => this.onWheel(e), { signal, passive: false })
    }

    /**
     * Wheel zoom - no counterpart in the Kotlin, which only sees touch, but a mouse has no pinch.
     *
     * Routed through [ImagePage.animateTo] for both halves of what a wheel needs: it animates, so a
     * notch glides rather than snapping, and it cancels `animationJob`, so a fling in flight stops
     * instead of dragging the page out from under the cursor.
     *
     * Notches accumulate onto the *pending target* ([ImagePage.animationTargetScale], null once
     * settled), not onto the scale reached so far - otherwise each notch of a quick flick restarts
     * from a scale still travelling, and three zoom barely further than one.
     */
    private onWheel(e: WheelEvent) {
        if (this._state instanceof ImageViewerContinuousState) {
            this.onContinuousWheel(e, this._state)
            return
        }

        const page = this.state.getPage(0)
        if (!page) return
        e.preventDefault()

        const off = WHEEL_ZOOM_DECADES * -wheelNotches(e)
        if (off === 0) return

        const from = page.animationTargetScale ?? page.scale
        const targetScale = coerceIn(
            Math.pow(10, Math.log10(from) + off),
            page.minScale,
            page.maxScale,
        )
        // At a zoom limit: restarting the spring would cancel the fling for nothing.
        if (targetScale === from) return

        const rect = this.getBoundingClientRect()
        page.animateTo({
            origin: { x: (e.clientX - rect.x) / rect.width, y: (e.clientY - rect.y) / rect.height },
            targetScale,
            spec: spring(STIFFNESS_MEDIUM),
        })
    }

    /**
     * Wheel in continuous mode: scroll the document, or zoom it when ctrl is held.
     *
     * A wheel is the mode's primary scroll input, unlike the paged viewer where it can only mean
     * zoom. Ctrl+wheel is the browser-wide convention for zooming what a wheel otherwise scrolls.
     */
    private onContinuousWheel(e: WheelEvent, state: ImageViewerContinuousState) {
        e.preventDefault()

        if (e.ctrlKey) {
            const off = WHEEL_ZOOM_DECADES * -wheelNotches(e)
            if (off === 0) return

            // Onto the pending target, not the scale reached so far - the same accumulation the
            // paged wheel zoom needs, and for the same reason: each notch of a quick flick would
            // otherwise restart from a scale still travelling, and three would zoom barely
            // further than one.
            const from = state.animationTargetScale ?? state.scale
            // The state's own bounds, not a copy: minScale follows minZoomWidthFraction, so a
            // duplicated constant here would let the wheel zoom past where a pinch may settle.
            const target = coerceIn(
                Math.pow(10, Math.log10(from) + off),
                state.minScale,
                state.maxScale,
            )
            // At a zoom limit: restarting the spring would cancel a fling for nothing.
            if (target === from) return

            // Anchored on the pointer, the same inversion the pinch uses.
            const rect = this.getBoundingClientRect()
            state.animateZoom(
                target,
                (e.clientX - rect.x) / rect.width - 0.5,
                (e.clientY - rect.y) / rect.height - 0.5,
                spring(STIFFNESS_MEDIUM),
            )
            return
        }

        // A notch is a line, not a page: scroll by a fraction of the viewport so the gesture is
        // independent of how tall the pages happen to be.
        //
        // Animated rather than applied outright, and accumulating, so a spun wheel glides the sum
        // of its notches instead of stepping through them - see [animateScroll].
        const notches = wheelNotches(e)
        if (notches === 0) return
        // Stiffer than the default a tap or an arrow key gets: a wheel is a rapid, repeated input,
        // and 203ms lands it while a 385ms glide reads as lag under a second notch.
        state.animateScroll(
            (notches * state.height * WHEEL_SCROLL_FRACTION) / state.scale,
            spring(STIFFNESS_MEDIUM, SCROLL_THRESHOLD_PX),
        )
    }

    /** `awaitEachGesture` - one pass per gesture, forever. */
    private async gestureLoop(job: Job) {
        while (true) {
            job.ensureActive()
            const firstEvent = await this.awaitFirstDown()
            job.ensureActive()
            try {
                await this.handleGesture(firstEvent)
            } catch (e) {
                console.error("ImageViewer: gesture failed", e)
            }
        }
    }

    private async awaitFirstDown(): Promise<GestureEvent> {
        while (true) {
            const event = await this.stream.next()
            if (event.type === "down" && this.stream.pressedCount === 1) return event
        }
    }

    private async handleGesture(firstEvent: GestureEvent) {
        const continuous = this._state
        if (continuous instanceof ImageViewerContinuousState) {
            return handleContinuousGesture(
                {
                    state: continuous,
                    stream: this.stream,
                    touchSlop: this.touchSlop,
                    doubleTapTimeout: DOUBLE_TAP_TIMEOUT,
                    longPressTimeout: LONG_PRESS_TIMEOUT,
                },
                firstEvent,
            )
        }

        const state = this.state
        const firstDownId = firstEvent.raw.pointerId
        const firstDown = firstEvent.changes.find(c => c.id === firstDownId)!
        const firstPosition = firstDown.current

        const wasScrolling = state.pageOffset !== 0
        const pageTurnJob = state.animationJob
        const page = state.getPage(0)
        if (!page) return
        page.animationJob?.cancel()

        // A touch on a moving page only stops it: no long press, no tap, but still a double tap,
        // drag or pinch. Cleared here, not in the cancelled job, which settles late enough to
        // swallow the next touch too.
        const stoppedMotion = page.isScaleAnimating || page.isFlinging
        if (stoppedMotion) {
            page.isScaleAnimating = false
            page.isFlinging = false
        }

        let longPressed = false

        const nearEdge =
            firstPosition.x < EDGE_THRESHOLD || firstPosition.x > state.width - EDGE_THRESHOLD
        let longPressTimer: number | null = null
        if (!nearEdge && !stoppedMotion) {
            longPressTimer = window.setTimeout(() => {
                longPressed = true
                state.onLongTap?.({
                    x: firstPosition.x / state.width,
                    y: firstPosition.y / state.height,
                })
            }, LONG_PRESS_TIMEOUT)
        }
        const cancelLongPress = () => {
            if (longPressTimer !== null) {
                clearTimeout(longPressTimer)
                longPressTimer = null
            }
        }

        const cleanUp = await waitForCleanUp(
            this.stream,
            firstDownId,
            DOUBLE_TAP_TIMEOUT,
            this.touchSlop,
        )

        if (cleanUp) {
            cancelLongPress()
            // A stop settles below and fires no tap, but still waits out the double tap window:
            // it can be the first of a pair.
            const secondDown = await waitForDown(this.stream, DOUBLE_TAP_TIMEOUT)

            if (!secondDown) {
                pageTurnJob?.cancel()
                if (state.pageOffset !== 0) {
                    state.animationJob = animate(state.pageOffset, 0, spring(), value => {
                        state.pageOffset = value
                        state.invalidate()
                    })
                }
                page.animateTo({ origin: { x: 0.5, y: 0.5 } })
                if (!stoppedMotion) {
                    state.onTap?.({
                        x: firstPosition.x / state.width,
                        y: firstPosition.y / state.height,
                    })
                }
                return
            }

            const secondCleanUp = await waitForCleanUp(
                this.stream,
                secondDown.id,
                DOUBLE_TAP_TIMEOUT,
                this.touchSlop,
            )

            if (secondCleanUp) {
                // Double tap - let any in-progress page turn finish committing first.
                const tapX = secondDown.current.x / state.width
                const tapY = secondDown.current.y / state.height
                await pageTurnJob?.join()
                const zoomPage = state.getPage(0)
                if (!zoomPage) return
                zoomPage.animateTo({
                    origin: { x: tapX, y: tapY },
                    targetScale:
                        zoomPage.atHomeScale ? zoomPage.doubleTapScale : zoomPage.homeScale,
                })
                return
            }

            await this.doubleTapDragZoom(page, secondDown.id, secondDown.current)
            return
        }

        await this.panPinch(page, firstEvent, wasScrolling, pageTurnJob, {
            get longPressed() {
                return longPressed
            },
            cancelLongPress,
        })
    }

    /** The vertical drag after a double tap that scales continuously, and its fling. */
    private async doubleTapDragZoom(page: ImagePage, dragPointerId: number, origin: Offset) {
        const state = this.state
        const velocityTracker = new VelocityTracker()
        velocityTracker.add(performance.now(), origin)

        const originalScale = page.scale
        const originalX = page.x
        const originalY = page.y
        let totalDeltaY = 0

        state.animationJob?.cancel()

        page.isScaleAnimating = true
        let willFlingZoom = false
        try {
            while (true) {
                const event = await this.stream.next()
                const change = event.changes.find(c => c.id === dragPointerId)
                if (!change || change.changedToUp) break

                velocityTracker.add(event.raw.timeStamp, change.current)

                if (event.positionChanged()) {
                    const pan = event.pan()
                    totalDeltaY += pan.y
                    if (totalDeltaY !== 0) {
                        const px = origin.x / state.width - 0.5
                        const py = origin.y / state.height - 0.5

                        page.scale = originalScale * Math.pow(10, (2 * totalDeltaY) / state.height)
                        const diff = 1 / page.scale - 1 / originalScale

                        page.setPos(orZero(originalX + px * diff), orZero(originalY + py * diff))
                    }
                }
            }
            const dragVelocity = velocityTracker.calculateVelocity()
            // Decided before the finally below, so isScaleAnimating has no gap between this drag
            // ending and its fling starting.
            willFlingZoom =
                Math.abs(dragVelocity.y) > 200 &&
                page.scale > page.homeScale &&
                page.scale < page.maxScale
        } finally {
            if (!willFlingZoom) page.isScaleAnimating = false
        }

        const velocity = velocityTracker.calculateVelocity()
        if (willFlingZoom) {
            const zoomFling = animateDecay(velocity.y, value => {
                const px = origin.x / state.width - 0.5
                const py = origin.y / state.height - 0.5

                const newScale =
                    originalScale * Math.pow(10, (2 * (totalDeltaY + value)) / state.height)

                page.scale = coerceIn(newScale, page.homeScale, page.maxScale)
                const diff = 1 / page.scale - 1 / originalScale

                page.setPos(
                    coerceIn(
                        orZero(originalX + px * diff),
                        page.minX(page.scale),
                        page.maxX(page.scale),
                    ),
                    coerceIn(
                        orZero(originalY + py * diff),
                        page.minY(page.scale),
                        page.maxY(page.scale),
                    ),
                )
            })
            page.animationJob = zoomFling
            zoomFling.promise.then(() => {
                // Only if this fling is still the current animation: a cancelled job's promise
                // still settles, and clearing the flag would then lie about whatever replaced it.
                if (page.animationJob !== zoomFling) return
                page.isScaleAnimating = false
            })
        } else {
            page.animateTo({ origin: { x: origin.x / state.width, y: origin.y / state.height } })
        }
    }

    /**
     * The main drag: pan and pinch the page, handing over to a page turn once panning overflows
     * the page's own bounds on the scroll axis, then settling with a fling or a spring home.
     */
    private async panPinch(
        page: ImagePage,
        firstEvent: GestureEvent,
        wasScrolling: boolean,
        pageTurnJob: Job | null,
        longPress: { readonly longPressed: boolean; cancelLongPress: () => void },
    ) {
        const state = this.state
        const firstDownId = firstEvent.raw.pointerId
        const firstPosition = firstEvent.changes.find(c => c.id === firstDownId)!.current

        if (!wasScrolling) page.animateTo({ origin: { x: 0.5, y: 0.5 } })
        pageTurnJob?.cancel()

        let lastMoveTime = firstEvent.raw.timeStamp
        let lastEventTime = firstEvent.raw.timeStamp
        let acc: Offset = { x: 0, y: 0 }

        let scaleOrigin: Offset = { x: 0.5, y: 0.5 }

        let single = true
        let pageTurning = wasScrolling

        // If grabbing mid-animation, update firstPos so panning continues smoothly.
        if (wasScrolling) state.firstPos = firstPosition

        const velocityTracker = new VelocityTracker()
        velocityTracker.add(firstEvent.raw.timeStamp, firstPosition)

        page.animationJob?.cancel()

        let cancelled = false
        try {
            while (true) {
                const event = await this.stream.next()
                cancelled = event.type === "cancel"
                if (cancelled) {
                    longPress.cancelLongPress()
                    break
                }

                const change = event.changes[0]
                lastEventTime = event.raw.timeStamp
                if (event.positionChanged()) lastMoveTime = event.raw.timeStamp

                const centroid = event.centroid(true)

                const pressed = event.pressed
                const twoFingers = pressed.length > 1
                page.isScaleAnimating = twoFingers

                let pointerCountChanged = false
                if (twoFingers) {
                    if (single && !pageTurning) {
                        longPress.cancelLongPress()
                        velocityTracker.reset()
                        acc = { x: 0, y: 0 }
                        pointerCountChanged = true
                    }
                    if (!pageTurning) {
                        velocityTracker.add(event.raw.timeStamp, change.current)
                        single = false
                        scaleOrigin = { x: centroid.x / state.width, y: centroid.y / state.height }
                    }
                } else if (single) {
                    velocityTracker.add(event.raw.timeStamp, change.current)
                }

                if (!pointerCountChanged) {
                    const pan = event.pan()
                    if (distance(acc) > this.touchSlop) longPress.cancelLongPress()
                    acc = { x: acc.x + pan.x, y: acc.y + pan.y }

                    if (pageTurning) {
                        const prev = state.pageOffset
                        // Always the raw drag direction - pageOffset's sign is also the live
                        // visual pan amount, so it has to keep tracking the finger 1:1 regardless
                        // of reading direction. isReversed is resolved separately, in
                        // getPage/onPageChange, where it only affects which page a crossing
                        // reveals - not how far the finger has to move to cause one.
                        const panAmount =
                            state.isVertical ? -pan.y / state.height : -pan.x / state.width
                        state.pageOffset += panAmount
                        if (
                            (prev > 0 && state.pageOffset <= 0) ||
                            (prev < 0 && state.pageOffset >= 0)
                        ) {
                            state.pageOffset = 0
                            pageTurning = false
                            acc = { x: 0, y: 0 }
                        }
                        state.currentPos = change.current
                        state.invalidate()
                    } else {
                        const zoom = event.zoom()

                        if (zoom !== 1 || pan.x !== 0 || pan.y !== 0) {
                            const newScale = page.scale * zoom
                            const diff = 1 / newScale - 1 / page.scale

                            let x = page.x + pan.x / state.width / page.scale
                            let y = page.y + pan.y / state.height / page.scale

                            x += (centroid.x / state.width - 0.5) * diff
                            y += (centroid.y / state.height - 0.5) * diff

                            const minX = page.minX(newScale)
                            const maxX = page.maxX(newScale)
                            const minY = page.minY(newScale)
                            const maxY = page.maxY(newScale)

                            if (single) {
                                const clampedX = coerceIn(x, minX, maxX)
                                const clampedY = coerceIn(y, minY, maxY)
                                const overflow = state.isVertical ? y - clampedY : x - clampedX
                                const isBiased =
                                    state.isVertical ?
                                        Math.abs(acc.y) > Math.abs(acc.x)
                                        : Math.abs(acc.x) > Math.abs(acc.y)
                                if (overflow !== 0 && isBiased) {
                                    page.animateTo({ origin: { x: 0.5, y: 0.5 } })
                                    pageTurning = true
                                    state.firstPos = firstPosition
                                    state.pageOffset += -overflow * page.scale
                                    state.invalidate()
                                }
                                x = clampedX
                                y = clampedY
                            }

                            page.scale = newScale
                            page.setPos(orZero(x), orZero(y))
                        }
                    }
                }

                if (!event.changes.some(c => c.pressed)) break
            }
        } finally {
            page.isScaleAnimating = false
        }

        longPress.cancelLongPress()
        if (longPress.longPressed || cancelled) return

        if (pageTurning) {
            const velocity = velocityTracker.calculateVelocity()
            // Always raw, matching panAmount above - see that comment.
            const initialVelocity =
                state.isVertical ? -velocity.y / state.height : -velocity.x / state.width

            // Flicking opposite to current direction = go back to 0.
            const flickingOpposite =
                (state.pageOffset > 0 && initialVelocity < -0.5) ||
                (state.pageOffset < 0 && initialVelocity > 0.5)

            const target =
                flickingOpposite ? 0
                    : initialVelocity > 1 && state.haveNext ? 1
                        : initialVelocity < -1 && state.havePrev ? -1
                            : state.pageOffset > 0.5 && state.haveNext ? 1
                                : state.pageOffset < -0.5 && state.havePrev ? -1
                                    : 0

            // The flick's own velocity carries into the spring that settles it, and the animation
            // stops dead at +/-1 - `anim.updateBounds(-1f, 1f)` before `animateTo(target,
            // initialVelocity, spring(...))`. Without the velocity a hard flick eases in at the
            // same rate as a slow release, which is most of what makes a turn feel sluggish.
            state.animationJob = animate(
                state.pageOffset,
                target,
                spring(),
                value => {
                    state.pageOffset = value
                    state.invalidate()
                },
                { initialVelocity, lowerBound: -1, upperBound: 1 },
            )
            return
        }

        const minX = page.minX(page.scale)
        const maxX = page.maxX(page.scale)
        const minY = page.minY(page.scale)
        const maxY = page.maxY(page.scale)

        const velocity = velocityTracker.calculateVelocity()
        // Bounded by minScale/maxScale, the pair a release settles back into: a pinch past either
        // springs back, so there is no fling to start - but zoomed out below homeScale is a
        // resting place like any other, and pans there like any other.
        if (
            page.scale >= page.minScale &&
            page.scale <= page.maxScale &&
            lastEventTime - lastMoveTime < 100 &&
            (Math.abs(velocity.x) > 400 || Math.abs(velocity.y) > 400) &&
            (coerceIn(page.x, minX, maxX) === page.x || coerceIn(page.y, minY, maxY) === page.y)
        ) {
            page.isFlinging = true
            let lastOffset: Offset = { x: 0, y: 0 }
            const fling = animateDecay2d(velocity, value => {
                const dx = (value.x - lastOffset.x) / state.width / page.scale
                const dy = (value.y - lastOffset.y) / state.height / page.scale
                lastOffset = value
                const prevX = page.x
                const prevY = page.y
                const newX = orZero(coerceIn(page.x + dx, minX, maxX))
                const newY = orZero(coerceIn(page.y + dy, minY, maxY))
                page.setPos(newX, newY)
                // Pinned on both axes: the decay would run on without moving anything,
                // swallowing the next tap as "mid-fling". It never reverses, so one such frame
                // settles it - but only one that asked for a move.
                if ((dx !== 0 || dy !== 0) && newX === prevX && newY === prevY) fling.cancel()
            })
            page.animationJob = fling
            fling.promise.then(() => {
                // As the zoom fling: a cancelled job still settles, so only the current one may
                // clear the flag the next tap reads.
                if (page.animationJob !== fling) return
                page.isFlinging = false
            })
        } else {
            page.animateTo({ origin: scaleOrigin })
        }
    }
}
