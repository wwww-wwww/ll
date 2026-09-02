/**
 * `ca.mpreg.webgpuviewer`, ported to TypeScript.
 *
 * Layout mirrors the Kotlin package so the two can be read side by side:
 *
 *   renderer/renderer.ts     WebGpuRenderer.kt      device, surface, frame loop
 *   renderer/image.ts        renderer/Image.kt      a decoded page and its mip pyramid
 *   renderer/mipmap.ts       renderer/Mipmap.kt     one mip level, cut into tiles
 *   renderer/renderpage.ts   renderer/RenderPage.kt the image shaders
 *   renderer/fullscreen.ts   renderer/Fullscreen.kt one triangle over the destination
 *   renderer/rescaler.ts     renderer/Rescaler.kt   how a tile is resized
 *   renderer/tilerenderer.ts renderer/TileRenderer.kt  the progressive sharp-tile cache
 *   draw/draw.ts             draw/{Draw,Rect,Circle,Clear}.kt
 *   draw/text.ts             draw/Text.kt           (canvas-rasterised, not a glyph atlas)
 *   draw/line.ts             draw/Line.kt
 *   viewer/imagepage.ts      viewer/ImagePage.kt    page geometry, bounds, animation
 *   viewer/imageviewerstate.ts viewer/ImageViewerState.kt  paging and the draw loop
 *   viewer/imageviewer.ts    viewer/ImageViewer.kt  the gesture state machine
 *   viewer/gestures.ts       extensions.kt          the pointer plumbing Compose supplied
 *   transition/*.ts          transition/*.kt        page-turn animations and their cache
 *   imageutil.ts             cpp/resize.cpp         the mipmap box filter
 *   trim.ts                  cpp/trim.cpp           margin trim and background detection
 *
 * The two native libraries are implemented in TypeScript here rather than called through wasm.
 */

export * from "./util"
export * from "./imageutil"
export * from "./trim"

export { WebGpuRenderer } from "./renderer/renderer"
export { Image, BUFFER_SIZE } from "./renderer/image"
export type { ImageOptions, MipMapForDraw, TileForDraw } from "./renderer/image"
export { Mipmap, Quad } from "./renderer/mipmap"
export type { TileRect } from "./renderer/mipmap"
export { RenderPage, Variant } from "./renderer/renderpage"
export type { Filtered } from "./renderer/renderpage"
export { Fullscreen } from "./renderer/fullscreen"
export { Rescaler, Upscaler, Downscaler } from "./renderer/rescaler"
export { UpscalerCatmullRom, CATMULL_ROM_CODE } from "./renderer/upscalercatmullrom"
export { DownscalerBox, BOX_CODE } from "./renderer/downscalerbox"
export { UpscalerArtCnn } from "./renderer/upscalerartcnn"
export { TileRenderer, TILE_SIZE, solveImagePlacement } from "./renderer/tilerenderer"

export { Draw } from "./draw/draw"
export { drawLine } from "./draw/line"
export { clearTextCache, drawText } from "./draw/text"
export type { TextAlign, TextOptions } from "./draw/text"

export {
    FADE_MILLIS,
    DummyPage,
    ImagePage,
    ImageSingle,
    ImageSpread,
    RenderPageBase,
} from "./viewer/imagepage"
export { ImageViewerState } from "./viewer/imageviewerstate"
export { ImageViewerElement } from "./viewer/imageviewer"
export { GestureEvent, PointerStream } from "./viewer/gestures"

export {
    Transition,
    beginClearedPass,
    blendBackgroundColor,
    blitCached,
    getCachedTexture,
    invalidateCache,
    rotateCacheOnPageChange,
} from "./transition/transition"
export {
    TransitionBasic,
    TransitionBasicVerticalInstance,
    TransitionCube,
    TransitionCubeOuter,
    TransitionFlip,
    TransitionFade,
    TransitionFadeWhite,
    TransitionFlipLeft,
    TransitionFlipRight,
    TransitionNone,
    TransitionSphere,
    TransitionStackDown,
    TransitionStackLeft,
    TransitionStackRight,
    TransitionStackUp,
} from "./transition/transitions"
