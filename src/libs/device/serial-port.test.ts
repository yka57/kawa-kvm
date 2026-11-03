import { afterEach, describe, expect, it, vi } from 'vitest';

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
