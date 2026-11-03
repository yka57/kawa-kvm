import { describe, expect, it } from 'vitest';

import { DEFAULT_WHEEL_SETTINGS, WHEEL, WheelAccumulator, type WheelInput } from './wheel';

function ev(deltaY: number, t = 0, deltaX = 0, deltaMode: 0 | 1 | 2 = 0): WheelInput {
  return { deltaX, deltaY, deltaMode, t };
}

/** Feed a stream of vertical deltas `stepMs` apart (one trackpad frame) and return every result. */
function run(acc: WheelAccumulator, deltas: number[], stepMs = 16, startT = 0): number[] {
  return deltas.map((deltaY, i) => acc.feed(ev(deltaY, startT + i * stepMs)));
}

/** direction 1 so the sign of the result is the sign of the host delta (readable expectations). */
function up(settings: Partial<ConstructorParameters<typeof WheelAccumulator>[0]> = {}) {
  return new WheelAccumulator({ direction: 1, ...settings });
}

/** The literal upstream expression (absolute.tsx / relative.tsx handleWheel). */
function upstream(deltaY: number, direction: number): number {
  return (deltaY > 0 ? 1 : -1) * direction;
}

describe('WheelAccumulator regression against upstream', () => {
  it('defaults match upstream (direction -1, interval 0) and 100 px per notch', () => {
    expect(DEFAULT_WHEEL_SETTINGS).toEqual({ pxPerNotch: 100, direction: -1, minIntervalMs: 0 });
    const acc = new WheelAccumulator();
    expect(acc.feed(ev(100))).toBe(upstream(100, -1));
    expect(acc.feed(ev(50))).toBe(0); // same gesture, half a notch accumulated
    expect(acc.feed(ev(50))).toBe(-1); // the second half completes it
    expect(-1 & 0xff).toBe(0xff); // the wheel byte upstream sent for deltaY > 0
  });

  it.each([100, -100, 4, -4, 3, -3])(
    'first event of a gesture with deltaY=%d reproduces (deltaY>0?1:-1)*direction',
    (deltaY) => {
      for (const direction of [1, -1] as const) {
        const acc = new WheelAccumulator({ direction });
        expect(acc.feed(ev(deltaY))).toBe(upstream(deltaY, direction));
      }
    }
  );

  it('direction -1 flips the sign both ways', () => {
    const acc = new WheelAccumulator({ direction: -1 });
    expect(acc.feed(ev(100, 0))).toBe(-1);
    expect(acc.feed(ev(-100, 500))).toBe(1);
  });
});

describe('WheelAccumulator kick and accumulation', () => {
  it('ten events of 12 px: one kick notch, then the next only after 100 px', () => {
    const acc = up();
    expect(run(acc, Array(10).fill(12))).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    // residue 8 px; the next notch needs 92 px more = 8 further events
    const more = run(acc, Array(8).fill(12), 16, 10 * 16);
    expect(more).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('is symmetric: +0.5 and -0.5 alone fire nothing (upstream fired on -0.5)', () => {
    expect(up().feed(ev(0.5))).toBe(0);
    expect(up().feed(ev(-0.5))).toBe(0);
    const acc = up();
    expect(run(acc, [0.5, -0.5])).toEqual([0, 0]);
  });

  it('eight events of 0.4 px produce exactly one notch once 3 px are crossed', () => {
    const acc = up();
    const out = run(acc, Array(9).fill(0.4));
    expect(out).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 0]);
  });

  it('a slow continuous drag scrolls one notch per pxPerNotch of travel', () => {
    const acc = up({ pxPerNotch: 50 });
    const out = run(acc, Array(30).fill(10));
    // kick at the first event, then every 5 events (50 px)
    expect(out.reduce((a, b) => a + b, 0)).toBe(1 + Math.floor((29 * 10) / 50));
    expect(out.indexOf(1, 1)).toBe(5);
  });

  it('a momentum-like tail is proportional to its pixel sum, not one notch per event', () => {
    const acc = up();
    const tail = Array.from({ length: 48 }, (_, i) => 18 * 0.92 ** i); // ~220 px
    const out = run(acc, tail);
    const total = out.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(2);
    expect(total).toBeLessThanOrEqual(3);
    expect(out.every((n) => n === 0 || n === 1)).toBe(true);
  });

  it('huge deltas return the raw notch count; the caller clamps to WHEEL.MAX_NOTCHES', () => {
    expect(up().feed(ev(20000))).toBe(200);
    expect(new WheelAccumulator({ direction: -1 }).feed(ev(20000))).toBe(-200);
    expect(WHEEL.MAX_NOTCHES).toBe(127);
    expect(Math.max(-WHEEL.MAX_NOTCHES, Math.min(WHEEL.MAX_NOTCHES, 200))).toBe(127);
  });
});

describe('WheelAccumulator gesture gap', () => {
  it('re-arms the kick: slow mouse clicks 500 ms apart give one notch each', () => {
    const acc = up();
    expect(acc.feed(ev(4, 0))).toBe(1);
    expect(acc.feed(ev(4, 500))).toBe(1);
    expect(acc.feed(ev(4, 1000))).toBe(1);
    const big = up();
    expect(big.feed(ev(100, 0))).toBe(1);
    expect(big.feed(ev(100, 500))).toBe(1);
  });

  it('inside a gesture the kick is spent: 4 px events 100 ms apart accumulate instead', () => {
    const acc = up();
    expect(acc.feed(ev(4, 0))).toBe(1);
    expect(acc.feed(ev(4, 100))).toBe(0);
    expect(acc.feed(ev(4, 200))).toBe(0);
    expect(acc.feed(ev(4, 401))).toBe(1); // > 200 ms since the last event: new gesture
  });

  it('reset() starts a fresh gesture', () => {
    const acc = up();
    expect(acc.feed(ev(60, 0))).toBe(1);
    expect(acc.feed(ev(60, 16))).toBe(0);
    acc.reset();
    expect(acc.feed(ev(60, 32))).toBe(1);
  });
});

describe('WheelAccumulator axis lock', () => {
  it('a horizontal-dominant gesture emits nothing until the next gap', () => {
    const acc = up();
    expect(acc.feed(ev(0.4, 0, 40))).toBe(0);
    expect(acc.feed(ev(50, 16, 0))).toBe(0); // still the same (horizontal) gesture
    expect(acc.feed(ev(50, 32, 1))).toBe(0);
    expect(acc.feed(ev(50, 400, 0))).toBe(1); // gap: new gesture, vertical, kick
  });

  it('ties lock vertical, and a vertical gesture ignores later horizontal deltas', () => {
    const acc = up();
    expect(acc.feed(ev(5, 0, 5))).toBe(1);
    expect(acc.feed(ev(100, 16, 500))).toBe(1); // 100 px more, locked vertical
  });

  it('sub-pixel events on both axes accumulate as vertical until an axis is fixed', () => {
    const acc = up();
    expect(run(acc, [0.9, 0.9, 0.9, 0.9])).toEqual([0, 0, 0, 1]); // 3.6 px >= KICK_MIN_PX
  });
});

describe('WheelAccumulator reversal', () => {
  it('+60, +60 then -10 gives exactly one negative notch, immediately', () => {
    expect(run(up(), [60, 60, -10])).toEqual([1, 0, -1]);
  });

  it('a reversal right after a kick fires on the first event of >= 2 px', () => {
    expect(run(up(), [12, -1, -3])).toEqual([1, 0, -1]);
  });

  it('a 1 px wobble never re-arms the kick (no bonus notch)', () => {
    expect(run(up(), [12, -1, 12, 12])).toEqual([1, 0, 0, 0]);
  });

  it('a slow reversal (2 px per frame) fires the reverse notch once 3 px are crossed', () => {
    expect(run(up(), [60, 60, -2, -2, -2, -2])).toEqual([1, 0, 0, -1, 0, 0]);
  });

  it('a 60-frame reverse scroll at 2.5 px/frame emits exactly two reverse notches (kick, then 100 px)', () => {
    const acc = up();
    expect(run(acc, [60, 60])).toEqual([1, 0]);
    const out = run(acc, Array(60).fill(-2.5), 16, 2 * 16);
    expect(out.filter((n) => n !== 0)).toEqual([-1, -1]);
    expect(out.indexOf(-1)).toBe(1);
  });

  it('a reversal below REVERSAL_MIN_PX only nudges the accumulator', () => {
    expect(WHEEL.REVERSAL_MIN_PX).toBe(2);
    const acc = up();
    expect(run(acc, [10, 10, 10, 10, 10, 10, 10, 10, 10])).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0]); // acc 80
    expect(acc.feed(ev(-1, 9 * 16))).toBe(0); // acc 79
    expect(acc.feed(ev(21, 10 * 16))).toBe(1); // acc 100
  });
});

describe('WheelAccumulator deltaMode and settings', () => {
  it('converts deltaMode 1 (lines) with 16 px and 2 (pages) with 800 px', () => {
    const lines = up();
    expect(lines.feed(ev(7, 0, 0, 1))).toBe(1); // 112 px: a whole notch, not the kick
    expect(lines.feed(ev(6, 16, 0, 1))).toBe(1); // 12 + 96 = 108 px
    const pixels = up();
    expect(pixels.feed(ev(7, 0))).toBe(1); // kick
    expect(pixels.feed(ev(6, 16))).toBe(0); // 6 px
    expect(up().feed(ev(1, 0, 0, 2))).toBe(8);
    expect(WHEEL.LINE_PX).toBe(16);
    expect(WHEEL.PAGE_PX).toBe(800);
  });

  it('update() changes pxPerNotch and direction on the fly', () => {
    const acc = up();
    expect(acc.feed(ev(100, 0))).toBe(1);
    acc.update({ pxPerNotch: 50 });
    expect(acc.feed(ev(50, 16))).toBe(1);
    acc.update({ direction: -1 });
    expect(acc.feed(ev(50, 32))).toBe(-1);
  });

  it('falls back to defaults for invalid settings', () => {
    expect(new WheelAccumulator({ pxPerNotch: 0, direction: 1 }).feed(ev(100))).toBe(1);
    expect(new WheelAccumulator({ pxPerNotch: NaN, direction: 1 }).feed(ev(100))).toBe(1);
    const acc = up({ minIntervalMs: NaN });
    expect(acc.feed(ev(100, 0))).toBe(1);
    expect(acc.feed(ev(100, 1))).toBe(1);
  });

  it('ignores non-finite deltas', () => {
    const acc = up();
    expect(acc.feed(ev(NaN, 0))).toBe(0);
    expect(acc.feed(ev(100, 16))).toBe(1);
  });
});

describe('WheelAccumulator legacy minIntervalMs (Wheel speed slider)', () => {
  it('drops notches inside the window, including their residue, like upstream', () => {
    const acc = up({ minIntervalMs: 100 });
    expect(acc.feed(ev(100, 0))).toBe(1);
    expect(acc.feed(ev(150, 50))).toBe(0); // dropped; the 50 px residue is discarded too
    expect(acc.feed(ev(60, 150))).toBe(0); // only 60 px accumulated (not 110)
    expect(acc.feed(ev(40, 166))).toBe(1); // 100 px, 166 ms since the last emit
    expect(acc.feed(ev(100, 200))).toBe(0); // 34 ms since the last emit: dropped
    expect(acc.feed(ev(100, 300))).toBe(1);
  });

  it('does not touch the emit timestamp for events that emit nothing', () => {
    const acc = up({ minIntervalMs: 100 });
    expect(run(acc, Array(7).fill(10), 16)).toEqual([1, 0, 0, 0, 0, 0, 0]); // 60 px accumulated
    expect(acc.feed(ev(40, 7 * 16))).toBe(1); // 112 ms after the kick
  });
});
