import { realClock } from '@/libs/clock';
import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';

/**
 * HID log (spec §6.2): a ring buffer of the last reports handed to the device,
 * decoded for humans, with the time since the previous report. `Device`
 * pushes every keyboard / mouse payload before the serial write and marks the
 * entry when the write fails; the `?debug=hid` overlay renders the tail.
 *
 * Pure: no DOM, no React, no timers (the clock is injectable).
 */
export type HidKind = 'kb' | 'abs' | 'rel';

export const HID_LOG_CAPACITY = 200;

/**
 * Window event the Key-test modal dispatches after switching the storage flag
 * on, so an already mounted overlay shows itself without a reload.
 */
export const DEBUG_HID_EVENT = 'nanokvm-usb-debug-hid';

export interface HidLogEntry {
  /** Monotonic per log (1-based); keeps counting across eviction and clear(). */
  seq: number;
  /** Timestamp in ms (domain of the injected `now`, performance.now() by default). */
  t: number;
  /** ms since the previous entry of any kind; 0 for the very first entry. */
  dt: number;
  kind: HidKind;
  /**
   * Payload exactly as handed to Device: the 8-byte keyboard report
   * [modifier, 0, k1..k6], or the mouse payload including its 0x02 / 0x01
   * prefix byte ([0x02, buttons, xLo, xHi, yLo, yHi, wheel] /
   * [0x01, buttons, dx, dy, wheel]).
   */
  bytes: number[];
  /** Human-readable decode of `bytes` (see describeHid). */
  decoded: string;
  /** Set when the serial write of this report failed. */
  error?: string;
}

export interface KeyboardDecoded {
  kind: 'kb';
  /** Modifier names in bit order: Ctrl Shift Alt Win RCtrl RShift RAlt RWin. */
  modifiers: string[];
  /** Key names in report order (KeyC → 'C', Digit1 → '1', unknown → '0x..'). */
  keys: string[];
}

export interface AbsoluteDecoded {
  kind: 'abs';
  buttons: number;
  /** 0..4095 */
  x: number;
  /** 0..4095 */
  y: number;
  /** -128..127 */
  wheel: number;
}

export interface RelativeDecoded {
  kind: 'rel';
  buttons: number;
  dx: number;
  dy: number;
  wheel: number;
}

export type HidDecoded = KeyboardDecoded | AbsoluteDecoded | RelativeDecoded;

const NONE = '(none)';

const MODIFIER_NAMES: ReadonlyArray<readonly [number, string]> = [
  [ModifierBits.LeftCtrl, 'Ctrl'],
  [ModifierBits.LeftShift, 'Shift'],
  [ModifierBits.LeftAlt, 'Alt'],
  [ModifierBits.LeftMeta, 'Win'],
  [ModifierBits.RightCtrl, 'RCtrl'],
  [ModifierBits.RightShift, 'RShift'],
  [ModifierBits.RightAlt, 'RAlt'],
  [ModifierBits.RightMeta, 'RWin']
];

/** HID mouse buttons byte, bit for bit (same layout as DOM `buttons`). */
const BUTTON_NAMES: ReadonlyArray<readonly [number, string]> = [
  [1 << 0, 'L'],
  [1 << 1, 'R'],
  [1 << 2, 'M'],
  [1 << 3, 'B'],
  [1 << 4, 'F']
];

/** Reverse KeycodeMap; the first name wins for aliased usages (MetaLeft over WinLeft). */
const KEY_NAMES: ReadonlyMap<number, string> = (() => {
  const names = new Map<number, string>();
  for (const [code, usage] of Object.entries(KeycodeMap)) {
    if (!names.has(usage)) names.set(usage, code);
  }
  return names;
})();

function hexByte(byte: number): string {
  return (byte & 0xff).toString(16).padStart(2, '0');
}

/** Two-digit hex bytes separated by spaces: [1, 0, 6] → '01 00 06'. */
export function formatHex(bytes: readonly number[]): string {
  return bytes.map(hexByte).join(' ');
}

/** Signed interpretation of one report byte: 0x83 → -125, 0xff → -1. */
export function toInt8(byte: number): number {
  const value = byte & 0xff;
  return value > 127 ? value - 256 : value;
}

/** Display name of a HID usage: 'C', '1', 'Enter', 'ArrowLeft', or '0x..' when unknown. */
export function keyName(usage: number): string {
  const code = KEY_NAMES.get(usage & 0xff);
  if (code === undefined) return `0x${hexByte(usage).toUpperCase()}`;
  if (code.length === 4 && code.startsWith('Key')) return code.slice(3);
  if (code.length === 6 && code.startsWith('Digit')) return code.slice(5);
  return code;
}

function buttonNames(mask: number): string {
  const names = BUTTON_NAMES.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name);
  return names.length > 0 ? names.join('+') : '-';
}

/** Structured decode of a payload; missing bytes read as 0. */
export function decodeHid(kind: HidKind, bytes: readonly number[]): HidDecoded {
  const at = (index: number): number => (bytes[index] ?? 0) & 0xff;

  switch (kind) {
    case 'kb': {
      const modifier = at(0);
      const modifiers = MODIFIER_NAMES.filter(([bit]) => (modifier & bit) !== 0).map(
        ([, name]) => name
      );
      const keys: string[] = [];
      for (let i = 2; i < Math.min(bytes.length, 8); i++) {
        const usage = at(i);
        if (usage !== 0) keys.push(keyName(usage));
      }
      return { kind, modifiers, keys };
    }
    case 'abs':
      return {
        kind,
        buttons: at(1),
        x: at(2) | (at(3) << 8),
        y: at(4) | (at(5) << 8),
        wheel: toInt8(at(6))
      };
    case 'rel':
      return { kind, buttons: at(1), dx: toInt8(at(2)), dy: toInt8(at(3)), wheel: toInt8(at(4)) };
  }
}

/** One-line text of a decode: 'Ctrl + C', 'x=4095 y=2048 btn=L whl=-1', 'dx=-125 dy=3 btn=- whl=0'. */
export function describeHid(decoded: HidDecoded): string {
  switch (decoded.kind) {
    case 'kb': {
      const parts = [...decoded.modifiers, ...decoded.keys];
      return parts.length > 0 ? parts.join(' + ') : NONE;
    }
    case 'abs':
      return `x=${decoded.x} y=${decoded.y} btn=${buttonNames(decoded.buttons)} whl=${decoded.wheel}`;
    case 'rel':
      return `dx=${decoded.dx} dy=${decoded.dy} btn=${buttonNames(decoded.buttons)} whl=${decoded.wheel}`;
  }
}

/** `decodeHid` + `describeHid`; never throws (a malformed payload reads as '?'). */
export function decodeToText(kind: HidKind, bytes: readonly number[]): string {
  try {
    return describeHid(decodeHid(kind, bytes));
  } catch {
    return '?';
  }
}

/** One text line per entry, for the Copy button and bug reports. */
export function formatEntry(entry: HidLogEntry): string {
  const line = [
    `#${entry.seq}`,
    `${Math.round(entry.t)}ms`,
    `+${Math.round(entry.dt)}ms`,
    entry.kind.padEnd(3),
    formatHex(entry.bytes).padEnd(23),
    entry.decoded
  ].join('  ');
  return entry.error ? `${line}  !! ${entry.error}` : line;
}

/** True when a `location.search` string asks for the overlay (`?debug=hid`, also `debug=hid,foo`). */
export function hasDebugHidQuery(search: string): boolean {
  try {
    const value = new URLSearchParams(search).get('debug');
    return value !== null && value.split(',').includes('hid');
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

export type HidLogListener = () => void;

export interface HidLogOptions {
  /** Entries kept (oldest evicted first). Default HID_LOG_CAPACITY. */
  capacity?: number;
  /** Clock in ms. Default: realClock.now (performance.now). */
  now?: () => number;
}

export class HidLog {
  readonly capacity: number;

  private readonly now: () => number;
  private buffer: HidLogEntry[] = [];
  private seq = 0;
  private lastT: number | null = null;
  private failed = 0;
  private revision = 0;
  private readonly listeners = new Set<HidLogListener>();

  constructor(options: HidLogOptions = {}) {
    const capacity = options.capacity ?? HID_LOG_CAPACITY;
    this.capacity = Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : 1;
    this.now = options.now ?? realClock.now;
  }

  /** Records a payload about to be written. Never throws. */
  push(kind: HidKind, bytes: readonly number[]): HidLogEntry {
    const t = this.now();
    const entry: HidLogEntry = {
      seq: ++this.seq,
      t,
      dt: this.lastT === null ? 0 : Math.max(0, t - this.lastT),
      kind,
      bytes: Array.from(bytes, (byte) => byte & 0xff),
      decoded: decodeToText(kind, bytes)
    };
    this.lastT = t;

    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    this.notify();
    return entry;
  }

  /** Marks a pushed entry as failed; counted even when the entry was already evicted. */
  fail(entry: HidLogEntry, error: unknown): void {
    this.failed++;
    if (this.buffer.includes(entry)) {
      entry.error = errorMessage(error);
    }
    this.notify();
  }

  /** Oldest first. */
  entries(): HidLogEntry[] {
    return this.buffer.slice();
  }

  /** The newest `count` entries, oldest first. */
  last(count: number): HidLogEntry[] {
    return count > 0 ? this.buffer.slice(-count) : [];
  }

  /** Entries currently kept. */
  get size(): number {
    return this.buffer.length;
  }

  /** Reports pushed since creation (including evicted and cleared ones). */
  get total(): number {
    return this.seq;
  }

  /** Failed writes since creation or the last clear(). */
  get failures(): number {
    return this.failed;
  }

  /** Increments on every change; a cheap `useSyncExternalStore` snapshot. */
  get version(): number {
    return this.revision;
  }

  /** Drops the kept entries and the failure count; `seq` and the Δt reference keep running. */
  clear(): void {
    this.buffer = [];
    this.failed = 0;
    this.notify();
  }

  /** Fires after every push / fail / clear. Returns the unsubscribe function. */
  subscribe(listener: HidLogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  toText(): string {
    return this.buffer.map(formatEntry).join('\n');
  }

  private notify(): void {
    this.revision++;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch (error) {
        console.error('[hid-log] listener threw', error);
      }
    }
  }
}

/** The app-wide log, fed by Device. */
export const hidLog = new HidLog();
