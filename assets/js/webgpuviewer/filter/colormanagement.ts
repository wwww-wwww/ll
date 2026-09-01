import type { FilterChain } from "./filterchain"
import { FilterLut3d } from "./filterlut3d"
import { Lut3d } from "./lut3d"

/**
 * Colour-managing the WebGPU canvas by hand, since Firefox does not.
 *
 * Firefox transforms the content it presents into the display's profile - images, CSS colours, a 2D
 * canvas - but a WebGPU canvas is handed to the compositor as-is. So on a display whose profile is
 * not sRGB the reader's frame is the one thing on screen that skipped the transform, and it does
 * not match the browser around it or the same page in another engine.
 *
 * There is no flag to ask for it. But the transform can be measured, because a path that does get
 * it will report what it did: fill a lattice of known colours onto a 2D canvas, read it straight
 * back, and the values that come back are those colours in display space - see [probeCanvas]. That
 * is the transform, sampled on a grid, which is a 3D LUT; applying it to the frame puts the WebGPU
 * canvas where every other surface on the page already is.
 *
 * Applied as an output filter, over the finished frame, rather than per page on the way in: it is
 * one fullscreen pass either way round, against a 3D LUT interpolation over every pixel of every
 * mip level on the CPU. The cost of that placement is that the tile shaders and the upscaler work
 * in the untransformed values - which is the right way round anyway, since blending and resampling
 * belong before a display transform rather than after it.
 */

/**
 * Points per axis in the probe, which is also the LUT's own resolution - the measurement is applied
 * as taken, so one number sets both.
 *
 * 65 is the conventional cube size and a 2.2MB `rgba16float` texture, at 275k one-pixel fills once.
 * The gap between entries is just under 4 code values, which the GPU's trilinear filtering covers
 * comfortably even where the transform has a gamma curve in it.
 *
 * 64 does not divide 255, so a lattice value is not generally a whole code value and the canvas
 * stores the nearest one - see [level]. That puts each grid point up to half a code value away from
 * where this LUT says it is, against a transform whose slope is around 1: an eighth of the error the
 * grid spacing itself carries, and not worth picking a size like 52 to avoid.
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
 * A UA test, since the behaviour it stands for cannot be feature-detected: what the probe measures
 * is the display transform, which every engine will report, and whether the compositor also applies
 * it to this canvas is not visible from script. Getting this wrong either way is safe in one
 * direction only - a browser that does manage its canvas would be transformed twice, so the test
 * gates the whole thing rather than the probe deciding alone.
 */
export function isFirefox(): boolean {
    return typeof navigator !== "undefined" && /\bGecko\/|\bFirefox\//.test(navigator.userAgent)
}

/**
 * The lattice rendered onto a canvas and read straight back: for each of [PROBE_SIZE]^3 known
 * colours, the value the canvas gives back for it.
 *
 * A `<canvas>` of its own, never in the document - what a readback returns does not depend on the
 * canvas being laid out or painted, and an off-document one costs no reflow. `willReadFrequently`
 * keeps it in system memory, so `getImageData` is CPU work rather than a synchronous readback
 * through the compositor.
 *
 * Laid out one row per blue slice, red fastest along x - the order [Lut3d.data] wants, so the
 * result needs no reshuffling.
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
 * [wanted] rather than a boolean: the measurement is asynchronous and the setting is a checkbox, so
 * by the time there is a LUT to install the answer may have changed. Re-read at the point of use,
 * it cannot install a pass the reader has since switched off.
 *
 * Off leaves the filter in the chain, disabled - [FilterChain] skips an inactive filter entirely,
 * so the pass costs nothing, and switching back on then needs no upload. Nothing is installed on an
 * engine that manages its own canvas, or on a display that wants no transform: [displayCorrection]
 * resolves to null and this does nothing at all.
 */
export function applyDisplayCorrection(chain: FilterChain, wanted: () => boolean): void {
    const existing = () => chain.filters.find(f => f instanceof FilterLut3d) as FilterLut3d | undefined

    // Immediate, and without waiting on a probe that may never have been asked for: the reader
    // switching this off should not start a measurement to find out there was nothing to stop.
    if (!wanted()) {
        const filter = existing()
        if (filter) filter.enabled = false
        return
    }

    void displayCorrection().then(lut => {
        if (!lut || !wanted()) return
        const filter = existing()
        if (filter) {
            // Set both: this is also the path a second chain takes, and one built while the
            // setting was off is sitting here with no table.
            filter.lut = lut
            filter.enabled = true
            return
        }
        chain.filters = [...chain.filters, new FilterLut3d(lut)]
    })
}
