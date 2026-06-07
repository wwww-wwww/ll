import { ViewHook } from "phoenix_live_view"
import shader from "./shader"
import downsample from "./downsample"

const TILESIZE = 4096

class Mipmap {
    scale: number = 1
    tiles: GPUTexture[][] = []
    width: number = 0
    height: number = 0

    constructor(scale: number, tiles: GPUTexture[][]) {
        this.scale = scale
        this.tiles = tiles
        this.width = tiles[0].length
        this.height = tiles.length
    }
}

class Reader extends ViewHook {
    private device!: GPUDevice
    private pipeline_draw!: GPUComputePipeline
    private uniform_buffer!: GPUBuffer

    private files: string[] = []
    private draw_image: (() => void) | null = null
    private loaded_page = -1
    private page = -1

    create_shader(code: string) {
        const module = this.device!.createShaderModule({ code })
        const log = async () => {
            const info = await module.getCompilationInfo()

            for (const message of info.messages) {
                console.error(`Line ${message.lineNum}:${message.linePos} - ${message.message}`)
            }
        }
        log()

        return module
    }

    private x: number = 0
    private y: number = 0
    private scale: number = 1

    crop_image(
        im: ImageBitmap | HTMLImageElement,
        x: number,
        y: number,
        width: number,
        height: number,
    ) {
        const canvas = document.createElement("canvas")
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext("2d")
        ctx!.drawImage(im, x, y, width, height, 0, 0, width, height)
        return canvas
    }

    async create_tiles(
        im: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
    ): Promise<GPUTexture[][]> {
        console.log("Create tiles", im.width, im.height)
        const tiles = []
        for (let y = 0; y < im.height; y += TILESIZE) {
            const row = []
            for (let x = 0; x < im.width; x += TILESIZE) {
                console.log("Tile", x, y)
                const width = Math.min(TILESIZE, im.width - x)
                const height = Math.min(TILESIZE, im.height - y)
                const im2 = this.crop_image(im, x, y, width, height)

                let texture = this.device.createTexture({
                    size: [width, height, 1],
                    format: "rgba8unorm",
                    usage:
                        GPUTextureUsage.STORAGE_BINDING |
                        GPUTextureUsage.TEXTURE_BINDING |
                        GPUTextureUsage.COPY_DST |
                        GPUTextureUsage.RENDER_ATTACHMENT,
                })
                row.push(texture)

                this.device.queue.copyExternalImageToTexture(
                    { source: im2 },
                    { texture: texture },
                    [width, height],
                )
            }
            tiles.push(row)
        }

        return tiles
    }

    render_image(
        im: HTMLImageElement,
        mipmap: Mipmap,
        dest: GPUTexture,
        x: number,
        y: number,
        scale: number,
    ) {
        const encoder = this.device.createCommandEncoder()

        let vx = (-x * dest.width + 0.5 * im.width) * mipmap.scale
        vx = Math.round(vx / TILESIZE) - 1
        vx = Math.min(vx, mipmap.width - 2)
        vx = Math.max(vx, 0)

        let vy = (-y * dest.height + 0.5 * im.height) * mipmap.scale
        vy = Math.round(vy / TILESIZE) - 1
        vy = Math.min(vy, mipmap.height - 2)
        vy = Math.max(vy, 0)

        const data = new Float32Array(8)
        data[0] =
            (0.5 / scale + x) * mipmap.scale +
            (vx * TILESIZE - (mipmap.scale * im.width) / 2) / dest.width
        data[1] =
            (0.5 / scale + y) * mipmap.scale +
            (vy * TILESIZE - (mipmap.scale * im.height) / 2) / dest.height
        data[2] = scale / mipmap.scale
        data[3] = TILESIZE
        data[4] = mipmap.width
        data[5] = mipmap.height
        this.device.queue.writeBuffer(this.uniform_buffer, 0, data)

        const vx1 = mipmap.width > 1 ? vx + 1 : vx
        const vy1 = mipmap.height > 1 ? vy + 1 : vy

        const textures = [
            mipmap.tiles[vy][vx],
            mipmap.tiles[vy][vx1],
            mipmap.tiles[vy1][vx],
            mipmap.tiles[vy1][vx1],
        ].map((texture, i) => {
            return { binding: 2 + i, resource: texture }
        })

        const pass = encoder.beginComputePass()
        pass.setPipeline(this.pipeline_draw)
        pass.setBindGroup(
            0,
            this.device.createBindGroup({
                layout: this.pipeline_draw.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: dest },
                    { binding: 1, resource: this.uniform_buffer },
                ].concat(textures),
            }),
        )
        pass.dispatchWorkgroups(Math.ceil(dest.width / 16), Math.ceil(dest.height / 16))
        pass.end()
        this.device.queue.submit([encoder.finish()])
    }

    async init() {
        const canvas: HTMLCanvasElement = this.el.querySelector("canvas")!

        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
        const device = await adapter?.requestDevice({
            requiredLimits: { maxComputeWorkgroupStorageSize: 32768 },
        })

        if (!device) {
            throw Error("need a browser that supports WebGPU")
        }

        this.device = device

        this.pipeline_draw = device.createComputePipeline({
            layout: "auto",
            compute: { module: this.create_shader(shader) },
        })

        this.uniform_buffer = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })

        const context = canvas.getContext("webgpu") as GPUCanvasContext
        context.configure({
            device: device,
            format: "rgba8unorm",
            colorSpace: "srgb",
            // @ts-ignore
            usage: GPUTextureUsage.STORAGE_BINDING || GPUTextureUsage.RENDER_ATTACHMENT,
            alphaMode: "premultiplied",
        })

        let fit = true

        let im: HTMLImageElement = new Image()
        let mipmaps: Mipmap[] = []
        const e_mipmaplevel = this.el.querySelector(".info>.mipmaplevel")!

        this.draw_image = async () => {
            if (this.page == -1) return
            if (this.page != this.loaded_page) {
                this.loaded_page = this.page

                this.el.classList.toggle("loading", true)
                const new_im = new Image()
                new_im.src = this.files[this.page]
                await new_im.decode()
                im = new_im

                if (this.page < this.files.length - 1) {
                    const next = new Image()
                    next.src = this.files[this.page + 1]
                    next.decode()
                }

                if (this.page > 0) {
                    const next = new Image()
                    next.src = this.files[this.page - 1]
                    next.decode()
                }

                mipmaps.forEach(t =>
                    t.tiles
                        .flat()
                        .flat()
                        .forEach(t => t.destroy()),
                )
                mipmaps = []
                e_mipmaplevel.textContent = `Creating textures`
                mipmaps.push(new Mipmap(1, await this.create_tiles(im)))

                refit(0, 0, 0, false)
                move(0, 0, tz, 0, false)

                let scale = 1
                while (im.width * scale > 512 && im.height * scale > 512) {
                    scale /= 2
                    e_mipmaplevel.textContent = `Creating mipmap ${im.width}x${im.height} ${scale}`
                    const width = Math.floor(im.width * scale)
                    const height = Math.floor(im.height * scale)
                    console.log("Create mipmap", scale, width, height)

                    const im2 = downsample(im, width, height)

                    mipmaps.push(new Mipmap(scale, await this.create_tiles(im2)))
                }

                this.el.classList.toggle("loading", false)

                if (fit) {
                    const zoom = Math.min(canvas.height / im.height, canvas.width / im.width)
                    move(0, 0, zoom)
                }
            }

            if (mipmaps.length == 0) return

            let level = Math.floor(Math.log2(1 / this.scale))
            level = Math.min(Math.max(level, 0), mipmaps.length - 1)
            if (mipmaps[level]) {
                const mipmap = mipmaps[level]
                e_mipmaplevel.textContent = `${level + 1}/${mipmaps.length} ${mipmap.tiles[0].length}x${mipmap.tiles.length}`
                this.render_image(
                    im,
                    mipmap,
                    context.getCurrentTexture(),
                    this.x,
                    this.y,
                    this.scale,
                )
            }
        }

        const e_zoom = this.el.querySelector(".info>.zoom")!

        let tx = 0
        let ty = 0
        let tz = 1

        let mx = 0
        let my = 0

        let tx0 = 0
        let ty0 = 0
        let tz0 = 1

        let end_time = 0
        let duration = 100

        const animate_zoom = () => {
            const t = performance.now()
            const m = Math.pow(Math.max(end_time - t, 0) / duration, 2)

            const new_zoom = tz + (tz0 - tz) * m
            const diff = 1 / new_zoom - 1 / tz0

            this.x = tx0 + (mx - 0.5) * diff
            this.y = ty0 + (my - 0.5) * diff
            this.scale = new_zoom

            this.draw_image!()

            if (t < end_time) {
                requestAnimationFrame(animate_zoom)
            }
        }

        const animate_pan = () => {
            const t = performance.now()
            const m = Math.pow(Math.max(end_time - t, 0) / duration, 2)
            this.x = tx + (tx0 - tx) * m
            this.y = ty + (ty0 - ty) * m

            this.draw_image!()

            if (t < end_time) {
                requestAnimationFrame(animate_pan)
            }
        }

        const move = (x: number, y: number, zoom: number, _duration = 0, render = true) => {
            end_time = performance.now()

            if (_duration > 0) {
                duration = _duration
                tx0 = tx
                ty0 = ty
                end_time = performance.now() + duration
                requestAnimationFrame(animate_pan)
            }

            tx = x
            ty = y
            tz = Math.min(Math.max(0.01, zoom || 1), 1000)

            this.x = x
            this.y = y
            this.scale = zoom

            if (_duration == 0) {
                if (render) {
                    this.draw_image!()
                }
            }

            e_zoom.textContent = `${(zoom * 100).toFixed(2)}%`
        }

        const zoom = (x: number, y: number, zoom: number, _duration = 1000) => {
            duration = _duration

            tx0 = tx
            ty0 = ty
            tz0 = tz

            mx = x
            my = y

            const new_zoom = Math.min(Math.max(0.01, zoom || 1), 1000)
            const diff = 1 / new_zoom - 1 / tz

            tx = tx + (x - 0.5) * diff
            ty = ty + (y - 0.5) * diff
            tz = new_zoom

            if (_duration == 0) {
                this.x = tx0
                this.y = ty0
                this.scale = tz
            } else {
                end_time = performance.now() + duration
                requestAnimationFrame(animate_zoom)
            }

            e_zoom.textContent = `${(zoom * 100).toFixed(2)}%`
        }

        const observer = new ResizeObserver(() => {
            const rect = this.el.getBoundingClientRect()
            canvas.width = rect.width * window.devicePixelRatio
            canvas.height = rect.height * window.devicePixelRatio

            if (fit) {
                const zoom = Math.min(canvas.height / im.height, canvas.width / im.width)
                move(0, 0, zoom)
            }

            this.draw_image!()
        })

        observer.observe(this.el)

        let last_pos = [0, 0]
        let start = [0, 0]

        const pan = (clientX: number, clientY: number) => {
            const rect = canvas.getBoundingClientRect()
            const x = (clientX - rect.x) / rect.width
            const y = (clientY - rect.y) / rect.height

            move(tx + (x - last_pos[0]) / tz, ty + (y - last_pos[1]) / tz, tz)

            last_pos = [x, y]
        }

        canvas.addEventListener("wheel", e => {
            if (canvas.classList.contains("grabbing")) {
                pan(e.clientX, e.clientY)
            }

            fit = false

            const rect = canvas.getBoundingClientRect()
            const x = (e.clientX - rect.x) / rect.width
            const y = (e.clientY - rect.y) / rect.height

            const off = e.deltaY > 0 ? -0.05 : +0.05
            const new_zoom = Math.pow(10, Math.log10(tz) + off)

            zoom(x, y, new_zoom, 100)

            this.draw_image!()
        })

        canvas.addEventListener("click", e => {
            const rect = canvas.getBoundingClientRect()
            const x = (e.clientX - rect.x) / rect.width
            const y = (e.clientY - rect.y) / rect.height

            if (e.button == 0) {
                if (x > 2 / 3) {
                    this.set_page(this.page - 1)
                } else if (x < 1 / 3) {
                    this.set_page(this.page + 1)
                }
            }

            if (e.detail == 2) {
                if (x > 1 / 3 && x < 2 / 3) {
                    toggle_fit(x, y)
                }
            }
        })

        let last_dist = 0

        canvas.addEventListener("touchstart", e => {
            if (e.touches.length == 2) {
                const rect = canvas.getBoundingClientRect()
                const clientX = (e.touches[0].clientX + e.touches[1].clientX) / 2
                const clientY = (e.touches[0].clientY + e.touches[1].clientY) / 2
                const x = (clientX - rect.x) / rect.width
                const y = (clientY - rect.y) / rect.height
                last_pos = [x, y]

                last_dist = Math.sqrt(
                    Math.pow(e.touches[0].clientX - e.touches[1].clientX, 2) +
                    Math.pow(e.touches[0].clientY - e.touches[1].clientY, 2),
                )
            }
        })

        canvas.addEventListener("touchend", e => {
            if (e.touches.length == 1) {
                const rect = canvas.getBoundingClientRect()
                const x = (e.touches[0].clientX - rect.x) / rect.width
                const y = (e.touches[0].clientY - rect.y) / rect.height
                last_pos = [x, y]
            }
        })

        canvas.addEventListener("touchmove", e => {
            if (e.touches.length == 2) {
                fit = false
                const clientX = (e.touches[0].clientX + e.touches[1].clientX) / 2
                const clientY = (e.touches[0].clientY + e.touches[1].clientY) / 2
                pan(clientX, clientY)
                const dist = Math.sqrt(
                    Math.pow(e.touches[0].clientX - e.touches[1].clientX, 2) +
                    Math.pow(e.touches[0].clientY - e.touches[1].clientY, 2),
                )
                const rect = canvas.getBoundingClientRect()
                const x = (clientX - rect.x) / rect.width
                const y = (clientY - rect.y) / rect.height

                const new_zoom = tz * (dist / last_dist)
                const diff = 1 / new_zoom - 1 / tz

                last_dist = dist

                move(tx + (x - 0.5) * diff, ty + (y - 0.5) * diff, new_zoom)

                this.draw_image!()
            }
        })

        canvas.addEventListener("pointerdown", e => {
            if (e.button != 1) return

            const rect = canvas.getBoundingClientRect()
            const x = (e.clientX - rect.x) / rect.width
            const y = (e.clientY - rect.y) / rect.height

            canvas.setPointerCapture(e.pointerId)
            e.preventDefault()
            canvas.classList.toggle("grabbing", true)

            last_pos = [x, y]
            start = [x, y]
        })

        const update_cursor = (e: PointerEvent) => {
            const rect = canvas.getBoundingClientRect()
            const x = (e.clientX - rect.x) / rect.width

            if (x > 2 / 3) {
                this.el.classList.toggle("cursor-left", this.page > 0 || this.prev_chapter != null)
                this.el.classList.toggle("cursor-right", false)
            } else if (x < 1 / 3) {
                this.el.classList.toggle("cursor-left", false)
                this.el.classList.toggle(
                    "cursor-right",
                    this.page < this.files.length - 1 || this.next_chapter != null,
                )
            } else {
                this.el.classList.toggle("cursor-left", false)
                this.el.classList.toggle("cursor-right", false)
            }
        }

        canvas.addEventListener("pointermove", e => {
            update_cursor(e)

            if (!canvas.hasPointerCapture(e.pointerId)) return
            if (!canvas.classList.contains("grabbing")) return

            pan(e.clientX, e.clientY)

            this.draw_image!()
        })

        const refit = (x: number, y: number, duration: number, render: boolean = true) => {
            const ratiox = canvas.width / im.width
            const ratioy = canvas.height / im.height

            const new_zoom = Math.min(Math.max(0.01, Math.min(ratiox, ratioy)), 1000)
            if (tz == new_zoom) {
                move(0, 0, new_zoom, duration, render)
            } else {
                const diff = 1 / new_zoom - 1 / tz
                zoom(-tx / diff + 0.5, -ty / diff + 0.5, new_zoom, duration)
            }
        }

        const toggle_fit = (x: number, y: number) => {
            if (!fit) {
                // scale to fit
                fit = true
                refit(x, y, 200)
            } else {
                // 100%
                fit = false
                zoom(x, y, 1, 200)
            }
            this.draw_image!()
        }

        canvas.addEventListener("pointerup", e => {
            if (e.button != 1) return
            if (!canvas.hasPointerCapture(e.pointerId)) return
            canvas.releasePointerCapture(e.pointerId)
            canvas.classList.toggle("grabbing", false)

            const rect = canvas.getBoundingClientRect()
            const x = (e.clientX - rect.x) / rect.width
            const y = (e.clientY - rect.y) / rect.height
            if (x == start[0] && y == start[1]) {
                toggle_fit(x, y)
                update_cursor(e)
            } else {
                fit = false
                pan(e.clientX, e.clientY)
                this.draw_image!()
            }
        })
    }

    private e_page!: HTMLElement
    private e_interstitial!: HTMLElement

    private next_chapter!: HTMLElement | null
    private prev_chapter!: HTMLElement | null
    private navigating = false

    set_page(page: number, push_state: boolean = true) {
        if (this.files.length == 0) return

        if (page == this.files.length || page == -1) {
            let next_chapter: HTMLElement | null = null

            next_chapter = page == this.files.length ? this.next_chapter : this.prev_chapter

            if (!next_chapter) return

            if (this.e_interstitial.classList.contains("visible")) {
                this.navigating = true
                next_chapter.querySelector("a")?.click()
                this.e_interstitial.classList.toggle("visible", false)
                return
            }

            this.e_interstitial.textContent = next_chapter.querySelector(".title")!.textContent
            this.e_interstitial.classList.toggle("visible", true)
            return
        }

        if (this.e_interstitial.classList.contains("visible")) {
            this.e_interstitial.classList.toggle("visible", false)
            return
        }

        if (push_state) {
            const params = new URLSearchParams(window.location.search)
            params.set("page", (page + 1).toString())
            const new_url = decodeURIComponent(`${window.location.pathname}?${params}`)
            window.history.replaceState({ ...window.history.state, page: page }, "", new_url)
        }

        this.page = Math.max(Math.min(page, this.files.length - 1), 0)
        this.e_page.textContent = `${this.page + 1}/${this.files.length}`
        this.draw_image?.()
    }

    private key_event!: ((e: KeyboardEvent) => void) | null

    mounted() {
        this.e_page = this.el.querySelector(".info>.page")!
        this.e_interstitial = this.el.querySelector(".interstitial")!

        this.e_interstitial.onclick = e => {
            const rect = this.e_interstitial.getBoundingClientRect()
            const x = (e.clientX - rect.x) / rect.width
            if (x < 0.5) {
                this.set_page(this.page + 1)
            } else {
                this.set_page(this.page - 1)
            }
        }

        let mounted = false

        let chapters: HTMLElement[] | null = null

        if (document.getElementById("chapterlist")) {
            chapters = Array.from(document.getElementById("chapterlist")!.children) as HTMLElement[]
            const current_index = chapters.findIndex(e => e.classList.contains("selected"))
            this.next_chapter = current_index > 0 ? chapters.at(current_index - 1)! : null
            this.prev_chapter = chapters.at(current_index + 1)!
        }

        this.files = JSON.parse(this.el.dataset.files! || "[]")

        this.handleEvent("files", data => {
            if (!mounted) return
            console.info("files", data, window.history.state)

            this.files = data.files
            this.loaded_page = -1
            this.e_interstitial.classList.toggle("visible", false)

            if (chapters) {
                const current_index = chapters.findIndex(e => e.classList.contains("selected"))

                if (this.navigating && this.prev_chapter == chapters.at(current_index)) {
                    this.set_page(this.files.length - 1, false)
                } else {
                    this.set_page(window.history.state.page || 0, false)
                }

                this.next_chapter = current_index > 0 ? chapters.at(current_index - 1)! : null
                this.prev_chapter = chapters.at(current_index + 1)!
            }

            this.navigating = false
        })

        const params = new URLSearchParams(window.location.search)
        const page = window.history.state.page || parseInt(params?.get("page")! ?? "1") - 1

        this.set_page(page)

        this.init().then(() => {
            this.set_page(page)
            mounted = true
        })

        const canvas = this.el.querySelector("canvas")!
        canvas.addEventListener("drop", e => {
            Array.from(e.dataTransfer!.items).forEach(item => {
                if (item.type.startsWith("image/")) {
                    const f = item.getAsFile()!
                    this.files.push(URL.createObjectURL(f))
                }
            })
            this.set_page(this.files.length - 1)
        })

        this.key_event = (e: KeyboardEvent) => {
            if (e.key == "ArrowLeft") {
                e.preventDefault()

                this.set_page(this.page + 1)
            }
            if (e.key == "ArrowRight") {
                e.preventDefault()

                this.set_page(this.page - 1)
            }
        }

        window.addEventListener("keydown", this.key_event)
    }

    destroyed() {
        window.removeEventListener("keydown", this.key_event!)
    }
}

class chapterlist extends ViewHook {
    mounted() {
        Array.from(this.el.children).forEach(e => {
            if (e.classList.contains("selected")) {
                e.scrollIntoView({ block: "center" })
            }
        })
    }
}

export default { Reader, chapterlist }
