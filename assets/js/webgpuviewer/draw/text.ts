import { colorToFloats } from "../util"
import { WebGpuRenderer } from "../renderer/renderer"

/**
 * Text drawing - the role of `draw/Text.kt`, by a different route.
 *
 * The Kotlin builds a glyph atlas by hand: measure each glyph through `Typeface`, pack it, upload
 * it, then assemble runs from the atlas - about a thousand lines, because Android hands it glyph
 * outlines and nothing else. The browser already has a text engine with shaping, fallback fonts
 * and subpixel positioning, so the whole atlas collapses into "rasterise the run on a 2D canvas
 * and upload that". Wrapping and alignment come from `measureText` for the same reason.
 *
 * Rasters are cached by their full appearance, so a label redrawn every frame (a progress
 * readout, a chapter name) uploads once. Straight-alpha out of the canvas, premultiplied in the
 * shader to match what everything else in the pass produces.
 */

export type TextAlign = "left" | "center" | "right"

export interface TextOptions {
    align?: TextAlign
    maxWidth?: number
    /** A CSS font shorthand tail - family, weight, style. The size comes from `size`. */
    fontFamily?: string
    weight?: number | string
    style?: "normal" | "italic"
    lineHeight?: number
}

const TEXT_SHADER = `
struct Params {
    rect: vec4<f32>,
    color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var src_tex: texture_2d<f32>;
@group(0) @binding(2) var src_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0)
    );

    let uv = corners[vertex_index];
    let x = mix(params.rect.x, params.rect.z, uv.x);
    let y = mix(params.rect.y, params.rect.w, uv.y);

    var out: VertexOutput;
    out.position = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
    out.uv = uv;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // The raster is a coverage mask in its own alpha; the colour comes from the uniform, so one
    // cached raster serves every colour it is ever drawn in.
    let coverage = textureSample(src_tex, src_sampler, in.uv).a;
    let alpha = params.color.a * coverage;
    return vec4<f32>(params.color.rgb * alpha, alpha);
}
`

function device(): GPUDevice {
    return WebGpuRenderer.device
}

let pipeline: GPURenderPipeline | null = null
let stencilPipeline: GPURenderPipeline | null = null
let sampler: GPUSampler | null = null

function buildPipeline(depthStencil?: GPUDepthStencilState): GPURenderPipeline {
    const module = device().createShaderModule({ code: TEXT_SHADER })
    return device().createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs_main" },
        fragment: {
            module,
            entryPoint: "fs_main",
            targets: [
                {
                    format: "rgba8unorm",
                    // Premultiplied out of the shader, so One rather than SrcAlpha.
                    blend: {
                        color: {
                            srcFactor: "one",
                            dstFactor: "one-minus-src-alpha",
                            operation: "add",
                        },
                        alpha: {
                            srcFactor: "one",
                            dstFactor: "one-minus-src-alpha",
                            operation: "add",
                        },
                    },
                },
            ],
        },
        primitive: { topology: "triangle-list" },
        ...(depthStencil ? { depthStencil } : {}),
    })
}

function getPipeline(masked: boolean): GPURenderPipeline {
    if (masked) {
        if (!stencilPipeline) {
            stencilPipeline = buildPipeline({
                format: "stencil8",
                depthWriteEnabled: false,
                depthCompare: "always",
            })
        }
        return stencilPipeline
    }
    if (!pipeline) pipeline = buildPipeline()
    return pipeline
}

function getSampler(): GPUSampler {
    if (!sampler) {
        sampler = device().createSampler({ magFilter: "linear", minFilter: "linear" })
    }
    return sampler
}

interface Raster {
    texture: GPUTexture
    view: GPUTextureView
    width: number
    height: number
    /** Distance from the raster's top edge to the first line's baseline. */
    baseline: number
}

/** Rasters are keyed by everything that changes their pixels - not by colour, which is a uniform. */
const rasters = new Map<string, Raster>()
const RASTER_CACHE_LIMIT = 64

let measureContext: OffscreenCanvasRenderingContext2D | null = null

function measurer(): OffscreenCanvasRenderingContext2D {
    if (!measureContext) {
        const ctx = new OffscreenCanvas(1, 1).getContext("2d")
        if (!ctx) throw new Error("could not acquire a 2D context to measure text")
        measureContext = ctx
    }
    return measureContext
}

function cssFont(size: number, options: TextOptions): string {
    const style = options.style ?? "normal"
    const weight = options.weight ?? 400
    const family = options.fontFamily ?? "system-ui, sans-serif"
    return `${style} ${weight} ${size}px ${family}`
}

/** Break [text] into lines, honouring existing newlines and wrapping to [maxWidth]. */
function layout(
    ctx: OffscreenCanvasRenderingContext2D,
    text: string,
    maxWidth: number,
): string[] {
    const lines: string[] = []

    for (const paragraph of text.split("\n")) {
        if (!Number.isFinite(maxWidth) || ctx.measureText(paragraph).width <= maxWidth) {
            lines.push(paragraph)
            continue
        }

        let line = ""
        for (const word of paragraph.split(/(\s+)/)) {
            const candidate = line + word
            if (line !== "" && ctx.measureText(candidate).width > maxWidth) {
                lines.push(line.trimEnd())
                // A single word longer than the line still has to go somewhere: it starts a line
                // of its own and overflows, rather than being dropped or split mid-glyph.
                line = word.trimStart()
            } else {
                line = candidate
            }
        }
        if (line !== "") lines.push(line.trimEnd())
    }

    return lines.length > 0 ? lines : [""]
}

function rasterise(text: string, size: number, options: TextOptions): Raster {
    const align = options.align ?? "left"
    const maxWidth = options.maxWidth ?? Number.POSITIVE_INFINITY
    const lineHeight = options.lineHeight ?? 1.25
    const font = cssFont(size, options)

    const key = `${font}|${align}|${maxWidth}|${lineHeight}|${text}`
    const cached = rasters.get(key)
    if (cached) {
        // Re-insert so the eviction below drops the genuinely coldest raster.
        rasters.delete(key)
        rasters.set(key, cached)
        return cached
    }

    const measure = measurer()
    measure.font = font
    const lines = layout(measure, text, maxWidth)

    const metrics = measure.measureText("Mg")
    const ascent = metrics.fontBoundingBoxAscent || size * 0.8
    const descent = metrics.fontBoundingBoxDescent || size * 0.2
    const step = size * lineHeight

    const width = Math.max(1, Math.ceil(Math.max(...lines.map(l => measure.measureText(l).width))))
    const height = Math.max(1, Math.ceil(ascent + descent + step * (lines.length - 1)))

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("could not acquire a 2D context to draw text")
    ctx.font = font
    ctx.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left"
    ctx.textBaseline = "alphabetic"
    // White, so the raster is pure coverage in its alpha and the shader can tint it.
    ctx.fillStyle = "#ffffff"

    const originX = align === "center" ? width / 2 : align === "right" ? width : 0
    lines.forEach((line, i) => ctx.fillText(line, originX, ascent + step * i))

    const texture = device().createTexture({
        size: { width, height },
        format: "rgba8unorm",
        usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device().queue.copyExternalImageToTexture(
        { source: canvas },
        { texture, premultipliedAlpha: true },
        { width, height },
    )

    const raster: Raster = { texture, view: texture.createView(), width, height, baseline: ascent }

    if (rasters.size >= RASTER_CACHE_LIMIT) {
        const coldest = rasters.keys().next()
        if (!coldest.done) {
            rasters.get(coldest.value)?.texture.destroy()
            rasters.delete(coldest.value)
        }
    }
    rasters.set(key, raster)
    return raster
}

const scratch = new Float32Array(8)

/**
 * Draw [text] into [pass], centred vertically on [y] and placed horizontally at [x] per [align].
 * Coordinates and [size] are in [dst]'s pixels, matching the render pass's own space.
 *
 * [masked] picks the twin valid inside a stencil-attached pass; the default is off, since a page
 * that draws its own content opens a pass without one.
 */
export function drawText(
    pass: GPURenderPassEncoder,
    dst: GPUTexture,
    text: string,
    x: number,
    y: number,
    size: number,
    color: number,
    options: TextOptions = {},
    masked: boolean = false,
) {
    if (text === "") return

    const raster = rasterise(text, size, options)
    const align = options.align ?? "left"

    const left =
        align === "center" ? x - raster.width / 2
            : align === "right" ? x - raster.width
                : x
    const top = y - raster.height / 2

    const [r, g, b, a] = colorToFloats(color)
    scratch.set([
        left / dst.width,
        top / dst.height,
        (left + raster.width) / dst.width,
        (top + raster.height) / dst.height,
        r,
        g,
        b,
        a,
    ])

    const uniform = device().createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    device().queue.writeBuffer(uniform, 0, scratch)

    const built = getPipeline(masked)
    pass.setPipeline(built)
    pass.setBindGroup(
        0,
        device().createBindGroup({
            layout: built.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniform } },
                { binding: 1, resource: raster.view },
                { binding: 2, resource: getSampler() },
            ],
        }),
    )
    pass.draw(6)
}

/** Drop every cached raster - for a theme or font change, which invalidates all of them. */
export function clearTextCache() {
    rasters.forEach(raster => raster.texture.destroy())
    rasters.clear()
}
