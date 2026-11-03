import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HidLock, hidLock } from './hid-lock';

describe('HidLock', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acquire/release toggle the owner and notify in order', () => {
    const lock = new HidLock();
    const log: Array<[string | null, boolean]> = [];
    lock.onChange((owner) => log.push([owner, lock.isLocked()]));

    expect(lock.owner).toBeNull();
    expect(lock.isLocked()).toBe(false);
    expect(lock.acquire('paste')).toBe(true);
    expect(lock.owner).toBe('paste');
    expect(lock.isLocked()).toBe(true);
    lock.release('paste');
    expect(lock.owner).toBeNull();
    expect(lock.isLocked()).toBe(false);
    expect(log).toEqual([
      ['paste', true],
      [null, false]
    ]);
  });

  it('refuses a double acquire and ignores a release when not held', () => {
    const lock = new HidLock();
    const log: Array<string | null> = [];
    lock.onChange((owner) => log.push(owner));

    expect(lock.acquire('paste')).toBe(true);
    expect(lock.acquire('paste')).toBe(false);
    expect(lock.owner).toBe('paste');
    expect(log).toEqual(['paste']);

    lock.release('paste');
    lock.release('paste');
    expect(log).toEqual(['paste', null]);
    expect(lock.acquire('paste')).toBe(true);
  });

  it('stops notifying after unsubscribe', () => {
    const lock = new HidLock();
    const log: Array<string | null> = [];
    const unsubscribe = lock.onChange((owner) => log.push(owner));
    lock.acquire('paste');
    unsubscribe();
    lock.release('paste');
    expect(log).toEqual(['paste']);
  });

  it('dispatches interrupt() to registered handlers with the reason (default keydown)', () => {
    const lock = new HidLock();
    const seen: string[] = [];
    const off = lock.onInterrupt((reason) => seen.push(reason));
    lock.interrupt();
    lock.interrupt('serial-error');
    expect(seen).toEqual(['keydown', 'serial-error']);
    off();
    lock.interrupt();
    expect(seen).toHaveLength(2);
  });

  it('interrupt() without handlers is a no-op', () => {
    const lock = new HidLock();
    expect(() => lock.interrupt()).not.toThrow();
    expect(lock.isLocked()).toBe(false);
  });

  it('isolates exceptions thrown by listeners and handlers', () => {
    const lock = new HidLock();
    const seen: string[] = [];
    lock.onChange(() => {
      throw new Error('change boom');
    });
    lock.onChange((owner) => seen.push(`change:${owner}`));
    lock.onInterrupt(() => {
      throw new Error('interrupt boom');
    });
    lock.onInterrupt((reason) => seen.push(`interrupt:${reason}`));

    expect(lock.acquire('paste')).toBe(true);
    lock.interrupt('keydown');
    lock.release('paste');
    expect(seen).toEqual(['change:paste', 'interrupt:keydown', 'change:null']);
    expect(console.error).toHaveBeenCalledTimes(3);
  });

  it('serves as a useSyncExternalStore source (onChange subscribes, isLocked is the snapshot)', () => {
    const lock = new HidLock();
    let snapshot = lock.isLocked();
    const unsubscribe = lock.onChange(() => {
      snapshot = lock.isLocked();
    });
    lock.acquire('paste');
    expect(snapshot).toBe(true);
    unsubscribe();
    lock.release('paste');
    expect(snapshot).toBe(true);
  });

  it('exports a shared singleton', () => {
    expect(hidLock).toBeInstanceOf(HidLock);
    expect(hidLock.isLocked()).toBe(false);
  });
});
