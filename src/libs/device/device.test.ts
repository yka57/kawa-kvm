import { afterEach, describe, expect, it, vi } from 'vitest';

import { hidLog } from '@/libs/debug/hid-log';
import { FakeClock } from '@/test/fakes';

import { Device } from './index';

const GET_INFO = [0x57, 0xab, 0x00, 0x01, 0x00, 0x03];
const ACK = [0x57, 0xab, 0x00, 0x82, 0x01, 0x00, 0x85];

function frameBytes(cmd: number, data: number[]): number[] {
  const bytes = [0x57, 0xab, 0x00, cmd, data.length, ...data];
  return [...bytes, bytes.reduce((sum, byte) => sum + byte, 0) & 0xff];
}

/** GET_INFO reply: version V1.8, `usb` enumerated flag, LED bits (bit0 Num, bit1 Caps, bit2 Scroll). */
const info = (led: number, usb = 0x01) => frameBytes(0x81, [0x38, usb, led, 0, 0, 0, 0, 0]);
const INFO_ERROR = frameBytes(0xc1, [0xe1]);

/** Lets the streams and the read loop run (the device's own timers use the FakeClock). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A Device on an open fake port. `answers[n]` is what the chip sends back
 * for the n-th GET_INFO (chunks pushed in order); nothing when absent.
 * `glitch()` is a recoverable read error: as in WebSerial, the stream errors
 * and the next `readable` access opens a new one; bytes sent in between
 * wait for it.
 */
async function setup(answers: number[][][] = []) {
  vi.stubGlobal('navigator', { serial: new EventTarget() });
  const clock = new FakeClock();
  const device = new Device(clock);
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let stream: ReadableStream<Uint8Array> | null = null;
  const waiting: number[][] = [];
  const push = (bytes: number[]) => {
    if (controller) controller.enqueue(new Uint8Array(bytes));
    else waiting.push(bytes);
  };
  const writes: number[][] = [];
  let requests = 0;
  const port = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    get readable(): ReadableStream<Uint8Array> {
      if (stream === null) {
        stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          }
        });
        waiting.splice(0).forEach(push);
      }
      return stream;
    },
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        const bytes = Array.from(chunk);
        writes.push(bytes);
        if (bytes[3] === 0x01) (answers[requests++] ?? []).forEach(push);
      }
    })
  };
  await device.serialPort.init({ port });
  const glitch = (name: string) => {
    const errored = controller!;
    stream = null;
    controller = null;
    errored.error(new DOMException(`${name} on the line`, name));
  };
  return { device, clock, writes, push, glitch };
}

describe('Device.getLockState', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('writes GET_INFO and answers with the first 0x81 frame, after stale acks', async () => {
    const t = await setup([[ACK, ACK, [...ACK, ...info(0x02)]]]);
    const logged = hidLog.size;

    const state = t.device.getLockState();
    await tick();
    await expect(state).resolves.toEqual({ num: false, caps: true, scroll: false, version: 0x38 });
    expect(t.writes).toEqual([GET_INFO]);
    expect(hidLog.size).toBe(logged); // a query is not a report the target sees
    expect(t.clock.pendingTimers()).toBe(0);
  });

  it('decodes the Num, Caps and Scroll bits', async () => {
    const t = await setup([[info(0x07)], [info(0x01)], [info(0x00)]]);
    const all = t.device.getLockState();
    await tick();
    expect(await all).toEqual({ num: true, caps: true, scroll: true, version: 0x38 });
    const num = t.device.getLockState();
    await tick();
    expect(await num).toMatchObject({ num: true, caps: false, scroll: false });
    const none = t.device.getLockState();
    await tick();
    expect(await none).toMatchObject({ num: false, caps: false, scroll: false });
  });

  it('ignores a GET_INFO reply that arrived before the request', async () => {
    const t = await setup([[info(0x02)]]);
    t.push(info(0x00)); // an old unsolicited LED report
    await tick();
    const state = t.device.getLockState();
    await tick();
    expect(await state).toMatchObject({ caps: true });
  });

  it('retries once after a timeout, then answers null', async () => {
    const t = await setup();
    let result: unknown = 'pending';
    t.device.getLockState().then((value) => (result = value));
    await tick();
    expect(t.writes).toEqual([GET_INFO]);

    await t.clock.advanceAsync(299);
    expect(t.writes).toHaveLength(1);
    await t.clock.advanceAsync(1);
    await tick();
    expect(t.writes).toEqual([GET_INFO, GET_INFO]);
    expect(result).toBe('pending');

    await t.clock.advanceAsync(300);
    await tick();
    expect(result).toBeNull();
    expect(t.writes).toHaveLength(2);
    expect(t.clock.pendingTimers()).toBe(0);
  });

  it('retries once after a 0xC1 error reply', async () => {
    const t = await setup([[INFO_ERROR], [info(0x02)]]);
    const state = t.device.getLockState();
    await tick();
    await tick();
    expect(await state).toMatchObject({ caps: true });
    expect(t.writes).toEqual([GET_INFO, GET_INFO]);

    const twice = await setup([[INFO_ERROR], [INFO_ERROR], [info(0x02)]]);
    const failed = twice.device.getLockState();
    await tick();
    await tick();
    expect(await failed).toBeNull();
    expect(twice.writes).toHaveLength(2);
  });

  it('answers null without retrying when the target has not enumerated the device', async () => {
    const t = await setup([[info(0x02, 0x00)], [info(0x02)]]);
    const state = t.device.getLockState();
    await tick();
    expect(await state).toBeNull();
    expect(t.writes).toHaveLength(1);
  });

  it('concurrent calls share the request in flight; the next call asks again', async () => {
    const t = await setup([[info(0x02)], [info(0x00)]]);
    const first = t.device.getLockState();
    const second = t.device.getLockState(50);
    expect(second).toBe(first);
    await tick();
    expect(await first).toMatchObject({ caps: true });
    expect(t.writes).toHaveLength(1);

    const third = t.device.getLockState();
    expect(third).not.toBe(first);
    await tick();
    expect(await third).toMatchObject({ caps: false });
    expect(t.writes).toHaveLength(2);
  });

  it('still answers after a recoverable read error: the read loop resumes on the new stream', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await setup([[info(0x02)]]);
    t.glitch('FramingError');
    await tick();
    expect(error).toHaveBeenCalledWith('Serial read failed:', expect.any(DOMException));

    let result: unknown = 'pending';
    void t.device.getLockState().then((value) => (result = value));
    await tick();
    expect(result).toEqual({ num: false, caps: true, scroll: false, version: 0x38 });
    expect(t.writes).toEqual([GET_INFO]);
  });

  it('answers null at once when the serial port is not open', async () => {
    const clock = new FakeClock();
    const device = new Device(clock);
    await expect(device.getLockState()).resolves.toBeNull();
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('Device.lockState', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('follows the unsolicited LED reports and the answers to requests', async () => {
    const t = await setup([[info(0x01)]]);
    expect(t.device.lockState).toBeNull();

    t.push(info(0x02));
    await tick();
    expect(t.device.lockState).toEqual({ num: false, caps: true, scroll: false, version: 0x38 });

    const state = t.device.getLockState();
    await tick();
    await state;
    expect(t.device.lockState).toMatchObject({ num: true, caps: false });

    t.push(info(0x02, 0x00)); // target gone: the LED bits mean nothing
    await tick();
    expect(t.device.lockState).toBeNull();
  });
});
