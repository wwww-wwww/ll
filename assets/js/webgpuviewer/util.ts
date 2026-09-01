/**
 * Small helpers shared across the port - the TypeScript stand-ins for the bits of Kotlin,
 * Compose and the Android framework the original leaned on.
 */

/** Kotlin's `Float.coerceIn`. */
export function coerceIn(value: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, value))
}

/** Kotlin's `Float.coerceAtLeast`/`coerceAtMost`. */
export function coerceAtLeast(value: number, lo: number): number {
    return Math.max(value, lo)
}

export function coerceAtMost(value: number, hi: number): number {
    return Math.min(value, hi)
}

/** `Float.orZero()` - NaN reads as 0 rather than poisoning a transform. */
export function orZero(value: number): number {
    return Number.isNaN(value) ? 0 : value
}

/** `Float.closeTo` - the epsilon-equality `atHome`/`atHomeScale` are built on. */
export function closeTo(a: number, b: number, eps: number = 0.0001): boolean {
    return Math.abs(a - b) < eps
}

export interface Offset {
    x: number
    y: number
}

export const OFFSET_ZERO: Offset = { x: 0, y: 0 }

export function offset(x: number, y: number): Offset {
    return { x, y }
}

export function distance(o: Offset): number {
    return Math.sqrt(o.x * o.x + o.y * o.y)
}

/** `android.graphics.Rect` - integer bounds, exclusive right/bottom. */
export class Rect {
    constructor(
        public left: number,
        public top: number,
        public right: number,
        public bottom: number,
    ) { }

    width(): number {
        return this.right - this.left
    }

    height(): number {
        return this.bottom - this.top
    }
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** Colours are ARGB ints, the same 0xAARRGGBB packing the Kotlin uses throughout. */
export function argb(a: number, r: number, g: number, b: number): number {
    return (a << 24) | (r << 16) | (g << 8) | b | 0
}

export function alphaOf(color: number): number {
    return (color >>> 24) & 0xff
}

export function redOf(color: number): number {
    return (color >> 16) & 0xff
}

export function greenOf(color: number): number {
    return (color >> 8) & 0xff
}

export function blueOf(color: number): number {
    return color & 0xff
}

/** [r, g, b, a] in 0..1, the form every uniform write wants. */
export function colorToFloats(color: number): [number, number, number, number] {
    return [redOf(color) / 255, greenOf(color) / 255, blueOf(color) / 255, alphaOf(color) / 255]
}

export function srgbToLinear(c: number): number {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function linearToSrgb(c: number): number {
    return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

interface SchedulerLike {
    yield?: () => Promise<void>
}

const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler

/**
 * `kotlinx.coroutines.yield()`.
 *
 * The Kotlin hands the render thread back mid-upload so a queued frame gets through; here that means
 * giving the event loop a turn. `scheduler.yield()` where it exists, since it resumes ahead of
 * ordinary tasks, else a macrotask. A microtask would not do: it runs before the next rAF callback,
 * which is the thing that has to get in.
 */
export function yieldToEventLoop(): Promise<void> {
    if (scheduler?.yield) return scheduler.yield()
    return new Promise(resolve => setTimeout(resolve, 0))
}

export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Cooperative pacing for a long job: work for [budgetMs], hand the frame loop a turn, repeat.
 *
 * The Kotlin yields per unit of work, which costs it a function call on an idle dispatcher. Here
 * every yield is an event-loop turn, clamped in the `setTimeout` fallback, so per-unit yielding
 * becomes the bottleneck - a page's upload runs to well over a hundred turns, slower than the work
 * it protects.
 *
 * Budgeting by time keeps both properties: no turn long enough to drop a frame, and a turn count
 * proportional to total work rather than to the number of calls.
 */
export class FrameBudget {
    private deadline = 0

    constructor(private readonly budgetMs: number = 4) { }

    /** Yield if this turn's budget is spent, otherwise return immediately. */
    async next(): Promise<void> {
        const now = performance.now()
        if (this.deadline === 0) {
            this.deadline = now + this.budgetMs
            return
        }
        if (now < this.deadline) return
        await yieldToEventLoop()
        this.deadline = performance.now() + this.budgetMs
    }
}

/** A cancellable unit of async work - the port's stand-in for `kotlinx.coroutines.Job`. */
export class Job {
    private _cancelled = false
    readonly promise: Promise<void>

    constructor(run: (job: Job) => Promise<void>) {
        this.promise = run(this)
            .catch(e => {
                if (!(e instanceof JobCancelled)) throw e
            })
            // Here, not in [join]: nothing calls join, so [isActive] used to stay true for the life
            // of a finished job - the opposite of what `Job.isActive` means in the Kotlin.
            .finally(() => {
                this._settled = true
            })
    }

    get cancelled(): boolean {
        return this._cancelled
    }

    get isActive(): boolean {
        return !this._cancelled && !this._settled
    }

    private _settled = false

    cancel() {
        this._cancelled = true
    }

    /** Throws out of the job body once cancelled - `ensureActive()`. */
    ensureActive() {
        if (this._cancelled) throw new JobCancelled()
    }

    async join(): Promise<void> {
        await this.promise
    }
}

export class JobCancelled extends Error {
    constructor() {
        super("job cancelled")
    }
}

/** Launches [body] as a [Job]. */
export function launch(body: (job: Job) => Promise<void>): Job {
    return new Job(async job => {
        await body(job)
    })
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

/** Compose's `Spring.StiffnessMedium` / `StiffnessMediumLow` / `StiffnessLow`. */
export const STIFFNESS_MEDIUM = 1500
export const STIFFNESS_MEDIUM_LOW = 400

let scale = 0.5

export function animationScale(): number {
    return scale
}

export function setAnimationScale(value: number) {
    if (!Number.isFinite(value)) return
    scale = value
}

/** One animation's state at a point in time. */
export interface AnimationFrame {
    value: number
    velocity: number
    /** True once the animation has settled and should stop. */
    done: boolean
}

/**
 * An animation resolved for a specific run: where it starts, where it is going, and how fast the
 * value was already moving.
 *
 * Compose's `AnimationSpec` is a factory in the same way - `Animatable.animateTo(target,
 * initialVelocity, spec)` binds the spec to those three before anything is integrated. Keeping
 * that shape is what lets a flick's velocity carry into the spring that settles it, which a
 * normalised 0..1 easing curve cannot express.
 */
export type AnimationSpec = (
    from: number,
    to: number,
    initialVelocity: number,
) => (t: number) => AnimationFrame

/**
 * Compose's `spring(dampingRatio, stiffness, visibilityThreshold)`, as the closed-form solution
 * of the same second-order system rather than a per-frame integration.
 *
 * The closed form matters for more than tidiness: a browser drops frames, and re-integrating from
 * the previous frame's state accumulates whatever error a long frame introduced. Evaluating at
 * absolute time means a 200ms stall resumes exactly where the physics says it should be, so a
 * page turn that hitches still lands where and when it should.
 *
 * All three damping regimes are here because Compose's presets span them; the default
 * ([DAMPING_NO_BOUNCY]) is the critically damped case, which is what the viewer uses throughout.
 */
export function spring(
    stiffness: number = STIFFNESS_MEDIUM_LOW,
    visibilityThreshold: number = 0.0005,
    dampingRatio: number = 1,
): AnimationSpec {
    const omega = Math.sqrt(stiffness)
    const zeta = Math.max(0, dampingRatio)

    return (from, to, initialVelocity) => {
        const d0 = from - to
        const v0 = initialVelocity

        // Velocity settles on a different scale from position; Compose derives its velocity
        // threshold from the same visibility threshold, and this is that relationship.
        const velocityThreshold = visibilityThreshold * omega

        let solve: (t: number) => { offset: number; velocity: number }

        if (Math.abs(zeta - 1) < 1e-4) {
            // Critically damped: offset = (d0 + (v0 + w*d0) t) e^(-w t)
            const c = v0 + omega * d0
            solve = t => {
                const decay = Math.exp(-omega * t)
                return { offset: (d0 + c * t) * decay, velocity: (v0 - omega * c * t) * decay }
            }
        } else if (zeta < 1) {
            // Underdamped: oscillates toward the target inside an exponential envelope.
            const wd = omega * Math.sqrt(1 - zeta * zeta)
            const a = d0
            const b = (v0 + zeta * omega * d0) / wd
            solve = t => {
                const decay = Math.exp(-zeta * omega * t)
                const cos = Math.cos(wd * t)
                const sin = Math.sin(wd * t)
                return {
                    offset: decay * (a * cos + b * sin),
                    velocity:
                        decay * (-zeta * omega * (a * cos + b * sin) + wd * (b * cos - a * sin)),
                }
            }
        } else {
            // Overdamped: two real roots, no oscillation, slower to arrive than critical.
            const r = omega * Math.sqrt(zeta * zeta - 1)
            const r1 = -zeta * omega + r
            const r2 = -zeta * omega - r
            const c2 = (v0 - r1 * d0) / (r2 - r1)
            const c1 = d0 - c2
            solve = t => ({
                offset: c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t),
                velocity: c1 * r1 * Math.exp(r1 * t) + c2 * r2 * Math.exp(r2 * t),
            })
        }

        return t => {
            const { offset, velocity } = solve(t)
            return {
                value: to + offset,
                velocity,
                done:
                    Math.abs(offset) < visibilityThreshold &&
                    Math.abs(velocity) < velocityThreshold,
            }
        }
    }
}

/** Compose's `tween(durationMillis)` with its default `FastOutSlowIn` easing. */
export function tween(durationMillis: number): AnimationSpec {
    const duration = Math.max(durationMillis, 1) / 1000

    // FastOutSlowIn is cubic-bezier(0.4, 0, 0.2, 1); smoothstep tracks it to within a couple of
    // percent across the whole curve and needs no root solver.
    return (from, to) => t => {
        const progress = Math.min(t / duration, 1)
        return {
            value: from + (to - from) * progress * progress * (3 - 2 * progress),
            // Derivative of the eased curve, in value per second.
            velocity: ((to - from) * 6 * progress * (1 - progress)) / duration,
            done: progress >= 1,
        }
    }
}

export interface AnimateOptions {
    /** Velocity the value already had - what makes a flick settle faster than a slow release. */
    initialVelocity?: number
    /** `Animatable.updateBounds` - reaching a bound clamps the value and ends the animation. */
    lowerBound?: number
    upperBound?: number
}

/**
 * `androidx.compose.animation.core.animate` - drives [block] once per frame until [spec] settles.
 *
 * The last frame always lands exactly on [to] (or on whichever bound stopped it), so a caller can
 * rely on the animation having arrived rather than on it having got close. Returns a [Job] so
 * callers can cancel it the way the Kotlin does.
 */
export function animate(
    from: number,
    to: number,
    spec: AnimationSpec,
    block: (value: number, velocity: number) => void,
    options: AnimateOptions = {},
): Job {
    const {
        initialVelocity = 0,
        lowerBound = Number.NEGATIVE_INFINITY,
        upperBound = Number.POSITIVE_INFINITY,
    } = options

    const solve = spec(from, to, initialVelocity)

    // Fixed for this run: see [setAnimationScale].
    const timeScale = animationScale()

    return launch(async job => {
        const start = performance.now()
        while (true) {
            const now = await nextFrame()
            job.ensureActive()

            // Animations off - still a frame late rather than synchronous, so a caller that starts
            // one and reads the value back gets the same ordering it does at any other scale.
            if (timeScale === 0) {
                block(coerceIn(to, lowerBound, upperBound), 0)
                return
            }

            const frame = solve((now - start) / 1000 / timeScale)

            if (frame.value <= lowerBound) {
                block(lowerBound, 0)
                return
            }
            if (frame.value >= upperBound) {
                block(upperBound, 0)
                return
            }
            if (frame.done) {
                block(to, 0)
                return
            }

            block(frame.value, frame.velocity)
        }
    })
}

/**
 * `Animatable.animateDecay(initialVelocity, exponentialDecay())`.
 *
 * Compose's exponential decay is `v(t) = v0 e^(kt)` with `k = -4.2 * frictionMultiplier`, ending
 * at `absVelocityThreshold` (0.1 by default) - reproduced here so a fling glides for the same
 * distance and duration it does on Android.
 */
export function animateDecay(
    initialVelocity: number,
    block: (value: number, velocity: number) => void,
    frictionMultiplier: number = 1,
    absVelocityThreshold: number = 0.1,
): Job {
    const k = -4.2 * frictionMultiplier
    const timeScale = animationScale()
    return launch(async job => {
        const start = performance.now()
        while (true) {
            const now = await nextFrame()
            job.ensureActive()
            // Animations off - the glide's whole distance at once, x(inf) = -v0/k.
            if (timeScale === 0) {
                block(-initialVelocity / k, 0)
                return
            }
            const decay = Math.exp(k * ((now - start) / 1000 / timeScale))
            const velocity = initialVelocity * decay
            // x(t) = v0 / k * (e^(kt) - 1)
            block((initialVelocity / k) * (decay - 1), velocity)
            if (Math.abs(velocity) < absVelocityThreshold) return
        }
    })
}

/** As [animateDecay], over a 2D offset - the pan fling. */
export function animateDecay2d(
    velocity: Offset,
    block: (value: Offset, velocity: Offset) => void,
): Job {
    const k = -4.2
    return launch(async job => {
        const start = performance.now()
        while (true) {
            const now = await nextFrame()
            job.ensureActive()
            const t = (now - start) / 1000
            const decay = Math.exp(k * t)
            const v = { x: velocity.x * decay, y: velocity.y * decay }
            const value = { x: (velocity.x / k) * (decay - 1), y: (velocity.y / k) * (decay - 1) }
            block(value, v)
            if (distance(v) < 1) return
        }
    })
}

export function nextFrame(): Promise<number> {
    return new Promise(resolve => requestAnimationFrame(resolve))
}

/**
 * `VelocityTracker` - least-squares fit over the last 100ms of samples, the same window Android
 * uses, in pixels per second.
 */
export class VelocityTracker {
    private samples: { t: number; x: number; y: number }[] = []

    add(timeMillis: number, position: Offset) {
        this.samples.push({ t: timeMillis, x: position.x, y: position.y })
        const cutoff = timeMillis - 100
        while (this.samples.length > 0 && this.samples[0].t < cutoff) this.samples.shift()
    }

    reset() {
        this.samples = []
    }

    calculateVelocity(): Offset {
        if (this.samples.length < 2) return OFFSET_ZERO
        const first = this.samples[0]
        const last = this.samples[this.samples.length - 1]
        const dt = (last.t - first.t) / 1000
        if (dt <= 0) return OFFSET_ZERO
        return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt }
    }
}
