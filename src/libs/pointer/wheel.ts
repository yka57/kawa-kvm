/**
 * Wheel accumulator (spec §4.1): turns host wheel events into signed HID wheel
 * notches. Trackpads deliver small pixel deltas at 60-120 Hz (plus an
 * un-flagged momentum tail); a mouse wheel delivers one event per click.
 * Upstream sent one notch per event; this accumulates pixels instead.
 *
 * Pure: no DOM, no timers. The caller passes the event timestamp (`t`, ms).
 */
export interface WheelSettings {
  /** Host pixels of travel per HID notch (20..400, default 100). */
  pxPerNotch: number;
  /**
   * Existing "wheel direction" setting. -1 (default) sends host deltaY>0 as
   * wheel -1, exactly like upstream's `(deltaY > 0 ? 1 : -1) * direction`.
   */
  direction: 1 | -1;
  /**
   * Legacy "Wheel speed" slider: minimum ms between emitted notches, 0 = off.
   * Notches inside the window are DROPPED (upstream semantics kept on purpose).
   */
  minIntervalMs: number;
}

export const WHEEL = {
  /** Silence longer than this starts a new gesture (re-arms the kick). */
  GESTURE_GAP_MS: 200,
  /** The first notch of a gesture fires as soon as this many px accumulated. */
  KICK_MIN_PX: 3,
  /** A sign flip of at least this many px resets the gesture (immediate reverse notch). */
  REVERSAL_MIN_PX: 2,
  /** deltaMode 1 (lines) and 2 (pages) conversion. Chrome only ever sends mode 0. */
  LINE_PX: 16,
  PAGE_PX: 800,
  /** Wheel byte range; the CALLER clamps `feed()`'s result to ±MAX_NOTCHES. */
  MAX_NOTCHES: 127
} as const;

export const DEFAULT_WHEEL_SETTINGS: WheelSettings = {
  pxPerNotch: 100,
  direction: -1,
  minIntervalMs: 0
};

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: 0 | 1 | 2;
  /** Event timestamp in ms (`WheelEvent.timeStamp`). */
  t: number;
}

const MODE_SCALE: Record<number, number> = { 0: 1, 1: WHEEL.LINE_PX, 2: WHEEL.PAGE_PX };

type Sign = -1 | 0 | 1;

function sign(value: number): Sign {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function normalizeSettings(settings: WheelSettings): WheelSettings {
  const pxPerNotch =
    Number.isFinite(settings.pxPerNotch) && settings.pxPerNotch > 0
      ? settings.pxPerNotch
      : DEFAULT_WHEEL_SETTINGS.pxPerNotch;
  const direction: 1 | -1 = settings.direction < 0 ? -1 : 1;
  const minIntervalMs =
    Number.isFinite(settings.minIntervalMs) && settings.minIntervalMs > 0
      ? settings.minIntervalMs
      : 0;
  return { pxPerNotch, direction, minIntervalMs };
}

export class WheelAccumulator {
  private settings: WheelSettings;

  /** Pixels accumulated towards the next notch (signed). */
  private acc = 0;
  /** True until the first notch of the gesture has been emitted. */
  private kick = true;
  /** Dominant axis of the gesture, fixed by its first event with |delta| >= 1 px. */
  private axis: 'x' | 'y' | null = null;
  /** Direction of the gesture: the last notch emitted or the side of the last reversal (0 = none yet). */
  private gestureSign: Sign = 0;
  private lastT: number | null = null;
  /** Timestamp of the last emitted notch; only used by the legacy rate cap. */
  private lastEmit = -Infinity;

  constructor(settings: Partial<WheelSettings> = {}) {
    this.settings = normalizeSettings({ ...DEFAULT_WHEEL_SETTINGS, ...settings });
  }

  update(partial: Partial<WheelSettings>): void {
    this.settings = normalizeSettings({ ...this.settings, ...partial });
  }

  /**
   * Feed one wheel event. Returns the signed number of vertical notches to send
   * NOW (direction already applied), or 0. Values beyond ±MAX_NOTCHES are
   * returned as-is; the caller clamps (practically unreachable).
   */
  feed(event: WheelInput): number {
    const scale = MODE_SCALE[event.deltaMode] ?? 1;
    const px = event.deltaY * scale;
    const pxX = event.deltaX * scale;
    if (!Number.isFinite(px) || !Number.isFinite(pxX)) {
      return 0;
    }

    // 1. Gesture gap: silence > 200 ms starts a new gesture (lastEmit untouched).
    const t = event.t;
    if (this.lastT === null || t - this.lastT > WHEEL.GESTURE_GAP_MS) {
      this.startGesture();
    }
    this.lastT = t;

    // 2. Axis lock: the first event with max(|dx|,|dy|) >= 1 fixes the axis.
    //    A horizontal-dominant gesture emits nothing until the next gap.
    if (this.axis === null && Math.max(Math.abs(pxX), Math.abs(px)) >= 1) {
      this.axis = Math.abs(pxX) > Math.abs(px) ? 'x' : 'y';
    }
    if (this.axis === 'x') {
      this.acc = 0;
      return 0;
    }

    // 3. Reversal: a sign flip of >= 2 px zeroes the accumulator and re-arms the
    //    kick, so reversing mid-gesture produces an immediate reverse notch.
    //    The reference sign is the gesture's direction and, before any notch,
    //    sign(acc). (The spec's literal `sign(acc)` is degenerate at acc = 0
    //    right after a kick: it would either re-fire the kick on every event or
    //    miss a reversal that starts with a 1 px event.) The reversal itself
    //    turns the gesture around: following events of the new sign accumulate
    //    towards the kick instead of resetting it again (a slow 2-3 px/frame
    //    reverse scroll would otherwise never emit).
    const reference: Sign = this.gestureSign !== 0 ? this.gestureSign : sign(this.acc);
    if (reference !== 0 && Math.abs(px) >= WHEEL.REVERSAL_MIN_PX && sign(px) !== reference) {
      this.acc = 0;
      this.kick = true;
      this.gestureSign = sign(px);
    }

    // 4. Accumulate; whole notches leave the accumulator (remainder carried).
    this.acc += px;
    const { pxPerNotch } = this.settings;
    let n = Math.trunc(this.acc / pxPerNotch);
    if (n === 0 && this.kick && Math.abs(this.acc) >= WHEEL.KICK_MIN_PX) {
      // First notch of the gesture: a nudge or a slow wheel click moves one notch.
      n = sign(this.acc);
      this.acc = 0;
    } else if (n !== 0) {
      this.acc -= n * pxPerNotch;
    }
    if (n === 0) {
      return 0;
    }
    this.kick = false;
    this.gestureSign = sign(n);

    // 5. Legacy "Wheel speed" rate cap: DROP semantics, unchanged from upstream.
    const { minIntervalMs } = this.settings;
    if (minIntervalMs > 0 && t - this.lastEmit < minIntervalMs) {
      this.acc = 0;
      return 0;
    }
    this.lastEmit = t;

    return n * this.settings.direction;
  }

  /** Forget the current gesture (blur, mode switch, disconnect). */
  reset(): void {
    this.startGesture();
    this.lastT = null;
  }

  private startGesture(): void {
    this.acc = 0;
    this.kick = true;
    this.axis = null;
    this.gestureSign = 0;
  }
}
