/**
 * Slider ↔ setting mappings for the mouse menu (spec §4.3). Pure, no DOM.
 *
 * Every slider runs 0..100. The inverse functions of the two new sliders
 * return integer slider positions (clamped), so a value read back from
 * storage lands exactly on the stop it was saved from (see the round-trip
 * tests). The legacy "Wheel speed" mapping is upstream's, unchanged.
 */
export const SLIDER = { MIN: 0, MAX: 100 } as const;

/** Legacy "Wheel speed": interval = 300 − 3·speed ms (upstream mapping; 100 ↔ 0 ms = off). */
export const WHEEL_SPEED = { MAX_INTERVAL_MS: 300, DEFAULT_SLIDER: 100 } as const;

/**
 * "Scroll sensitivity": pxPerNotch = round(400 · 0.1^(v/100)).
 * 0 ↔ 400 px (slow), 60 ↔ 100 px (default), 100 ↔ 40 px (fast).
 */
export const SCROLL_SENSITIVITY = { MAX_PX: 400, RATIO: 0.1, DEFAULT_SLIDER: 60 } as const;

/**
 * "Pointer speed" (relative mode): gain = 0.25 · 16^(v/100).
 * 0 ↔ 0.25×, 50 ↔ 1.0× (default), 100 ↔ 4×.
 */
export const POINTER_SPEED = { MIN_GAIN: 0.25, RATIO: 16, DEFAULT_SLIDER: 50 } as const;

function clampSlider(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(SLIDER.MAX, Math.max(SLIDER.MIN, value));
}

/** Legacy "Wheel speed" slider position → minimum ms between notches (upstream formula). */
export function wheelSpeedToInterval(speed: number): number {
  const v = clampSlider(speed, WHEEL_SPEED.DEFAULT_SLIDER);
  return WHEEL_SPEED.MAX_INTERVAL_MS - v * (WHEEL_SPEED.MAX_INTERVAL_MS / 100);
}

/** Minimum ms between notches → legacy "Wheel speed" slider position (upstream formula). */
export function intervalToWheelSpeed(interval: number): number {
  if (!Number.isFinite(interval)) {
    return WHEEL_SPEED.DEFAULT_SLIDER;
  }
  const ms = Math.min(WHEEL_SPEED.MAX_INTERVAL_MS, Math.max(0, interval));
  return ((WHEEL_SPEED.MAX_INTERVAL_MS - ms) * 100) / WHEEL_SPEED.MAX_INTERVAL_MS;
}

/** "Scroll sensitivity" slider position → host pixels per wheel notch (40..400). */
export function sliderToPxPerNotch(value: number): number {
  const v = clampSlider(value, SCROLL_SENSITIVITY.DEFAULT_SLIDER);
  return Math.round(SCROLL_SENSITIVITY.MAX_PX * SCROLL_SENSITIVITY.RATIO ** (v / 100));
}

/** Host pixels per wheel notch → nearest "Scroll sensitivity" slider position. */
export function pxPerNotchToSlider(pxPerNotch: number): number {
  if (!Number.isFinite(pxPerNotch) || pxPerNotch <= 0) {
    return SCROLL_SENSITIVITY.DEFAULT_SLIDER;
  }
  const v =
    (100 * Math.log(SCROLL_SENSITIVITY.MAX_PX / pxPerNotch)) /
    Math.log(1 / SCROLL_SENSITIVITY.RATIO);
  return Math.round(clampSlider(v, SCROLL_SENSITIVITY.DEFAULT_SLIDER));
}

/** "Pointer speed" slider position → relative-mode gain (0.25..4, 4 decimals). */
export function sliderToGain(value: number): number {
  const v = clampSlider(value, POINTER_SPEED.DEFAULT_SLIDER);
  const gain = POINTER_SPEED.MIN_GAIN * POINTER_SPEED.RATIO ** (v / 100);
  return Math.round(gain * 1e4) / 1e4;
}

/** Relative-mode gain → nearest "Pointer speed" slider position. */
export function gainToSlider(gain: number): number {
  if (!Number.isFinite(gain) || gain <= 0) {
    return POINTER_SPEED.DEFAULT_SLIDER;
  }
  const v = (100 * Math.log(gain / POINTER_SPEED.MIN_GAIN)) / Math.log(POINTER_SPEED.RATIO);
  return Math.round(clampSlider(v, POINTER_SPEED.DEFAULT_SLIDER));
}
