import { ARTCNN_PASSES } from "./artcnn/passes"
import { Fullscreen } from "./fullscreen"
import { Upscaler } from "./rescaler"
import { CATMULL_ROM_CODE } from "./upscalercatmullrom"

const LABEL = "ArtCNN"

/** Matches `@workgroup_size(8, 8)` in every pass - see [UpscalerArtCnn] for why 8. */
const WORKGROUP = 8

/**
 * Input pixels of surrounding page one output pixel reads: seven 3x3 convolutions plus the final
 * pass's chroma tap, so 8 per run.
 *
 * Chained, run 1 needs 8 of its own input pixels, which are run 0's output - 4 of run 0's input.
 * The series 8 + 4 + 2 + ... converges below 16, so 16 covers any number of runs, and one figure
 * beats reasoning about the fraction each time. It costs a few first-step pixels either side.
 */
const HALO = 16

/**
 * Ceiling on doublings. 16x is already past the point where a page has anything left to
 * reconstruct, and the intermediates grow fourfold per run.
 */
const MAX_RUNS = 4

function groupsFor(size: number): number {
    return Math.ceil(size / WORKGROUP)
}

/** True when a tile of [tileSize] can carry [runs] of them - see [UpscalerArtCnn.fits]. */
function carries(tileSize: number, runs: number): boolean {
    const factor = 2 ** runs
    // The first step resolves a whole number of pixels, and the tile's own content is worth at
    // least as much of the square as the padding around it.
    return tileSize % factor === 0 && tileSize / factor >= 2 * HALO
}

/** One dispatch, with the bindings it never changes. */
interface Pass {
    readonly pipeline: GPUComputePipeline
    readonly bindGroup: GPUBindGroup
    readonly groups: number
}

/**
 * ArtCNN C4F16 - the port of `renderer/UpscalerArtCnn.kt`. A small convolutional network that
 * doubles resolution, run over each high-quality tile. See [Rescaler] for how it fits.
 *
 * Nine compute passes, in `artcnn/passes.ts`. Luma only: pass 1 converts to YCbCr, passes 2-8
 * convolve Y (16 channels, packed four RGBA texels per pixel in a double-sized feature map), pass
 * 9 recombines it with pass 1's chroma. Not reconstructing chroma is what makes a network this
 * small affordable.
 *
 * Run as many times as the zoom asks for, rather than once - see [plan]. Each run's output is RGB
 * at twice the resolution, which is exactly what the next run's first pass wants, so the chain is
 * the same nine passes again against the previous run's result. Catmull-Rom still covers whatever
 * is left over below the next whole doubling.
 *
 * At 8x8 workgroups, not the 16x16 upstream ArtCNN ships: at 16x16 the shared tile is 4*18*18
 * vec4s, 20736 bytes, over the 16384-byte default `maxComputeWorkgroupStorageSize`, so the
 * pipelines would not build. At 8x8 it is 4*10*10, 6400 bytes.
 *
 * Bindings hold for every tile while the tile size and the number of runs do, so a tile costs nine
 * `dispatchWorkgroups` calls per run in one compute pass and nothing else.
 *
 * Alpha passes through, and the colour converted is premultiplied - exact for the opaque content
 * this is for, approximate where a page is genuinely translucent.
 */
export class UpscalerArtCnn extends Upscaler {
    override get code(): string {
        return CATMULL_ROM_CODE
    }

    private runs = 1

    /**
     * 2 to the number of runs. Never 1, whatever [plan] settled on, so [TileRenderer]'s reading of
     * whether tiles are staged at all does not swing with the zoom - a tile with nothing to give
     * declines through [appliesAt] and [fits] instead.
     */
    override get factor(): number {
        return 2 ** this.runs
    }

    override get halo(): number {
        return HALO
    }

    /**
     * As many doublings as the zoom asks for, then as many as the tile can carry. Floors at one so
     * [factor] holds still; the inherited [appliesAt] declines a tile below 2x either way.
     */
    override plan(scale: number, tileSize: number) {
        let want = 0
        while (want < MAX_RUNS && 2 ** (want + 1) <= scale) want++
        let runs = Math.max(want, 1)
        while (runs > 1 && !carries(tileSize, runs)) runs--
        this.runs = runs
    }

    override fits(tileSize: number): boolean {
        return carries(tileSize, this.runs)
    }

    override get supported(): boolean {
        return !this.failed
    }

    private failed = false
    private textures: Textures | null = null
    private built: GPUComputePipeline[] | null = null
    private samplerOrNull: GPUSampler | null = null
    // One per crop distance, which is factor * halo - so one per number of runs, at most MAX_RUNS.
    private readonly resolvePipelines = new Map<number, GPURenderPipeline>()

    override get inputView(): GPUTextureView | null {
        return this.textures?.inputView ?? null
    }

    override input(size: number): GPUTexture | null {
        if (this.failed) return null
        try {
            // Not in [encode]: this is the last point the tile path can still change its mind, so
            // a device that cannot build them falls back instead of committing a blank tile.
            const built = this.pipelines()
            let current = this.textures
            if (!current || current.size !== size || current.runs !== this.runs) {
                current?.destroy()
                current = new Textures(this.device, this, size, this.runs, built)
                this.textures = current
            }
            return current.input
        } catch (e) {
            this.fail(e)
            return null
        }
    }

    override encode(encoder: GPUCommandEncoder, _size: number) {
        const t = this.textures
        if (!t || this.failed) return
        try {
            // One pass for every run's dispatches: WebGPU orders dispatches within a pass and
            // inserts the barriers, and a begin/end pair per pass is real work on a tiler.
            const compute = encoder.beginComputePass({ label: LABEL })
            try {
                for (const p of t.passes) {
                    compute.setPipeline(p.pipeline)
                    compute.setBindGroup(0, p.bindGroup)
                    compute.dispatchWorkgroups(p.groups, p.groups)
                }
            } finally {
                compute.end()
            }
        } catch (e) {
            this.fail(e)
        }
    }

    override resolve(pass: GPURenderPassEncoder) {
        const t = this.textures
        if (!t || this.failed) return
        try {
            pass.setPipeline(this.resolvePipeline(t.runs))
            pass.setBindGroup(0, t.resolveGroup)
            pass.draw(3)
        } catch (e) {
            this.fail(e)
        }
    }

    override cleanup() {
        this.textures?.destroy()
        this.textures = null
    }

    /** Give up for good - the tile path reads [supported] and goes back to Catmull-Rom. */
    private fail(e: unknown) {
        if (this.failed) return
        this.failed = true
        console.warn("ArtCNN unavailable, falling back to Catmull-Rom", e)
        this.cleanup()
    }

    private pipelines(): GPUComputePipeline[] {
        if (this.built) return this.built
        const device = this.device
        const built = ARTCNN_PASSES.map(([name, code]) =>
            device.createComputePipeline({
                label: `${LABEL} ${name}`,
                layout: "auto",
                compute: {
                    module: device.createShaderModule({ label: name, code }),
                    entryPoint: "main",
                },
            }),
        )
        this.built = built
        return built
    }

    /** Pass 9's chroma tap, the one filtered read in the network. */
    get sampler(): GPUSampler {
        if (!this.samplerOrNull) {
            this.samplerOrNull = this.device.createSampler({
                label: LABEL,
                magFilter: "linear",
                minFilter: "linear",
            })
        }
        return this.samplerOrNull
    }

    /**
     * Cuts the halo back off. It is [HALO] first-step pixels, so 2^[runs] * [HALO] of the result -
     * which is why there is one of these per number of runs. A render pass, not a copy: the
     * network works in `rgba16float` and the tile atlas is 8-bit.
     */
    resolvePipeline(runs: number): GPURenderPipeline {
        let found = this.resolvePipelines.get(runs)
        if (!found) {
            found = Fullscreen.buildPipeline(
                `
@group(0) @binding(0) var src: texture_2d<f32>;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return textureLoad(src, vec2<i32>(in.position.xy) + ${2 ** runs * HALO}, 0);
}
`,
                "rgba8unorm",
                `${LABEL} resolve x${2 ** runs}`,
            )
            this.resolvePipelines.set(runs, found)
        }
        return found
    }
}

/**
 * The intermediates for one tile size and run count, and the bind groups over them. Rebuilt only
 * when either changes - [TileRenderer] holds the tile size still while a staged rescaler runs, and
 * the run count only moves when the zoom crosses a power of two.
 */
class Textures {
    /** What the first step draws into: 8-bit, since that is what it reads from. */
    readonly input: GPUTexture
    readonly inputView: GPUTextureView
    readonly passes: readonly Pass[]
    readonly resolveGroup: GPUBindGroup

    private readonly features: GPUTexture[] = []

    constructor(
        device: GPUDevice,
        owner: UpscalerArtCnn,
        readonly size: number,
        readonly runs: number,
        built: readonly GPUComputePipeline[],
    ) {
        this.input = device.createTexture({
            label: `${LABEL} input`,
            size: [size, size],
            format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
        this.inputView = this.input.createView()

        const feature = (side: number): GPUTextureView => {
            const tex = device.createTexture({
                label: `${LABEL} feature`,
                size: [side, side],
                format: "rgba16float",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            })
            this.features.push(tex)
            return tex.createView()
        }

        const bind = (
            pipeline: GPUComputePipeline,
            groups: number,
            ...bindings: (GPUTextureView | GPUSampler)[]
        ): Pass => ({
            pipeline,
            bindGroup: device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                label: LABEL,
                entries: bindings.map((resource, binding) => ({ binding, resource })),
            }),
            groups,
        })

        const passes: Pass[] = []
        // Each run's own resolution, the previous run's output being this one's input: pass 9
        // writes RGB at twice the input, which is what pass 1 reads.
        let src = this.inputView
        let side = size
        for (let run = 0; run < runs; run++) {
            // Feature maps pack four texels per input pixel, so they are double-sized; every pass
            // but the last runs one invocation per *input* pixel.
            const outer = side * 2
            const yuv = feature(side)
            const luma = feature(side)
            const f0 = feature(outer)
            const f1 = feature(outer)
            const f2 = feature(outer)

            const inner = groupsFor(side)
            const whole = groupsFor(outer)
            passes.push(
                bind(built[0], inner, src, yuv),
                bind(built[1], inner, yuv, f0),
                bind(built[2], inner, f0, f1),
                bind(built[3], inner, f1, f2),
                bind(built[4], inner, f2, f1),
                bind(built[5], inner, f1, f2),
                bind(built[6], inner, f2, f1),
                // Skip connection: conv2d_6 adds pass 2's output back in.
                bind(built[7], inner, f1, f0, luma),
                // Writes over f1, which nothing reads again this run.
                bind(built[8], whole, yuv, luma, f1, owner.sampler),
            )

            src = f1
            side = outer
        }
        this.passes = passes

        this.resolveGroup = device.createBindGroup({
            layout: owner.resolvePipeline(runs).getBindGroupLayout(0),
            label: LABEL,
            entries: [{ binding: 0, resource: src }],
        })
    }

    destroy() {
        this.input.destroy()
        for (const tex of this.features) tex.destroy()
    }
}
