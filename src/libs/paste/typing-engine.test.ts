import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HidLock } from '@/libs/keyboard/hid-lock';
import type { TargetLayout } from '@/libs/paste/types';
import { FakeClock, FakeSink, flushMicrotasks } from '@/test/fakes';

import { textToKeySequence } from './text-to-keys';
import {
  DEFAULT_WATCHDOG_MS,
  DEFAULT_WRITE_TIMEOUT_MS,
  isInterruptingKeyDown,
  PACING,
  TypingEngine,
  type EngineDeps,
  type EngineEvent
} from './typing-engine';

const ZERO = [0, 0, 0, 0, 0, 0, 0, 0];
const KEY_A = [0, 0, 0x04, 0, 0, 0, 0, 0];
const KEY_B = [0, 0, 0x05, 0, 0, 0, 0, 0];
const ENTER = [0, 0, 0x28, 0, 0, 0, 0, 0];

function compile(text: string, layout: TargetLayout = 'us') {
  return textToKeySequence(text, {
    layout,
    newline: 'enter',
    normalizePunct: false,
    stripTrailingNewline: false,
    imePreKey: 'none',
    maxChars: 20000
  });
}

function setup(over: Partial<EngineDeps> = {}) {
  const clock = new FakeClock();
  const sink = new FakeSink();
  const lock = new HidLock();
  const target = new EventTarget();
  const times: number[] = [];
  let insideUi = false;
  const engine = new TypingEngine({
    send: (report) => {
      times.push(clock.now());
      return sink.send(report);
    },
    lock,
    clock,
    interruptTarget: target,
    isInsideOwnUi: () => insideUi,
    ...over
  });
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push({ ...event }));
  return {
    clock,
    sink,
    lock,
    target,
    engine,
    events,
    times,
    setInsideUi: (value: boolean) => {
      insideUi = value;
    }
  };
}

function keydown(code: string, extra: { repeat?: boolean } = {}): Event {
  return Object.assign(new Event('keydown'), { code, repeat: false, ...extra });
}

/** Starts a run and lets the ARM report and the first press go out at t=0. */
async function start(engine: TypingEngine, text: string, pacing = PACING.normal) {
  const result = engine.run(compile(text), pacing);
  await flushMicrotasks();
  return { result };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TypingEngine', () => {
  it('types "aa" as ZERO, press, ZERO, press, ZERO, ZERO with 20/20 ms waits', async () => {
    const t = setup();
    const { result: promise } = await start(t.engine, 'aa');
    expect(t.engine.state).toBe('running');
    expect(t.lock.owner).toBe('paste');

    await t.clock.advanceAsync(200);
    const result = await promise;

    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, KEY_A, ZERO, ZERO]);
    expect(t.times).toEqual([0, 0, 20, 40, 60, 60]);
    expect(result).toEqual({ reason: 'completed', typedStrokes: 2, totalStrokes: 2 });
    expect(t.lock.owner).toBeNull();
    expect(t.engine.state).toBe('idle');
    expect(t.clock.pendingTimers()).toBe(0);
    expect(t.events[0]).toEqual({ type: 'start', done: 0, total: 2, etaMs: 80 });
    expect(t.events[t.events.length - 1]).toEqual({
      type: 'stop',
      done: 2,
      total: 2,
      etaMs: 0,
      reason: 'completed'
    });
  });

  it('honours the safe preset and the afterEnter pause', async () => {
    const t = setup();
    const { result: promise } = await start(t.engine, 'a\nb', PACING.safe);
    await t.clock.advanceAsync(1000);
    const result = await promise;

    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, ENTER, ZERO, KEY_B, ZERO, ZERO]);
    // hold 50, gap 50, enter hold 50, gap 50 + afterEnter 150, hold 50
    expect(t.times).toEqual([0, 0, 50, 100, 150, 350, 400, 400]);
    expect(result.reason).toBe('completed');
    expect(PACING).toEqual({
      safe: { holdMs: 50, gapMs: 50, afterEnterMs: 150 },
      normal: { holdMs: 20, gapMs: 20, afterEnterMs: 100 }
    });
  });

  it('sends ZERO on ARM and FINISH even for an empty compile', async () => {
    const t = setup();
    const { result } = await start(t.engine, '');
    expect(t.sink.reports).toEqual([ZERO, ZERO]);
    expect(await result).toEqual({ reason: 'completed', typedStrokes: 0, totalStrokes: 0 });
    expect(t.lock.owner).toBeNull();
  });

  it('cancel() during the hold releases the lock synchronously and sends exactly one ZERO', async () => {
    const t = setup();
    const { result: promise } = await start(t.engine, 'aa');
    await t.clock.advanceAsync(10);
    expect(t.sink.reports).toEqual([ZERO, KEY_A]);

    t.engine.cancel();
    expect(t.lock.isLocked()).toBe(false);
    expect(t.engine.state).toBe('stopping');
    expect(t.sink.reports).toHaveLength(2); // nothing sent synchronously

    await flushMicrotasks();
    const result = await promise;
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO]);
    expect(t.times[t.times.length - 1]).toBe(10);
    expect(result).toEqual({ reason: 'cancelled', typedStrokes: 0, totalStrokes: 2 });
    expect(t.engine.state).toBe('idle');
    expect(t.clock.pendingTimers()).toBe(0);
    expect(t.events[t.events.length - 1]).toMatchObject({
      type: 'stop',
      done: 0,
      total: 2,
      reason: 'cancelled'
    });
  });

  it('cancel() during the gap keeps the typed count and adds one ZERO', async () => {
    const t = setup();
    const { result: promise } = await start(t.engine, 'aa');
    await t.clock.advanceAsync(30); // press@0, release@20, now in the gap
    t.engine.cancel();
    await flushMicrotasks();
    const result = await promise;
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, ZERO]);
    expect(result).toEqual({ reason: 'cancelled', typedStrokes: 1, totalStrokes: 2 });
  });

  it('cancel() is a no-op when idle and accepts an external reason', async () => {
    const t = setup();
    t.engine.cancel();
    expect(t.engine.state).toBe('idle');
    expect(t.events).toEqual([]);

    const { result: promise } = await start(t.engine, 'aa');
    t.engine.cancel('serial-error');
    await flushMicrotasks();
    expect((await promise).reason).toBe('serial-error');
  });

  it('stops with key-interrupt on a non-modifier keydown', async () => {
    const t = setup();
    const { result: promise } = await start(t.engine, 'aaaa');
    await t.clock.advanceAsync(10);
    t.target.dispatchEvent(keydown('KeyQ'));
    expect(t.lock.isLocked()).toBe(false);
    await flushMicrotasks();
    const result = await promise;
    expect(result.reason).toBe('key-interrupt');
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO]);
  });

  it('ignores modifier keys, CapsLock and autorepeat', async () => {
    const t = setup();
    const { result: promise } = await start(t.engine, 'aa');
    await t.clock.advanceAsync(10);
    for (const code of [
      'MetaLeft',
      'MetaRight',
      'ShiftLeft',
      'ControlLeft',
      'AltRight',
      'CapsLock'
    ]) {
      t.target.dispatchEvent(keydown(code));
    }
    t.target.dispatchEvent(keydown('KeyQ', { repeat: true }));
    expect(t.engine.state).toBe('running');
    await t.clock.advanceAsync(200);
    expect((await promise).reason).toBe('completed');
  });

  it('ignores keydown inside its own UI except Escape', async () => {
    const t = setup();
    const { result: promise } = await start(t.engine, 'aaaa');
    t.setInsideUi(true);
    await t.clock.advanceAsync(10);
    t.target.dispatchEvent(keydown('KeyQ'));
    t.target.dispatchEvent(keydown('Enter'));
    expect(t.engine.state).toBe('running');
    t.target.dispatchEvent(keydown('Escape'));
    expect(t.engine.state).toBe('stopping');
    await flushMicrotasks();
    expect((await promise).reason).toBe('key-interrupt');
  });

  it('stops with mouse-interrupt on pointerdown/mousedown/touchstart outside its UI only', async () => {
    const inside = setup();
    const { result: insidePromise } = await start(inside.engine, 'aa');
    inside.setInsideUi(true);
    inside.target.dispatchEvent(new Event('pointerdown'));
    inside.target.dispatchEvent(new Event('mousedown'));
    inside.target.dispatchEvent(new Event('touchstart'));
    expect(inside.engine.state).toBe('running');
    await inside.clock.advanceAsync(200);
    expect((await insidePromise).reason).toBe('completed');

    const mouse = setup();
    const { result: mousePromise } = await start(mouse.engine, 'aa');
    mouse.target.dispatchEvent(new Event('mousedown'));
    expect(mouse.lock.isLocked()).toBe(false);
    await flushMicrotasks();
    expect((await mousePromise).reason).toBe('mouse-interrupt');

    const touch = setup();
    const { result: touchPromise } = await start(touch.engine, 'aa');
    touch.target.dispatchEvent(new Event('touchstart'));
    await flushMicrotasks();
    expect((await touchPromise).reason).toBe('mouse-interrupt');

    // a mouse component cancelling the pointerdown suppresses the compatibility
    // mousedown, so the pointerdown itself must stop the run
    const pointer = setup();
    const { result: pointerPromise } = await start(pointer.engine, 'aa');
    pointer.target.dispatchEvent(new Event('pointerdown', { cancelable: true }));
    expect(pointer.lock.isLocked()).toBe(false);
    await flushMicrotasks();
    expect((await pointerPromise).reason).toBe('mouse-interrupt');
  });

  it('stops with tab-hidden when the document becomes hidden or the page hides', async () => {
    const hiddenTarget = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
    const hidden = setup({ interruptTarget: hiddenTarget });
    const { result: hiddenPromise } = await start(hidden.engine, 'aa');
    hiddenTarget.dispatchEvent(new Event('visibilitychange'));
    await flushMicrotasks();
    expect((await hiddenPromise).reason).toBe('tab-hidden');

    const visibleTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const visible = setup({ interruptTarget: visibleTarget });
    const { result: visiblePromise } = await start(visible.engine, 'aa');
    visibleTarget.dispatchEvent(new Event('visibilitychange'));
    expect(visible.engine.state).toBe('running');
    await visible.clock.advanceAsync(200);
    expect((await visiblePromise).reason).toBe('completed');

    const pagehide = setup();
    const { result: pagehidePromise } = await start(pagehide.engine, 'aa');
    pagehide.target.dispatchEvent(new Event('pagehide'));
    await flushMicrotasks();
    expect((await pagehidePromise).reason).toBe('tab-hidden');
  });

  it('removes its listeners after the run', async () => {
    const t = setup();
    const add = vi.spyOn(t.target, 'addEventListener');
    const remove = vi.spyOn(t.target, 'removeEventListener');
    const { result: promise } = await start(t.engine, 'a');
    expect(add).toHaveBeenCalledTimes(6);
    await t.clock.advanceAsync(100);
    await promise;
    expect(remove).toHaveBeenCalledTimes(6);
    expect(remove.mock.calls.map((call) => call[0]).sort()).toEqual(
      ['keydown', 'mousedown', 'pagehide', 'pointerdown', 'touchstart', 'visibilitychange'].sort()
    );
    t.target.dispatchEvent(keydown('KeyQ'));
    expect(t.engine.state).toBe('idle');
  });

  it('stops with serial-error when a write rejects and still attempts the final ZERO', async () => {
    const t = setup();
    t.sink.rejectAt = 3;
    const { result: promise } = await start(t.engine, 'aa');
    await t.clock.advanceAsync(100);
    const result = await promise;
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, ZERO]);
    expect(t.times).toEqual([0, 0, 20, 20]);
    expect(result).toEqual({ reason: 'serial-error', typedStrokes: 0, totalStrokes: 2 });
    expect(t.lock.owner).toBeNull();
    expect(t.clock.pendingTimers()).toBe(0);
  });

  it('treats a hung write as serial-error after writeTimeoutMs', async () => {
    const t = setup();
    t.sink.hangAt = 2;
    const { result: promise } = await start(t.engine, 'aa');
    await t.clock.advanceAsync(DEFAULT_WRITE_TIMEOUT_MS - 1);
    expect(t.engine.state).toBe('running');
    await t.clock.advanceAsync(2);
    const result = await promise;
    expect(result).toEqual({ reason: 'serial-error', typedStrokes: 0, totalStrokes: 2 });
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO]);
    expect(t.times).toEqual([0, 0, DEFAULT_WRITE_TIMEOUT_MS]);
    expect(t.lock.owner).toBeNull();
    expect(t.clock.pendingTimers()).toBe(0);
    t.sink.releaseHung();
  });

  it('does not hang on a FINISH ZERO that never completes', async () => {
    const t = setup({ writeTimeoutMs: 100 });
    t.sink.hangAt = 2;
    t.sink.send = ((inner) => async (report: number[]) => {
      if (t.sink.reports.length === 2) t.sink.hangAt = 3; // the final ZERO hangs too
      return inner(report);
    })(t.sink.send);
    const { result: promise } = await start(t.engine, 'a');
    await t.clock.advanceAsync(150); // press times out at 100, FINISH ZERO goes out and hangs
    await t.clock.advanceAsync(150); // its own timeout fires at 200
    const result = await promise;
    expect(result.reason).toBe('serial-error');
    expect(t.engine.state).toBe('idle');
    t.sink.releaseHung();
  });

  it('cancel() during a hanging FINISH ZERO is ignored: a fully typed run stays completed', async () => {
    const t = setup();
    t.sink.hangAt = 4; // the FINISH ZERO
    const { result: promise } = await start(t.engine, 'a');
    await t.clock.advanceAsync(30);
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, ZERO]);
    expect(t.engine.state).toBe('stopping');

    t.engine.cancel();
    expect(t.engine.state).toBe('stopping');
    t.sink.releaseHung();
    await flushMicrotasks();
    expect(await promise).toEqual({ reason: 'completed', typedStrokes: 1, totalStrokes: 1 });
    expect(t.engine.state).toBe('idle');
    expect(t.lock.owner).toBeNull();
    expect(t.clock.pendingTimers()).toBe(0);
    expect(t.events[t.events.length - 1]).toMatchObject({ type: 'stop', reason: 'completed' });
  });

  it('cancel() while the FINISH ZERO hangs after a serial error keeps serial-error (first reason wins)', async () => {
    const t = setup();
    t.sink.rejectAt = 2;
    t.sink.hangAt = 3;
    const { result: promise } = await start(t.engine, 'a');
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO]);
    expect(t.engine.state).toBe('stopping');

    t.engine.cancel();
    t.sink.releaseHung();
    await flushMicrotasks();
    expect((await promise).reason).toBe('serial-error');
    expect(t.engine.state).toBe('idle');
    expect(t.lock.owner).toBeNull();
  });

  it('watchdog cancels when no report could be sent for watchdogMs', async () => {
    const t = setup({ writeTimeoutMs: 10_000, watchdogMs: 3_000 });
    t.sink.hangAt = 2;
    const { result: promise } = await start(t.engine, 'aa');
    await t.clock.advanceAsync(2_999);
    expect(t.engine.state).toBe('running');
    await t.clock.advanceAsync(2);
    const result = await promise;
    expect(result.reason).toBe('serial-error');
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO]);
    expect(t.times).toEqual([0, 0, 3_000]);
    expect(t.lock.owner).toBeNull();
    expect(t.clock.pendingTimers()).toBe(0);
    expect(DEFAULT_WATCHDOG_MS).toBe(3000);
    t.sink.releaseHung();
  });

  it('resolves lock-busy without sending while another run is in progress', async () => {
    const t = setup();
    const { result: first } = await start(t.engine, 'aa');
    const sentBefore = t.sink.reports.length;
    const second = await t.engine.run(compile('b'), PACING.normal);
    expect(second).toEqual({ reason: 'lock-busy', typedStrokes: 0, totalStrokes: 1 });
    expect(t.sink.reports).toHaveLength(sentBefore);
    expect(t.events.filter((e) => e.type === 'start')).toHaveLength(1);

    await t.clock.advanceAsync(200);
    expect((await first).reason).toBe('completed');
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, KEY_A, ZERO, ZERO]);
  });

  it('resolves lock-busy when somebody else holds the HID lock', async () => {
    const t = setup();
    expect(t.lock.acquire('paste')).toBe(true);
    const result = await t.engine.run(compile('a'), PACING.normal);
    expect(result).toEqual({ reason: 'lock-busy', typedStrokes: 0, totalStrokes: 1 });
    expect(t.sink.reports).toEqual([]);
    expect(t.events).toEqual([]);
    expect(t.lock.owner).toBe('paste');
    expect(t.engine.state).toBe('idle');
  });

  it('emits monotonic progress ending at done === total, throttled', async () => {
    const t = setup();
    const { result: promise } = await start(t.engine, 'a'.repeat(30));
    await t.clock.advanceAsync(30 * 40 + 100);
    await promise;

    const progress = t.events.filter((e) => e.type === 'progress');
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.length).toBeLessThan(30);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].done).toBeGreaterThan(progress[i - 1].done);
      expect(progress[i].etaMs).toBeLessThanOrEqual(progress[i - 1].etaMs);
    }
    expect(progress[progress.length - 1]).toEqual({
      type: 'progress',
      done: 30,
      total: 30,
      etaMs: 0
    });
    expect(t.events[t.events.length - 1]).toMatchObject({ type: 'stop', done: 30, total: 30 });
    expect(t.events[0]).toEqual({ type: 'start', done: 0, total: 30, etaMs: 1200 });
  });

  it('isolates subscriber exceptions and supports unsubscribe', async () => {
    const t = setup();
    const seen: string[] = [];
    const unsubscribe = t.engine.subscribe(() => {
      throw new Error('boom');
    });
    const unsubscribeSeen = t.engine.subscribe((e) => seen.push(e.type));
    const { result: promise } = await start(t.engine, 'a');
    await t.clock.advanceAsync(100);
    expect((await promise).reason).toBe('completed');
    expect(seen).toEqual(['start', 'progress', 'stop']);
    expect(console.error).toHaveBeenCalled();

    unsubscribe();
    unsubscribeSeen();
    const { result: again } = await start(t.engine, 'a');
    await t.clock.advanceAsync(100);
    await again;
    expect(seen).toEqual(['start', 'progress', 'stop']);
  });

  it('stops with key-interrupt when the HID lock is interrupted, only while running', async () => {
    const t = setup();
    const { result: promise } = await start(t.engine, 'aa');
    t.lock.interrupt('keydown');
    expect(t.engine.state).toBe('stopping');
    await flushMicrotasks();
    expect((await promise).reason).toBe('key-interrupt');

    t.lock.interrupt('keydown');
    expect(t.engine.state).toBe('idle');

    const { result: second } = await start(t.engine, 'aa');
    t.lock.interrupt('serial-error');
    await flushMicrotasks();
    expect((await second).reason).toBe('serial-error');
  });

  it('notifies lock observers on acquire and release exactly once per run', async () => {
    const t = setup();
    const owners: Array<string | null> = [];
    t.lock.onChange((owner) => owners.push(owner));
    const { result: promise } = await start(t.engine, 'a');
    await t.clock.advanceAsync(100);
    await promise;
    expect(owners).toEqual(['paste', null]);
  });
});

describe('isInterruptingKeyDown (shared with the keyboard adapter)', () => {
  const outside = (): boolean => false;
  const inside = (): boolean => true;
  const key = (code: string, repeat = false) => ({ code, repeat, target: null });

  it('stops on a fresh non-modifier keydown outside the paste UI', () => {
    expect(isInterruptingKeyDown(key('KeyQ'), outside)).toBe(true);
    expect(isInterruptingKeyDown(key('Enter'), outside)).toBe(true);
    expect(isInterruptingKeyDown(key('KeyV'), outside)).toBe(true);
  });

  it('never stops on host autorepeat (a held ⌘⇧V chord keeps the paste it started)', () => {
    expect(isInterruptingKeyDown(key('KeyV', true), outside)).toBe(false);
    expect(isInterruptingKeyDown(key('KeyQ', true), outside)).toBe(false);
  });

  it('ignores modifiers and CapsLock', () => {
    for (const code of [
      'MetaLeft',
      'MetaRight',
      'ShiftLeft',
      'ControlLeft',
      'AltRight',
      'CapsLock'
    ]) {
      expect(isInterruptingKeyDown(key(code), outside)).toBe(false);
    }
  });

  it('ignores keys inside the paste UI except Escape', () => {
    expect(isInterruptingKeyDown(key('KeyQ'), inside)).toBe(false);
    expect(isInterruptingKeyDown(key('Enter'), inside)).toBe(false);
    expect(isInterruptingKeyDown(key('Escape'), inside)).toBe(true);
    expect(isInterruptingKeyDown(key('Escape', true), inside)).toBe(false);
  });
});
