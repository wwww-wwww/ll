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
        
        // Let the Y coordinate go outside the image bounds naturally
        let current_y = base_coord.y - 1 + y;
        
        for (var x: i32 = 0; x < 4; x++) {
            
            // Let the X coordinate go outside bounds
            let current_x = base_coord.x - 1 + x;
            
            var texel = vec4<f32>(0.0); // Default to fully transparent
            
            // Only read the texture if we are strictly inside the image!
            if (current_x >= 0 && current_x <= max_coord.x && 
                current_y >= 0 && current_y <= max_coord.y) {
                
                texel = textureLoad(src_tex, vec2<i32>(current_x, current_y), 0);
            }
            
            row_color += texel * wx[x];
        }
        
        final_color += row_color * wy[y];
    }
    
    // ⚠️ CRUCIAL: Clamp the final color to prevent negative alpha!
    // Because Catmull-Rom has negative curve weights, interpolating between
    // a bright edge pixel (1.0) and a transparent out-of-bounds pixel (0.0) 
    // can cause the alpha to dip to -0.1, which causes weird blending bugs.
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

                {
                    const next = new Image()
                    next.src = this.files[Math.min(this.page + 1, this.files.length - 1)]
                    next.decode()
                }

                {
                    const next = new Image()
                    next.src = this.files[Math.max(this.page - 1, 0)]
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

        const move = (x: number, y: number, zoom: number) => {
            uniformData[0] = x
            uniformData[1] = y
            uniformData[2] = zoom

            device.queue.writeBuffer(uniform_buffer, 0, uniformData)
            e_zoom.textContent = `${(zoom * 100).toFixed(2)}%`
        }

        const observer = new ResizeObserver(() => {
            const rect = this.el.getBoundingClientRect()
            canvas.width = rect.width
            canvas.height = rect.height

            if (fit) {
                const zoom = Math.min(canvas.height / im.height, canvas.width / im.width)
                move(0, 0, zoom)
            }

            this.draw_image!()
        })

        observer.observe(this.el)

        let last_pos = [0, 0]
        let start = [0, 0]

        const pan = (e: MouseEvent) => {
            if (!canvas.hasPointerCapture(0)) return

            const rect = canvas.getBoundingClientRect()
            const x = (e.clientX - rect.x) / rect.width
            const y = (e.clientY - rect.y) / rect.height

            const ratiox = canvas.width / im.width
            const ratioy = canvas.height / im.height

            move(
                uniformData[0] + ((x - last_pos[0]) / uniformData[2]) * ratiox,
                uniformData[1] + ((y - last_pos[1]) / uniformData[2]) * ratioy,
                uniformData[2],
            )

            last_pos = [x, y]
        }

        canvas.addEventListener("wheel", e => {
            pan(e)

            fit = false

            const rect = canvas.getBoundingClientRect()
            const x = (e.clientX - rect.x) / rect.width
            const y = (e.clientY - rect.y) / rect.height

            const ratiox = canvas.width / im.width
            const ratioy = canvas.height / im.height

            const off = e.deltaY > 0 ? -0.05 : +0.05
            const new_zoom = Math.pow(10, Math.log10(uniformData[2]) + off)
            const diff = 1 / new_zoom - 1 / uniformData[2]

            move(
                uniformData[0] + (x - 0.5) * diff * ratiox,
                uniformData[1] + (y - 0.5) * diff * ratioy,
                new_zoom,
            )

            this.draw_image!()
        })

        canvas.addEventListener("pointerdown", e => {
            if (e.button != 0) return
            canvas.setPointerCapture(e.pointerId)
            e.preventDefault()
            canvas.classList.toggle("grabbing", true)

            const rect = canvas.getBoundingClientRect()
            const x = (e.clientX - rect.x) / rect.width
            const y = (e.clientY - rect.y) / rect.height

            last_pos = [x, y]
            start = [x, y]
        })

        const update_cursor = (e: PointerEvent) => {
            const rect = canvas.getBoundingClientRect()
            const x = (e.clientX - rect.x) / rect.width

            if (x < 1 / 3) {
                this.el.classList.toggle("cursor-left", this.page > 0 || this.prev_chapter != null)
                this.el.classList.toggle("cursor-right", false)
                this.el.classList.toggle("cursor-zoom-out", false)
                this.el.classList.toggle("cursor-zoom-in", false)
            } else if (x > 2 / 3) {
                this.el.classList.toggle("cursor-left", false)
                this.el.classList.toggle(
                    "cursor-right",
                    this.page < this.files.length - 1 || this.next_chapter != null,
                )
                this.el.classList.toggle("cursor-zoom-out", false)
                this.el.classList.toggle("cursor-zoom-in", false)
            } else {
                this.el.classList.toggle("cursor-left", false)
                this.el.classList.toggle("cursor-right", false)
                this.el.classList.toggle("cursor-zoom-out", !fit)
                this.el.classList.toggle("cursor-zoom-in", fit)
            }
        }

        canvas.addEventListener("pointermove", e => {
            update_cursor(e)

            if (!canvas.hasPointerCapture(e.pointerId)) return

            pan(e)

            this.draw_image!()
        })

        canvas.addEventListener("pointerup", e => {
            if (!canvas.hasPointerCapture(e.pointerId)) return
            canvas.releasePointerCapture(e.pointerId)
            canvas.classList.toggle("grabbing", false)

            const rect = canvas.getBoundingClientRect()
            const x = (e.clientX - rect.x) / rect.width
            const y = (e.clientY - rect.y) / rect.height
            if (x == start[0] && y == start[1]) {
                if (x < 1 / 3) {
                    this.set_page(this.page - 1)
                } else if (x > 2 / 3) {
                    this.set_page(this.page + 1)
                } else {
                    const ratiox = canvas.width / im.width
                    const ratioy = canvas.height / im.height

                    if (!fit) {
                        // scale to fit
                        fit = true
                        const zoom = Math.min(ratiox, ratioy)
                        move(0, 0, zoom)
                    } else {
                        // 100%
                        fit = false

                        const diff = 1 - 1 / uniformData[2]

                        fit = false
                        let offx = uniformData[0] + (x - 0.5) * diff * ratiox
                        let offy = uniformData[1] + (y - 0.5) * diff * ratioy
                        if (ratiox > 1) {
                            offx = 0
                        }
                        if (ratioy > 1) {
                            offy = 0
                        }
                        move(offx, offy, 1)
                    }
                }

                update_cursor(e)
            } else {
                fit = false
                pan(e)
            }

            this.draw_image!()
        })
    }

    private e_page!: HTMLElement
    private e_interstitial!: HTMLElement

    private next_chapter!: HTMLElement | null
    private prev_chapter!: HTMLElement | null

    set_page(page: number, push_state: boolean = true) {
        if (this.files.length == 0) return

        if (page == this.files.length || page == -1) {
            let next_chapter: HTMLElement | null = null

            next_chapter = page == this.files.length ? this.next_chapter : this.prev_chapter

            if (!next_chapter) return

            if (this.e_interstitial.classList.contains("visible")) {
                next_chapter.querySelector("a")?.click()
                this.e_interstitial.classList.toggle("visible", false)
                return
            }

            this.e_interstitial.onclick = e => {
                const rect = this.e_interstitial.getBoundingClientRect()
                const x = (e.clientX - rect.x) / rect.width
                if ((page == this.files.length && x > 0.5) || (page == -1 && x < 0.5)) {
                    next_chapter.querySelector("a")?.click()
                } else {
                    this.e_interstitial.classList.toggle("visible", false)
                }
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

        let mounted = false

        const chapters = Array.from(document.getElementById("chapterlist")!.children)

        {
            const current_index = chapters.findIndex(e => e.classList.contains("selected"))
            this.next_chapter = chapters.at(current_index - 1) as HTMLElement
            this.prev_chapter = chapters.at(current_index + 1) as HTMLElement
        }

        this.files = JSON.parse(this.el.dataset.files! || "[]")

        this.handleEvent("files", data => {
            if (!mounted) return
            console.info("files", data, window.history.state)
            this.files = data.files
            this.loaded_page = -1
            this.e_interstitial.classList.toggle("visible", false)
            const current_index = chapters.findIndex(e => e.classList.contains("selected"))

            if (this.prev_chapter == chapters.at(current_index)) {
                this.set_page(this.files.length - 1, false)
            } else {
                this.set_page(window.history.state.page || 0, false)
            }

            this.next_chapter = chapters.at(current_index - 1) as HTMLElement
            this.prev_chapter = chapters.at(current_index + 1) as HTMLElement
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

                this.set_page(this.page - 1)
            }
            if (e.key == "ArrowRight") {
                e.preventDefault()

                this.set_page(this.page + 1)
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
