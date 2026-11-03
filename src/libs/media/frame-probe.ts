/**
 * Frame probe (spec v2 §7): the browser bridge reads the target's screen
 * through the capture video to see a window open and its sentinel page
 * colours. The classification functions are pure and accept frames of any
 * size; only createVideoSampler touches the DOM.
 */

export interface Frame {
  w: number;
  h: number;
  /** RGBA, row-major, `w * h * 4` bytes. */
  data: Uint8ClampedArray;
}

export interface FrameSampler {
  /** The current video frame, downscaled; null when no frame can be read. */
  sample(): Frame | null;
  available(): boolean;
}

export const FRAME_W = 96;
export const FRAME_H = 54;
/** Share of changed pixels that means "a new window appeared". */
export const WINDOW_CHANGE_MIN = 0.1;
/**
 * Two samples about 300 ms apart that differ by less than this share count as
 * a still screen (spec v2 §14.3): scrolling or video must not pass for a window.
 */
export const SCREEN_STILL_MAX = 0.02;

export type Sentinel = 'magenta' | 'lime' | 'red' | 'blue';

/** |dr| + |dg| + |db| from which a pixel counts as changed. */
const CHANGE_MIN_DELTA = 96;
const PRESENT_MIN = 0.08;
const PRESENT_MARGIN = 0.06;
const GONE_MAX = 0.03;
const GONE_MARGIN = 0.02;

/**
 * Wide bounds on purpose: limited-range HDMI (16–235) and compression shift
 * the pure page colours, and the four ranges never overlap.
 */
export function classifyPixel(r: number, g: number, b: number): Sentinel | null {
  if (r >= 150 && b >= 150 && g <= 110) return 'magenta';
  if (g >= 150 && r <= 110 && b <= 110) return 'lime';
  if (r >= 150 && g <= 90 && b <= 90) return 'red';
  if (b >= 150 && r <= 90 && g <= 90) return 'blue';
  return null;
}

/** Pixel count of a well-formed frame, 0 for an empty or truncated one. */
function pixelCount(f: Frame): number {
  const n = f.w * f.h;
  return Number.isInteger(n) && n > 0 && f.data.length >= n * 4 ? n : 0;
}

function sameSize(a: Frame, b: Frame): boolean {
  return pixelCount(a) > 0 && a.w === b.w && a.h === b.h && pixelCount(b) > 0;
}

export function sentinelFraction(f: Frame, s: Sentinel): number {
  const n = pixelCount(f);
  if (n === 0) return 0;
  const { data } = f;
  let hits = 0;
  for (let p = 0; p < n * 4; p += 4) {
    if (classifyPixel(data[p], data[p + 1], data[p + 2]) === s) hits++;
  }
  return hits / n;
}

/** Share of pixels whose colour moved by at least CHANGE_MIN_DELTA; 0 for frames of different sizes. */
export function changedFraction(a: Frame, b: Frame): number {
  if (!sameSize(a, b)) return 0;
  const n = pixelCount(a);
  let changed = 0;
  for (let p = 0; p < n * 4; p += 4) {
    const delta =
      Math.abs(a.data[p] - b.data[p]) +
      Math.abs(a.data[p + 1] - b.data[p + 1]) +
      Math.abs(a.data[p + 2] - b.data[p + 2]);
    if (delta >= CHANGE_MIN_DELTA) changed++;
  }
  return changed / n;
}

/**
 * The sentinel covers a real share of the screen, clearly more than it did
 * in the baseline (whatever was already that colour does not count).
 */
export function sentinelPresent(f: Frame, base: Frame | null, s: Sentinel): boolean {
  if (base !== null && !sameSize(f, base)) return false;
  const baseline = base === null ? 0 : sentinelFraction(base, s);
  return sentinelFraction(f, s) >= Math.max(PRESENT_MIN, baseline + PRESENT_MARGIN);
}

/** The sentinel is back to (about) its baseline share; never true for a frame without pixels. */
export function sentinelGone(f: Frame, base: Frame | null, s: Sentinel): boolean {
  if (pixelCount(f) === 0 || (base !== null && !sameSize(f, base))) return false;
  const baseline = base === null ? 0 : sentinelFraction(base, s);
  return sentinelFraction(f, s) <= Math.max(GONE_MAX, baseline + GONE_MARGIN);
}

/**
 * Samples the capture video's intrinsic frame (drawImage ignores the CSS
 * scale and rotation applied to the element) into a FRAME_W × FRAME_H canvas.
 */
export function createVideoSampler(getVideo: () => HTMLVideoElement | null): FrameSampler {
  let context: CanvasRenderingContext2D | null = null;
  let warned = false;

  const readyVideo = (): HTMLVideoElement | null => {
    const video = getVideo();
    // HAVE_CURRENT_DATA: a frame is decoded and drawable
    return video !== null && video.readyState >= 2 && video.videoWidth > 0 ? video : null;
  };

  return {
    available: () => readyVideo() !== null,
    sample: () => {
      const video = readyVideo();
      if (video === null) return null;
      if (context === null) {
        const canvas = document.createElement('canvas');
        canvas.width = FRAME_W;
        canvas.height = FRAME_H;
        // polled every 100 ms: keep the bitmap on the CPU for getImageData
        context = canvas.getContext('2d', { willReadFrequently: true });
        if (context === null) return null;
      }
      try {
        context.drawImage(video, 0, 0, FRAME_W, FRAME_H);
        return { w: FRAME_W, h: FRAME_H, data: context.getImageData(0, 0, FRAME_W, FRAME_H).data };
      } catch (error) {
        // polled every 100 ms: say it once, the bridge then stops on its timeout
        if (!warned) console.warn('[paste] video frame not readable', error);
        warned = true;
        return null;
      }
    }
  };
}
