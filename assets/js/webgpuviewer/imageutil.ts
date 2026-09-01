/**
 * Port of `cpp/resize.cpp` - the half-size box filter each mipmap level is built with.
 *
 * The C++ works through `uint32_t` pixels and the NEON path unrolls by four; neither survives
 * the trip usefully, so this is the scalar path over the bytes directly. That is not a change of
 * behaviour: every channel gets the same treatment, so reading byte 0 as red rather than blue
 * lands on the same numbers.
 *
 * Filtering is in linear light and alpha-weighted: colour is premultiplied on the way in, divided
 * back out at the end, so a transparent neighbour cannot drag a colour toward black. Pixel layout
 * is RGBA8, row-major, tightly packed - what `copyExternalImageToTexture` and `rgba8unorm` want.
 */

const srgbToLinearLUT = new Float32Array(256)

for (let i = 0; i < 256; i++) {
    const val01 = i / 255
    srgbToLinearLUT[i] = val01 <= 0.04045 ? val01 / 12.92 : Math.pow((val01 + 0.055) / 1.055, 2.4)
}

function linearToSRGBExact(linearVal: number): number {
    if (linearVal <= 0) return 0
    if (linearVal >= 1) return 255
    const srgb01 =
        linearVal <= 0.0031308 ? linearVal * 12.92 : 1.055 * Math.pow(linearVal, 1 / 2.4) - 0.055
    return Math.round(srgb01 * 255)
}

function exactLinearToAlpha(linearAlpha: number): number {
    if (linearAlpha <= 0) return 0
    if (linearAlpha >= 1) return 255
    return Math.round(linearAlpha * 255)
}

/**
 * Halve [source] (RGBA8, [width] x [height]) with an area filter, returning the new pixels.
 *
 * The destination is `floor(width / 2)` x `floor(height / 2)`, matching `ImageUtil.resize`'s
 * allocation - the caller derives the same dimensions for the mip level it is building.
 */
export function resize(source: Uint8Array, width: number, height: number): Uint8Array {
    const dstWidth = Math.floor(width / 2)
    const dstHeight = Math.floor(height / 2)
    if (dstWidth <= 0 || dstHeight <= 0) return new Uint8Array(0)

    const dst = new Uint8Array(dstWidth * dstHeight * 4)

    const scaleX = width / dstWidth
    const scaleY = height / dstHeight

    // The C++ caches at most 256 x-weights per destination pixel; a 2x reduction never needs more
    // than three, so the cap is academic - sized to the real span here instead.
    const xWeights = new Float32Array(Math.ceil(scaleX) + 2)

    for (let y = 0; y < dstHeight; ++y) {
        const srcYStart = y * scaleY
        const srcYEnd = srcYStart + scaleY
        const yMin = Math.max(0, Math.floor(srcYStart))
        const yMax = Math.min(height - 1, Math.floor(srcYEnd))

        for (let x = 0; x < dstWidth; ++x) {
            const srcXStart = x * scaleX
            const srcXEnd = srcXStart + scaleX
            const xMin = Math.max(0, Math.floor(srcXStart))
            const xMax = Math.min(width - 1, Math.floor(srcXEnd))

            const numXPixels = xMax - xMin + 1
            for (let i = 0; i < numXPixels; ++i) {
                const sx = xMin + i
                const w = Math.min(sx + 1, srcXEnd) - Math.max(sx, srcXStart)
                xWeights[i] = w > 0 ? w : 0
            }

            let sumA = 0
            let sumR = 0
            let sumG = 0
            let sumB = 0
            let totalWeight = 0

            for (let sy = yMin; sy <= yMax; ++sy) {
                const yWeight = Math.min(sy + 1, srcYEnd) - Math.max(sy, srcYStart)
                if (yWeight <= 0) continue

                const srcRowOffset = sy * width

                for (let sx = xMin; sx <= xMax; ++sx) {
                    const pWeight = xWeights[sx - xMin] * yWeight
                    if (pWeight <= 0) continue

                    const idx = (srcRowOffset + sx) * 4
                    const aVal = source[idx + 3] / 255

                    sumA += aVal * pWeight
                    sumR += srgbToLinearLUT[source[idx]] * aVal * pWeight
                    sumG += srgbToLinearLUT[source[idx + 1]] * aVal * pWeight
                    sumB += srgbToLinearLUT[source[idx + 2]] * aVal * pWeight

                    totalWeight += pWeight
                }
            }

            const dstIdx = (y * dstWidth + x) * 4
            if (totalWeight <= 0) continue

            const invWeight = 1 / totalWeight
            const finalLinearA = sumA * invWeight
            let finalLinearR = sumR * invWeight
            let finalLinearG = sumG * invWeight
            let finalLinearB = sumB * invWeight

            if (finalLinearA > 0.00001) {
                const invAlpha = 1 / finalLinearA
                finalLinearR = Math.min(1, finalLinearR * invAlpha)
                finalLinearG = Math.min(1, finalLinearG * invAlpha)
                finalLinearB = Math.min(1, finalLinearB * invAlpha)
            } else {
                finalLinearR = 0
                finalLinearG = 0
                finalLinearB = 0
            }

            dst[dstIdx] = linearToSRGBExact(finalLinearR)
            dst[dstIdx + 1] = linearToSRGBExact(finalLinearG)
            dst[dstIdx + 2] = linearToSRGBExact(finalLinearB)
            dst[dstIdx + 3] = exactLinearToAlpha(finalLinearA)
        }
    }

    return dst
}

/**
 * Decoded RGBA8 bytes for [source], via a 2D canvas.
 *
 * The Kotlin gets these straight from the decoder; the browser only hands out pixels through a
 * canvas, so this is the one extra step the web needs. `willReadFrequently` is deliberately off -
 * this reads once per image, and the flag would push the canvas onto a slower software path.
 */
export function decodeToPixels(
    source: ImageBitmap | HTMLImageElement | HTMLCanvasElement | VideoFrame,
    width: number,
    height: number,
): Uint8Array {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("could not acquire a 2D context to decode image pixels")
    ctx.drawImage(source as CanvasImageSource, 0, 0)
    return new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer)
}
