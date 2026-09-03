import {
    Job,
    Offset,
    VelocityTracker,
    animate,
    animateDecay,
    coerceIn,
    delay,
    launch,
    spring,
} from "../util"
import { GestureEvent, PointerStream, waitForCleanUp, waitForDown } from "./gestures"
import { ImageViewerContinuousState } from "./imageviewercontinuousstate"

/**
 * The continuous viewer's gestures - the port of `viewer/ImageViewerContinuous.kt`.
 *
 * Structurally the paged viewer's machine (tap / double tap / double-tap-drag zoom / pan-pinch),
 * but every transform lands on the viewer rather than on a page: there is one [scale] and one
 * [offsetX] for the whole document, and vertical movement goes through
 * [ImageViewerContinuousState.scrollBy], which is what walks page boundaries.
 *
 * Given the host's stream rather than owning one, so [ImageViewerElement] keeps a single set of
 * pointer listeners and one gesture loop for both modes.
 */
export interface ContinuousGestureHost {
    state: ImageViewerContinuousState
    stream: PointerStream
    touchSlop: number
    doubleTapTimeout: number
    longPressTimeout: number
}

/** Zoom-fling and pan-fling thresholds, in px/s - `abs(velocity) > n` in the Kotlin. */
const ZOOM_FLING_VELOCITY = 200
const PAN_FLING_VELOCITY = 400

/** Raised to end a fling that is pinned on both axes - see the pan fling below. */
class FlingStalled extends Error { }

export async function handleContinuousGesture(
    host: ContinuousGestureHost,
    firstEvent: GestureEvent,
) {
    const { state, stream } = host
    const firstDownId = firstEvent.raw.pointerId
    const firstDown = firstEvent.changes.find(c => c.id === firstDownId)!
    const firstPosition = firstDown.current

    state.animationJob?.cancel()

    // A touch on moving content only stops it: no long press, no tap, but still a double tap,
    // drag or pinch.
    const stoppedMotion = state.isScaleAnimating || state.isFlinging
    if (stoppedMotion) {
        state.isScaleAnimating = false
        state.isFlinging = false
        state.invalidate()
    }

    let longPressed = false
    const longPressJob: Job | null =
        stoppedMotion ? null : (
            launch(async job => {
                await delay(host.longPressTimeout)
                job.ensureActive()
                longPressed = true
                state.onLongTap?.({
                    x: firstPosition.x / state.width,
                    y: firstPosition.y / state.height,
                })
            })
        )

    const cleanUp = await waitForCleanUp(stream, firstDownId, host.doubleTapTimeout, host.touchSlop)

    if (cleanUp !== null) {
        longPressJob?.cancel()
        // Tap - wait for a double tap. A touch that only stopped motion waits too: no single tap
        // below, but it can still be the first of a pair.
        const secondDown = await waitForDown(stream, host.doubleTapTimeout)
        if (secondDown === null) {
            if (!stoppedMotion) {
                state.onTap?.({
                    x: firstPosition.x / state.width,
                    y: firstPosition.y / state.height,
                })
            }
            return
        }

        const secondCleanUp = await waitForCleanUp(
            stream,
            secondDown.id,
            host.doubleTapTimeout,
            host.touchSlop,
        )

        if (secondCleanUp !== null) {
            doubleTapZoom(state, secondDown.current)
            return
        }

        await doubleTapDragZoom(host, secondDown.id, secondDown.current)
        return
    }

    await dragGesture(host, firstEvent, firstPosition, longPressJob, () => longPressed)
}

/** Double tap: toggle between the state's minScale and doubleTapScale, anchored at the tap. */
function doubleTapZoom(state: ImageViewerContinuousState, position: Offset) {
    const py = position.y / state.height - 0.5
    const zoomedIn = state.scale > state.minScale + 0.1

    // Zooming out returns offsetX to 0, so the anchor is whatever x offset would arrive there;
    // zooming in anchors on the tap itself.
    const startScale = state.scale
    const startOffsetX = state.offsetX
    const target = zoomedIn ? state.minScale : state.doubleTapScale
    const px =
        zoomedIn ?
            (() => {
                const totalDiff = 1 / state.minScale - 1 / startScale
                return totalDiff !== 0 ? -startOffsetX / totalDiff : 0
            })()
            : position.x / state.width - 0.5

    state.isScaleAnimating = true
    const job = animate(0, 1, spring(), t => {
        const newScale = startScale + (target - startScale) * t
        // Against the live scale, not the start: each step moves by what this frame changed.
        const diff = 1 / newScale - 1 / state.scale
        state.offsetX += px * diff
        state.scale = newScale
        state.scrollBy(-py * diff * state.height)
        state.invalidate()
    })
    state.animationJob = job
    job.promise.then(() => {
        if (state.animationJob === job) state.isScaleAnimating = false
    })
}

/** Second tap held and dragged: vertical drag drives zoom, with a decay fling on release. */
async function doubleTapDragZoom(
    host: ContinuousGestureHost,
    dragPointerId: number,
    origin: Offset,
) {
    const { state, stream } = host
    const velocityTracker = new VelocityTracker()
    velocityTracker.add(performance.now(), origin)

    const originalScale = state.scale
    const originalOffsetX = state.offsetX
    // Zoom anchors the tap point, and the scroll that needs is a function of the total scale
    // change - so it is applied as the step since the last frame. Page crossings and the end of
    // the document are scrollBy's to keep, and it is the only thing that keeps them.
    let anchorApplied = 0
    const anchorScroll = (target: number) => {
        state.scrollBy(target - anchorApplied)
        anchorApplied = target
    }

    const px = origin.x / state.width - 0.5
    const py = origin.y / state.height - 0.5
    let totalDeltaY = 0

    state.isScaleAnimating = true
    let willFlingZoom = false
    try {
        for (; ;) {
            const event = await stream.next()
            const change = event.changes.find(c => c.id === dragPointerId)
            if (!change || change.changedToUp) break

            velocityTracker.add(event.raw.timeStamp, change.current)
            totalDeltaY += event.pan().y
            if (totalDeltaY === 0) continue

            const newScale = originalScale * Math.pow(10, (2 * totalDeltaY) / state.height)
            const diff = 1 / newScale - 1 / originalScale
            state.scale = newScale
            state.offsetX = originalOffsetX + px * diff
            anchorScroll(-py * diff * state.height)
            state.invalidate()
        }

        const dragVelocity = velocityTracker.calculateVelocity()
        // Decided before the finally below, so isScaleAnimating has no gap between this drag
        // ending and its fling starting.
        willFlingZoom =
            Math.abs(dragVelocity.y) > ZOOM_FLING_VELOCITY &&
            state.scale > state.minScale &&
            state.scale < state.maxScale
    } finally {
        if (!willFlingZoom) state.isScaleAnimating = false
    }

    const velocity = velocityTracker.calculateVelocity()

    if (willFlingZoom) {
        const job = animateDecay(velocity.y, value => {
            const newScale = coerceIn(
                originalScale * Math.pow(10, (2 * (totalDeltaY + value)) / state.height),
                state.minScale,
                state.maxScale,
            )
            const diff = 1 / newScale - 1 / originalScale
            const limit = state.maxOffsetX(newScale)
            state.scale = newScale
            state.offsetX = coerceIn(originalOffsetX + px * diff, -limit, limit)
            anchorScroll(-py * diff * state.height)
            state.invalidate()
        })
        state.animationJob = job
        job.promise.then(() => {
            if (state.animationJob === job) state.isScaleAnimating = false
        })
        return
    }

    // Snap scale and offsetX back if the drag overshot either limit.
    if (!snapScaleIntoBounds(state, px, py)) {
        // Only the pan overshot.
        snapOffsetXIntoBounds(state)
    }
}

/**
 * Walk a scale that overshot back into bounds about [originX]/[originY], the point the zoom was
 * anchored to - fractions of the viewport from its centre. False if the scale was already fine.
 *
 * Position interpolates on the reciprocal of the scale, as `ImagePage.animateTo` does, so the
 * origin holds throughout: what the anchor owes is a function of 1/scale, not of the animation's
 * own progress.
 */
function snapScaleIntoBounds(
    state: ImageViewerContinuousState,
    originX: number,
    originY: number,
): boolean {
    const startScale = state.scale
    const targetScale = coerceIn(startScale, state.minScale, state.maxScale)
    if (targetScale === startScale) return false

    const diffEnd = 1 / targetScale - 1 / startScale
    const startOffsetX = state.offsetX
    const endLimit = state.maxOffsetX(targetScale)
    const endOffsetX = coerceIn(startOffsetX + originX * diffEnd, -endLimit, endLimit)
    const endScroll = -originY * diffEnd * state.height

    state.isScaleAnimating = true
    let applied = 0
    const job = animate(0, 1, spring(), t => {
        const newScale = (1 - t) * startScale + t * targetScale
        const c = coerceIn((1 / newScale - 1 / startScale) / diffEnd, 0, 1)
        state.scale = newScale
        state.offsetX = startOffsetX + (endOffsetX - startOffsetX) * c
        // As a step, so scrollBy keeps its page crossings and clamp.
        state.scrollBy(endScroll * c - applied)
        applied = endScroll * c
        state.invalidate()
    })
    state.animationJob = job
    job.promise.then(() => {
        if (state.animationJob === job) state.isScaleAnimating = false
    })
    return true
}

/** Walk a pan that overshot back to the edge it overshot, the scale being fine. */
function snapOffsetXIntoBounds(state: ImageViewerContinuousState) {
    const limit = state.maxOffsetX(state.scale)
    const clampedX = coerceIn(state.offsetX, -limit, limit)
    if (clampedX === state.offsetX) return

    const startX = state.offsetX
    state.animationJob = animate(0, 1, spring(), t => {
        state.offsetX = startX + (clampedX - startX) * t
        state.invalidate()
    })
}

/** One-or-two-finger drag: pan the document, pinch to zoom, then fling or snap back. */
async function dragGesture(
    host: ContinuousGestureHost,
    firstEvent: GestureEvent,
    firstPosition: Offset,
    longPressJob: Job | null,
    longPressed: () => boolean,
) {
    const { state, stream } = host
    const velocityTracker = new VelocityTracker()
    velocityTracker.add(firstEvent.raw.timeStamp, firstPosition)

    let single = true
    let zoomOriginX = 0
    let zoomOriginY = 0
    let lastMoveTime = firstEvent.raw.timeStamp
    let lastEventTime = firstEvent.raw.timeStamp

    try {
        for (; ;) {
            const event = await stream.next()
            const change = event.changes[0]
            if (!change) break

            const multi = event.changes.length > 1 && event.changes.every(c => c.pressed)
            if (multi && single) {
                longPressJob?.cancel()
                velocityTracker.reset()
            }
            if (multi) single = false

            velocityTracker.add(event.raw.timeStamp, change.current)

            const pan = event.pan()
            const zoom = event.zoom()
            // Whenever two fingers are down: a quiet moment mid-pinch is still a pinch, and
            // generation stays held off.
            state.isScaleAnimating = multi

            lastEventTime = event.raw.timeStamp
            if (change.current !== change.previous) lastMoveTime = event.raw.timeStamp

            if (pan.x !== 0 || pan.y !== 0 || zoom !== 1) {
                longPressJob?.cancel()

                if (zoom !== 1) {
                    velocityTracker.reset()
                    const centroid = event.centroid(true)
                    const newScale = state.scale * zoom
                    const diff = 1 / newScale - 1 / state.scale
                    const cx = centroid.x / state.width - 0.5
                    const cy = centroid.y / state.height - 0.5
                    // What the snap-back below anchors to.
                    zoomOriginX = cx
                    zoomOriginY = cy
                    state.offsetX += cx * diff
                    state.scale = newScale
                    state.scrollBy(-cy * diff * state.height)
                }

                // One finger is bounded; a pinch is not, so the release can snap it back.
                if (single) {
                    const limit = state.maxOffsetX(state.scale)
                    state.offsetX = coerceIn(
                        state.offsetX + pan.x / state.width / state.scale,
                        -limit,
                        limit,
                    )
                } else {
                    state.offsetX += pan.x / state.width / state.scale
                }
                state.scrollBy(-pan.y / state.scale)
                state.invalidate()
            }

            if (!event.changes.some(c => c.pressed)) break
        }
    } finally {
        state.isScaleAnimating = false
    }

    longPressJob?.cancel()
    if (longPressed()) return

    // Scale out of bounds: snap it back, anchored where the pinch was.
    if (snapScaleIntoBounds(state, zoomOriginX, zoomOriginY)) return

    // Scale in bounds: fling pan or snap offsetX.
    const velocity = velocityTracker.calculateVelocity()
    // Held still before lifting: no fling, however fast it got there.
    const flingable =
        lastEventTime - lastMoveTime < 100 &&
        (Math.abs(velocity.y) > PAN_FLING_VELOCITY || Math.abs(velocity.x) > PAN_FLING_VELOCITY)

    if (flingable) {
        panFling(state, velocity)
        return
    }

    snapOffsetXIntoBounds(state)
}

/** Decay fling along the release direction, scrolling and panning together. */
function panFling(state: ImageViewerContinuousState, velocity: Offset) {
    const speed = Math.hypot(velocity.x, velocity.y)
    const dirX = velocity.x / speed
    const dirY = velocity.y / speed
    let last = 0

    state.isFlinging = true
    const job = animateDecay(speed, value => {
        const delta = value - last
        last = value
        const limit = state.maxOffsetX(state.scale)
        const prevOffsetX = state.offsetX
        const prevScrollY = state.scrollY
        state.offsetX = coerceIn(
            state.offsetX + (dirX * delta) / state.width / state.scale,
            -limit,
            limit,
        )
        state.scrollBy((-dirY * delta) / state.scale)
        state.invalidate()
        // Pinned on both axes: the decay would run on without moving anything, swallowing the next
        // tap as "mid-fling". It never reverses, so one such frame settles it - but only one that
        // asked for a move, the first frame being the initial value.
        if (delta !== 0 && state.offsetX === prevOffsetX && state.scrollY === prevScrollY) {
            throw new FlingStalled()
        }
    })
    state.animationJob = job
    job.promise
        .catch(e => {
            if (!(e instanceof FlingStalled)) throw e
        })
        .finally(() => {
            if (state.animationJob !== job) return
            // A final invalidate so generation resumes promptly rather than waiting on whatever
            // gesture happens to invalidate next.
            state.isFlinging = false
            state.invalidate()
        })
}
