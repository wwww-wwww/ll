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

export class Viewer extends HTMLCanvasElement {
    device!: GPUDevice
    context!: GPUCanvasContext
    private shader!: Shader

    scale: number = 1
    x: number = 0
    y: number = 0

    page = 0

    pages: Map<number, Page> = new Map<number, Page>()
    fetch_pages?: (n: number) => Page

    get_page(n: number): Page | null {
        if (this.pages.has(n)) {
            return this.pages.get(n)!
        }

        const image = this.fetch_pages?.(n)

        return (
            (image &&
                (() => {
                    this.pages.set(n, image)
                    return image
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

    get fit_scale() {
        const page1 = this.get_page(this.page)
        const page2 = this.get_page(this.page + 1)
        return Math.min(page1?.fit_scale ?? 1, page2?.fit_scale ?? 1)
    }

    get min_scale() {
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

        const page1 = this.get_page(this.page)
        if (page1 && page1.ready) {
            this.shader.render(
                encoder,
                page1,
                texture,
                this.x + (0.5 * page1.width) / this.width,
                this.y,
                this.scale,
            )
        }

        const page2 = this.get_page(this.page + 1)
        if (page2 && page2.ready) {
            this.shader.render(
                encoder,
                page2,
                texture,
                this.x - (0.5 * page2.width) / this.width,
                this.y,
                this.scale,
            )
        }

        if (!page1?.ready) {
            page1?.promise.promise.then(() => {
                this.scale = Math.min(page1?.fit_scale ?? 1, page2?.fit_scale ?? 1)
            })
        }
        if (!page2?.ready) {
            page2?.promise.promise.then(() => {
                this.scale = Math.min(page1?.fit_scale ?? 1, page2?.fit_scale ?? 1)
            })
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
                :   start_x
            :   x
        const end_y =
            origin_y != null ?
                scale != start_scale ?
                    start_y + (origin_y - 0.5) * diff_end
                :   start_y
            :   y

        this.animation(t => {
            t = spring(t)
            const new_scale = start_scale * (1 - t) + scale * t
            const c =
                start_scale != scale ?
                    Math.max(0, Math.min((1 / new_scale - 1 / start_scale) / diff_end, 1))
                :   t

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

        const pan = (clientX: number, clientY: number) => {
            const rect = (this.context.canvas as HTMLCanvasElement).getBoundingClientRect()
            const x = (clientX - rect.x) / rect.width
            const y = (clientY - rect.y) / rect.height

            const offx = (x - last_pos[0]) / this.scale
            const offy = (y - last_pos[1]) / this.scale

            this.x = this.x + offx
            this.y = this.y + offy

            last_pos = [x, y]
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

            this.addEventListener("pointerdown", e => {
                if (e.button != 0) return

                const rect = this.getBoundingClientRect()
                const x = (e.clientX - rect.x) / rect.width
                const y = (e.clientY - rect.y) / rect.height

                this.setPointerCapture(e.pointerId)
                e.preventDefault()
                this.classList.toggle("grabbing", true)

                last_pos = [x, y]
                start = [x, y]
            })

            this.addEventListener("pointermove", e => {
                // update_cursor(e)

                if (!this.hasPointerCapture(e.pointerId)) return
                if (!this.classList.contains("grabbing")) return

                pan(e.clientX, e.clientY)
                this.invalidate()
            })

            this.addEventListener("pointerup", e => {
                if (e.button != 0) return
                if (!this.hasPointerCapture(e.pointerId)) return
                this.releasePointerCapture(e.pointerId)
                this.classList.toggle("grabbing", false)

                const rect = this.getBoundingClientRect()
                const x = (e.clientX - rect.x) / rect.width
                const y = (e.clientY - rect.y) / rect.height
                if (x == start[0] && y == start[1]) {
                    if (this.at_home) {
                        this.move_to(0, 0, 1, x, y)
                    } else {
                        this.move_to(0, 0, this.fit_scale)
                    }

                    this.invalidate()
                } else {
                    pan(e.clientX, e.clientY)
                    this.invalidate()
                }
            })
        }
    }

    set_page(n: number) {
        this.page = n
        this.move_to(0, 0, this.fit_scale)
        this.invalidate()
    }
}

customElements.define("webgpu-viewer", Viewer, { extends: "canvas" })
