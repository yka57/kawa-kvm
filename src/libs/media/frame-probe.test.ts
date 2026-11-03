import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  changedFraction,
  classifyPixel,
  createVideoSampler,
  FRAME_H,
  FRAME_W,
  sentinelFraction,
  sentinelGone,
  sentinelPresent,
  WINDOW_CHANGE_MIN,
  type Frame
} from './frame-probe';

type Rgb = [number, number, number];

const PIXELS = FRAME_W * FRAME_H;

/** A FRAME_W × FRAME_H frame: the first `count` pixels `top`, the rest `rest`. */
function frame(rest: Rgb, top: Rgb = rest, count = 0, w = FRAME_W, h = FRAME_H): Frame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = i < count ? top : rest;
    data.set([r, g, b, 255], i * 4);
  }
  return { w, h, data };
}

const GREY: Rgb = [128, 128, 128];
const DARK: Rgb = [32, 32, 32];

describe('classifyPixel', () => {
  it('recognises the page colours in full and limited (16–235) range', () => {
    expect(classifyPixel(255, 0, 255)).toBe('magenta');
    expect(classifyPixel(235, 16, 235)).toBe('magenta');
    expect(classifyPixel(0, 255, 0)).toBe('lime');
    expect(classifyPixel(16, 235, 16)).toBe('lime');
    expect(classifyPixel(255, 0, 0)).toBe('red');
    expect(classifyPixel(235, 16, 16)).toBe('red');
  });

  it('tolerates compression drift at the documented bounds', () => {
    expect(classifyPixel(150, 110, 150)).toBe('magenta');
    expect(classifyPixel(110, 150, 110)).toBe('lime');
    expect(classifyPixel(150, 90, 90)).toBe('red');
    expect(classifyPixel(149, 110, 150)).toBeNull();
    expect(classifyPixel(111, 150, 110)).toBeNull();
    expect(classifyPixel(150, 91, 90)).toBeNull();
  });

  it('leaves ordinary screen colours unclassified', () => {
    for (const [r, g, b] of [
      [255, 255, 255],
      [0, 0, 0],
      [128, 128, 128],
      [32, 32, 32],
      [255, 255, 0], // yellow
      [255, 165, 0], // orange
      [0, 0, 255], // blue
      [0, 255, 255], // cyan
      [0, 120, 215] // Windows accent blue
    ]) {
      expect(classifyPixel(r, g, b), `${r},${g},${b}`).toBeNull();
    }
  });
});

describe('sentinelFraction / changedFraction', () => {
  it('measures the share of sentinel pixels', () => {
    expect(sentinelFraction(frame(GREY, [16, 235, 16], PIXELS / 2), 'lime')).toBe(0.5);
    expect(sentinelFraction(frame([235, 16, 235]), 'magenta')).toBe(1);
    expect(sentinelFraction(frame(GREY), 'red')).toBe(0);
  });

  it('counts a pixel as changed from |dr|+|dg|+|db| >= 96', () => {
    const base = frame(GREY);
    expect(changedFraction(base, frame(GREY))).toBe(0);
    expect(changedFraction(base, frame(DARK))).toBe(1);
    expect(changedFraction(base, frame(GREY, [160, 160, 160], PIXELS / 4))).toBe(0.25);
    expect(changedFraction(base, frame(GREY, [159, 160, 160], PIXELS / 4))).toBe(0);
    // alpha is ignored
    const transparent = frame(GREY);
    for (let i = 3; i < transparent.data.length; i += 4) transparent.data[i] = 0;
    expect(changedFraction(base, transparent)).toBe(0);
    expect(WINDOW_CHANGE_MIN).toBe(0.1);
  });

  it('returns 0 for frames of different or broken sizes', () => {
    const small = frame(DARK, DARK, 0, 48, 27);
    expect(changedFraction(frame(GREY), small)).toBe(0);
    expect(changedFraction(small, frame(GREY))).toBe(0);
    const truncated: Frame = { w: FRAME_W, h: FRAME_H, data: new Uint8ClampedArray(16) };
    expect(changedFraction(truncated, truncated)).toBe(0);
    expect(sentinelFraction(truncated, 'lime')).toBe(0);
    expect(sentinelFraction({ w: 0, h: 0, data: new Uint8ClampedArray(0) }, 'lime')).toBe(0);
  });

  it('handles frames of any size', () => {
    const tiny = frame(GREY, [0, 255, 0], 1, 2, 1);
    expect(sentinelFraction(tiny, 'lime')).toBe(0.5);
    expect(changedFraction(tiny, frame(GREY, GREY, 0, 2, 1))).toBe(0.5);
  });
});

describe('sentinelPresent / sentinelGone', () => {
  const LIME: Rgb = [16, 235, 16];
  // 8 % of 5184 pixels is 414.72
  const PRESENT_MIN_PIXELS = 415;

  it('without a baseline: present from 8 %, gone up to 3 %', () => {
    expect(sentinelPresent(frame(GREY, LIME, PRESENT_MIN_PIXELS), null, 'lime')).toBe(true);
    expect(sentinelPresent(frame(GREY, LIME, PRESENT_MIN_PIXELS - 1), null, 'lime')).toBe(false);
    // 3 % is 155.52 pixels
    expect(sentinelGone(frame(GREY, LIME, 155), null, 'lime')).toBe(true);
    expect(sentinelGone(frame(GREY, LIME, 156), null, 'lime')).toBe(false);
  });

  it('what the baseline already shows does not count', () => {
    const base = frame(GREY, LIME, PIXELS / 2); // a lime wallpaper
    expect(sentinelPresent(frame(GREY, LIME, PIXELS / 2), base, 'lime')).toBe(false);
    // needs baseline + 6 % = 56 % = 2903.04 pixels
    expect(sentinelPresent(frame(GREY, LIME, 2904), base, 'lime')).toBe(true);
    expect(sentinelPresent(frame(GREY, LIME, 2903), base, 'lime')).toBe(false);
    // gone once back within baseline + 2 % = 52 % = 2695.68 pixels
    expect(sentinelGone(frame(GREY, LIME, 2695), base, 'lime')).toBe(true);
    expect(sentinelGone(frame(GREY, LIME, 2696), base, 'lime')).toBe(false);
    // a small baseline keeps the absolute floors
    const speck = frame(GREY, LIME, 10);
    expect(sentinelPresent(frame(GREY, LIME, PRESENT_MIN_PIXELS - 1), speck, 'lime')).toBe(false);
    expect(sentinelGone(frame(GREY, LIME, 155), speck, 'lime')).toBe(true);
  });

  it('a page of one sentinel is neither of the others', () => {
    const red = frame(DARK, [235, 16, 16], PIXELS * 0.75);
    expect(sentinelPresent(red, frame(DARK), 'red')).toBe(true);
    expect(sentinelPresent(red, frame(DARK), 'lime')).toBe(false);
    expect(sentinelPresent(red, frame(DARK), 'magenta')).toBe(false);
  });

  it('is false for a baseline of another size and for a frame without pixels', () => {
    const small = frame(GREY, GREY, 0, 48, 27);
    const page = frame(GREY, LIME, PIXELS);
    expect(sentinelPresent(page, small, 'lime')).toBe(false);
    expect(sentinelGone(frame(GREY), small, 'lime')).toBe(false);
    const empty: Frame = { w: 0, h: 0, data: new Uint8ClampedArray(0) };
    expect(sentinelPresent(empty, null, 'lime')).toBe(false);
    expect(sentinelGone(empty, null, 'lime')).toBe(false);
  });
});

describe('createVideoSampler', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubCanvas() {
    const drawImage = vi.fn();
    const getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(7)
    }));
    const getContext = vi.fn(() => ({ drawImage, getImageData }));
    const canvas = { width: 0, height: 0, getContext };
    const createElement = vi.fn(() => canvas);
    vi.stubGlobal('document', { createElement });
    return { canvas, createElement, getContext, drawImage, getImageData };
  }

  const video = (over: Partial<HTMLVideoElement> = {}) =>
    ({ readyState: 4, videoWidth: 1920, ...over }) as HTMLVideoElement;

  it('is available only with a decoded frame', () => {
    expect(createVideoSampler(() => null).available()).toBe(false);
    expect(createVideoSampler(() => video({ readyState: 1 })).available()).toBe(false);
    expect(createVideoSampler(() => video({ videoWidth: 0 })).available()).toBe(false);
    expect(createVideoSampler(() => video({ readyState: 2 })).available()).toBe(true);
  });

  it('draws the intrinsic video frame into a 96×54 canvas read back frequently', () => {
    const stub = stubCanvas();
    const element = video();
    const sampler = createVideoSampler(() => element);

    const first = sampler.sample();
    expect(first).not.toBeNull();
    expect(first!.w).toBe(FRAME_W);
    expect(first!.h).toBe(FRAME_H);
    expect(first!.data).toHaveLength(FRAME_W * FRAME_H * 4);
    expect(stub.canvas).toMatchObject({ width: 96, height: 54 });
    expect(stub.getContext).toHaveBeenCalledWith('2d', { willReadFrequently: true });
    expect(stub.drawImage).toHaveBeenCalledWith(element, 0, 0, 96, 54);
    expect(stub.getImageData).toHaveBeenCalledWith(0, 0, 96, 54);

    // one canvas for the sampler's lifetime, a fresh pixel array per sample
    const second = sampler.sample();
    expect(stub.createElement).toHaveBeenCalledTimes(1);
    expect(second!.data).not.toBe(first!.data);
  });

  it('returns null without a frame and when the frame cannot be read', () => {
    const stub = stubCanvas();
    expect(createVideoSampler(() => null).sample()).toBeNull();
    expect(stub.createElement).not.toHaveBeenCalled();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub.drawImage.mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const sampler = createVideoSampler(() => video());
    expect(sampler.sample()).toBeNull();
    expect(sampler.sample()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
