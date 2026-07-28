import { Mipmap } from "./mipmap"
import { Viewer } from "./viewer"

export default class Page {
    renderer: Viewer
    width: number = 1
    height: number = 1

    x: number = 0
    y: number = 0
    scale: number = 1

    get fit_scale(): number | null {
        if (!this.ready) { return null; }

        const ratiox = this.renderer.context.canvas.width / this.width
        const ratioy = this.renderer.context.canvas.height / this.height

        return Math.min(ratiox, ratioy)
    }

    mipmaps: Mipmap[] = []

    buffer!: GPUBuffer
    ready = false
    promise = Promise.withResolvers<boolean>()

    constructor(renderer: Renderer, image: HTMLImageElement) {
        this.renderer = renderer

        this.buffer = renderer.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })

        image.decode().then(() => {
            this.width = image.width
            this.height = image.height

            // this.scale = this.fit_scale

            const tilesize = 4096

            // TODO: create mipmaps
            const maxWidth = 1024
            const maxHeight = 1024

            this.mipmaps.push(new Mipmap(renderer.device, image, 1, tilesize))
            this.promise.resolve(true)
            this.ready = true
            renderer.invalidate()
        })
    }

    destroy() {
        this.mipmaps.forEach(mipmap => mipmap.destroy())
        this.buffer.destroy()
    }
}
