/**
 * Relative-mode motion (spec §4.1): applies the pointer-speed gain and carries
 * the signed sub-pixel remainders so slow motion is never lost to truncation
 * (replaces upstream's `|d*DPR| < 10 ? d*2 : d` rule). Pure, no DOM.
 */
export const RELATIVE = { GAIN_MIN: 0.25, GAIN_MAX: 4 } as const;

function clampGain(gain: number): number {
  if (!Number.isFinite(gain)) {
    return 1;
  }
  return Math.max(RELATIVE.GAIN_MIN, Math.min(RELATIVE.GAIN_MAX, gain));
}

export class RelativeMotion {
  private gain: number;
  private remX = 0;
  private remY = 0;

  constructor(gain = 1) {
    this.gain = clampGain(gain);
  }

  setGain(gain: number): void {
    this.gain = clampGain(gain);
  }

  /** Scaled integer deltas; the fractional parts are carried to the next call. */
  feed(dx: number, dy: number): { dx: number; dy: number } {
    const fx = (Number.isFinite(dx) ? dx : 0) * this.gain + this.remX;
    const fy = (Number.isFinite(dy) ? dy : 0) * this.gain + this.remY;
    const ox = Math.trunc(fx) || 0;
    const oy = Math.trunc(fy) || 0;
    this.remX = fx - ox;
    this.remY = fy - oy;
    return { dx: ox, dy: oy };
  }

  /** Drop the carried remainders (pointer lock lost, mode switch). */
  reset(): void {
    this.remX = 0;
    this.remY = 0;
  }
}

/**
 * Split a delta into int8 report chunks: 300 → [127, 127, 46], -130 → [-127, -3],
 * 0 → []. Non-integers are rounded like `buildReport` does.
 */
export function splitInt8(value: number): number[] {
  if (!Number.isFinite(value)) {
    return [];
  }
  let rest = Math.round(value);
  const chunks: number[] = [];
  while (rest !== 0) {
    const chunk = Math.max(-127, Math.min(127, rest));
    chunks.push(chunk);
    rest -= chunk;
  }
  return chunks;
}
