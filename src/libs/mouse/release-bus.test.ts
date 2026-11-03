import { afterEach, describe, expect, it, vi } from 'vitest';

import { emitMouseRelease, mouseReleaseListenerCount, onMouseRelease } from './release-bus';

describe('release-bus', () => {
  const unsubscribers: Array<() => void> = [];
  const subscribe = (fn: () => void) => {
    const off = onMouseRelease(fn);
    unsubscribers.push(off);
    return off;
  };

  afterEach(() => {
    unsubscribers.splice(0).forEach((off) => off());
    vi.restoreAllMocks();
  });

  it('calls every subscriber once per emit, in subscription order', () => {
    const calls: string[] = [];
    subscribe(() => calls.push('a'));
    subscribe(() => calls.push('b'));

    emitMouseRelease();
    emitMouseRelease();

    expect(calls).toEqual(['a', 'b', 'a', 'b']);
    expect(mouseReleaseListenerCount()).toBe(2);
  });

  it('stops calling a listener after unsubscribe (idempotent)', () => {
    const listener = vi.fn();
    const off = subscribe(listener);

    emitMouseRelease();
    off();
    off();
    emitMouseRelease();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(mouseReleaseListenerCount()).toBe(0);
  });

  it('isolates a throwing listener from the others', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = vi.fn();
    subscribe(() => {
      throw new Error('boom');
    });
    subscribe(second);

    expect(() => emitMouseRelease()).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('is a no-op without subscribers', () => {
    expect(() => emitMouseRelease()).not.toThrow();
  });
});
