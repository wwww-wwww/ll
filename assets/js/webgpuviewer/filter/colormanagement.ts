import type { FilterChain } from "./filterchain"
import { FilterLut3d } from "./filterlut3d"
import { Lut3d } from "./lut3d"

/**
 * Colour-managing the WebGPU canvas by hand, since Firefox does not.
 *
 * Firefox transforms what it presents into the display's profile - images, CSS colours, a 2D
 * canvas - but hands a WebGPU canvas to the compositor as-is, so on a non-sRGB display the reader's
 * frame is the one surface on the page that skipped the transform.
 *
 * No flag asks for it, but a path that does get it reports what it did: fill known colours onto a
 * 2D canvas, read them back, and that is the transform on a grid - see [probeCanvas].
 *
 * An output filter over the finished frame, so the tile shaders and the upscaler work in the
 * untransformed values - where blending and resampling belong.
 */

/**
 * Points per axis in the probe, which is the LUT's own resolution too - it is applied as measured.
 *
 * 65 is the conventional cube size: a 2.2MB `rgba16float` texture, 275k one-pixel fills once, and
 * entries just under 4 code values apart for the GPU to interpolate between. 64 does not divide 255,
 * so a lattice value lands on the nearest whole code value - see [level] - half a step out against
 * the 4 the spacing itself carries.
 */
const PROBE_SIZE = 65

/** The 8-bit value probe point [i] of [last] + 1 actually gets filled with. */
function level(i: number, last: number): number {
    return Math.round((i * 255) / last)
}

/** A colour lattice rendered onto a canvas and read back - see [probeCanvas]. */
export interface ColorProbe {
    /** Points per axis. */
    size: number
    /** Where each point came out, RGB triples, red varying fastest - [Lut3d.data]'s order. */
    mapped: Uint8Array
}

/**
 * How far from identity the measured transform has to be before it is worth correcting, in 8-bit
 * steps. Below this the LUT is measurement noise and a pass that would only round-trip the frame.
 */
const IDENTITY_TOLERANCE = 1.5 / 255

/**
 * True on Firefox, the only engine that leaves a WebGPU canvas unmanaged.
 *
 * A UA test: the probe measures the display transform, which every engine reports, but whether the
 * compositor applies it here too is invisible from script. A browser that does manage its canvas
 * would be transformed twice, so this gates the whole thing rather than the probe deciding alone.
 */
export function isFirefox(): boolean {
    return typeof navigator !== "undefined" && /\bGecko\/|\bFirefox\//.test(navigator.userAgent)
}

/**
 * The lattice rendered onto a canvas and read straight back: for each of [PROBE_SIZE]^3 known
 * colours, the value the canvas gives back for it.
 *
 * An off-document `<canvas>` - a readback needs no layout - with `willReadFrequently`, which keeps
 * it in system memory so `getImageData` is CPU work rather than a compositor round-trip. One row per
 * blue slice, red fastest along x: [Lut3d.data]'s order, so nothing needs reshuffling.
 */
export function probeCanvas(size = PROBE_SIZE): ColorProbe | null {
    if (typeof document === "undefined") return null
    const width = size * size
    const height = size
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return null

    const last = size - 1
    // Per axis up front: 275k fills is enough that the rounding is worth not repeating.
    const levels = new Uint8Array(size)
    for (let i = 0; i < size; i++) levels[i] = level(i, last)

    for (let b = 0; b < size; b++) {
        for (let g = 0; g < size; g++) {
            for (let r = 0; r < size; r++) {
                ctx.fillStyle = `rgb(${levels[r]}, ${levels[g]}, ${levels[b]})`
                ctx.fillRect(g * size + r, b, 1, 1)
            }
        }
    }

    const read = ctx.getImageData(0, 0, width, height).data
    const count = width * height
    const mapped = new Uint8Array(count * 3)
    for (let i = 0; i < count; i++) {
        mapped[i * 3] = read[i * 4]
        mapped[i * 3 + 1] = read[i * 4 + 1]
        mapped[i * 3 + 2] = read[i * 4 + 2]
    }
    return { size, mapped }
}

/** [probe] as the LUT it is: where each lattice point went, on a regular grid. */
export function forwardLut(probe: ColorProbe): Lut3d {
    const { size, mapped } = probe
    const count = size * size * size
    if (mapped.length !== count * 3) throw new Error(`probe ${mapped.length} for size ${size}`)
    const data = new Float32Array(count * 3)
    for (let i = 0; i < count * 3; i++) data[i] = mapped[i] / 255
    return new Lut3d(size, data)
}

/** How far [lut] moves the colour furthest from where it came in. */
export function distanceFromIdentity(lut: Lut3d): number {
    const n = lut.size
    const last = n - 1
    let worst = 0
    let i = 0
    for (let b = 0; b < n; b++) {
        for (let g = 0; g < n; g++) {
            for (let r = 0; r < n; r++) {
                worst = Math.max(
                    worst,
                    Math.abs(lut.data[i] - r / last),
                    Math.abs(lut.data[i + 1] - g / last),
                    Math.abs(lut.data[i + 2] - b / last),
                )
                i += 3
            }
        }
    }
    return worst
}

/**
 * The correction for this browser and display, or null where there is nothing to correct - which
 * is every engine but Firefox, and Firefox itself when the probe comes back as identity.
 *
 * Measured once. The transform is a property of the display profile, so every viewer wants the
 * same answer, and the probe costs a decode.
 */
let measured: Promise<Lut3d | null> | null = null

export function displayCorrection(): Promise<Lut3d | null> {
    if (measured) return measured
    measured = measure()
    return measured
}

/** In 8-bit steps, for the log below. */
function codes(value: number): string {
    return `${(value * 255).toFixed(1)}/255`
}

async function measure(): Promise<Lut3d | null> {
    if (!isFirefox()) return null
    try {
        const probe = probeCanvas()
        if (!probe) {
            console.warn(
                "colour management: no 2d canvas to probe with, leaving the frame as drawn",
            )
            return null
        }

        const forward = forwardLut(probe)
        const moved = distanceFromIdentity(forward)
        if (moved < IDENTITY_TOLERANCE) {
            console.log(
                "colour management: the canvas read back what went in " +
                `(under ${codes(IDENTITY_TOLERANCE)}), so this display wants no transform`,
            )
            return null
        }
        console.log(
            `colour management: installed, up to ${codes(moved)} of display transform, ` +
            `${probe.size} points per axis`,
        )
        return forward
    } catch (e) {
        console.warn("colour management: probe failed, leaving the frame as drawn", e)
        return null
    }
}

/**
 * Turn the correction on or off over [chain], measuring it the first time it is asked for.
 *
 * [wanted] rather than a boolean: the measurement is async, so it is re-read at the point of use
 * and cannot install a pass the reader has since switched off.
 *
 * Off disables the filter but leaves it in the chain - [FilterChain] skips an inactive one, so
 * switching back needs no upload. Nothing is installed where [displayCorrection] resolves to null.
 */
export function applyDisplayCorrection(chain: FilterChain, wanted: () => boolean): void {
    const existing = () => chain.filters.find(f => f instanceof FilterLut3d) as FilterLut3d | undefined

    // Immediate, and without starting a probe just to find out there was nothing to stop.
    if (!wanted()) {
        const filter = existing()
        if (filter) filter.enabled = false
        return
    }

    void displayCorrection().then(lut => {
        if (!lut || !wanted()) return
        const filter = existing()
        if (filter) {
            // Both: a filter built while the setting was off is sitting here with no table.
            filter.lut = lut
            filter.enabled = true
            return
        }
        chain.filters = [...chain.filters, new FilterLut3d(lut)]
    })
}
