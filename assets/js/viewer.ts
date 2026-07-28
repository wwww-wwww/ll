import { Shader } from "./shader"
import Page from "./page"

function spring(t: number) {
    const stiffness = 200.0
    const damping = 1.0
    const omega = Math.sqrt(stiffness)
    const a = omega * damping
    const raw = 1.0 - (1.0 + a * t) * Math.exp(-a * t)
    const end = 1.0 - (1.0 + a) * Math.exp(-a)
    return raw / end
}

function dist(pos1: number[], pos2: number[]) {
    return Math.sqrt(Math.pow(pos1[0] - pos2[0], 2) + Math.pow(pos1[1] - pos2[1], 2))
}

const TOUCH_SLOP = 8 * window.devicePixelRatio * 96 / 160
const DOUBLE_CLICK_DELAY = 300

export class Viewer extends HTMLCanvasElement {
    device!: GPUDevice
    context!: GPUCanvasContext
    private shader!: Shader

    scale: number = 1
    x: number = 0
    y: number = 0

    page = 0

    pages: Map<number, (Page | null)[]> = new Map<number, (Page | null)[]>()
    fetch_pages?: (n: number) => (HTMLImageElement | null)[]

    get_page(n: number): (Page | null)[] | null {
        if (this.pages.has(n)) {
            return this.pages.get(n)!
        }

        const pages = this.fetch_pages?.(n)?.map(im => {
            if (!im) return null
            return this.create_image(im)
        })

        return (
            (pages &&
                (() => {
                    this.pages.set(n, pages)
                    return pages
                })()) ||
            null
        )
    }

    create_image(image: HTMLImageElement): Page {
        return new Page(this, image)
    }

    next_frame?: number
    invalidate() {
        if (this.next_frame) {
            cancelAnimationFrame(this.next_frame)
        }

        this.next_frame = requestAnimationFrame(() => this.render())
    }

    get fit_scale(): number {
        const pages = this.get_page(this.page)?.filter(p => p != null) ?? []
        const width = pages.map(p => p.width).reduce((acc, val) => acc+val, 0)
        const height = Math.max(...pages.map(p => p.height))

        if (width <= 0 && height <= 0) return 1

        const ratiox = this.context.canvas.width / width
        const ratioy = this.context.canvas.height / height

        return Math.min(ratiox, ratioy)
    }

    get min_scale(): number {
        return this.fit_scale
    }

    get at_home(): boolean {
        return this.x == 0 && this.y == 0 && this.scale == this.fit_scale
    }

    async render() {
        const texture = this.context.getCurrentTexture()
        const encoder = this.device.createCommandEncoder()
        encoder
            .beginRenderPass({
                colorAttachments: [
                    { view: texture, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] },
                ],
            })
            .end()

        const pages = this.get_page(this.page) ?? []
        if (pages.length == 2) {
            pages.forEach((v, i) => {
                if (v == null) return
                if (!v.ready) return
                this.shader.render(
                    encoder,
                    v,
                    texture,
                    this.x + ((0.5 - i) * v.width) / this.width,
                    this.y,
                    this.scale,
                )
            })
        } else if (pages.length == 1) {
            if (pages[0] != null) {
                if (pages[0].ready) {
                    this.shader.render(
                        encoder,
                        pages[0],
                        texture,
                        this.x,
                        this.y,
                        this.scale,
                    )
                }
            }
        }

        this.device.queue.submit([encoder.finish()])
    }

    static async new(): Promise<Viewer> {
        const viewer = document.createElement("canvas", { is: "webgpu-viewer" }) as Viewer
        await viewer.init()
        return viewer
    }

    current_animation: any = null

    animation(fn: (t: number) => void, duration: number) {
        if (this.current_animation != null) {
            cancelAnimationFrame(this.current_animation)
        }

        const t0 = performance.now()
        const loop = () => {
            const t1 = performance.now()
            const t = Math.min((t1 - t0) / duration, 1)
            fn(t)
            if (t < 1) {
                this.current_animation = requestAnimationFrame(loop)
            }
        }
        this.current_animation = requestAnimationFrame(loop)
    }

    move_to(
        x: number,
        y: number,
        scale: number,
        origin_x: number | null = null,
        origin_y: number | null = null,
    ) {
        const start_x = this.x
        const start_y = this.y
        const start_scale = this.scale

        const diff_end = scale != start_scale ? 1 / scale - 1 / start_scale : 1

        const end_x =
            origin_x != null ?
                scale != start_scale ?
                    start_x + (origin_x - 0.5) * diff_end
                    : start_x
                : x
        const end_y =
            origin_y != null ?
                scale != start_scale ?
                    start_y + (origin_y - 0.5) * diff_end
                    : start_y
                : y

        this.animation(t => {
            t = spring(t)
            const new_scale = start_scale * (1 - t) + scale * t
            const c =
                start_scale != scale ?
                    Math.max(0, Math.min((1 / new_scale - 1 / start_scale) / diff_end, 1))
                    : t

            this.x = start_x * (1 - c) + end_x * c
            this.y = start_y * (1 - c) + end_y * c
            this.scale = new_scale
            this.invalidate()
        }, 200)
    }

    private async init() {
        const adapter = await navigator.gpu?.requestAdapter()
        const device = await adapter?.requestDevice()

        if (!device) {
            throw Error("need a browser that supports WebGPU")
        }

        this.device = device

        this.context = this.getContext("webgpu") as GPUCanvasContext
        this.context.configure({
            device: device,
            format: "rgba8unorm",
            colorSpace: "srgb",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            alphaMode: "premultiplied",
        })

        this.shader = new Shader(device)

        new ResizeObserver(() => {
            const rect = this.getBoundingClientRect()
            this.width = rect.width * window.devicePixelRatio
            this.height = rect.height * window.devicePixelRatio
            this.invalidate()
        }).observe(this)

        let last_pos = [0, 0]
        let start = [0, 0]

        const pan = (x: number, y: number) => {
            this.x = this.x + x
            this.y = this.y + y
            this.invalidate()
        }

        {
            this.addEventListener("wheel", e => {
                if (this.classList.contains("grabbing")) {
                    pan(e.clientX, e.clientY)
                }

                const rect = this.getBoundingClientRect()
                const x = (e.clientX - rect.x) / rect.width
                const y = (e.clientY - rect.y) / rect.height

                const off = e.deltaY > 0 ? -0.05 : +0.05
                let new_scale = Math.pow(10, Math.log10(this.scale) + off)
                new_scale = Math.max(this.min_scale, new_scale)

                const diff = 1 / new_scale - 1 / this.scale
                this.x = this.x + (x - 0.5) * diff
                this.y = this.y + (y - 0.5) * diff
                this.scale = new_scale

                this.invalidate()
            })

            let past_slop = false
            this.addEventListener("pointerdown", e => {
                if (e.button != 0) return

                const rect = this.getBoundingClientRect()
                const x = (e.clientX - rect.x) / rect.width
                const y = (e.clientY - rect.y) / rect.height

                this.setPointerCapture(e.pointerId)
                e.preventDefault()
                this.classList.toggle("grabbing", true)

                past_slop = false
                last_pos = [x, y]
                start = [e.clientX, e.clientY]
            })

            this.addEventListener("pointermove", e => {
                // update_cursor(e)

                if (!this.hasPointerCapture(e.pointerId)) return
                if (!this.classList.contains("grabbing")) return


                if (!past_slop && dist([e.clientX, e.clientY], start) >= TOUCH_SLOP) {
                    past_slop = true
                }
                if (!past_slop) return

                const rect = (this.context.canvas as HTMLCanvasElement).getBoundingClientRect()
                const x = (e.clientX - rect.x) / rect.width
                const y = (e.clientY - rect.y) / rect.height

                const offx = (x - last_pos[0]) / this.scale
                const offy = (y - last_pos[1]) / this.scale

                last_pos = [x, y]

                pan(offx, offy)
            })

            let click_timeout: any = null
            this.addEventListener("pointerup", e => {
                if (e.button != 0) return

                if (!this.hasPointerCapture(e.pointerId)) return
                this.releasePointerCapture(e.pointerId)
                this.classList.toggle("grabbing", false)

                const rect = this.getBoundingClientRect()
                const x = (e.clientX - rect.x) / rect.width
                const y = (e.clientY - rect.y) / rect.height

                if (dist([e.clientX, e.clientY], start) < TOUCH_SLOP) {
                    if (click_timeout) {
                        clearTimeout(click_timeout)
                        click_timeout = null
                        this.on_double_click(x, y)
                    } else {
                        click_timeout = setTimeout(() => {
                            this.on_click(x, y)
                            click_timeout = null
                        }, DOUBLE_CLICK_DELAY)
                    }
                }
            })
        }
    }

    on_click(x: number, y: number) {
        document.getElementById("series_details_toggle")?.click()
    }

    on_double_click(x: number, y: number) {
        if (this.at_home) {
            this.move_to(0, 0, 1, x, y)
        } else {
            this.move_to(0, 0, this.fit_scale)
        }
    }

    set_page(n: number) {
        this.page = n
        Promise.all(this.get_page(n)?.filter(v => v != null)?.map(v => v.promise.promise) ?? [])
            .then(() => {
                this.move_to(0, 0, this.fit_scale)
            })
        this.invalidate()
    }
}

customElements.define("webgpu-viewer", Viewer, { extends: "canvas" })
