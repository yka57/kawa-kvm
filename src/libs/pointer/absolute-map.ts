import type { Rotation } from '@/types';

/**
 * Absolute-mode coordinate mapping (spec §4.1). Pure, no DOM: the component
 * passes `getBoundingClientRect()` (which already includes the CSS
 * `scale()`/`rotate()` transforms) and the video's intrinsic size.
 */
export interface ClientPoint {
  clientX: number;
  clientY: number;
}

export interface ElementRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface VideoSize {
  width: number;
  height: number;
}

export const ABS_MAX = 4095;

/**
 * Map a client-space point to normalized video-source coordinates (0..1 inside
 * the picture; outside that range over the letterbox bars, exactly like the
 * legacy `getCoordinate`). `video` is null before metadata is known.
 *
 * Rotation: the picture is letterboxed inside the element's own box and the
 * whole element is then rotated about its center, which is the same as
 * letterboxing the swapped aspect inside the rotated rect and applying the
 * inverse rotation to the display-normalized point.
 */
export function mapClientToVideo(
  p: ClientPoint,
  rect: ElementRect,
  video: VideoSize | null,
  rotation: Rotation
): { x: number; y: number } {
  const clientX = p.clientX;
  const clientY = p.clientY;

  if (!video || !(video.width > 0) || !(video.height > 0)) {
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return { x, y };
  }

  const swapped = rotation === 90 || rotation === 270;
  const displayedWidth = swapped ? video.height : video.width;
  const displayedHeight = swapped ? video.width : video.height;

  const videoRatio = displayedWidth / displayedHeight;
  const elementRatio = rect.width / rect.height;

  let renderedWidth = rect.width;
  let renderedHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;

  if (videoRatio > elementRatio) {
    renderedHeight = rect.width / videoRatio;
    offsetY = (rect.height - renderedHeight) / 2;
  } else {
    renderedWidth = rect.height * videoRatio;
    offsetX = (rect.width - renderedWidth) / 2;
  }

  const dx = (clientX - rect.left - offsetX) / renderedWidth;
  const dy = (clientY - rect.top - offsetY) / renderedHeight;

  // Inverse of CSS rotate(<rotation>deg) (clockwise).
  switch (rotation) {
    case 90:
      return { x: dy, y: 1 - dx };
    case 180:
      return { x: 1 - dx, y: 1 - dy };
    case 270:
      return { x: 1 - dy, y: dx };
    default:
      return { x: dx, y: dy };
  }
}

/**
 * Normalized 0..1 → CH9329 absolute coordinate 0..4095. Identical to upstream's
 * `floor(clamp01(v) * 4096)` except at v = 1.0, which now yields 4095 instead of
 * the out-of-range 4096. NaN maps to 0 (as upstream's `NaN & 0xff` did).
 */
export function toAbs4095(value: number): number {
  if (!(value > 0)) {
    return 0;
  }
  return Math.min(ABS_MAX, Math.floor(Math.min(1, value) * 4096));
}
