import { describe, expect, it } from 'vitest';

import { RELATIVE, RelativeMotion, splitInt8 } from './relative-motion';

function feedN(motion: RelativeMotion, n: number, dx: number, dy: number) {
  const outs: Array<{ dx: number; dy: number }> = [];
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    const out = motion.feed(dx, dy);
    outs.push(out);
    sumX += out.dx;
    sumY += out.dy;
  }
  return { outs, sumX, sumY };
}

describe('RelativeMotion', () => {
  it('gain 1 passes integer motion through unchanged (27 x 1 px = 27 px)', () => {
    const { outs, sumX, sumY } = feedN(new RelativeMotion(1), 27, 1, 0);
    expect(sumX).toBe(27);
    expect(sumY).toBe(0);
    expect(outs.every((o) => o.dx === 1 && o.dy === 0)).toBe(true);
  });

  it('gain 0.25 carries the remainder: 27 x 1 px = 6 px (0.75 carried), one pixel every 4th event', () => {
    const { outs, sumX } = feedN(new RelativeMotion(0.25), 27, 1, 0);
    expect(sumX).toBeGreaterThanOrEqual(6);
    expect(sumX).toBeLessThanOrEqual(7);
    expect(sumX).toBe(6);
    expect(outs.map((o) => o.dx)).toEqual(
      Array.from({ length: 27 }, (_, i) => ((i + 1) % 4 === 0 ? 1 : 0))
    );
  });

  it('carries negative remainders and never emits -0', () => {
    const { outs, sumX, sumY } = feedN(new RelativeMotion(0.25), 8, -1, -1);
    expect(sumX).toBe(-2);
    expect(sumY).toBe(-2);
    for (const out of outs) {
      expect([0, -1]).toContain(out.dx);
      expect(Object.is(out.dx, -0)).toBe(false);
      expect(Object.is(out.dy, -0)).toBe(false);
    }
  });

  it('remainders cancel on a direction change', () => {
    const motion = new RelativeMotion(0.5);
    expect(motion.feed(1, 0)).toEqual({ dx: 0, dy: 0 }); // 0.5 carried
    expect(motion.feed(-1, 0)).toEqual({ dx: 0, dy: 0 }); // back to 0
    expect(motion.feed(1, 0)).toEqual({ dx: 0, dy: 0 }); // 0.5 again
    expect(motion.feed(1, 0)).toEqual({ dx: 1, dy: 0 });
  });

  it('treats x and y independently and accepts fractional input', () => {
    expect(new RelativeMotion(1).feed(3, -2)).toEqual({ dx: 3, dy: -2 });
    expect(new RelativeMotion(0.5).feed(1, 2)).toEqual({ dx: 0, dy: 1 });
    const motion = new RelativeMotion(1);
    expect(motion.feed(0.5, 0)).toEqual({ dx: 0, dy: 0 });
    expect(motion.feed(0.5, 0)).toEqual({ dx: 1, dy: 0 });
  });

  it('reset() drops the carried remainders', () => {
    const motion = new RelativeMotion(0.5);
    expect(motion.feed(1, 1)).toEqual({ dx: 0, dy: 0 });
    motion.reset();
    expect(motion.feed(1, 1)).toEqual({ dx: 0, dy: 0 }); // would be 1 without the reset
    expect(motion.feed(1, 1)).toEqual({ dx: 1, dy: 1 });
  });

  it('clamps the gain to RELATIVE.GAIN_MIN..GAIN_MAX and ignores NaN', () => {
    expect(RELATIVE).toEqual({ GAIN_MIN: 0.25, GAIN_MAX: 4 });
    const motion = new RelativeMotion(1);
    motion.setGain(100);
    expect(motion.feed(1, 0)).toEqual({ dx: 4, dy: 0 });
    motion.setGain(0);
    expect(feedN(motion, 4, 1, 0).sumX).toBe(1);
    motion.setGain(NaN);
    expect(motion.feed(1, 0)).toEqual({ dx: 1, dy: 0 });
    expect(new RelativeMotion(0.1).feed(4, 0)).toEqual({ dx: 1, dy: 0 });
  });

  it('counts non-finite deltas as zero', () => {
    expect(new RelativeMotion(1).feed(NaN, Infinity)).toEqual({ dx: 0, dy: 0 });
  });
});

describe('splitInt8', () => {
  it.each<[number, number[]]>([
    [300, [127, 127, 46]],
    [-130, [-127, -3]],
    [0, []],
    [127, [127]],
    [-127, [-127]],
    [128, [127, 1]],
    [-128, [-127, -1]],
    [254, [127, 127]],
    [255, [127, 127, 1]],
    [2.6, [3]],
    [-0.4, []],
    [NaN, []],
    [Infinity, []]
  ])('splitInt8(%s) -> %j', (value, expected) => {
    expect(splitInt8(value)).toEqual(expected);
  });

  it('chunks are non-zero, within ±127 and sum to the rounded input', () => {
    for (let value = -1000; value <= 1000; value += 37) {
      const chunks = splitInt8(value);
      expect(chunks.every((c) => c !== 0 && Math.abs(c) <= 127)).toBe(true);
      expect(chunks.reduce((a, b) => a + b, 0)).toBe(Math.round(value));
    }
  });
});
