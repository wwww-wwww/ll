/**
 * WebGPU image viewer.
 *
 *   renderer/renderer.ts        device, surface, frame loop
 *   renderer/image.ts           a decoded page and its mip pyramid
 *   renderer/mipmap.ts          one mip level, cut into tiles
 *   renderer/renderpage.ts      the image shaders
 *   renderer/fullscreen.ts      one triangle over the destination
 *   renderer/rescaler.ts        how a tile is resized
 *   renderer/tilerenderer.ts    the progressive sharp-tile cache
 *   draw/                       immediate-mode primitives and text
 *   viewer/imagepage.ts         page geometry, bounds, animation
 *   viewer/imageviewerstate.ts  paging and the draw loop
 *   viewer/imageviewer.ts       the gesture state machine
 *   viewer/gestures.ts          pointer plumbing
 *   transition/                 page-turn animations and their cache
 *   filter/                     output filters
 *   imageutil.ts                the mipmap box filter
 *   trim.ts                     margin trim and background detection
 */

export * from "./util"
export * from "./imageutil"
export * from "./trim"

export { WebGpuRenderer } from "./renderer/renderer"
export { Image, BUFFER_SIZE } from "./renderer/image"
export type { ImageOptions, MipMapForDraw, Placement, TileForDraw } from "./renderer/image"
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

export {
    TRANSITIONS,
    SpreadPosition,
    ProgressPage,
    ErrorPage,
    Viewer,
} from "./viewer/viewer"
export type { FitMode, ZoomStart, TransitionName, ViewerConfig } from "./viewer/viewer"
