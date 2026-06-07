const srgbToLinearLUT = new Float32Array(256)
let lutInitialized = false

function initSRGBToLinearLUT(): void {
    if (lutInitialized) return

    for (let i = 0; i < 256; i++) {
        const val01 = i / 255.0
        srgbToLinearLUT[i] = val01 <= 0.04045
            ? val01 / 12.92
            : Math.pow((val01 + 0.055) / 1.055, 2.4)
    }

    lutInitialized = true
}

function linearToSRGBExact(linearVal: number): number {
    const srgb01 = linearVal <= 0.0031308
        ? linearVal * 12.92
        : 1.055 * Math.pow(linearVal, 1.0 / 2.4) - 0.055

    return Math.max(0, Math.min(255, Math.round(srgb01 * 255.0)))
}

export function downsample(
    im: HTMLImageElement | ImageBitmap,
    width: number,
    height: number,
): HTMLCanvasElement {
    initSRGBToLinearLUT()

    const srcWidth = "naturalHeight" in im ? im.naturalWidth : im.width
    const srcHeight = "naturalHeight" in im ? im.naturalHeight : im.height

    if (srcWidth === 0 || srcHeight === 0) {
        throw new Error("Source image dimensions are 0. Ensure the image is fully loaded.")
    }

    const srcCanvas = document.createElement("canvas")
    srcCanvas.width = srcWidth
    srcCanvas.height = srcHeight
    const srcCtx = srcCanvas.getContext("2d")
    if (!srcCtx) {
        throw new Error("Could not acquire 2D context for the source canvas.")
    }
    srcCtx.drawImage(im, 0, 0)
    const srcImageData = srcCtx.getImageData(0, 0, srcWidth, srcHeight)
    const srcData = srcImageData.data

    const dstCanvas = document.createElement("canvas")
    dstCanvas.width = width
    dstCanvas.height = height
    const dstCtx = dstCanvas.getContext("2d")
    if (!dstCtx) {
        throw new Error("Could not acquire 2D context for the destination canvas.")
    }
    const dstImageData = dstCtx.createImageData(width, height)
    const dstData = dstImageData.data

    const scaleX = srcWidth / width
    const scaleY = srcHeight / height
    const xWeights = new Float32Array(srcWidth)

    const lutSrgbToLinear = srgbToLinearLUT

    for (let y = 0; y < height; ++y) {
        const srcYStart = y * scaleY
        const srcYEnd = srcYStart + scaleY
        const yMin = Math.max(0, Math.floor(srcYStart))
        const yMax = Math.min(srcHeight - 1, Math.floor(srcYEnd))

        for (let x = 0; x < width; ++x) {
            const srcXStart = x * scaleX
            const srcXEnd = srcXStart + scaleX
            const xMin = Math.max(0, Math.floor(srcXStart))
            const xMax = Math.min(srcWidth - 1, Math.floor(srcXEnd))

            let sumA = 0.0
            let sumR = 0.0
            let sumG = 0.0
            let sumB = 0.0
            let totalWeight = 0.0

            const numXPixels = xMax - xMin + 1

            for (let i = 0; i < numXPixels; ++i) {
                const sx = xMin + i
                const xWeight = Math.min(sx + 1.0, srcXEnd) - Math.max(sx, srcXStart)
                xWeights[i] = xWeight > 0 ? xWeight : 0.0
            }

            for (let sy = yMin; sy <= yMax; ++sy) {
                const yWeight = Math.min(sy + 1.0, srcYEnd) - Math.max(sy, srcYStart)
                if (yWeight <= 0) continue

                const srcRowOffset = sy * srcWidth

                for (let sx = xMin; sx <= xMax; ++sx) {
                    const cacheIdx = sx - xMin
                    const pWeight = xWeights[cacheIdx] * yWeight
                    if (pWeight <= 0.0) continue

                    const srcIdx = (srcRowOffset + sx) * 4
                    const r = srcData[srcIdx]
                    const g = srcData[srcIdx + 1]
                    const b = srcData[srcIdx + 2]
                    const a = srcData[srcIdx + 3]

                    sumA += a * 0.00392156862 * pWeight
                    sumR += lutSrgbToLinear[r] * pWeight
                    sumG += lutSrgbToLinear[g] * pWeight
                    sumB += lutSrgbToLinear[b] * pWeight

                    totalWeight += pWeight
                }
            }

            let finalA = 0
            let finalR = 0
            let finalG = 0
            let finalB = 0

            if (totalWeight > 0.0) {
                const invWeight = 1.0 / totalWeight
                finalA = Math.max(0, Math.min(255, Math.round(sumA * invWeight * 255.0)))

                finalR = linearToSRGBExact(sumR * invWeight)
                finalG = linearToSRGBExact(sumG * invWeight)
                finalB = linearToSRGBExact(sumB * invWeight)
            }

            const dstIdx = (y * width + x) * 4
            dstData[dstIdx] = finalR
            dstData[dstIdx + 1] = finalG
            dstData[dstIdx + 2] = finalB
            dstData[dstIdx + 3] = finalA
        }
    }

    dstCtx.putImageData(dstImageData, 0, 0)
    return dstCanvas
}

export default downsample
