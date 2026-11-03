import { toAbs4095 } from '@/libs/pointer/absolute-map';
import { splitInt8 } from '@/libs/pointer/relative-motion';

// Button bit positions
const MouseButtons = {
  Left: 1 << 0,
  Right: 1 << 1,
  Middle: 1 << 2,
  Back: 1 << 3,
  Forward: 1 << 4
} as const;

// Map browser button index to HID bit
function getMouseButtonBit(button: number): number {
  switch (button) {
    case 0:
      return MouseButtons.Left;
    case 1:
      return MouseButtons.Middle;
    case 2:
      return MouseButtons.Right;
    case 3:
      return MouseButtons.Back;
    case 4:
      return MouseButtons.Forward;
    default:
      return 0;
  }
}

/**
 * Build relative reports for arbitrary deltas: each axis is split into int8
 * chunks (`splitInt8`), the chunks are zipped into one report per index and
 * the buttons byte is repeated. 300/-130 → three reports; all-zero → [].
 */
export function buildRelativeReports(
  buttons: number,
  deltaX: number,
  deltaY: number,
  wheel: number = 0
): number[][] {
  const xs = splitInt8(deltaX);
  const ys = splitInt8(deltaY);
  const ws = splitInt8(wheel);
  const count = Math.max(xs.length, ys.length, ws.length);

  const reports: number[][] = [];
  for (let i = 0; i < count; i++) {
    reports.push([buttons, (xs[i] ?? 0) & 0xff, (ys[i] ?? 0) & 0xff, (ws[i] ?? 0) & 0xff]);
  }
  return reports;
}

/**
 * Relative Mouse Report (4 bytes)
 *
 * Byte 0: Buttons
 * Byte 1: X movement (-127 to 127)
 * Byte 2: Y movement (-127 to 127)
 * Byte 3: Wheel (-127 to 127)
 */
export class MouseReportRelative {
  private buttons: number = 0;

  buttonDown(button: number): void {
    this.buttons |= getMouseButtonBit(button);
  }

  buttonUp(button: number): void {
    this.buttons &= ~getMouseButtonBit(button);
  }

  /**
   * Build relative mouse report
   * @param deltaX X movement (-127 to 127)
   * @param deltaY Y movement (-127 to 127)
   * @param wheel Scroll wheel (-127 to 127, negative = down)
   */
  buildReport(deltaX: number, deltaY: number, wheel: number = 0): number[] {
    const x = this.clamp(Math.round(deltaX), -127, 127) & 0xff;
    const y = this.clamp(Math.round(deltaY), -127, 127) & 0xff;
    const scroll = this.clamp(Math.round(wheel), -127, 127) & 0xff;
    return [this.buttons, x, y, scroll];
  }

  /**
   * Build one report per int8 chunk for deltas beyond ±127 (flicks), buttons
   * repeated in every report. Returns [] when nothing moves; use
   * buildButtonReport() for a pure button change.
   * @param deltaX X movement (any integer)
   * @param deltaY Y movement (any integer)
   * @param wheel Scroll wheel notches (any integer, negative = down)
   */
  buildReports(deltaX: number, deltaY: number, wheel: number = 0): number[][] {
    return buildRelativeReports(this.buttons, deltaX, deltaY, wheel);
  }

  /**
   * Build button-only report (no movement)
   */
  buildButtonReport(): number[] {
    return this.buildReport(0, 0, 0);
  }

  reset(): number[] {
    this.buttons = 0;
    return this.buildReport(0, 0, 0);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}

/**
 * Absolute Mouse Report (6 bytes)
 *
 * Byte 0: Buttons
 * Byte 1-2: X position (0 to 4095, Little Endian)
 * Byte 3-4: Y position (0 to 4095, Little Endian)
 * Byte 5: Wheel
 */
export class MouseAbsoluteRelative {
  private buttons: number = 0;

  buttonDown(button: number): void {
    this.buttons |= getMouseButtonBit(button);
  }

  buttonUp(button: number): void {
    this.buttons &= ~getMouseButtonBit(button);
  }

  /**
   * Build absolute mouse report
   * @param x X position (0.0 to 1.0, normalized)
   * @param y Y position (0.0 to 1.0, normalized)
   * @param wheel Scroll wheel (-127 to 127)
   */
  buildReport(x: number, y: number, wheel: number = 0): number[] {
    // Convert normalized coordinates (0-1) to absolute coordinates (0-4095)
    const xAbs = toAbs4095(x);
    const yAbs = toAbs4095(y);

    const x1 = xAbs & 0xff;
    const x2 = (xAbs >> 8) & 0xff;
    const y1 = yAbs & 0xff;
    const y2 = (yAbs >> 8) & 0xff;
    const scroll = this.clamp(Math.round(wheel), -127, 127) & 0xff;

    return [this.buttons, x1, x2, y1, y2, scroll];
  }

  /**
   * Build button-only report (keeps last position)
   */
  buildButtonReport(lastX: number, lastY: number): number[] {
    return this.buildReport(lastX, lastY, 0);
  }

  reset(): number[] {
    this.buttons = 0;
    return this.buildReport(0, 0, 0);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
