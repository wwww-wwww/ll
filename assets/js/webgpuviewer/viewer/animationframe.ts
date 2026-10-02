/** One decoded animation frame, as `ImageSingle.animate` asks for it. */
export class AnimationFrame {
    constructor(
        /** The whole canvas, as `Image` takes it. */
        readonly pixels: Uint8Array,
        /** Display time in ms. */
        readonly duration: number,
        private readonly onClose: () => void = () => { },
    ) { }

    close() {
        this.onClose()
    }
}
