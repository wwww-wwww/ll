import Image from "./image"
import { Shader } from "./shader"
import { Viewer } from "./viewer"

export default class Page {
    viewer: Viewer

    images: (Image | null)[]

    constructor(viewer: Viewer, images: (Image | null)[]) {
        this.viewer = viewer
        this.images = images
    }

    get width(): number {
        return this.images
            .filter(p => p != null)
            .map(p => p.width)
            .reduce((acc, val) => acc + val, 0)
    }

    get height(): number {
        return Math.max(...this.images.filter(p => p != null).map(p => p.height))
    }

    x: number = 0
    y: number = 0
    scale: number = 1

    render(
        encoder: GPUCommandEncoder,
        texture: GPUTexture,
        shader: Shader,
        x: number,
        y: number,
        scale: number,
    ) {
        if (this.images.length == 2) {
            this.images.forEach((v, i) => {
                if (v == null) return
                if (!v.ready) return
                shader.render(
                    encoder,
                    v,
                    texture,
                    x + ((0.5 - i) * v.width) / this.viewer.width,
                    y,
                    scale,
                )
            })
        } else if (this.images.length == 1) {
            if (this.images[0] != null) {
                if (this.images[0].ready) {
                    shader.render(encoder, this.images[0], texture, x, y, scale)
                }
            }
        }
    }

    destroy() {
        this.images.filter(p => p != null).forEach(im => im.destroy())
    }
}
