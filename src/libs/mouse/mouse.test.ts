import { describe, expect, it } from 'vitest';

import { buildRelativeReports, MouseAbsoluteRelative, MouseReportRelative } from './index';

describe('MouseAbsoluteRelative', () => {
  it('buildReport(1.0, 1.0) encodes 4095 as 0xFF,0x0F (upstream sent 4096)', () => {
    const mouse = new MouseAbsoluteRelative();
    expect(mouse.buildReport(1, 1)).toEqual([0, 0xff, 0x0f, 0xff, 0x0f, 0]);
  });

  it('positions below 1.0 stay byte-identical to upstream floor(v*4096)', () => {
    const mouse = new MouseAbsoluteRelative();
    expect(mouse.buildReport(0, 0)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(mouse.buildReport(0.5, 0.25, -1)).toEqual([0, 0x00, 0x08, 0x00, 0x04, 0xff]);
    for (let i = 0; i < 1000; i++) {
      const v = i / 1000;
      const legacy = Math.floor(Math.max(0, Math.min(1, v)) * 4096);
      const [, lo, hi] = mouse.buildReport(v, 0);
      expect(lo | (hi << 8)).toBe(legacy);
    }
  });

  it('clamps out-of-range positions and wheel like upstream', () => {
    const mouse = new MouseAbsoluteRelative();
    expect(mouse.buildReport(-0.5, 2, 300)).toEqual([0, 0, 0, 0xff, 0x0f, 127]);
    expect(mouse.buildReport(0, 0, -300)).toEqual([0, 0, 0, 0, 0, (-127 & 0xff) >>> 0]);
  });

  it('tracks button bits, keeps the last position in button reports and resets', () => {
    const mouse = new MouseAbsoluteRelative();
    mouse.buttonDown(0);
    expect(mouse.buildButtonReport(0.5, 0.5)).toEqual([1, 0, 8, 0, 8, 0]);
    mouse.buttonDown(2);
    expect(mouse.buildButtonReport(0.5, 0.5)[0]).toBe(3);
    mouse.buttonUp(0);
    expect(mouse.buildButtonReport(0.5, 0.5)[0]).toBe(2);
    expect(mouse.reset()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(mouse.buildButtonReport(0.5, 0.5)[0]).toBe(0);
  });
});

describe('MouseReportRelative', () => {
  it('buildReport keeps the upstream ±127 clamp (single report)', () => {
    const mouse = new MouseReportRelative();
    expect(mouse.buildReport(300, -130, 2)).toEqual([0, 127, 0x81, 2]);
    expect(mouse.buildReport(2.5, -2.5)).toEqual([0, 3, 0xfe, 0]);
  });

  it('buildReports(300, -130, 0) splits into three reports with the buttons byte repeated', () => {
    const mouse = new MouseReportRelative();
    // -127 -> 0x81, -3 -> 0xFD
    expect(mouse.buildReports(300, -130, 0)).toEqual([
      [0, 127, 0x81, 0],
      [0, 127, 0xfd, 0],
      [0, 46, 0, 0]
    ]);
    mouse.buttonDown(0);
    expect(mouse.buildReports(300, -130)).toEqual([
      [1, 127, 0x81, 0],
      [1, 127, 0xfd, 0],
      [1, 46, 0, 0]
    ]);
  });

  it('buildReports returns [] for no motion and one report for small deltas', () => {
    const mouse = new MouseReportRelative();
    expect(mouse.buildReports(0, 0, 0)).toEqual([]);
    expect(mouse.buildReports(5, -3)).toEqual([[0, 5, 0xfd, 0]]);
    expect(mouse.buildReports(0, 0, 2)).toEqual([[0, 0, 0, 2]]);
    expect(mouse.buildReports(0, 0, 300)).toEqual([
      [0, 0, 0, 127],
      [0, 0, 0, 127],
      [0, 0, 0, 46]
    ]);
  });

  it('a button-only change is one report via buildButtonReport', () => {
    const mouse = new MouseReportRelative();
    mouse.buttonDown(1); // middle
    expect(mouse.buildButtonReport()).toEqual([4, 0, 0, 0]);
    mouse.buttonUp(1);
    expect(mouse.buildButtonReport()).toEqual([0, 0, 0, 0]);
    mouse.buttonDown(2);
    expect(mouse.reset()).toEqual([0, 0, 0, 0]);
  });

  it('buildRelativeReports is the pure core used by the move queue', () => {
    expect(buildRelativeReports(4, 128, 0)).toEqual([
      [4, 127, 0, 0],
      [4, 1, 0, 0]
    ]);
    expect(buildRelativeReports(0, 0, 0)).toEqual([]);
    expect(buildRelativeReports(0, -1, 1, -1)).toEqual([[0, 0xff, 1, 0xff]]);
  });
});
