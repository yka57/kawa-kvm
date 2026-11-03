import { describe, expect, it } from 'vitest';

import { FakeClock, FakeSink, flattenKeys, makeKeyEvent } from './fakes';

describe('FakeClock', () => {
  it('fires timers in due order on advance()', () => {
    const clock = new FakeClock();
    const log: string[] = [];
    clock.setTimeout(() => log.push('b@30'), 30);
    clock.setTimeout(() => log.push('a@10'), 10);
    clock.setTimeout(() => log.push('c@10'), 10);
    clock.advance(5);
    expect(log).toEqual([]);
    clock.advance(10);
    expect(log).toEqual(['a@10', 'c@10']);
    expect(clock.now()).toBe(15);
    clock.advance(100);
    expect(log).toEqual(['a@10', 'c@10', 'b@30']);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('clears timers by handle and freezes now() inside callbacks', () => {
    const clock = new FakeClock();
    const seen: number[] = [];
    const handle = clock.setTimeout(() => seen.push(-1), 10);
    clock.setTimeout(() => seen.push(clock.now()), 20);
    clock.clearTimeout(handle);
    clock.advance(50);
    expect(seen).toEqual([20]);
  });
});

describe('FakeSink', () => {
  it('records payloads and rejects on the configured call', async () => {
    const sink = new FakeSink();
    sink.rejectAt = 2;
    await sink.send([1, 2, 3]);
    await expect(sink.send([4])).rejects.toThrow('fake serial error');
    expect(sink.reports).toEqual([[1, 2, 3], [4]]);
  });

  it('can hang a write until released', async () => {
    const sink = new FakeSink();
    sink.hangAt = 1;
    let done = false;
    const p = sink.send([9]).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    sink.releaseHung();
    await p;
    expect(done).toBe(true);
  });
});

describe('helpers', () => {
  it('makeKeyEvent fills defaults', () => {
    expect(makeKeyEvent({ code: 'KeyA' })).toEqual({
      type: 'keydown',
      code: 'KeyA',
      key: undefined,
      repeat: false,
      timeStamp: 0,
      mods: { meta: false, ctrl: false, alt: false, shift: false }
    });
    expect(
      makeKeyEvent({ type: 'keyup', code: 'MetaLeft', mods: { meta: true } as never })
    ).toEqual({
      type: 'keyup',
      code: 'MetaLeft',
      timeStamp: 0,
      mods: { meta: true, ctrl: false, alt: false, shift: false }
    });
  });

  it('flattenKeys returns sorted dotted leaf paths', () => {
    expect(flattenKeys({ b: { y: '1', x: '2' }, a: '3' })).toEqual(['a', 'b.x', 'b.y']);
  });
});
