/**
 * A cubic colour lookup table - the port of `filter/Lut3d.kt`.
 *
 * [size]^3 RGB triples in [data], red varying fastest, then green, then blue: the layout a 3D
 * texture wants, with red on x.
 *
 * Values are the mapped output for that input colour, normally in 0..1 but not clamped - a LUT that
 * overshoots keeps its overshoot until [FilterLut3d] writes an 8-bit frame.
 */
export class Lut3d {
    constructor(
        readonly size: number,
        readonly data: Float32Array,
        readonly limitedRange = false,
    ) {
        if (size < 2) throw new Error(`LUT size ${size}`)
        if (data.length !== size * size * size * 3) {
            throw new Error(`LUT data ${data.length} for size ${size}`)
        }
    }

    /**
     * Points per axis [parseMadVr] will build. 128^3 is already 25MB of floats and 16MB on the GPU;
     * the file's own 256 would be eight times that.
     */
    static readonly MAX_SIZE = 128

    /** The LUT that changes nothing. Red varies fastest, as [data] requires. */
    static identity(size = 2): Lut3d {
        const data = new Float32Array(size * size * size * 3)
        const last = size - 1
        let i = 0
        for (let b = 0; b < size; b++) {
            for (let g = 0; g < size; g++) {
                for (let r = 0; r < size; r++) {
                    data[i++] = r / last
                    data[i++] = g / last
                    data[i++] = b / last
                }
            }
        }
        return new Lut3d(size, data)
    }

    /**
     * An Adobe/IRIDAS `.cube` 3D LUT. 1D cubes (`LUT_1D_SIZE`) are not 3D LUTs and are rejected;
     * `DOMAIN_MIN`/`DOMAIN_MAX` are honoured by rescaling into 0..1.
     */
    static parseCube(text: string): Lut3d {
        let size = 0
        const domainMin = [0, 0, 0]
        const domainMax = [1, 1, 1]
        let data: Float32Array | null = null
        let count = 0

        for (const raw of text.split("\n")) {
            const hash = raw.indexOf("#")
            const line = (hash < 0 ? raw : raw.slice(0, hash)).trim()
            if (line.length === 0) continue

            // A value line starts with a number - anything else is a keyword, which lets the hot
            // path skip the case fold and the keyword compares entirely.
            const first = line[0]
            if ((first >= "0" && first <= "9") || first === "-" || first === "+" || first === ".") {
                if (!data) throw new Error("LUT_3D_SIZE missing")
                if (count + 3 > data.length) throw new Error("cube too long")
                const parts = line.split(/\s+/)
                if (parts.length < 3) throw new Error(`cube value line: ${line}`)
                for (let c = 0; c < 3; c++) {
                    const span = domainMax[c] - domainMin[c]
                    const v = Number(parts[c])
                    if (!Number.isFinite(v)) throw new Error(`cube value line: ${line}`)
                    data[count + c] = span !== 0 ? (v - domainMin[c]) / span : v
                }
                count += 3
                continue
            }

            const parts = line.split(/\s+/)
            switch (parts[0].toUpperCase()) {
                case "LUT_1D_SIZE":
                    throw new Error("1D cube, not a 3D LUT")
                case "LUT_3D_SIZE": {
                    size = Number(parts[1])
                    if (!(size >= 2 && size <= Lut3d.MAX_SIZE)) {
                        throw new Error(`LUT_3D_SIZE ${parts[1]}`)
                    }
                    data = new Float32Array(size * size * size * 3)
                    break
                }
                case "DOMAIN_MIN":
                    for (let c = 0; c < 3; c++) domainMin[c] = Number(parts[c + 1])
                    break
                case "DOMAIN_MAX":
                    for (let c = 0; c < 3; c++) domainMax[c] = Number(parts[c + 1])
                    break
                default:
                    break // TITLE, and anything else this doesn't need
            }
        }

        if (!data) throw new Error("LUT_3D_SIZE missing")
        if (count !== data.length) throw new Error(`cube has ${count} of ${data.length} values`)
        // .cube entries run red fastest, the same order as [data].
        return new Lut3d(size, data)
    }

    /**
     * A madVR `.3dlut`: a 16KB header, then 256^3 entries of three little-endian 16-bit samples in
     * B, G, R order, blue varying fastest, over TV-level input and output.
     *
     * Resampled to [size]^3 rather than kept at the file's own 256 points, which would be 200MB of
     * floats. 64 is visually indistinguishable for the smooth tables madVR writes.
     *
     * Takes the whole buffer rather than the Kotlin's stream: a fetch hands over an `ArrayBuffer`
     * already, and there is no way to skip forward through one without having it.
     */
    static parseMadVr(buffer: ArrayBuffer, size = 64): Lut3d {
        if (!(size >= 2 && size <= Lut3d.MAX_SIZE)) {
            throw new Error(`madVR LUT size ${size} (limit ${Lut3d.MAX_SIZE})`)
        }

        const HEADER = 16384
        const FULL = 256
        const needed = HEADER + FULL * FULL * FULL * 6
        if (buffer.byteLength < needed) throw new Error("madVR LUT ends early")

        const samples = new DataView(buffer, HEADER)
        const data = new Float32Array(size * size * size * 3)

        /** Nearest full-resolution index for step [i] of a [size]-point axis. */
        const axis = (i: number) =>
            size === FULL ? i : Math.trunc((i * (FULL - 1) + (size - 1) / 2) / (size - 1))

        /** One 16-bit TV-level sample as 0..1 full range. */
        const sample = (at: number) => (samples.getUint16(at, true) - 4096) / 56064

        for (let r = 0; r < size; r++) {
            const fileR = axis(r)
            for (let g = 0; g < size; g++) {
                const rowStart = (fileR * FULL + axis(g)) * FULL * 6
                for (let b = 0; b < size; b++) {
                    const at = rowStart + axis(b) * 6
                    const i = ((b * size + g) * size + r) * 3
                    data[i] = sample(at + 4)
                    data[i + 1] = sample(at + 2)
                    data[i + 2] = sample(at)
                }
            }
        }
        return new Lut3d(size, data, true)
    }
}
