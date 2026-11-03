import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Device } from '@/libs/device';

import {
  decodeHid,
  describeHid,
  formatEntry,
  formatHex,
  hasDebugHidQuery,
  HID_LOG_CAPACITY,
  HidLog,
  hidLog,
  keyName,
  toInt8
} from './hid-log';

const KB_CTRL_C = [0x01, 0, 0x06, 0, 0, 0, 0, 0];
const ZERO = [0, 0, 0, 0, 0, 0, 0, 0];

/** Deterministic clock: returns the queued timestamps in order, then repeats the last one. */
function clockOf(...times: number[]): () => number {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)];
}

describe('decodeHid / describeHid', () => {
  it('decodes a keyboard report into modifier and key names', () => {
    expect(decodeHid('kb', KB_CTRL_C)).toEqual({ kind: 'kb', modifiers: ['Ctrl'], keys: ['C'] });
    expect(describeHid(decodeHid('kb', KB_CTRL_C))).toBe('Ctrl + C');
    expect(describeHid(decodeHid('kb', [0x03, 0, 0x17, 0, 0, 0, 0, 0]))).toBe('Ctrl + Shift + T');
    expect(describeHid(decodeHid('kb', [0x08, 0, 0, 0, 0, 0, 0, 0]))).toBe('Win');
    expect(describeHid(decodeHid('kb', [0xf0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      'RCtrl + RShift + RAlt + RWin'
    );
  });

  it('shortens letters and digits, keeps named keys and lists several keys in report order', () => {
    expect(describeHid(decodeHid('kb', [0, 0, 0x1e, 0x28, 0x50, 0, 0, 0]))).toBe(
      '1 + Enter + ArrowLeft'
    );
    expect(describeHid(decodeHid('kb', [0x02, 0, 0x04, 0x05, 0, 0, 0, 0]))).toBe('Shift + A + B');
  });

  it('reads the all-zero report as (none) and unknown usages as hex', () => {
    expect(describeHid(decodeHid('kb', ZERO))).toBe('(none)');
    expect(describeHid(decodeHid('kb', [0, 0, 0xff, 0, 0, 0, 0, 0]))).toBe('0xFF');
    // short or over-long payloads never throw
    expect(describeHid(decodeHid('kb', []))).toBe('(none)');
    expect(describeHid(decodeHid('kb', [0x01]))).toBe('Ctrl');
    expect(decodeHid('kb', [0, 0, 0x04, 0, 0, 0, 0, 0, 0x05])).toMatchObject({ keys: ['A'] });
  });

  it('decodes an absolute payload: little-endian 12-bit x/y, buttons, signed wheel', () => {
    const decoded = decodeHid('abs', [0x02, 0x01, 0xff, 0x0f, 0x00, 0x08, 0xff]);
    expect(decoded).toEqual({ kind: 'abs', buttons: 1, x: 4095, y: 2048, wheel: -1 });
    expect(describeHid(decoded)).toBe('x=4095 y=2048 btn=L whl=-1');
    expect(describeHid(decodeHid('abs', [0x02, 0x03, 0, 0, 0, 0, 0x01]))).toBe(
      'x=0 y=0 btn=L+R whl=1'
    );
    expect(describeHid(decodeHid('abs', [0x02, 0x1c, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBe(
      'x=0 y=0 btn=M+B+F whl=0'
    );
  });

  it('decodes a relative payload with signed deltas', () => {
    const decoded = decodeHid('rel', [0x01, 0x00, 0x83, 0x05, 0xfe]);
    expect(decoded).toEqual({ kind: 'rel', buttons: 0, dx: -125, dy: 5, wheel: -2 });
    expect(describeHid(decoded)).toBe('dx=-125 dy=5 btn=- whl=-2');
    expect(describeHid(decodeHid('rel', [0x01, 0x01, 0x7f, 0x80, 0x00]))).toBe(
      'dx=127 dy=-128 btn=L whl=0'
    );
  });

  it('toInt8 / formatHex / keyName helpers', () => {
    expect([0x7f, 0x80, 0xff, 0x83, 0x00].map(toInt8)).toEqual([127, -128, -1, -125, 0]);
    expect(formatHex(KB_CTRL_C)).toBe('01 00 06 00 00 00 00 00');
    expect(formatHex([])).toBe('');
    expect(keyName(0x04)).toBe('A');
    expect(keyName(0x1e)).toBe('1');
    expect(keyName(0x28)).toBe('Enter');
    // aliases: the first KeycodeMap name wins
    expect(keyName(0xe3)).toBe('MetaLeft');
    expect(keyName(0xf0)).toBe('BrowserSearch');
    expect(keyName(0x00)).toBe('0x00');
  });
});

describe('HidLog ring buffer', () => {
  it('keeps the newest 200 entries and keeps counting seq across eviction', () => {
    const log = new HidLog({ now: () => 0 });
    expect(log.capacity).toBe(HID_LOG_CAPACITY);
    expect(HID_LOG_CAPACITY).toBe(200);

    for (let i = 0; i < 250; i++) log.push('kb', [0, 0, 0x04 + (i % 26), 0, 0, 0, 0, 0]);

    const entries = log.entries();
    expect(log.size).toBe(200);
    expect(log.total).toBe(250);
    expect(entries).toHaveLength(200);
    expect(entries[0].seq).toBe(51);
    expect(entries[199].seq).toBe(250);
    expect(log.last(3).map((entry) => entry.seq)).toEqual([248, 249, 250]);
    expect(log.last(0)).toEqual([]);
  });

  it('records bytes, kind, decoded text and Δt to the previous entry of any kind', () => {
    const log = new HidLog({ now: clockOf(100, 115.5, 115.5, 110) });

    const first = log.push('kb', KB_CTRL_C);
    const second = log.push('abs', [0x02, 0, 0xff, 0x0f, 0, 0, 0]);
    const third = log.push('rel', [0x01, 0, 0x83, 0, 0]);
    const fourth = log.push('kb', ZERO);

    expect(first).toMatchObject({ seq: 1, t: 100, dt: 0, kind: 'kb', decoded: 'Ctrl + C' });
    expect(first.bytes).toEqual(KB_CTRL_C);
    expect(second).toMatchObject({
      seq: 2,
      dt: 15.5,
      kind: 'abs',
      decoded: 'x=4095 y=0 btn=- whl=0'
    });
    expect(third).toMatchObject({
      seq: 3,
      dt: 0,
      kind: 'rel',
      decoded: 'dx=-125 dy=0 btn=- whl=0'
    });
    // a clock going backwards never yields a negative Δt
    expect(fourth.dt).toBe(0);
    // the stored bytes are a copy
    const bytes = [0x01, 0, 0, 0, 0, 0, 0, 0];
    const entry = log.push('kb', bytes);
    bytes[0] = 0xff;
    expect(entry.bytes[0]).toBe(0x01);
  });

  it('fail() marks the entry in place, counts failures and ignores evicted entries', () => {
    const log = new HidLog({ capacity: 2, now: () => 0 });
    const a = log.push('kb', KB_CTRL_C);
    const b = log.push('kb', ZERO);

    log.fail(b, new Error('fake serial error'));
    expect(log.entries().map((entry) => entry.error)).toEqual([undefined, 'fake serial error']);
    expect(log.failures).toBe(1);

    log.push('kb', ZERO); // evicts a
    log.fail(a, 'late');
    expect(a.error).toBeUndefined();
    expect(log.failures).toBe(2);
    expect(log.entries().map((entry) => entry.seq)).toEqual([2, 3]);

    log.fail(log.push('kb', ZERO), { name: 'Weird' });
    expect(log.last(1)[0].error).toBe('[object Object]');
  });

  it('clear() drops entries and the failure count but not seq or the Δt reference', () => {
    const log = new HidLog({ now: clockOf(0, 10, 1000) });
    log.fail(log.push('kb', ZERO), new Error('x'));
    log.push('kb', ZERO);

    log.clear();
    expect(log.size).toBe(0);
    expect(log.failures).toBe(0);
    expect(log.toText()).toBe('');

    const next = log.push('kb', ZERO);
    expect(next.seq).toBe(3);
    expect(next.dt).toBe(990);
  });

  it('subscribe() fires on push, fail and clear until unsubscribed; version increments', () => {
    const log = new HidLog({ now: () => 0 });
    const calls: number[] = [];
    const off = log.subscribe(() => calls.push(log.version));

    const entry = log.push('kb', ZERO);
    log.fail(entry, new Error('e'));
    log.clear();
    expect(calls).toEqual([1, 2, 3]);

    off();
    log.push('kb', ZERO);
    expect(calls).toEqual([1, 2, 3]);
    expect(log.version).toBe(4);
  });

  it('a throwing listener is isolated and the others still run', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = new HidLog({ now: () => 0 });
    const seen: string[] = [];
    log.subscribe(() => {
      throw new Error('boom');
    });
    log.subscribe(() => seen.push('ok'));

    expect(() => log.push('kb', ZERO)).not.toThrow();
    expect(seen).toEqual(['ok']);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('formatEntry / toText produce one readable line per entry, failures flagged', () => {
    const log = new HidLog({ now: clockOf(1000, 1012.4) });
    log.push('kb', KB_CTRL_C);
    log.fail(log.push('abs', [0x02, 0x01, 0xff, 0x0f, 0, 0, 0]), new Error('Device disconnected'));

    const [first, second] = log.entries();
    expect(formatEntry(first)).toBe('#1  1000ms  +0ms  kb   01 00 06 00 00 00 00 00  Ctrl + C');
    expect(formatEntry(second)).toBe(
      '#2  1012ms  +12ms  abs  02 01 ff 0f 00 00 00     x=4095 y=0 btn=L whl=0  !! Device disconnected'
    );
    expect(log.toText().split('\n')).toHaveLength(2);
  });

  it('capacity is validated', () => {
    expect(new HidLog({ capacity: 0 }).capacity).toBe(1);
    expect(new HidLog({ capacity: 2.7 }).capacity).toBe(2);
    expect(new HidLog({ capacity: Number.NaN }).capacity).toBe(1);
  });
});

describe('hasDebugHidQuery', () => {
  it('matches debug=hid in any position, with or without the leading ?', () => {
    expect(hasDebugHidQuery('?debug=hid')).toBe(true);
    expect(hasDebugHidQuery('debug=hid')).toBe(true);
    expect(hasDebugHidQuery('?a=1&debug=hid&b=2')).toBe(true);
    expect(hasDebugHidQuery('?debug=hid,foo')).toBe(true);
    expect(hasDebugHidQuery('?debug=foo,hid')).toBe(true);
  });

  it('rejects other values and empty searches', () => {
    expect(hasDebugHidQuery('')).toBe(false);
    expect(hasDebugHidQuery('?debug')).toBe(false);
    expect(hasDebugHidQuery('?debug=hid2')).toBe(false);
    expect(hasDebugHidQuery('?debug=HID')).toBe(false);
    expect(hasDebugHidQuery('?hid=debug')).toBe(false);
  });
});

describe('Device tap', () => {
  beforeEach(() => {
    hidLog.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records every report before the write and marks a failed write on the entry', async () => {
    const device = new Device(); // serial not initialised: every write rejects
    const before = hidLog.size;

    await expect(device.sendKeyboardData(KB_CTRL_C)).rejects.toThrow('Serial port not initialized');
    await expect(device.sendMouseData([0x02, 0, 0xff, 0x0f, 0, 0, 0])).rejects.toThrow();
    await expect(device.sendMouseData([0x01, 0, 0x83, 0, 0])).rejects.toThrow();
    await device.sendMouseData([]); // upstream no-op stays a no-op

    const entries = hidLog.entries().slice(before);
    expect(entries.map((entry) => entry.kind)).toEqual(['kb', 'abs', 'rel']);
    expect(entries.map((entry) => entry.decoded)).toEqual([
      'Ctrl + C',
      'x=4095 y=0 btn=- whl=0',
      'dx=-125 dy=0 btn=- whl=0'
    ]);
    expect(entries.every((entry) => entry.error === 'Serial port not initialized')).toBe(true);
    expect(hidLog.failures).toBe(3);
  });

  it('a successful write leaves the entry clean and the wire bytes untouched', async () => {
    const device = new Device();
    const frames: number[][] = [];
    vi.spyOn(device.serialPort, 'write').mockImplementation(async (data: number[]) => {
      frames.push(data);
    });

    await device.sendKeyboardData(KB_CTRL_C);
    await device.sendMouseData([0x01, 0, 10, 10, 0]);

    // CH9329 framing: 57 AB addr cmd len data... sum (kb cmd 0x02, relative mouse cmd 0x05)
    expect(frames[0]).toEqual([0x57, 0xab, 0x00, 0x02, 0x08, ...KB_CTRL_C, 0x13]);
    expect(frames[1].slice(0, 5)).toEqual([0x57, 0xab, 0x00, 0x05, 0x05]);

    const [kb, rel] = hidLog.last(2);
    expect(kb).toMatchObject({ kind: 'kb', bytes: KB_CTRL_C, decoded: 'Ctrl + C' });
    expect(kb.error).toBeUndefined();
    expect(rel).toMatchObject({ kind: 'rel', decoded: 'dx=10 dy=10 btn=- whl=0' });
    expect(hidLog.failures).toBe(0);
  });
});
