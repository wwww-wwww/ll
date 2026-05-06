import { ViewHook } from "phoenix_live_view"

class Reader extends ViewHook {
    private device: GPUDevice | null = null
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

    async init() {
        const canvas: HTMLCanvasElement = this.el.querySelector("canvas")!

        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
        const device = await adapter?.requestDevice({
            requiredLimits: { maxComputeWorkgroupStorageSize: 32768 },
        })

        if (!device) {
            console.log("need a browser that supports WebGPU")
            return
        }

        this.device = device

        const context = canvas.getContext("webgpu") as GPUCanvasContext
        context.configure({
            device: device,
            format: "rgba8unorm",
            colorSpace: "srgb",
            // @ts-ignore
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
            alphaMode: "premultiplied",
        })

        const pipeline_draw = device.createComputePipeline({
            layout: "auto",
            compute: {
                module: this.create_shader(/* wgsl */ `
struct Uniforms {
    offset: vec2<f32>,
    scale: f32,
    padding: f32,
}

@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var dst_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> transform: Uniforms;

fn to_linear_exact(srgb: vec4<f32>) -> vec4<f32> {
    let c = max(srgb.rgb, vec3<f32>(0.0));
    let lower = c / vec3<f32>(12.92);
    let higher = pow((c + vec3<f32>(0.055)) / vec3<f32>(1.055), vec3<f32>(2.4));
    let cond = c <= vec3<f32>(0.04045);
    return vec4(select(higher, lower, cond), srgb.a);
}

fn to_srgb_exact(linear_rgb: vec4<f32>) -> vec4<f32> {
    let c = max(linear_rgb.rgb, vec3<f32>(0.0));
    let lower = c * vec3<f32>(12.92);
    let higher = vec3<f32>(1.055) * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    let cond = c <= vec3<f32>(0.0031308);
    return vec4(select(higher, lower, cond), linear_rgb.a);
}

fn to_linear_fast(srgb: vec4<f32>) -> vec4<f32> {
    return vec4(pow(max(srgb.rgb, vec3<f32>(0.0)), vec3<f32>(2.2)), srgb.a);
}

fn to_srgb_fast(linear: vec4<f32>) -> vec4<f32> {
    return vec4(pow(max(linear.rgb, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2)), linear.a);
}

fn catmull_rom_weights(t: f32) -> array<f32, 4> {
    let t2 = t * t;
    let t3 = t2 * t;

    return array<f32, 4>(
        -0.5 * t3 + t2 - 0.5 * t,          // Weight 0 (Negative lobe)
         1.5 * t3 - 2.5 * t2 + 1.0,        // Weight 1 (Primary influence)
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,    // Weight 2 (Primary influence)
         0.5 * t3 - 0.5 * t2               // Weight 3 (Negative lobe)
    );
}

// Main function: Samples the texture using a 4x4 Catmull-Rom filter
fn textureSampleCatmullRom(uv: vec2<f32>) -> vec4<f32> {
    let tex_size_u = textureDimensions(src_tex, 0);
    let tex_size = vec2<f32>(tex_size_u);

    let pixel_coord = uv * tex_size - vec2<f32>(0.5);
    let base_coord = vec2<i32>(floor(pixel_coord));
    let f = fract(pixel_coord);

    let wx = catmull_rom_weights(f.x);
    let wy = catmull_rom_weights(f.y);

    let max_coord = vec2<i32>(tex_size_u) - vec2<i32>(1, 1);

    var final_color = vec4<f32>(0.0);

    for (var y: i32 = 0; y < 4; y++) {
        var row_color = vec4<f32>(0.0);

        let current_y = base_coord.y - 1 + y;

        for (var x: i32 = 0; x < 4; x++) {
            let current_x = base_coord.x - 1 + x;

            var texel = vec4<f32>(0.0);

            if (current_x >= 0 && current_x <= max_coord.x &&
                current_y >= 0 && current_y <= max_coord.y) {
                texel = textureLoad(src_tex, vec2<i32>(current_x, current_y), 0);
                texel = to_linear_exact(texel);
            }

            row_color += texel * wx[x];
        }

        final_color += row_color * wy[y];
    }

    final_color = to_srgb_exact(final_color);
    return clamp(final_color, vec4<f32>(0.0), vec4<f32>(1.0));
}

fn downsample(src_start: vec2<f32>, scale: vec2<f32>) -> vec4<f32> {
    let dst_size = textureDimensions(dst_tex);
    let src_size = textureDimensions(src_tex);

    let src_size_f = vec2<f32>(src_size);
    let dst_size_f = vec2<f32>(dst_size);

    let src_end = src_start + vec2<f32>(1) * scale;

    let start_i = vec2<i32>(clamp(floor(src_start), vec2<f32>(0.0), src_size_f));
    let end_i   = vec2<i32>(clamp(ceil(src_end), vec2<f32>(0.0), src_size_f));

    var color_sum = vec4<f32>(0.0);
    var weight_sum = 0.0;

    for (var y: i32 = start_i.y; y < end_i.y; y++) {
        let y_f = f32(y);
        let y_overlap = max(0.0, min(y_f + 1.0, src_end.y) - max(y_f, src_start.y));

        for (var x: i32 = start_i.x; x < end_i.x; x++) {
            let x_f = f32(x);
            let x_overlap = max(0.0, min(x_f + 1.0, src_end.x) - max(x_f, src_start.x));

            let weight = x_overlap * y_overlap;
            var texel = textureLoad(src_tex, vec2<i32>(x, y), 0);
            texel = to_linear_exact(texel);

            color_sum += texel * weight;
            weight_sum += weight;
        }
    }

    var col = color_sum / weight_sum;
    return to_srgb_exact(col);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let dst_size = textureDimensions(dst_tex);
    let src_size = textureDimensions(src_tex);

    if (id.x >= dst_size.x || id.y >= dst_size.y) {
        return;
    }

    let src_size_f = vec2<f32>(src_size);
    let dst_size_f = vec2<f32>(dst_size);

    let aspect1 = vec2<f32>(src_size_f.x / src_size_f.y, 1);
    let aspect2 = vec2<f32>(dst_size_f.x / dst_size_f.y, 1);
    let aspect = aspect2 / aspect1;

    let ratio = dst_size_f / src_size_f;

    let scale = vec2(1.0 / transform.scale);
    let offset = transform.offset - vec2(0.5) + vec2(0.5) * ratio * scale;

    if (max(scale.x, scale.y) > 1.0) {
        let col = downsample(vec2<f32>(id.xy) * scale - offset * src_size_f, scale);
        textureStore(dst_tex, id.xy, col);
    } else {
        let uv = vec2<f32>(id.xy) / src_size_f * scale - offset;
        let col = textureSampleCatmullRom(uv);
        textureStore(dst_tex, id.xy, col);
    }
}`),
            },
        })

        const uniform_buffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })

        let fit = true

        let im: HTMLImageElement = new Image()
        let cubeTexture: GPUTexture | null = null

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

                cubeTexture?.destroy()
                cubeTexture = device.createTexture({
                    size: [im.width, im.height, 1],
                    format: "rgba8unorm",
                    usage:
                        GPUTextureUsage.TEXTURE_BINDING |
                        GPUTextureUsage.COPY_DST |
                        GPUTextureUsage.RENDER_ATTACHMENT,
                })
                device.queue.copyExternalImageToTexture({ source: im }, { texture: cubeTexture }, [
                    im.width,
                    im.height,
                ])

                this.el.classList.toggle("loading", false)

                if (fit) {
                    const zoom = Math.min(canvas.height / im.height, canvas.width / im.width)
                    move(0, 0, zoom)
                }
            }

            if (!cubeTexture) return

            const encoder = device.createCommandEncoder()

            const texture_canvas = context.getCurrentTexture().createView()

            const pass = encoder.beginComputePass()
            pass.setPipeline(pipeline_draw)
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: pipeline_draw.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: cubeTexture! },
                        { binding: 1, resource: texture_canvas },
                        { binding: 2, resource: uniform_buffer },
                    ],
                }),
            )
            pass.dispatchWorkgroups(Math.ceil(canvas.width / 16), Math.ceil(canvas.height / 16))
            pass.end()
            device.queue.submit([encoder.finish()])
        }

        const uniformData = new Float32Array(4)

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

            const ratiox = canvas.width / im.width
            const ratioy = canvas.height / im.height

            const new_zoom = tz + (tz0 - tz) * m
            const diff = 1 / new_zoom - 1 / tz0

            uniformData[0] = tx0 + (mx - 0.5) * diff * ratiox
            uniformData[1] = ty0 + (my - 0.5) * diff * ratioy
            uniformData[2] = new_zoom

            device.queue.writeBuffer(uniform_buffer, 0, uniformData)
            this.draw_image!()

            if (t < end_time) {
                requestAnimationFrame(animate_zoom)
            }
        }

        const animate_pan = () => {
            const t = performance.now()
            const m = Math.pow(Math.max(end_time - t, 0) / duration, 2)
            console.log("animate")
            uniformData[0] = tx + (tx0 - tx) * m
            uniformData[1] = ty + (ty0 - ty) * m

            device.queue.writeBuffer(uniform_buffer, 0, uniformData)
            this.draw_image!()

            if (t < end_time) {
                requestAnimationFrame(animate_pan)
            }
        }

        const move = (x: number, y: number, zoom: number, _duration = 0) => {
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

            console.log(tx, ty)

            uniformData[0] = x
            uniformData[1] = y
            uniformData[2] = zoom

            if (_duration == 0) {
                device.queue.writeBuffer(uniform_buffer, 0, uniformData)
                this.draw_image!()
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

            const ratiox = canvas.width / im.width
            const ratioy = canvas.height / im.height

            const new_zoom = Math.min(Math.max(0.01, zoom || 1), 1000)
            const diff = 1 / new_zoom - 1 / tz

            tx = tx + (x - 0.5) * diff * ratiox
            ty = ty + (y - 0.5) * diff * ratioy
            tz = new_zoom
            console.log(x, y, tx, ty)

            end_time = performance.now() + duration
            requestAnimationFrame(animate_zoom)

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

            const ratiox = canvas.width / im.width
            const ratioy = canvas.height / im.height

            move(tx + ((x - last_pos[0]) / tz) * ratiox, ty + ((y - last_pos[1]) / tz) * ratioy, tz)

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

                const ratiox = canvas.width / im.width
                const ratioy = canvas.height / im.height

                const new_zoom = tz * (dist / last_dist)
                const diff = 1 / new_zoom - 1 / tz

                last_dist = dist

                move(tx + (x - 0.5) * diff * ratiox, ty + (y - 0.5) * diff * ratioy, new_zoom)

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

        const toggle_fit = (x: number, y: number) => {
            const ratiox = canvas.width / im.width
            const ratioy = canvas.height / im.height

            if (!fit) {
                // scale to fit
                fit = true
                const new_zoom = Math.min(Math.max(0.01, Math.min(ratiox, ratioy)), 1000)
                if (tz == new_zoom) {
                    console.log("pan")
                    move(0, 0, new_zoom, 200)
                } else {
                    const diff = 1 / new_zoom - 1 / tz
                    zoom(-tx / (diff * ratiox) + 0.5, -ty / (diff * ratioy) + 0.5, new_zoom, 200)
                }
            } else {
                // 100%
                fit = false

                const diff = 1 - 1 / tz

                fit = false
                let offx = tx + (x - 0.5) * diff * ratiox
                let offy = ty + (y - 0.5) * diff * ratioy
                if (ratiox > 1) {
                    offx = 0
                }
                if (ratioy > 1) {
                    offy = 0
                }
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
