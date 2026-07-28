import { ViewHook } from "phoenix_live_view"
import { Viewer } from "./viewer"

const TILESIZE = 4096
const PRELOAD_COUNT = 5

class Reader extends ViewHook {
    private device!: GPUDevice

    private files: (HTMLImageElement | null)[][] = []

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

    crop_image(
        im: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
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

    viewer!: Viewer

    async init() {
        this.viewer = await Viewer.new()
        this.el.appendChild(this.viewer)

        this.viewer.fetch_pages = (n: number) => {
            let i = n + 1
            let preload_next = () => {
                if (i >= n + PRELOAD_COUNT) return
                if (i >= this.files.length) return
                Promise.all(this.files[i++].filter(f => f).map(f => f?.decode()))
                    .then(preload_next)
            }
            preload_next()
            return this.files[n]
        }
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

        this.viewer.set_page(Math.max(Math.min(page, this.files.length - 1), 0))
        this.e_page.textContent = `${this.viewer.page + 1}/${this.files.length}`
        this.viewer?.invalidate()
    }

    private key_event!: ((e: KeyboardEvent) => void) | null

    mounted() {
        this.e_page = this.el.querySelector(".info>.page")!
        this.e_interstitial = this.el.querySelector(".interstitial")!

        this.e_interstitial.onclick = e => {
            const rect = this.e_interstitial.getBoundingClientRect()
            const x = (e.clientX - rect.x) / rect.width
            if (x < 0.5) {
                this.viewer.set_page(this.viewer.page + 1)
            } else {
                this.viewer.set_page(this.viewer.page - 1)
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

        const data = JSON.parse(this.el.dataset.files! || "{}")

        function get_files(files_raw: HTMLImageElement[], order: number[]): (HTMLImageElement | null)[][] {
            let i = 0

            const files: (HTMLImageElement | null)[][] = []

            while (order.length > 0) {
                const o = order.shift()
                if (o == 0) {
                    if (order[0] == 1) {
                        order.shift()
                        files.push([files_raw[i++], files_raw[i++]])
                    } else {
                        files.push([files_raw[i++], null])
                    }
                }
                if (o == 1) {
                    files.push([null, files_raw[i++]])
                }
                if (o == 2) {
                    files.push([files_raw[i++]])
                }
            }

            return files
        }

        const files = data.files.map((f: string) => {
            const im = new Image()
            im.src = f
            return im
        })

        if (data.order) {
            this.files = get_files(files, data.order)
        } else {
            this.files = files.map((e: HTMLImageElement) => [e])
        }

        console.log(this.files)

        this.handleEvent("files", data => {
            if (!mounted) return
            console.info("files", data, window.history.state)

            this.viewer.pages.clear()

            const files = data.files.map((f: string) => {
                const im = new Image()
                im.src = f
                return im
            })
            if (data.order) {
                this.files = get_files(files, data.order)
            } else {
                this.files = files.map((e: HTMLImageElement) => [e])
            }

            this.e_interstitial.classList.toggle("visible", false)

            if (chapters) {
                const current_index = chapters.findIndex(e => e.classList.contains("selected"))

                if (this.navigating && this.prev_chapter == chapters.at(current_index)) {
                    this.viewer.set_page(this.files.length - 1)
                } else {
                    this.viewer.set_page(window.history.state.page || 0)
                }

                this.next_chapter = current_index > 0 ? chapters.at(current_index - 1)! : null
                this.prev_chapter = chapters.at(current_index + 1)!
            }

            this.navigating = false
        })

        const params = new URLSearchParams(window.location.search)
        const page = window.history.state.page || parseInt(params?.get("page")! ?? "1") - 1

        this.init().then(() => {
            this.viewer.set_page(page)
            mounted = true
        })

        this.key_event = (e: KeyboardEvent) => {
            if (document.activeElement?.tagName == "INPUT" || document.activeElement?.tagName == "TEXTAREA") {
                return;
            }

            if (e.key == "ArrowLeft") {
                e.preventDefault()

                this.set_page(this.viewer.page + 1)
            }
            if (e.key == "ArrowRight") {
                e.preventDefault()

                this.set_page(this.viewer.page - 1)
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
