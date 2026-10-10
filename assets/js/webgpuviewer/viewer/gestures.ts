import { Offset, VelocityTracker, distance } from "../util"

/**
 * Pointer plumbing for the gesture handlers in `imageviewer.ts`.
 *
 * DOM pointer events carry one pointer at a time and no history, so [PointerStream] keeps the
 * pointer set and synthesises a per-event snapshot of every pointer's current and previous
 * position, with pan/zoom/centroid over that set.
 */

export interface PointerInfo {
    id: number
    current: Offset
    previous: Offset
    pressed: boolean
    /** True on the event where this pointer went down. */
    changedToDown: boolean
    /** True on the event where this pointer transitioned to released. */
    changedToUp: boolean
    time: number
    /** Coalesced positions before [current] since the last event, oldest first. */
    historical: { time: number; position: Offset }[]
    touch: boolean
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

    /** Mean position of the pressed pointers. */
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

    /** Ratio of current to previous centroid size. */
    zoom(): number {
        const previous = this.centroidSize(false)
        const current = this.centroidSize(true)
        if (previous <= 0 || current <= 0) return 1
        return current / previous
    }

    /** Mean movement of the pressed pointers. */
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
        return this.changes.some(c => c.current.x !== c.previous.x || c.current.y !== c.previous.y)
    }
}

/**
 * A queue of [GestureEvent]s with an awaitable `next`, so a gesture reads as straight-line code.
 */
export class PointerStream {
    private readonly pointers = new Map<number, PointerInfo>()
    private readonly queue: GestureEvent[] = []
    private waiter: ((event: GestureEvent) => void) | null = null

    /** Positions are element-relative, in CSS pixels scaled to the backing store. */
    constructor(private readonly toLocal: (e: { clientX: number; clientY: number }) => Offset) { }

    get pressedCount(): number {
        let n = 0
        for (const p of this.pointers.values()) if (p.pressed) n++
        return n
    }

    /** Touch identifier -> pointer id, for [touchPointerId]. */
    private readonly touchIds = new Map<number, number>()

    /**
     * The pressed touch pointer for touch [identifier] at [position]. Touch and pointer ids differ,
     * so an unseen identifier pairs with the nearest unpaired pressed touch pointer. Null if none.
     */
    touchPointerId(identifier: number, position: Offset): number | null {
        const known = this.touchIds.get(identifier)
        if (known !== undefined && this.pointers.get(known)?.pressed) return known
        const paired = new Set(this.touchIds.values())
        let best: PointerInfo | null = null
        let bestDistance = Infinity
        for (const p of this.pointers.values()) {
            if (!p.pressed || !p.touch || paired.has(p.id)) continue
            const d = distance({ x: p.current.x - position.x, y: p.current.y - position.y })
            if (d < bestDistance) {
                best = p
                bestDistance = d
            }
        }
        if (!best) return null
        this.touchIds.set(identifier, best.id)
        return best.id
    }

    forgetTouch(identifier: number) {
        this.touchIds.delete(identifier)
    }

    handle(e: PointerEvent, type: "down" | "move" | "up" | "cancel") {
        const position = this.toLocal(e)
        const existing = this.pointers.get(e.pointerId)
        // A touchmove can repeat a position a pointermove already delivered - nothing moved.
        if (type === "move" && existing && existing.current.x === position.x && existing.current.y === position.y) return

        if (type === "down") {
            this.pointers.set(e.pointerId, {
                id: e.pointerId,
                current: position,
                previous: position,
                pressed: true,
                changedToDown: true,
                changedToUp: false,
                time: e.timeStamp,
                historical: [],
                touch: e.pointerType === "touch",
            })
        } else if (existing) {
            // [previous] stays at the last emitted position, so every pointer's move is
            // reported, not just this event's.
            existing.current = position
            existing.changedToUp = type === "up" || type === "cancel"
            if (existing.changedToUp) existing.pressed = false
            existing.time = e.timeStamp
            // The last coalesced event is this one.
            if (type === "move") {
                const coalesced = e.getCoalescedEvents?.() ?? []
                for (const c of coalesced.slice(0, -1)) {
                    existing.historical.push({ time: c.timeStamp, position: this.toLocal(c) })
                }
            }
        } else {
            return
        }

        // A snapshot: the gesture may await several events before reading this one, and the live
        // map keeps moving underneath it.
        const changes = [...this.pointers.values()].map(p => ({ ...p }))
        for (const p of this.pointers.values()) {
            p.previous = p.current
            p.changedToDown = false
            p.historical = []
        }
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
        this.touchIds.clear()
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
 * The event on which [pointerId] lifts, provided it
 * does so within [timeout] and without the gesture accumulating more than [touchSlop] of pan or
 * gaining a second pointer. Null otherwise, which is the caller's signal that this is a drag or
 * a hold rather than a tap.
 */
export async function waitForCleanUp(
    stream: PointerStream,
    pointerId: number,
    timeout: number,
    touchSlop: number,
    // Sees every event of the pointer, so a drag's velocity includes the motion spent in the slop.
    onChange?: (change: PointerInfo) => void,
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
        onChange?.(change)

        if (event.changes.some(c => c.id !== pointerId && c.pressed)) return null

        const pan = event.pan()
        acc = { x: acc.x + pan.x, y: acc.y + pan.y }
        if (distance(acc) > touchSlop) return null

        if (change.changedToUp) return event
    }
}

/** The next pressed pointer within [timeout]. */
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
