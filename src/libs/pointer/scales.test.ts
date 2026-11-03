import { describe, expect, it } from 'vitest';

import { RELATIVE } from '@/libs/pointer/relative-motion';
import { MOUSE_SENSITIVITY_RANGE, SCROLL_PX_PER_NOTCH_RANGE } from '@/libs/storage';

import {
  gainToSlider,
  intervalToWheelSpeed,
  POINTER_SPEED,
  pxPerNotchToSlider,
  SCROLL_SENSITIVITY,
  sliderToGain,
  sliderToPxPerNotch,
  WHEEL_SPEED,
  wheelSpeedToInterval
} from './scales';

const SLIDER_POSITIONS = Array.from({ length: 101 }, (_, v) => v);

describe('legacy wheel speed slider (upstream mapping)', () => {
  it('matches the literal upstream formulas on every 10-step stop', () => {
    for (let speed = 0; speed <= 100; speed += 10) {
      const upstreamInterval = 300 - speed * (300 / 100);
      expect(wheelSpeedToInterval(speed)).toBe(upstreamInterval);
      const upstreamSpeed = upstreamInterval === 300 ? 0 : ((300 - upstreamInterval) * 100) / 300;
      expect(intervalToWheelSpeed(upstreamInterval)).toBe(upstreamSpeed);
    }
  });

  it('round-trips: 100 ↔ 0 ms (off), 0 ↔ 300 ms', () => {
    expect(wheelSpeedToInterval(100)).toBe(0);
    expect(wheelSpeedToInterval(0)).toBe(WHEEL_SPEED.MAX_INTERVAL_MS);
    expect(intervalToWheelSpeed(0)).toBe(100);
    expect(intervalToWheelSpeed(300)).toBe(0);
    for (let speed = 0; speed <= 100; speed += 10) {
      expect(intervalToWheelSpeed(wheelSpeedToInterval(speed))).toBe(speed);
    }
  });

  it('clamps and falls back on garbage', () => {
    expect(wheelSpeedToInterval(150)).toBe(0);
    expect(wheelSpeedToInterval(-20)).toBe(300);
    expect(wheelSpeedToInterval(NaN)).toBe(0);
    expect(intervalToWheelSpeed(1000)).toBe(0);
    expect(intervalToWheelSpeed(-5)).toBe(100);
    expect(intervalToWheelSpeed(Infinity)).toBe(WHEEL_SPEED.DEFAULT_SLIDER);
  });
});

describe('scroll sensitivity slider ↔ pxPerNotch', () => {
  it('hits the spec anchors: 0 ↔ 400 px, 60 ↔ 100 px (default), 100 ↔ 40 px', () => {
    expect(sliderToPxPerNotch(0)).toBe(400);
    expect(sliderToPxPerNotch(60)).toBe(100);
    expect(sliderToPxPerNotch(100)).toBe(40);
    expect(pxPerNotchToSlider(400)).toBe(0);
    expect(pxPerNotchToSlider(100)).toBe(60);
    expect(pxPerNotchToSlider(40)).toBe(100);
    expect(sliderToPxPerNotch(SCROLL_SENSITIVITY.DEFAULT_SLIDER)).toBe(
      SCROLL_PX_PER_NOTCH_RANGE.default
    );
  });

  it('round-trips every integer slider position', () => {
    for (const v of SLIDER_POSITIONS) {
      expect(pxPerNotchToSlider(sliderToPxPerNotch(v)), `v=${v}`).toBe(v);
    }
  });

  it('is monotonic (more sensitivity = fewer px per notch) and stays inside the storage range', () => {
    let previous = Infinity;
    for (const v of SLIDER_POSITIONS) {
      const px = sliderToPxPerNotch(v);
      expect(Number.isInteger(px)).toBe(true);
      expect(px).toBeLessThanOrEqual(previous);
      expect(px).toBeGreaterThanOrEqual(SCROLL_PX_PER_NOTCH_RANGE.min);
      expect(px).toBeLessThanOrEqual(SCROLL_PX_PER_NOTCH_RANGE.max);
      previous = px;
    }
  });

  it('clamps out-of-range input and falls back to the default on garbage', () => {
    expect(sliderToPxPerNotch(-10)).toBe(400);
    expect(sliderToPxPerNotch(150)).toBe(40);
    expect(sliderToPxPerNotch(NaN)).toBe(100);
    expect(pxPerNotchToSlider(20)).toBe(100); // storage minimum, below the slider's 40 px
    expect(pxPerNotchToSlider(10_000)).toBe(0);
    expect(pxPerNotchToSlider(0)).toBe(SCROLL_SENSITIVITY.DEFAULT_SLIDER);
    expect(pxPerNotchToSlider(NaN)).toBe(SCROLL_SENSITIVITY.DEFAULT_SLIDER);
  });
});

describe('pointer speed slider ↔ gain', () => {
  it('hits the spec anchors: 0 ↔ 0.25, 50 ↔ 1.0 (default), 100 ↔ 4', () => {
    expect(sliderToGain(0)).toBe(0.25);
    expect(sliderToGain(50)).toBe(1);
    expect(sliderToGain(100)).toBe(4);
    expect(gainToSlider(0.25)).toBe(0);
    expect(gainToSlider(1)).toBe(50);
    expect(gainToSlider(4)).toBe(100);
    expect(sliderToGain(POINTER_SPEED.DEFAULT_SLIDER)).toBe(MOUSE_SENSITIVITY_RANGE.default);
  });

  it('round-trips every integer slider position', () => {
    for (const v of SLIDER_POSITIONS) {
      expect(gainToSlider(sliderToGain(v)), `v=${v}`).toBe(v);
    }
  });

  it('is monotonic and stays inside the RelativeMotion / storage gain range', () => {
    let previous = 0;
    for (const v of SLIDER_POSITIONS) {
      const gain = sliderToGain(v);
      expect(gain).toBeGreaterThan(previous);
      expect(gain).toBeGreaterThanOrEqual(RELATIVE.GAIN_MIN);
      expect(gain).toBeLessThanOrEqual(RELATIVE.GAIN_MAX);
      expect(gain).toBeGreaterThanOrEqual(MOUSE_SENSITIVITY_RANGE.min);
      expect(gain).toBeLessThanOrEqual(MOUSE_SENSITIVITY_RANGE.max);
      previous = gain;
    }
  });

  it('clamps out-of-range input and falls back to the default on garbage', () => {
    expect(sliderToGain(-1)).toBe(0.25);
    expect(sliderToGain(999)).toBe(4);
    expect(sliderToGain(NaN)).toBe(1);
    expect(gainToSlider(0.01)).toBe(0);
    expect(gainToSlider(100)).toBe(100);
    expect(gainToSlider(0)).toBe(POINTER_SPEED.DEFAULT_SLIDER);
    expect(gainToSlider(-Infinity)).toBe(POINTER_SPEED.DEFAULT_SLIDER);
  });
});
