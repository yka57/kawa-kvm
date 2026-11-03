import { describe, expect, it, vi } from 'vitest';

import { MouseAbsoluteRelative, MouseReportRelative } from '@/libs/mouse';

import {
  applyButtonsMask,
  BUTTONS_MASK,
  clampWheelNotches,
  disableEvent,
  isMouseLikePointer,
  MAX_WHEEL_NOTCHES,
  pointerButtonsMask
} from './pointer-events';

describe('isMouseLikePointer', () => {
  it('accepts mouse and pen, rejects touch and unknown types', () => {
    expect(isMouseLikePointer({ pointerType: 'mouse' })).toBe(true);
    expect(isMouseLikePointer({ pointerType: 'pen' })).toBe(true);
    expect(isMouseLikePointer({ pointerType: 'touch' })).toBe(false);
    expect(isMouseLikePointer({ pointerType: '' })).toBe(false);
  });
});

describe('pointerButtonsMask', () => {
  it('keeps the five HID bits and drops the pen eraser bit', () => {
    expect(pointerButtonsMask({ buttons: 0 })).toBe(0);
    expect(pointerButtonsMask({ buttons: 1 })).toBe(1);
    expect(pointerButtonsMask({ buttons: 32 })).toBe(0);
    expect(pointerButtonsMask({ buttons: 0x3f })).toBe(BUTTONS_MASK);
    expect(pointerButtonsMask({ buttons: NaN })).toBe(0);
  });
});

describe('applyButtonsMask', () => {
  function recorder() {
    const calls: string[] = [];
    return {
      calls,
      tracker: {
        buttonDown: (button: number) => calls.push(`down ${button}`),
        buttonUp: (button: number) => calls.push(`up ${button}`)
      }
    };
  }

  it('maps mask bits to browser button indices (left 0, right 2, middle 1, back 3, forward 4)', () => {
    const { calls, tracker } = recorder();
    expect(applyButtonsMask(tracker, 0, 1)).toBe(true);
    expect(applyButtonsMask(tracker, 1, 3)).toBe(true); // chord: right pressed while left held
    expect(applyButtonsMask(tracker, 3, 2)).toBe(true); // left released, right still held
    expect(applyButtonsMask(tracker, 2, 0)).toBe(true);
    expect(applyButtonsMask(tracker, 0, 4)).toBe(true);
    expect(applyButtonsMask(tracker, 4, 8)).toBe(true);
    expect(applyButtonsMask(tracker, 8, 16)).toBe(true);
    expect(calls).toEqual([
      'down 0',
      'down 2',
      'up 0',
      'up 2',
      'down 1',
      'up 1',
      'down 3',
      'up 3',
      'down 4'
    ]);
  });

  it('reports no change for an identical mask and ignores bits above the HID range', () => {
    const { calls, tracker } = recorder();
    expect(applyButtonsMask(tracker, 1, 1)).toBe(false);
    expect(applyButtonsMask(tracker, 1, 1 | 32)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('drives both report classes to a buttons byte identical to the DOM mask', () => {
    for (let mask = 0; mask <= BUTTONS_MASK; mask++) {
      const relative = new MouseReportRelative();
      applyButtonsMask(relative, 0, mask);
      expect(relative.buildButtonReport()[0], `rel mask ${mask}`).toBe(mask);

      const absolute = new MouseAbsoluteRelative();
      applyButtonsMask(absolute, 0, mask);
      expect(absolute.buildButtonReport(0, 0)[0], `abs mask ${mask}`).toBe(mask);

      // and back to nothing held
      applyButtonsMask(relative, mask, 0);
      expect(relative.buildButtonReport()[0]).toBe(0);
    }
  });

  it('self-heals from an arbitrary previous mask', () => {
    const mouse = new MouseReportRelative();
    applyButtonsMask(mouse, 0, 0b10101);
    applyButtonsMask(mouse, 0b10101, 0b01010);
    expect(mouse.buildButtonReport()[0]).toBe(0b01010);
  });
});

describe('clampWheelNotches', () => {
  it('clamps to ±127, truncates fractions and maps garbage to 0', () => {
    expect(clampWheelNotches(3)).toBe(3);
    expect(clampWheelNotches(-1)).toBe(-1);
    expect(clampWheelNotches(200)).toBe(MAX_WHEEL_NOTCHES);
    expect(clampWheelNotches(-200)).toBe(-MAX_WHEEL_NOTCHES);
    expect(clampWheelNotches(2.9)).toBe(2);
    expect(clampWheelNotches(NaN)).toBe(0);
  });
});

describe('disableEvent', () => {
  it('prevents the default and stops propagation', () => {
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    disableEvent(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });
});
