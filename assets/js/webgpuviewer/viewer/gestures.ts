import { Offset, VelocityTracker, distance } from "../util"

/**
 * Pointer plumbing standing in for Compose's `awaitPointerEventScope` - the shape the gesture
 * port in `imageviewer.ts` is written against.
 *
 * Compose hands a gesture a stream of `PointerEvent`s, each carrying every pointer's current and
 * previous position, plus `calculatePan`/`calculateZoom`/`calculateCentroid` over that set. DOM
 * pointer events carry one pointer at a time and no history, so [PointerStream] keeps the set and
 * synthesises the same per-event snapshot.
 */

export interface PointerInfo {
    id: number
    current: Offset
    previous: Offset
    pressed: boolean
    /** True on the event where this pointer transitioned to released. */
    changedToUp: boolean
    time: number
}

export class GestureEvent {
    constructor(
        readonly changes: PointerInfo[],
        readonly type: "down" | "move" | "up" | "cancel",
        readonly raw: PointerEvent,
    ) { }

    get pressed(): PointerInfo[] {
        return this.changes.filter(c => c.pressed)
    }

    /** Compose's `calculateCentroid`. */
    centroid(useCurrent: boolean = true): Offset {
        const pointers = this.pressed
        if (pointers.length === 0) return { x: 0, y: 0 }
        let x = 0
        let y = 0
        for (const p of pointers) {
            const pos = useCurrent ? p.current : p.previous
            x += pos.x
            y += pos.y
        }
        return { x: x / pointers.length, y: y / pointers.length }
    }

    /** Average distance of the pressed pointers from their centroid. */
    private centroidSize(useCurrent: boolean): number {
        const pointers = this.pressed
        if (pointers.length === 0) return 0
        const c = this.centroid(useCurrent)
        let sum = 0
        for (const p of pointers) {
            const pos = useCurrent ? p.current : p.previous
            sum += distance({ x: pos.x - c.x, y: pos.y - c.y })
        }
        return sum / pointers.length
    }

    /** Compose's `calculateZoom` - the ratio of current to previous centroid size. */
    zoom(): number {
        const previous = this.centroidSize(false)
        const current = this.centroidSize(true)
        if (previous <= 0 || current <= 0) return 1
        return current / previous
    }

    /** Compose's `calculatePan` - the mean movement of the pressed pointers. */
    pan(): Offset {
        const pointers = this.pressed
        if (pointers.length === 0) return { x: 0, y: 0 }
        let x = 0
        let y = 0
        for (const p of pointers) {
            x += p.current.x - p.previous.x
            y += p.current.y - p.previous.y
        }
        return { x: x / pointers.length, y: y / pointers.length }
    }

    positionChanged(): boolean {
        return this.changes.some(
            c => c.current.x !== c.previous.x || c.current.y !== c.previous.y,
        )
    }
}

/**
 * A queue of [GestureEvent]s with an awaitable `next`, so a gesture reads as the same
 * straight-line sequence the Kotlin's `awaitEachGesture` block is.
 */
export class PointerStream {
    private readonly pointers = new Map<number, PointerInfo>()
    private readonly queue: GestureEvent[] = []
    private waiter: ((event: GestureEvent) => void) | null = null

    /** Positions are element-relative, in CSS pixels scaled to the backing store. */
    constructor(private readonly toLocal: (e: PointerEvent) => Offset) { }

    get pressedCount(): number {
        let n = 0
        for (const p of this.pointers.values()) if (p.pressed) n++
        return n
    }

    handle(e: PointerEvent, type: "down" | "move" | "up" | "cancel") {
        const position = this.toLocal(e)
        const existing = this.pointers.get(e.pointerId)

        if (type === "down") {
            this.pointers.set(e.pointerId, {
                id: e.pointerId,
                current: position,
                previous: position,
                pressed: true,
                changedToUp: false,
                time: e.timeStamp,
            })
        } else if (existing) {
            existing.previous = existing.current
            existing.current = position
            existing.changedToUp = type === "up" || type === "cancel"
            if (existing.changedToUp) existing.pressed = false
            existing.time = e.timeStamp
        } else {
            return
        }

        // A snapshot: the gesture may await several events before reading this one, and the live
        // map keeps moving underneath it.
        const changes = [...this.pointers.values()].map(p => ({ ...p }))
        const event = new GestureEvent(changes, type, e)

        if (type === "up" || type === "cancel") this.pointers.delete(e.pointerId)

        if (this.waiter) {
            const waiter = this.waiter
            this.waiter = null
            waiter(event)
        } else {
            this.queue.push(event)
        }
    }

    next(): Promise<GestureEvent> {
        const queued = this.queue.shift()
        if (queued) return Promise.resolve(queued)
        return new Promise(resolve => {
            this.waiter = resolve
        })
    }

    clear() {
        this.pointers.clear()
        this.queue.length = 0
        this.waiter = null
    }
}

/** Resolves to null if [promise] hasn't settled within [ms]. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([
        promise,
        new Promise<null>(resolve => setTimeout(() => resolve(null), ms)),
    ])
}

/**
 * `AwaitPointerEventScope.waitForCleanUp` - the event on which [pointerId] lifts, provided it
 * does so within [timeout] and without the gesture accumulating more than [touchSlop] of pan or
 * gaining a second pointer. Null otherwise, which is the caller's signal that this is a drag or
 * a hold rather than a tap.
 */
export async function waitForCleanUp(
    stream: PointerStream,
    pointerId: number,
    timeout: number,
    touchSlop: number,
): Promise<GestureEvent | null> {
    const deadline = performance.now() + timeout
    let acc: Offset = { x: 0, y: 0 }

    while (true) {
        const remaining = deadline - performance.now()
        if (remaining <= 0) return null
        const event = await withTimeout(stream.next(), remaining)
        if (!event) return null

        const change = event.changes.find(c => c.id === pointerId)
        if (!change) return null

        if (event.changes.some(c => c.id !== pointerId && c.pressed)) return null

        const pan = event.pan()
        acc = { x: acc.x + pan.x, y: acc.y + pan.y }
        if (distance(acc) > touchSlop) return null

        if (change.changedToUp) return event
    }
}

/** `AwaitPointerEventScope.waitForDown` - the next pressed pointer within [timeout]. */
export async function waitForDown(
    stream: PointerStream,
    timeout: number,
): Promise<PointerInfo | null> {
    const deadline = performance.now() + timeout
    while (true) {
        const remaining = deadline - performance.now()
        if (remaining <= 0) return null
        const event = await withTimeout(stream.next(), remaining)
        if (!event) return null
        const down = event.changes.find(c => c.pressed && c.id === event.raw.pointerId)
        if (down && event.type === "down") return down
    }
}

export { VelocityTracker }
