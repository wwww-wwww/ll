/**
 * A GPU object built once per target texture format and kept - the port of `renderer/FormatKeyed.kt`.
 *
 * A render pipeline bakes its colour target's format, so one cached pipeline serves one format -
 * letting an SDR page and an HDR page draw in the same frame. An SDR-only session still builds
 * exactly what it always did, since nothing ever asks this for a second format.
 */
export class FormatKeyed<T> {
    private readonly byFormat = new Map<GPUTextureFormat, T>()

    constructor(private readonly build: (format: GPUTextureFormat) => T) { }

    get(format: GPUTextureFormat): T {
        let value = this.byFormat.get(format)
        if (value === undefined) {
            value = this.build(format)
            this.byFormat.set(format, value)
        }
        return value
    }
}

/** A storage texture's format is shader text, so it is interpolated in, not passed as a value. */
export function wgslStorageFormat(format: GPUTextureFormat): string {
    switch (format) {
        case "rgba16float":
            return "rgba16float"
        case "rgba8unorm":
            return "rgba8unorm"
        default:
            throw new Error(`No WGSL storage format for ${format}`)
    }
}
