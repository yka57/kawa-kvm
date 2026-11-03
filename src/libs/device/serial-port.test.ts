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
 * calls and how many are outstanding at once. Its `readable` never changes,
 * like a port after a fatal error.
 */
function makeReadablePort(write: (chunk: Uint8Array) => Promise<void> = async () => {}) {
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
    writable: new WritableStream<Uint8Array>({ write })
  };
  return {
    port,
    reads,
    push: (bytes: number[]) => controller.enqueue(new Uint8Array(bytes)),
    fail: (error: Error) => controller.error(error)
  };
}

/**
 * A port with WebSerial's read-error rules: a BreakError, FramingError,
 * ParityError or BufferOverrunError errors the current stream and the next
 * `readable` access creates a new one while the port stays open; after a
 * fatal error `readable` is null. Read statistics span all streams.
 */
function makeWebSerialPort() {
  let current: {
    stream: ReadableStream<Uint8Array>;
    controller: ReadableStreamDefaultController<Uint8Array>;
  } | null = null;
  let open = false;
  let fatal = false;
  const stats = { streams: 0, calls: 0, outstanding: 0, maxOutstanding: 0 };

  function createStream(): ReadableStream<Uint8Array> {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      }
    });
    const getReader = stream.getReader.bind(stream);
    stream.getReader = (() => {
      const reader = getReader();
      const read = reader.read.bind(reader);
      reader.read = () => {
        stats.calls++;
        stats.outstanding++;
        stats.maxOutstanding = Math.max(stats.maxOutstanding, stats.outstanding);
        return read().finally(() => {
          stats.outstanding--;
        });
      };
      return reader;
    }) as typeof stream.getReader;
    current = { stream, controller };
    stats.streams++;
    return stream;
  }

  const port = {
    open: vi.fn(async () => {
      open = true;
    }),
    close: vi.fn(async () => {
      open = false;
      current = null;
    }),
    get readable(): ReadableStream<Uint8Array> | null {
      if (current) return current.stream;
      return open && !fatal ? createStream() : null;
    },
    writable: new WritableStream<Uint8Array>()
  };

  const error = (name: string, message: string, isFatal: boolean) => {
    const stream = current!;
    current = null;
    fatal = isFatal;
    stream.controller.error(new DOMException(message, name));
  };
  return {
    port,
    stats,
    push: (bytes: number[]) => current!.controller.enqueue(new Uint8Array(bytes)),
    recoverable: (name: string) => error(name, `${name} on the line`, false),
    fatal: () => error('UnknownError', 'An unknown system error has occurred.', true),
    lost: () => error('NetworkError', 'The device has been lost.', true)
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

  it('a read error without a new stream to resume on ends the loop with a log and keeps the port', async () => {
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

describe('SerialPort read loop recovery (spec v2 §14.8)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function setup() {
    const events = new EventTarget();
    vi.stubGlobal('navigator', { serial: events });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const serial = new SerialPort();
    const device = makeWebSerialPort();
    const frames: number[] = [];
    serial.onFrame((frame) => frames.push(frame.cmd));
    const order: string[] = [];
    await serial.init({ port: device.port, onDisconnect: () => order.push('onDisconnect') });
    serial.addDisconnectListener(() => order.push('listener'));
    await tick();
    return { serial, device, frames, error, order, events };
  }

  it.each(['BreakError', 'FramingError', 'ParityError', 'BufferOverrunError'])(
    'resumes on the new stream after a %s; the frame cut by the error does not complete',
    async (name) => {
      const t = await setup();
      t.device.push(INFO.slice(0, 8)); // half a GET_INFO reply, then the line glitches
      await tick();
      t.device.recoverable(name);
      await tick();
      expect(t.error).toHaveBeenCalledWith('Serial read failed:', expect.any(DOMException));
      expect(t.order).toEqual([]);

      t.device.push([...INFO.slice(8), ...ACK]);
      await tick();
      expect(t.frames).toEqual([0x82]);
      expect(t.device.stats).toMatchObject({ streams: 2, outstanding: 1, maxOutstanding: 1 });

      // and again: every recoverable error gets a fresh stream
      t.device.recoverable(name);
      await tick();
      t.device.push(INFO);
      await tick();
      expect(t.frames).toEqual([0x82, 0x81]);
      expect(t.device.stats).toMatchObject({ streams: 3, outstanding: 1, maxOutstanding: 1 });
    }
  );

  it('a fatal error (no new stream) ends the loop without a new reader', async () => {
    const t = await setup();
    t.device.fatal();
    await tick();
    expect(t.error).toHaveBeenCalledWith('Serial read failed:', expect.any(DOMException));
    expect(t.device.stats).toMatchObject({ streams: 1, outstanding: 0, calls: 1 });
    expect(t.order).toEqual([]);
  });

  it('close() after a restart ends the loop and closes the port', async () => {
    const t = await setup();
    t.device.recoverable('BreakError');
    await tick();
    expect(t.device.stats.outstanding).toBe(1);
    await t.serial.close();
    await tick();
    expect(t.device.port.close).toHaveBeenCalledTimes(1);
    expect(t.device.stats.outstanding).toBe(0);
    const calls = t.device.stats.calls;
    await tick();
    expect(t.device.stats.calls).toBe(calls);
  });

  it('close() racing the error leaves no reader and no read outstanding', async () => {
    const t = await setup();
    t.device.recoverable('FramingError');
    await t.serial.close(); // before the loop has handled the error
    await tick();
    expect(t.device.stats.outstanding).toBe(0);
    expect(t.device.port.close).toHaveBeenCalledTimes(1);
  });

  it('a disconnect on the new stream runs the disconnect handling exactly once', async () => {
    const t = await setup();
    t.device.recoverable('BreakError');
    await tick();
    t.device.lost();
    await tick();
    expect(t.order).toEqual(['listener', 'onDisconnect']);

    const event = new Event('disconnect');
    Object.defineProperty(event, 'target', { value: t.device.port });
    t.events.dispatchEvent(event);
    expect(t.order).toEqual(['listener', 'onDisconnect']);
    await expect(t.serial.write([1])).rejects.toThrow('not initialized');
  });
});

describe('SerialPort reconnect after a disconnect', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['read error', 'write error', 'disconnect event'] as const)(
    'starts from a clean parser after a %s (a frame cut by the unplug never completes)',
    async (path) => {
      const events = new EventTarget();
      vi.stubGlobal('navigator', { serial: events });
      const serial = new SerialPort();
      const frames: number[] = [];
      serial.onFrame((frame) => frames.push(frame.cmd));

      const first = makeReadablePort(() => Promise.reject(disconnectError()));
      await serial.init({ port: first.port, onDisconnect: () => {} });
      first.push(INFO.slice(0, 8)); // half a GET_INFO reply, then the cable goes
      await tick();
      if (path === 'read error') first.fail(disconnectError());
      if (path === 'write error') await serial.write([1]).catch(() => {});
      if (path === 'disconnect event') {
        const event = new Event('disconnect');
        Object.defineProperty(event, 'target', { value: first.port });
        events.dispatchEvent(event);
      }
      await tick();
      await expect(serial.write([1])).rejects.toThrow('not initialized');
      // close() (and its parser reset) never ran on this path
      expect(first.port.close).not.toHaveBeenCalled();

      const second = makeReadablePort();
      await serial.init({ port: second.port });
      second.push([...INFO.slice(8), ...ACK]);
      await tick();
      expect(frames).toEqual([0x82]);
    }
  );
});
