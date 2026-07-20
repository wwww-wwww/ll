export class Mipmap {
    width: number
    height: number
    scale: number
    tilesCols: number
    tilesRows: number
    tilesize: number
    private textures: GPUTexture[] = []
    private tiles: GPUTexture[] = []

    constructor(device: GPUDevice, bitmap: HTMLImageElement, scale: number, tilesize: number) {
        this.width = bitmap.width
        this.height = bitmap.height
        this.scale = scale
        this.tilesCols = Math.ceil(bitmap.width / tilesize)
        this.tilesRows = Math.ceil(bitmap.height / tilesize)
        this.tilesize = tilesize

        for (let r = 0; r < this.tilesRows; r++) {
            let height = Math.min((r + 1) * tilesize, this.height) - r * tilesize
            let y = r * tilesize
            for (let c = 0; c < this.tilesCols; c++) {
                let x = c * tilesize
                let width = Math.min((c + 1) * tilesize, this.width) - c * tilesize

                console.log("Create tile", c, r)

                let texture = device.createTexture({
                    size: { width: width, height: height },
                    format: "rgba8unorm",
                    usage:
                        GPUTextureUsage.TEXTURE_BINDING |
                        GPUTextureUsage.COPY_DST |
                        GPUTextureUsage.RENDER_ATTACHMENT,
                })

                device.queue.copyExternalImageToTexture(
                    { source: bitmap, origin: [x, y] },
                    { texture: texture },
                    [width, height],
                )

                this.textures.push(texture)
            }
        }

        for (let r = 0; r < 2; r++) {
            let row = Math.min(r, this.tilesRows - 1) * this.tilesCols
            for (let c = 0; c < 2; c++) {
                let i = row + Math.min(c, this.tilesCols - 1)
                this.tiles.push(this.textures[i])
            }
        }
    }

    destroy() {
        this.textures.forEach(texture => texture.destroy())
    }

    getQuad(centerX: number, centerY: number) {
        if (this.tilesCols <= 2 && this.tilesRows <= 2) {
            return { tiles: this.tiles, x: 0, y: 0 }
        }

        let tiles: GPUTexture[] = []

        let c = centerX / this.tilesize
        let tX: number

        if (c >= this.tilesCols - 1) {
            tX = this.tilesCols - 2
        } else if (c <= 0) {
            tX = 0
        } else {
            let xCenterRight =
                c + 1 == this.tilesCols - 1 ?
                    ((this.tilesCols - 1) * this.tilesize + this.width) * 0.5
                    : (c + 1.5) * this.tilesize

            if (centerX - (c - 0.5) * this.tilesize < xCenterRight - centerX) {
                tX = c - 1
            } else {
                tX = c
            }
        }

        tX = Math.min(Math.max(tX, 0), this.tilesCols - 1)

        let r = centerY / this.tilesize
        let tY: number
        if (r >= this.tilesRows - 1) {
            tY = this.tilesRows - 2
        } else if (r <= 0) {
            tY = 0
        } else {
            let yCenterBottom =
                r + 1 == this.tilesRows - 1 ?
                    ((this.tilesRows - 1) * this.tilesize + this.height) * 0.5
                    : (r + 1.5) * this.tilesize

            if (centerY - (r - 0.5) * this.tilesize < yCenterBottom - centerY) {
                tY = r - 1
            } else {
                tY = r
            }
        }

        tX = Math.min(Math.max(tX, 0), this.tilesRows - 1)

        for (let r = 0; r < 2; r++) {
            let row = Math.min(tY + r, this.tilesRows - 1) * this.tilesCols
            for (let c = 0; c < 2; c++) {
                let i = row + Math.min(tX + c, this.tilesCols - 1)
                tiles.push(this.textures[i])
            }
        }

        return { tiles: tiles, x: tX * tiles[0].width, y: tY * tiles[0].height }
    }
}
