import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ParsedFrame } from './frame-parser';
import { SerialPort } from './serial-port';

function disconnectError(): Error {
  const error = new Error('The device has been lost.');
  error.name = 'NetworkError';
  return error;
}

function makePort(write: (chunk: Uint8Array) => Promise<void>) {
  return {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>({ write })
  };
}

describe('SerialPort disconnect listeners', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('run once, before onDisconnect, when a write hits a disconnect error', async () => {
    vi.stubGlobal('navigator', { serial: new EventTarget() });
    const serial = new SerialPort();
    const order: string[] = [];
    await serial.init({
      port: makePort(() => Promise.reject(disconnectError())),
      onDisconnect: () => {
        order.push('onDisconnect');
      }
    });
    const unsubscribe = serial.addDisconnectListener(() => {
      order.push('listener');
    });

    await expect(serial.write([1, 2, 3])).rejects.toThrow('Device disconnected');
    expect(order).toEqual(['listener', 'onDisconnect']);

    // the port is gone: no second round
    await expect(serial.write([4])).rejects.toThrow('not initialized');
    expect(order).toEqual(['listener', 'onDisconnect']);
    unsubscribe();
  });

  it('a throwing or unsubscribed listener does not stop the others', async () => {
    vi.stubGlobal('navigator', { serial: new EventTarget() });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const serial = new SerialPort();
    const calls: string[] = [];
    await serial.init({ port: makePort(() => Promise.reject(disconnectError())) });

    const off = serial.addDisconnectListener(() => {
      calls.push('removed');
    });
    serial.addDisconnectListener(() => {
      throw new Error('boom');
    });
    serial.addDisconnectListener(() => {
      calls.push('kept');
    });
    off();

    await expect(serial.write([1])).rejects.toThrow('Device disconnected');
    expect(calls).toEqual(['kept']);
  });

  it('a non-disconnect write error leaves the port open and the listeners silent', async () => {
    vi.stubGlobal('navigator', { serial: new EventTarget() });
    const serial = new SerialPort();
    const calls: string[] = [];
    await serial.init({ port: makePort(() => Promise.reject(new Error('busy'))) });
    serial.addDisconnectListener(() => {
      calls.push('listener');
    });

    await expect(serial.write([1])).rejects.toThrow('busy');
    expect(calls).toEqual([]);
  });
});

const ACK = [0x57, 0xab, 0x00, 0x82, 0x01, 0x00, 0x85];
const INFO = [0x57, 0xab, 0x00, 0x81, 0x08, 0x38, 0x01, 0x02, 0, 0, 0, 0, 0, 0xc6];

/** Lets the stream and the read loop run (no fake timers here). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A port whose incoming bytes the test pushes; counts the reader's read()
 * calls and how many are outstanding at once.
 */
function makeReadablePort() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    }
  });
  const reads = { calls: 0, outstanding: 0, maxOutstanding: 0 };
  const getReader = readable.getReader.bind(readable);
  readable.getReader = (() => {
    const reader = getReader();
    const read = reader.read.bind(reader);
    reader.read = () => {
      reads.calls++;
      reads.outstanding++;
      reads.maxOutstanding = Math.max(reads.maxOutstanding, reads.outstanding);
      return read().finally(() => {
        reads.outstanding--;
      });
    };
    return reader;
  }) as typeof readable.getReader;

  const port = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    readable,
    writable: new WritableStream<Uint8Array>()
  };
  return {
    port,
    reads,
    push: (bytes: number[]) => controller.enqueue(new Uint8Array(bytes)),
    fail: (error: Error) => controller.error(error)
  };
}

describe('SerialPort read loop', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses every chunk and dispatches the frames; a throwing listener is isolated', async () => {
    vi.stubGlobal('navigator', { serial: new EventTarget() });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const serial = new SerialPort();
    const device = makeReadablePort();
    await serial.init({ port: device.port });

    const frames: ParsedFrame[] = [];
    serial.onFrame(() => {
      throw new Error('boom');
    });
    const off = serial.onFrame((frame) => frames.push(frame));

    device.push(ACK.slice(0, 3));
    device.push([...ACK.slice(3), ...INFO.slice(0, 9)]);
    device.push(INFO.slice(9));
    await tick();
    expect(frames).toEqual([
      { addr: 0, cmd: 0x82, data: [0x00] },
      { addr: 0, cmd: 0x81, data: [0x38, 0x01, 0x02, 0, 0, 0, 0, 0] }
    ]);
    expect(error).toHaveBeenCalledTimes(2);

    off();
    device.push(ACK);
    await tick();
    expect(frames).toHaveLength(2);
  });

  it('keeps exactly one read() outstanding', async () => {
    vi.stubGlobal('navigator', { serial: new EventTarget() });
    const serial = new SerialPort();
    const device = makeReadablePort();
    await serial.init({ port: device.port });
    await tick();
    expect(device.reads).toMatchObject({ calls: 1, outstanding: 1 });

    for (let i = 0; i < 5; i++) device.push(ACK);
    await tick();
    expect(device.reads.outstanding).toBe(1);
    expect(device.reads.maxOutstanding).toBe(1);
    expect(device.reads.calls).toBeGreaterThan(1);
  });

  it('close() ends the loop and the next init starts from a clean parser', async () => {
    vi.stubGlobal('navigator', { serial: new EventTarget() });
    const serial = new SerialPort();
    const frames: number[] = [];
    serial.onFrame((frame) => frames.push(frame.cmd));

    const first = makeReadablePort();
    await serial.init({ port: first.port });
    first.push(INFO.slice(0, 8)); // half a frame
    await tick();
    await serial.close();
    await tick();
    expect(first.port.close).toHaveBeenCalledTimes(1);
    expect(first.reads.outstanding).toBe(0);
    const callsAtClose = first.reads.calls;

    const second = makeReadablePort();
    await serial.init({ port: second.port });
    second.push([...INFO.slice(8), ...ACK]); // the rest of the old frame must not complete it
    await tick();
    expect(frames).toEqual([0x82]);
    expect(first.reads.calls).toBe(callsAtClose);
  });

  it('a disconnect error from read() runs the disconnect handling exactly once', async () => {
    const serialEvents = new EventTarget();
    vi.stubGlobal('navigator', { serial: serialEvents });
    const serial = new SerialPort();
    const device = makeReadablePort();
    const order: string[] = [];
    await serial.init({
      port: device.port,
      onDisconnect: () => {
        order.push('onDisconnect');
      }
    });
    serial.addDisconnectListener(() => {
      order.push('listener');
    });

    device.fail(disconnectError());
    await tick();
    expect(order).toEqual(['listener', 'onDisconnect']);

    // the browser's own disconnect event for the same port arrives afterwards
    const event = new Event('disconnect');
    Object.defineProperty(event, 'target', { value: device.port });
    serialEvents.dispatchEvent(event);
    expect(order).toEqual(['listener', 'onDisconnect']);
    await expect(serial.write([1])).rejects.toThrow('not initialized');
  });

  it('ignores the rejected read of a reader it released itself', async () => {
    vi.stubGlobal('navigator', { serial: new EventTarget() });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const serial = new SerialPort();
    const calls: string[] = [];
    // the write path detects the disconnect and releases the reader under the pending read
    await serial.init({ port: makePort(() => Promise.reject(disconnectError())) });
    serial.addDisconnectListener(() => {
      calls.push('listener');
    });

    await expect(serial.write([1])).rejects.toThrow('Device disconnected');
    await tick();
    expect(calls).toEqual(['listener']);
    expect(error).not.toHaveBeenCalled();
  });

  it('another read error ends the loop with a log and keeps the port', async () => {
    vi.stubGlobal('navigator', { serial: new EventTarget() });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const serial = new SerialPort();
    const device = makeReadablePort();
    const calls: string[] = [];
    await serial.init({ port: device.port });
    serial.addDisconnectListener(() => {
      calls.push('listener');
    });

    device.fail(new Error('Framing error'));
    await tick();
    expect(error).toHaveBeenCalledWith('Serial read failed:', expect.any(Error));
    expect(calls).toEqual([]);
    expect(device.reads.outstanding).toBe(0);
    expect(device.reads.calls).toBe(1);
  });
});
