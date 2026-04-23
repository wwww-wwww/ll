import { ViewHook } from "phoenix_live_view"

class Reader extends ViewHook {
    device: GPUDevice | null = null

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
        const pages = JSON.parse(this.el.getAttribute("pages")!)
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
    let offset = (transform.offset) - vec2(0.5, 0) + vec2(0.5 * ratio.x * scale.x, 0);

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

        let page = 0
        let im: HTMLImageElement | null = null

        im = new Image()
        im.src = pages[page]
        await im.decode()

        let cubeTexture = device.createTexture({
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

        const uniform_buffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })

        let fit = true

        const draw_image = async () => {
            const encoder = device.createCommandEncoder()

            const texture_canvas = context.getCurrentTexture().createView()

            const pass = encoder.beginComputePass()
            pass.setPipeline(pipeline_draw)
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: pipeline_draw.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: cubeTexture },
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

        const e_zoom = this.el.querySelector(".img-nav-info>.zoom")!

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
                const zoom = canvas.height / im.height
                move(0, 0, zoom)
            }
            draw_image()
        })

        observer.observe(this.el)

        canvas.addEventListener("wheel", e => {
            const rect = canvas.getBoundingClientRect()
            let x = 0.5 - (e.clientX - rect.x) / rect.width
            let y = (e.clientY - rect.y) / rect.height

            const ratiox = canvas.width / im.width
            const ratioy = canvas.height / im.height

            let off = e.deltaY > 0 ? -0.05 : +0.05
            let new_zoom = Math.pow(10, Math.log10(uniformData[2]) + off)
            let diff = 1 / new_zoom - 1 / uniformData[2]

            fit = false

            move(
                uniformData[0] - x * diff * ratiox,
                uniformData[1] + y * diff * ratioy,
                new_zoom,
            )

            draw_image()
        })

        let start = [0, 0]
        let base = [0, 0]

        canvas.addEventListener("pointerdown", e => {
            e.preventDefault()
            if (e.button != 0) return
            canvas.setPointerCapture(e.pointerId)
            canvas.classList.toggle("grabbing", true)

            const rect = canvas.getBoundingClientRect()
            let x = (e.clientX - rect.x) / rect.width
            let y = (e.clientY - rect.y) / rect.height
            base = [uniformData[0], uniformData[1]]
            start = [x, y]
        })

        canvas.addEventListener("pointermove", e => {
            if (!canvas.hasPointerCapture(e.pointerId)) return

            const rect = canvas.getBoundingClientRect()
            let x = (e.clientX - rect.x) / rect.width
            let y = (e.clientY - rect.y) / rect.height

            const ratiox = canvas.width / im.width
            const ratioy = canvas.height / im.height

            move(
                base[0] + (x - start[0]) * 1 / uniformData[2] * ratiox,
                base[1] + (y - start[1]) * 1 / uniformData[2] * ratioy,
                uniformData[2],
            )
            draw_image()
        })

        window.addEventListener("pointerup", e => {
            if (!canvas.hasPointerCapture(e.pointerId)) return
            canvas.releasePointerCapture(e.pointerId)
            canvas.classList.toggle("grabbing", false)

            const rect = canvas.getBoundingClientRect()
            let x = (e.clientX - rect.x) / rect.width
            let y = (e.clientY - rect.y) / rect.height
            if (x == start[0] && y == start[1]) {
                if (!fit) {
                    // scale to fit
                    fit = true
                    const zoom = canvas.height / im.height
                    move(0, 0, zoom)
                } else {
                    // 100%
                    fit = false
                    move(0, 0, 1)
                }
            } else {
                fit = false
                const ratiox = canvas.width / im.width
                const ratioy = canvas.height / im.height

                move(
                    base[0] + (x - start[0]) * 1 / uniformData[2] * ratiox,
                    base[1] + (y - start[1]) * 1 / uniformData[2] * ratioy,
                    uniformData[2],
                )
            }

            device.queue.writeBuffer(uniform_buffer, 0, uniformData)
            draw_image()
        })

        window.addEventListener("keydown", async e => {
            if (e.key == "ArrowLeft") {
                e.preventDefault()

                page = Math.max(page - 1, 0)

                {
                    im = new Image()
                    im.src = pages[page]
                    await im.decode()
                    cubeTexture = device.createTexture({
                        size: [im.width, im.height, 1],
                        format: "rgba8unorm",
                        usage:
                            GPUTextureUsage.TEXTURE_BINDING |
                            GPUTextureUsage.COPY_DST |
                            GPUTextureUsage.RENDER_ATTACHMENT,
                    })
                    device.queue.copyExternalImageToTexture(
                        { source: im },
                        { texture: cubeTexture },
                        [im.width, im.height],
                    )
                    if (fit) {
                        const zoom = canvas.height / im.height
                        move(0, 0, zoom)
                    }
                }
                draw_image()
            }
            if (e.key == "ArrowRight") {
                e.preventDefault()

                page = Math.min(page + 1, pages.length - 1)

                {
                    im = new Image()
                    im.src = pages[page]
                    await im.decode()
                    cubeTexture = device.createTexture({
                        size: [im.width, im.height, 1],
                        format: "rgba8unorm",
                        usage:
                            GPUTextureUsage.TEXTURE_BINDING |
                            GPUTextureUsage.COPY_DST |
                            GPUTextureUsage.RENDER_ATTACHMENT,
                    })
                    device.queue.copyExternalImageToTexture(
                        { source: im },
                        { texture: cubeTexture },
                        [im.width, im.height],
                    )
                    if (fit) {
                        const zoom = canvas.height / im.height
                        move(0, 0, zoom)
                    }
                }
                draw_image()
            }
        })
    }

    mounted() {
        this.init()
    }
}

export { Reader }
