import { Offset } from "../util"
import type { TileRenderer } from "../renderer/tilerenderer"
import type { ImagePage } from "../viewer/imagepage"
import { Transition, beginClearedPass, blitCached, getCachedTexture } from "./transition"

/**
 * Port of the `TransitionStack{Up,Down,Left,Right}` family.
 *
 * One page stays put while the other slides over or out from under it, which is the whole
 * difference from [TransitionBasic]: there both pages move together, here only one does. Which one
 * moves, and in which direction, is all four variants differ by - so they share a body here rather
 * than being four near-identical files.
 *
 * The stationary page is drawn first so the moving one lands on top of it.
 */
class TransitionStack extends Transition {
    /**
     * @param axis which way the moving page travels
     * @param sign +1 for a slide toward positive (down/right), -1 for up/left
     * @param movesIncoming true when the *incoming* page is the one that moves on a forward turn
     */
    constructor(
        private readonly axis: "x" | "y",
        private readonly sign: number,
        private readonly movesIncoming: boolean,
    ) {
        super()
    }

    private place(
        pass: GPURenderPassEncoder,
        dst: GPUTexture,
        page: ImagePage,
        cached: GPUTextureView | null,
        offset: number,
    ) {
        const x = this.axis === "x" ? offset : 0
        const y = this.axis === "y" ? offset : 0
        page.drawBackgroundColumns(pass, dst, x, y)
        blitCached(pass, cached, x, y)
    }

    render(
        page1: ImagePage,
        page2: ImagePage,
        encoder: GPUCommandEncoder,
        dst: GPUTexture,
        frac: number,
        pos1: Offset,
        pos2: Offset,
        tiles: TileRenderer,
    ) {
        const cached1 = getCachedTexture(page1, true, encoder, dst.width, dst.height, tiles)
        const cached2 = getCachedTexture(page2, false, encoder, dst.width, dst.height, tiles)

        const pass = beginClearedPass(encoder, dst)
        try {
            // Forward (frac > 0) the moving page travels by `frac`; backward it starts a full
            // screen out and travels by `frac + 1`. Which page moves swaps with the direction, so
            // the same page is always revealed rather than covered.
            if (frac > 0) {
                if (this.movesIncoming) {
                    this.place(pass, dst, page1, cached1, 0)
                    this.place(pass, dst, page2, cached2, this.sign * (1 - frac))
                } else {
                    this.place(pass, dst, page2, cached2, 0)
                    this.place(pass, dst, page1, cached1, this.sign * frac)
                }
            } else {
                if (this.movesIncoming) {
                    this.place(pass, dst, page2, cached2, 0)
                    this.place(pass, dst, page1, cached1, this.sign * -frac)
                } else {
                    this.place(pass, dst, page1, cached1, 0)
                    this.place(pass, dst, page2, cached2, this.sign * (frac + 1))
                }
            }
        } finally {
            pass.end()
        }
    }
}

/** The outgoing page slides up, revealing the incoming one underneath. */
export const TransitionStackUp = new TransitionStack("y", -1, false)

/** As [TransitionStackUp], downward. */
export const TransitionStackDown = new TransitionStack("y", 1, false)

/** The outgoing page slides left, revealing the incoming one underneath. */
export const TransitionStackLeft = new TransitionStack("x", -1, false)

/** The incoming page slides in from the right, over the outgoing one. */
export const TransitionStackRight = new TransitionStack("x", 1, true)
