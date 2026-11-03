import { describe, expect, it } from 'vitest';

import {
  ABS_MAX,
  mapClientToVideo,
  toAbs4095,
  type ElementRect,
  type VideoSize
} from './absolute-map';

/** Verbatim port of upstream absolute.tsx getCoordinate (rotation unaware). */
function legacyGetCoordinate(
  event: { clientX: number; clientY: number },
  rect: ElementRect,
  screen: { videoWidth: number; videoHeight: number }
): { x: number; y: number } {
  const clientX = event.clientX;
  const clientY = event.clientY;

  if (!screen.videoWidth || !screen.videoHeight) {
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return { x, y };
  }

  const videoRatio = screen.videoWidth / screen.videoHeight;
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

  const x = (clientX - rect.left - offsetX) / renderedWidth;
  const y = (clientY - rect.top - offsetY) / renderedHeight;
  return { x, y };
}

const HD: VideoSize = { width: 1920, height: 1080 };
const SD: VideoSize = { width: 1440, height: 1080 };

function at(clientX: number, clientY: number) {
  return { clientX, clientY };
}

function grid(rect: ElementRect, steps = 6) {
  const points: Array<{ clientX: number; clientY: number }> = [];
  for (let i = -1; i <= steps + 1; i++) {
    for (let j = -1; j <= steps + 1; j++) {
      points.push(at(rect.left + (rect.width * i) / steps, rect.top + (rect.height * j) / steps));
    }
  }
  return points;
}

describe('mapClientToVideo rotation 0 (legacy parity)', () => {
  it.each<[string, ElementRect, VideoSize | null]>([
    ['16:9 video filling a 16:9 element', { left: 10.5, top: 20.25, width: 1600, height: 900 }, HD],
    [
      '4:3 video pillarboxed in a 16:9 element',
      { left: 10.5, top: 20.25, width: 1600, height: 900 },
      SD
    ],
    ['16:9 video letterboxed in a 4:3 element', { left: 0, top: 0, width: 1200, height: 900 }, HD],
    ['no video metadata', { left: 3, top: 7, width: 640, height: 360 }, null],
    [
      'zero-sized video metadata',
      { left: 3, top: 7, width: 640, height: 360 },
      { width: 0, height: 0 }
    ]
  ])('%s: identical to upstream getCoordinate', (_name, rect, video) => {
    const screen = { videoWidth: video?.width ?? 0, videoHeight: video?.height ?? 0 };
    for (const p of grid(rect)) {
      const expected = legacyGetCoordinate(p, rect, screen);
      const actual = mapClientToVideo(p, rect, video, 0);
      expect(actual.x).toBe(expected.x);
      expect(actual.y).toBe(expected.y);
    }
  });
});

describe('mapClientToVideo letterboxing', () => {
  it('16:9 in a 4:3 element: picture corners map to (0,0)/(1,1), bars map outside 0..1', () => {
    const rect = { left: 100, top: 50, width: 1200, height: 900 };
    // rendered 1200 x 675, bars of 112.5 px top and bottom
    expect(mapClientToVideo(at(100, 162.5), rect, HD, 0)).toEqual({ x: 0, y: 0 });
    expect(mapClientToVideo(at(1300, 837.5), rect, HD, 0)).toEqual({ x: 1, y: 1 });
    expect(mapClientToVideo(at(700, 500), rect, HD, 0)).toEqual({ x: 0.5, y: 0.5 });
    const topBar = mapClientToVideo(at(700, 60), rect, HD, 0);
    expect(topBar.y).toBeLessThan(0);
    expect(topBar.x).toBe(0.5);
    const bottomBar = mapClientToVideo(at(700, 940), rect, HD, 0);
    expect(bottomBar.y).toBeGreaterThan(1);
  });

  it('4:3 in a 16:9 element: pillarbox bars map outside 0..1', () => {
    const rect = { left: 0, top: 0, width: 1600, height: 900 };
    // rendered 1200 x 900, bars of 200 px left and right
    expect(mapClientToVideo(at(200, 0), rect, SD, 0)).toEqual({ x: 0, y: 0 });
    expect(mapClientToVideo(at(1400, 900), rect, SD, 0)).toEqual({ x: 1, y: 1 });
    expect(mapClientToVideo(at(100, 450), rect, SD, 0).x).toBeLessThan(0);
    expect(mapClientToVideo(at(1500, 450), rect, SD, 0).x).toBeGreaterThan(1);
  });

  it('without video metadata the mapping is element-relative', () => {
    const rect = { left: 10, top: 20, width: 200, height: 100 };
    expect(mapClientToVideo(at(10, 20), rect, null, 0)).toEqual({ x: 0, y: 0 });
    expect(mapClientToVideo(at(210, 120), rect, null, 0)).toEqual({ x: 1, y: 1 });
    expect(mapClientToVideo(at(110, 70), rect, { width: 0, height: 1080 }, 90)).toEqual({
      x: 0.5,
      y: 0.5
    });
  });
});

describe('mapClientToVideo rotation', () => {
  // The rotated bounding box of a 1600 x 900 element showing a 16:9 video.
  const tall = { left: 0, top: 0, width: 900, height: 1600 };
  const wide = { left: 0, top: 0, width: 1600, height: 900 };

  it('90 degrees: displayed corners map to the clockwise-rotated source corners', () => {
    expect(mapClientToVideo(at(900, 0), tall, HD, 90)).toEqual({ x: 0, y: 0 }); // top-right
    expect(mapClientToVideo(at(900, 1600), tall, HD, 90)).toEqual({ x: 1, y: 0 }); // bottom-right
    expect(mapClientToVideo(at(0, 0), tall, HD, 90)).toEqual({ x: 0, y: 1 }); // top-left
    expect(mapClientToVideo(at(0, 1600), tall, HD, 90)).toEqual({ x: 1, y: 1 }); // bottom-left
    expect(mapClientToVideo(at(450, 800), tall, HD, 90)).toEqual({ x: 0.5, y: 0.5 });
    expect(mapClientToVideo(at(900, 400), tall, HD, 90)).toEqual({ x: 0.25, y: 0 });
  });

  it('180 degrees: both axes flip', () => {
    expect(mapClientToVideo(at(0, 0), wide, HD, 180)).toEqual({ x: 1, y: 1 });
    expect(mapClientToVideo(at(1600, 900), wide, HD, 180)).toEqual({ x: 0, y: 0 });
    expect(mapClientToVideo(at(400, 225), wide, HD, 180)).toEqual({ x: 0.75, y: 0.75 });
  });

  it('270 degrees: displayed corners map to the counter-clockwise-rotated source corners', () => {
    expect(mapClientToVideo(at(0, 0), tall, HD, 270)).toEqual({ x: 1, y: 0 }); // top-left
    expect(mapClientToVideo(at(0, 1600), tall, HD, 270)).toEqual({ x: 0, y: 0 }); // bottom-left
    expect(mapClientToVideo(at(900, 0), tall, HD, 270)).toEqual({ x: 1, y: 1 }); // top-right
    expect(mapClientToVideo(at(900, 1600), tall, HD, 270)).toEqual({ x: 0, y: 1 }); // bottom-right
  });

  it('90/270 letterbox with the swapped aspect inside the rotated rect', () => {
    const rect = { left: 0, top: 0, width: 1000, height: 1600 };
    // displayed 1080:1920 inside 1000 x 1600 -> rendered 900 x 1600, 50 px bars left and right
    expect(mapClientToVideo(at(950, 0), rect, HD, 90)).toEqual({ x: 0, y: 0 });
    expect(mapClientToVideo(at(50, 0), rect, HD, 90)).toEqual({ x: 0, y: 1 });
    const leftBar = mapClientToVideo(at(10, 800), rect, HD, 90);
    expect(leftBar.y).toBeGreaterThan(1);
    expect(leftBar.x).toBe(0.5);
    expect(mapClientToVideo(at(50, 1600), rect, HD, 270)).toEqual({ x: 0, y: 0 });
    expect(mapClientToVideo(at(10, 800), rect, HD, 270).y).toBeLessThan(0);
  });

  it('rotating a point through 90 and 270 is consistent with the unrotated mapping', () => {
    const p = at(300, 1000);
    const r90 = mapClientToVideo(p, tall, HD, 90);
    const r270 = mapClientToVideo(p, tall, HD, 270);
    // 270 = inverse of 90 on the display plane: (x, y) -> (1 - x, 1 - y)
    expect(r270.x).toBeCloseTo(1 - r90.x, 12);
    expect(r270.y).toBeCloseTo(1 - r90.y, 12);
  });
});

describe('toAbs4095', () => {
  it.each<[number, number]>([
    [0, 0],
    [0.25, 1024],
    [0.5, 2048],
    [4095 / 4096, 4095],
    [0.99999, 4095],
    [1, 4095],
    [1.5, 4095],
    [-0.2, 0],
    [NaN, 0],
    [Infinity, 4095]
  ])('toAbs4095(%s) = %d', (value, expected) => {
    expect(toAbs4095(value)).toBe(expected);
  });

  it('never yields 4096 and matches upstream floor(v*4096) below 1.0', () => {
    expect(ABS_MAX).toBe(4095);
    for (let i = 0; i <= 5000; i++) {
      const v = (i / 5000) * 1.2;
      const abs = toAbs4095(v);
      expect(abs).toBeLessThanOrEqual(4095);
      expect(abs).toBeGreaterThanOrEqual(0);
      if (v < 1) {
        expect(abs).toBe(Math.floor(v * 4096));
      }
    }
  });
});
