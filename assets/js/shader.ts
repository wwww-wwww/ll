import Page from "./page"
import shader from "./shader_frag.wgsl"

export class Shader {
    private device: GPUDevice
    private pipeline: GPURenderPipeline

    constructor(device: GPUDevice) {
        this.device = device

        const shader_module = this.device!.createShaderModule({ code: shader })
        const log = async () => {
            const info = await shader_module.getCompilationInfo()

            for (const message of info.messages) {
                console.error(`Line ${message.lineNum}:${message.linePos} - ${message.message}`)
            }
        }
        log()

        this.pipeline = device.createRenderPipeline({
            layout: "auto",
            vertex: { module: shader_module, entryPoint: "vs_main" },
            fragment: {
                module: shader_module,
                entryPoint: "fs_main",
                targets: [{ format: "rgba8unorm" }],
            },
            primitive: { topology: "triangle-list" },
        })
    }

    async render(
        encoder: GPUCommandEncoder,
        page: Page,
        dst: GPUTexture,
        offset_x: number,
        offset_y: number,
        offset_scale: number,
    ) {
        const scale = page.scale * offset_scale

        const level = Math.min(
            Math.max(Math.floor(Math.log2(1 / scale)), 0),
            page.mipmaps.length - 1,
        )

        const x = offset_x / page.scale + page.x / dst.width
        const y = offset_y / page.scale + page.y / dst.height

        const mipmap = page.mipmaps[level]

        const vx = Math.round(((-x * page.width) / mipmap.width + 0.5) * mipmap.width)
        const vy = Math.round(((-y * page.height) / mipmap.height + 0.5) * mipmap.height)

        const quad = mipmap.getQuad(vx, vy)

        const data = new Float32Array(8)
        data[0] = (0.5 / scale + x) * mipmap.scale + (quad.x - 0.5 * mipmap.width) / dst.width
        data[1] = (0.5 / scale + y) * mipmap.scale + (quad.y - 0.5 * mipmap.height) / dst.height
        data[2] = scale / mipmap.scale
        data[3] = mipmap.tilesize
        data[4] = mipmap.tilesCols
        data[5] = mipmap.tilesRows
        data[6] = dst.width
        data[7] = dst.height
        this.device.queue.writeBuffer(page.buffer, 0, data)

        const pass = encoder.beginRenderPass({
            colorAttachments: [
                { clearValue: [0, 0, 0, 1], loadOp: "load", storeOp: "store", view: dst },
            ],
        })

        pass.setPipeline(this.pipeline)
        pass.setBindGroup(
            0,
            this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: page.buffer } as GPUBindGroupEntry].concat(
                    quad.tiles.map((val, i) => {
                        return { binding: 1 + i, resource: val }
                    }),
                ),
            }),
        )

        pass.draw(6)
        pass.end()
    }
}
