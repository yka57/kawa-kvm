import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HidLock } from '@/libs/keyboard/hid-lock';
import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import type { KeyStroke, TargetLayout } from '@/libs/paste/types';
import { FakeClock, FakeSink, flushMicrotasks } from '@/test/fakes';

import { textToKeySequence } from './text-to-keys';
import {
  DEFAULT_WAIT_INTERVAL_MS,
  DEFAULT_WATCHDOG_MS,
  DEFAULT_WRITE_TIMEOUT_MS,
  estimateProgramMs,
  isInterruptingKeyDown,
  PACING,
  TypingEngine,
  type EngineDeps,
  type EngineEvent,
  type Pacing,
  type ProgramStep,
  type WaitStep,
  type WaitVerdict
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

  it('a stroke with `hold` keeps that modifier down in its release report', async () => {
    const t = setup();
    const ALT = 0x04;
    const promise = t.engine.runProgram(
      [
        {
          kind: 'keys',
          strokes: [
            { mod: ALT, key: 0x57, src: 0, tag: 'unicode', group: 0, hold: ALT },
            { mod: ALT, key: 0x5b, src: 0, tag: 'unicode', group: 0 }
          ]
        }
      ],
      PACING.normal
    );
    await flushMicrotasks();
    await t.clock.advanceAsync(200);
    await promise;
    expect(t.sink.reports).toEqual([
      ZERO,
      [ALT, 0, 0x57, 0, 0, 0, 0, 0],
      [ALT, 0, 0, 0, 0, 0, 0, 0],
      [ALT, 0, 0x5b, 0, 0, 0, 0, 0],
      ZERO,
      ZERO
    ]);
  });

  it('a click inside a held group still ends with everything released', async () => {
    const t = setup();
    const ALT = 0x04;
    const promise = t.engine.runProgram(
      [
        {
          kind: 'keys',
          strokes: [
            { mod: ALT, key: 0x57, src: 0, tag: 'unicode', group: 0, hold: ALT },
            { mod: ALT, key: 0x5b, src: 0, tag: 'unicode', group: 0 }
          ]
        }
      ],
      PACING.normal
    );
    await flushMicrotasks();
    await t.clock.advanceAsync(30); // Alt alone is down
    t.target.dispatchEvent(new Event('pointerdown'));
    await t.clock.advanceAsync(200);
    const result = await promise;
    expect(result.reason).toBe('mouse-interrupt');
    expect(t.sink.reports[t.sink.reports.length - 1]).toEqual(ZERO);
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
      normal: { holdMs: 20, gapMs: 20, afterEnterMs: 100 },
      fast: { holdMs: 10, gapMs: 10, afterEnterMs: 60 }
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

const KEY_C = [0, 0, 0x06, 0, 0, 0, 0, 0];
const CTRL_W = [ModifierBits.LeftCtrl, 0, KeycodeMap.KeyW, 0, 0, 0, 0, 0];

function stroke(key: number, extra: Partial<KeyStroke> = {}): KeyStroke {
  return { mod: 0, key, src: 0, tag: 'char', ...extra };
}

const A = stroke(0x04);
const B = stroke(0x05);

/** Starts a program and lets the ARM report and its first sends go out at t=0 (like start()). */
async function begin(engine: TypingEngine, steps: ProgramStep[], pacing = PACING.normal) {
  const result = engine.runProgram(steps, pacing);
  await flushMicrotasks();
  return { result };
}

function wait(check: WaitStep['check'], over: Partial<WaitStep> = {}): WaitStep {
  return {
    kind: 'wait',
    check,
    timeoutMs: 1000,
    estimateMs: 300,
    timeoutReason: 'bridge-no-window',
    ...over
  };
}

describe('TypingEngine.runProgram', () => {
  it('runs keys, sleeps, callbacks and phases in order; events carry the latest phase', async () => {
    const t = setup();
    const calls: number[] = [];
    const steps: ProgramStep[] = [
      { kind: 'phase', phase: 'window' },
      { kind: 'keys', strokes: [A] },
      { kind: 'sleep', ms: 500 },
      { kind: 'run', fn: () => calls.push(t.clock.now()) },
      { kind: 'phase', phase: 'paste' },
      { kind: 'keys', strokes: [B] }
    ];
    const { result: promise } = await begin(t.engine, steps, PACING.normal);
    await t.clock.advanceAsync(1000);

    expect(await promise).toEqual({ reason: 'completed', typedStrokes: 2, totalStrokes: 2 });
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, KEY_B, ZERO, ZERO]);
    // A, its gap (B is still to come), the sleep, then B with no gap before FINISH
    expect(t.times).toEqual([0, 0, 20, 540, 560, 560]);
    expect(calls).toEqual([540]);
    expect(t.events).toEqual([
      { type: 'start', done: 0, total: 2, etaMs: 580 },
      { type: 'progress', done: 0, total: 2, etaMs: 580, phase: 'window' },
      { type: 'progress', done: 1, total: 2, etaMs: 40, phase: 'window' },
      { type: 'progress', done: 1, total: 2, etaMs: 40, phase: 'paste' },
      { type: 'progress', done: 2, total: 2, etaMs: 0, phase: 'paste' },
      { type: 'stop', done: 2, total: 2, etaMs: 0, reason: 'completed', phase: 'paste' }
    ]);
    expect(t.clock.pendingTimers()).toBe(0);
  });

  it('a single keys step of compiled strokes behaves exactly like run()', async () => {
    const t = setup();
    const { result: promise } = await begin(
      t.engine,
      [{ kind: 'keys', strokes: compile('aa').strokes }],
      PACING.normal
    );
    await t.clock.advanceAsync(200);
    expect(await promise).toEqual({ reason: 'completed', typedStrokes: 2, totalStrokes: 2 });
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, KEY_A, ZERO, ZERO]);
    expect(t.times).toEqual([0, 0, 20, 40, 60, 60]);
    expect(t.events.every((e) => e.phase === undefined)).toBe(true);
  });

  it('logs a throwing run step and goes on', async () => {
    const t = setup();
    const { result: promise } = await begin(
      t.engine,
      [
        {
          kind: 'run',
          fn: () => {
            throw new Error('boom');
          }
        },
        { kind: 'keys', strokes: [A] }
      ],
      PACING.normal
    );
    await t.clock.advanceAsync(100);
    expect((await promise).reason).toBe('completed');
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, ZERO]);
    expect(console.error).toHaveBeenCalledWith('[paste] program step threw', expect.any(Error));
  });

  it('honours afterMs after the gap, but sleeps nothing after the last stroke of the program', async () => {
    const t = setup();
    const steps: ProgramStep[] = [
      { kind: 'keys', strokes: [stroke(0x04, { afterMs: 150 }), stroke(0x05, { afterMs: 500 })] },
      wait(() => 'ok', { estimateMs: 0 })
    ];
    expect(estimateProgramMs(steps, PACING.normal)).toBe(190 + 540);
    const { result: promise } = await begin(t.engine, steps, PACING.normal);
    await t.clock.advanceAsync(1000);
    expect((await promise).reason).toBe('completed');
    expect(t.times).toEqual([0, 0, 20, 190, 210, 210]);
  });

  it('types at 10/10 ms with the fast preset', async () => {
    const t = setup();
    const { result } = await start(t.engine, 'aa', PACING.fast);
    await t.clock.advanceAsync(100);
    expect((await result).reason).toBe('completed');
    expect(t.times).toEqual([0, 0, 10, 20, 30, 30]);
    expect(t.events[0]).toMatchObject({ type: 'start', etaMs: 40 });
  });

  it('minMs: a stroke takes at least that long from its press to the next press, whatever the preset', async () => {
    // A must not be followed sooner than 40 ms after its press; B has no floor; C is the last
    const steps = (): ProgramStep[] => [
      { kind: 'keys', strokes: [stroke(0x04, { minMs: 40 }), B, stroke(0x06, { minMs: 40 })] }
    ];
    const run = async (pacing: Pacing) => {
      const t = setup();
      const { result: promise } = await begin(t.engine, steps(), pacing);
      await t.clock.advanceAsync(1000);
      expect(await promise).toEqual({ reason: 'completed', typedStrokes: 3, totalStrokes: 3 });
      expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, KEY_B, ZERO, KEY_C, ZERO, ZERO]);
      expect(t.clock.pendingTimers()).toBe(0);
      return { times: t.times, etaMs: t.events[0].etaMs };
    };

    // fast: A is held 10 ms as always and B waits until 40; B itself keeps 10 / 10; nothing is
    // slept after the last stroke of the program
    expect(await run(PACING.fast)).toEqual({
      times: [0, 0, 10, 40, 50, 60, 70, 70],
      etaMs: 40 + 20 + 40
    });
    expect(estimateProgramMs(steps(), PACING.fast)).toBe(100);
    // normal already takes 40 ms a stroke and safe 100: nothing changes there
    expect(await run(PACING.normal)).toEqual({
      times: [0, 0, 20, 40, 60, 80, 100, 100],
      etaMs: 120
    });
    expect(await run(PACING.safe)).toEqual({
      times: [0, 0, 50, 100, 150, 200, 250, 250],
      etaMs: 300
    });
  });

  it('minMs is a floor, not an addition: afterMs and the pause after Enter count towards it', async () => {
    const t = setup();
    const steps: ProgramStep[] = [
      {
        kind: 'keys',
        strokes: [
          // 10 + 10 + 100 is more than 40: the stroke's own pause stands
          stroke(0x04, { afterMs: 100, minMs: 40 }),
          // 10 + 10 + 5 is less: stretched to 40, not to 45
          stroke(0x05, { afterMs: 5, minMs: 40 }),
          // Enter at fast takes 10 + 10 + 60
          stroke(KeycodeMap.Enter, { tag: 'enter', minMs: 40 }),
          stroke(0x06)
        ]
      }
    ];
    expect(estimateProgramMs(steps, PACING.fast)).toBe(120 + 40 + 80 + 20);
    const { result: promise } = await begin(t.engine, steps, PACING.fast);
    await t.clock.advanceAsync(1000);
    expect((await promise).reason).toBe('completed');
    // A at 0, B at 120, Enter at 160, C at 240
    const pressed = t.sink.reports.filter((report) => report[2] !== 0);
    expect(pressed).toEqual([KEY_A, KEY_B, ENTER, KEY_C]);
    expect(t.times).toEqual([0, 0, 10, 120, 130, 160, 170, 240, 250, 250]);
  });

  it('counts strokes, Enter pauses, afterMs, sleeps and wait estimates in the ETA', async () => {
    const t = setup();
    const steps: ProgramStep[] = [
      { kind: 'keys', strokes: [A, stroke(KeycodeMap.Enter, { tag: 'enter' })] },
      { kind: 'sleep', ms: 600 },
      wait(() => 'ok', { estimateMs: 800 }),
      { kind: 'run', fn: () => undefined },
      { kind: 'phase', phase: 'copy' },
      { kind: 'keys', strokes: [stroke(0x06, { afterMs: 250 })] }
    ];
    // 40 + (40 + 100) + 600 + 800 + (40 + 250)
    expect(estimateProgramMs(steps, PACING.normal)).toBe(1870);
    expect(estimateProgramMs(steps, PACING.safe)).toBe(100 + 250 + 600 + 800 + 350);

    const { result: promise } = await begin(t.engine, steps, PACING.normal);
    await t.clock.advanceAsync(2000);
    expect((await promise).reason).toBe('completed');
    expect(t.events[0]).toEqual({ type: 'start', done: 0, total: 3, etaMs: 1870 });
    const progress = t.events.filter((e) => e.type === 'progress');
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].etaMs).toBeLessThanOrEqual(progress[i - 1].etaMs);
    }
    // the wait finished immediately: its estimate is spent, only the last stroke is left
    expect(progress.find((e) => e.phase === 'copy')).toMatchObject({ done: 2, etaMs: 290 });
    expect(progress[progress.length - 1]).toMatchObject({ done: 3, etaMs: 0 });
  });

  it('resolves lock-busy with the stroke total of keys steps only', async () => {
    const t = setup();
    t.lock.acquire('paste');
    const steps: ProgramStep[] = [
      { kind: 'keys', strokes: [A, B] },
      wait(() => 'fail', { onFail: [A] }),
      { kind: 'keys', strokes: [A] }
    ];
    expect(await t.engine.runProgram(steps, PACING.normal)).toEqual({
      reason: 'lock-busy',
      typedStrokes: 0,
      totalStrokes: 3
    });
    expect(t.sink.reports).toEqual([]);
  });
});

describe('TypingEngine wait steps', () => {
  it('polls every intervalMs until ok, then goes on', async () => {
    const t = setup();
    const polls: number[] = [];
    const check = (): WaitVerdict => {
      polls.push(t.clock.now());
      return polls.length === 3 ? 'ok' : 'pending';
    };
    const { result: promise } = await begin(
      t.engine,
      [{ kind: 'keys', strokes: [A] }, wait(check), { kind: 'keys', strokes: [B] }],
      PACING.normal
    );
    await t.clock.advanceAsync(1000);
    expect(await promise).toEqual({ reason: 'completed', typedStrokes: 2, totalStrokes: 2 });
    expect(DEFAULT_WAIT_INTERVAL_MS).toBe(100);
    expect(polls).toEqual([40, 140, 240]);
    expect(t.times).toEqual([0, 0, 20, 240, 260, 260]);
  });

  it('stops with timeoutReason at the deadline; the lock is held until FINISH', async () => {
    const t = setup();
    const polls: number[] = [];
    const { result: promise } = await begin(
      t.engine,
      [
        { kind: 'keys', strokes: [A] },
        wait(
          () => {
            polls.push(t.clock.now());
            return 'pending';
          },
          { timeoutMs: 1000, intervalMs: 250 }
        ),
        { kind: 'keys', strokes: [B] }
      ],
      PACING.normal
    );
    await t.clock.advanceAsync(500);
    expect(t.engine.state).toBe('running');
    expect(t.lock.owner).toBe('paste');
    await t.clock.advanceAsync(1000);

    expect(await promise).toEqual({ reason: 'bridge-no-window', typedStrokes: 1, totalStrokes: 2 });
    // the last poll lands on the deadline
    expect(polls).toEqual([40, 290, 540, 790, 1040]);
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, ZERO]);
    expect(t.times[t.times.length - 1]).toBe(1040);
    expect(t.lock.owner).toBeNull();
    expect(t.clock.pendingTimers()).toBe(0);
    expect(t.events[t.events.length - 1]).toMatchObject({
      type: 'stop',
      reason: 'bridge-no-window'
    });
  });

  it('fail: sends onFail (uncounted, not cancellable) and stops with failReason', async () => {
    const t = setup();
    const { result: promise } = await begin(
      t.engine,
      [
        { kind: 'keys', strokes: [A] },
        wait(() => 'fail', {
          timeoutReason: 'bridge-load-failed',
          failReason: 'bridge-verify-failed',
          onFail: [stroke(KeycodeMap.KeyW, { mod: ModifierBits.LeftCtrl, tag: 'chord' })]
        }),
        { kind: 'keys', strokes: [B] }
      ],
      PACING.normal
    );
    await t.clock.advanceAsync(50); // the failure keys are being held
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, CTRL_W]);
    t.engine.cancel();
    t.target.dispatchEvent(keydown('KeyQ'));
    expect(t.lock.owner).toBe('paste');
    await t.clock.advanceAsync(100);

    expect(await promise).toEqual({
      reason: 'bridge-verify-failed',
      typedStrokes: 1,
      totalStrokes: 2
    });
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, CTRL_W, ZERO, ZERO]);
    expect(t.times).toEqual([0, 0, 20, 40, 60, 60]);
    expect(t.lock.owner).toBeNull();
  });

  it('fail without a failReason stops with the timeoutReason; a failing onFail send is swallowed', async () => {
    const t = setup();
    t.sink.rejectAt = 4; // the onFail press
    const { result: promise } = await begin(
      t.engine,
      [{ kind: 'keys', strokes: [A] }, wait(() => 'fail', { onFail: [A, B] })],
      PACING.normal
    );
    await t.clock.advanceAsync(200);
    expect((await promise).reason).toBe('bridge-no-window');
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, KEY_A, ZERO]);
  });

  it('a throwing or rejecting check is pending; async verdicts are awaited', async () => {
    const t = setup();
    const answers: Array<() => WaitVerdict | Promise<WaitVerdict>> = [
      () => {
        throw new Error('no frame');
      },
      () => Promise.reject(new Error('no answer')),
      () => Promise.resolve('pending'),
      () => 'what' as WaitVerdict,
      () => Promise.resolve('ok')
    ];
    let n = 0;
    const { result: promise } = await begin(
      t.engine,
      [wait(() => answers[n++](), { intervalMs: 10 }), { kind: 'keys', strokes: [A] }],
      PACING.normal
    );
    await t.clock.advanceAsync(200);
    expect((await promise).reason).toBe('completed');
    expect(n).toBe(5);
    expect(t.times).toEqual([0, 40, 60, 60]);
  });

  it('a check that outlives the deadline times out', async () => {
    const t = setup();
    const { result: promise } = await begin(
      t.engine,
      [wait(() => new Promise<WaitVerdict>(() => undefined), { timeoutMs: 500 })],
      PACING.normal
    );
    await t.clock.advanceAsync(499);
    expect(t.engine.state).toBe('running');
    await t.clock.advanceAsync(2);
    expect((await promise).reason).toBe('bridge-no-window');
    expect(t.times).toEqual([0, 500]);
    expect(t.clock.pendingTimers()).toBe(0);
  });

  it('a cancel aborts the wait at once, also while a check is pending', async () => {
    const t = setup();
    const { result: promise } = await begin(
      t.engine,
      [wait(() => 'pending', { timeoutMs: 10_000 }), { kind: 'keys', strokes: [A] }],
      PACING.normal
    );
    await t.clock.advanceAsync(1050);
    t.engine.cancel();
    expect(t.lock.isLocked()).toBe(false);
    await flushMicrotasks();
    expect(await promise).toEqual({ reason: 'cancelled', typedStrokes: 0, totalStrokes: 1 });
    expect(t.times).toEqual([0, 1050]);

    const slow = setup();
    const { result: slowPromise } = await begin(
      slow.engine,
      [wait(() => new Promise<WaitVerdict>(() => undefined), { timeoutMs: 10_000 })],
      PACING.normal
    );
    await slow.clock.advanceAsync(300);
    slow.target.dispatchEvent(new Event('mousedown'));
    await flushMicrotasks();
    expect((await slowPromise).reason).toBe('mouse-interrupt');
    expect(slow.times).toEqual([0, 300]);
    expect(slow.clock.pendingTimers()).toBe(0);
  });
});

describe('TypingEngine watchdog', () => {
  it('stays quiet through sleeps and waits longer than watchdogMs', async () => {
    const t = setup({ watchdogMs: 3000 });
    let polls = 0;
    const { result: promise } = await begin(
      t.engine,
      [
        { kind: 'keys', strokes: [A] },
        { kind: 'sleep', ms: 5000 },
        wait(() => (++polls === 46 ? 'ok' : 'pending'), { timeoutMs: 10_000 }),
        { kind: 'keys', strokes: [B] }
      ],
      PACING.normal
    );
    await t.clock.advanceAsync(12_000, 10);
    expect(await promise).toEqual({ reason: 'completed', typedStrokes: 2, totalStrokes: 2 });
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, KEY_B, ZERO, ZERO]);
  });

  it('is re-armed by the next send: a write hanging after a wait still stops the run', async () => {
    const t = setup({ watchdogMs: 3000, writeTimeoutMs: 10_000 });
    t.sink.hangAt = 2; // the press after the wait
    const { result: promise } = await begin(
      t.engine,
      [
        wait(() => (t.clock.now() >= 4000 ? 'ok' : 'pending'), { timeoutMs: 5000 }),
        { kind: 'keys', strokes: [A] }
      ],
      PACING.normal
    );
    await t.clock.advanceAsync(6999);
    expect(t.engine.state).toBe('running');
    await t.clock.advanceAsync(2);
    expect((await promise).reason).toBe('serial-error');
    expect(t.times).toEqual([0, 4000, 7000]);
    expect(t.clock.pendingTimers()).toBe(0);
    t.sink.releaseHung();
  });
});

describe('TypingEngine atomic groups', () => {
  const group = (key: number, id: number) => stroke(key, { group: id, tag: 'unicode' });

  it('defers a cancel inside a group to its last release, keeping the lock and the first reason', async () => {
    const t = setup();
    const { result: promise } = await begin(
      t.engine,
      [{ kind: 'keys', strokes: [group(0x04, 1), group(0x05, 1), group(0x06, 1), A] }],
      PACING.normal
    );
    await t.clock.advanceAsync(10); // holding the group's first key
    t.engine.cancel();
    t.target.dispatchEvent(keydown('KeyQ'));
    t.lock.interrupt('keydown');
    expect(t.engine.state).toBe('running');
    expect(t.lock.owner).toBe('paste');

    await t.clock.advanceAsync(89);
    expect(t.lock.owner).toBe('paste');
    await t.clock.advanceAsync(1);
    // the group's last release at 100 is followed by the stop, not by its gap
    expect(t.lock.isLocked()).toBe(false);
    await flushMicrotasks();
    expect(await promise).toEqual({ reason: 'cancelled', typedStrokes: 3, totalStrokes: 4 });
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, KEY_B, ZERO, KEY_C, ZERO, ZERO]);
    expect(t.times).toEqual([0, 0, 20, 40, 60, 80, 100, 100]);
  });

  it('never defers serial-error (disconnect, watchdog, write timeout)', async () => {
    const t = setup();
    const { result: promise } = await begin(
      t.engine,
      [{ kind: 'keys', strokes: [group(0x04, 1), group(0x05, 1)] }],
      PACING.normal
    );
    await t.clock.advanceAsync(10);
    t.engine.cancel();
    t.engine.cancel('serial-error');
    expect(t.lock.isLocked()).toBe(false);
    await flushMicrotasks();
    expect(await promise).toEqual({ reason: 'serial-error', typedStrokes: 0, totalStrokes: 2 });
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO]);

    const hung = setup({ writeTimeoutMs: 100 });
    hung.sink.hangAt = 3; // the release of the group's first key
    const { result: hungPromise } = await begin(
      hung.engine,
      [{ kind: 'keys', strokes: [group(0x04, 1), group(0x05, 1)] }],
      PACING.normal
    );
    await hung.clock.advanceAsync(200);
    expect((await hungPromise).reason).toBe('serial-error');
    hung.sink.releaseHung();
  });

  it('stops at once on a click or a hidden tab inside a group: no press after the event, ZERO last', async () => {
    const cases = [
      ['pointerdown', 'mouse-interrupt'],
      ['mousedown', 'mouse-interrupt'],
      ['touchstart', 'mouse-interrupt'],
      ['visibilitychange', 'tab-hidden'],
      ['pagehide', 'tab-hidden']
    ] as const;
    for (const [type, reason] of cases) {
      const target = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
      const t = setup({ interruptTarget: target });
      const { result: promise } = await begin(
        t.engine,
        [{ kind: 'keys', strokes: [group(0x04, 1), group(0x05, 1), group(0x06, 1)] }],
        PACING.normal
      );
      await t.clock.advanceAsync(10); // holding the group's first key
      target.dispatchEvent(new Event(type));
      // the click reaches the target at once: the rest of the group must not follow it
      expect(t.lock.isLocked(), type).toBe(false);
      await flushMicrotasks();
      expect(await promise, type).toEqual({ reason, typedStrokes: 0, totalStrokes: 3 });
      expect(t.sink.reports, type).toEqual([ZERO, KEY_A, ZERO]);
      expect(t.times, type).toEqual([0, 0, 10]);
      expect(t.clock.pendingTimers(), type).toBe(0);
    }
  });

  it('pagehide while a group key is held: the ZERO goes out without any timer firing', async () => {
    const t = setup();
    const { result: promise } = await begin(
      t.engine,
      [{ kind: 'keys', strokes: [group(0x04, 1), group(0x05, 1)] }],
      PACING.normal
    );
    await t.clock.advanceAsync(10);
    expect(t.sink.reports).toEqual([ZERO, KEY_A]);

    t.target.dispatchEvent(new Event('pagehide'));
    // the page is being unloaded: no clock advance, microtasks only
    await flushMicrotasks();
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO]);
    expect(t.clock.now()).toBe(10);
    expect(t.engine.state).toBe('idle');
    expect(await promise).toEqual({ reason: 'tab-hidden', typedStrokes: 0, totalStrokes: 2 });
  });

  it("a cancel deferred in the program's last group is dropped: the whole text is typed, completed", async () => {
    for (const interrupt of ['cancel', 'keydown'] as const) {
      const t = setup();
      const { result: promise } = await begin(
        t.engine,
        [{ kind: 'keys', strokes: [A, group(0x05, 1), group(0x06, 1)] }],
        PACING.normal
      );
      await t.clock.advanceAsync(50); // A 0–20, its gap, B (the last group's first key) from 40
      if (interrupt === 'cancel') t.engine.cancel();
      else t.target.dispatchEvent(keydown('KeyQ'));
      expect(t.engine.state, interrupt).toBe('running');

      await t.clock.advanceAsync(100);
      // completed, and the run says that a stop was asked for and dropped
      const asked = interrupt === 'cancel' ? 'cancelled' : 'key-interrupt';
      expect(await promise, interrupt).toEqual({
        reason: 'completed',
        typedStrokes: 3,
        totalStrokes: 3,
        stopDropped: asked
      });
      expect(t.sink.reports, interrupt).toEqual([
        ZERO,
        KEY_A,
        ZERO,
        KEY_B,
        ZERO,
        KEY_C,
        ZERO,
        ZERO
      ]);
      expect(t.times, interrupt).toEqual([0, 0, 20, 40, 60, 80, 100, 100]);
      expect(t.lock.isLocked(), interrupt).toBe(false);
      expect(t.events[t.events.length - 1], interrupt).toMatchObject({
        type: 'stop',
        done: 3,
        total: 3,
        reason: 'completed',
        stopDropped: asked
      });
    }
  });

  it('a run nobody tried to stop, and a run that was stopped, report no dropped stop', async () => {
    // completed without any cancel
    const a = setup();
    const first = await begin(
      a.engine,
      [{ kind: 'keys', strokes: [A, group(0x05, 1), group(0x06, 1)] }],
      PACING.normal
    );
    await a.clock.advanceAsync(200);
    const done = await first.result;
    expect(done).toEqual({ reason: 'completed', typedStrokes: 3, totalStrokes: 3 });
    expect('stopDropped' in done).toBe(false);
    expect('stopDropped' in a.events[a.events.length - 1]).toBe(false);

    // a cancel deferred in a group that is not the last takes effect: cancelled, nothing dropped
    const b = setup();
    const second = await begin(
      b.engine,
      [{ kind: 'keys', strokes: [group(0x04, 1), group(0x05, 1), group(0x06, 2)] }],
      PACING.normal
    );
    await b.clock.advanceAsync(10);
    b.engine.cancel();
    await b.clock.advanceAsync(200);
    const stopped = await second.result;
    expect(stopped).toEqual({ reason: 'cancelled', typedStrokes: 2, totalStrokes: 3 });
    expect('stopDropped' in stopped).toBe(false);
    expect('stopDropped' in b.events[b.events.length - 1]).toBe(false);
  });

  // IME code input ends with the key that turns the target IME off again (tag 'ime-pre')
  const imeKey = stroke(KeycodeMap.Lang2, { tag: 'ime-pre', src: -1 });
  const IME_KEY = [0, 0, KeycodeMap.Lang2, 0, 0, 0, 0, 0];

  it("a cancel deferred in the last group is dropped when only 'ime-pre' strokes are left: they are sent, completed", async () => {
    for (const interrupt of ['cancel', 'keydown', 'lock'] as const) {
      const t = setup();
      const { result: promise } = await begin(
        t.engine,
        [{ kind: 'keys', strokes: [A, group(0x05, 1), group(0x06, 1), imeKey] }],
        PACING.normal
      );
      await t.clock.advanceAsync(50); // A 0–20, its gap, B (the group's first key) from 40
      if (interrupt === 'cancel') t.engine.cancel();
      else if (interrupt === 'keydown') t.target.dispatchEvent(keydown('KeyQ'));
      else t.lock.interrupt('keydown');
      expect(t.engine.state, interrupt).toBe('running');

      // past the group's last release at 100: the whole text is typed, the run goes on
      await t.clock.advanceAsync(55);
      expect(t.engine.state, interrupt).toBe('running');
      expect(t.lock.owner, interrupt).toBe('paste');

      await t.clock.advanceAsync(100);
      expect(await promise, interrupt).toEqual({
        reason: 'completed',
        typedStrokes: 4,
        totalStrokes: 4,
        stopDropped: interrupt === 'cancel' ? 'cancelled' : 'key-interrupt'
      });
      expect(t.sink.reports, interrupt).toEqual([
        ZERO,
        KEY_A,
        ZERO,
        KEY_B,
        ZERO,
        KEY_C,
        ZERO,
        IME_KEY,
        ZERO,
        ZERO
      ]);
      // the group's gap is kept before the IME key; nothing is slept after it
      expect(t.times, interrupt).toEqual([0, 0, 20, 40, 60, 80, 100, 120, 140, 140]);
      expect(t.lock.isLocked(), interrupt).toBe(false);
      expect(t.clock.pendingTimers(), interrupt).toBe(0);
      expect(t.events[t.events.length - 1], interrupt).toMatchObject({
        type: 'stop',
        done: 4,
        total: 4,
        reason: 'completed'
      });
    }
  });

  it("sends every 'ime-pre' stroke left after the last group, in whatever keys step it is", async () => {
    const t = setup();
    const { result: promise } = await begin(
      t.engine,
      [
        { kind: 'keys', strokes: [group(0x04, 1), imeKey] },
        { kind: 'sleep', ms: 100 },
        { kind: 'keys', strokes: [imeKey] }
      ],
      PACING.normal
    );
    await t.clock.advanceAsync(10);
    t.engine.cancel();
    await t.clock.advanceAsync(300);
    expect(await promise).toEqual({
      reason: 'completed',
      typedStrokes: 3,
      totalStrokes: 3,
      stopDropped: 'cancelled'
    });
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, IME_KEY, ZERO, IME_KEY, ZERO, ZERO]);
    expect(t.times).toEqual([0, 0, 20, 40, 60, 180, 200, 200]);
  });

  it("applies a deferred cancel while a stroke other than 'ime-pre' is still to come", async () => {
    // an IME key right after the group does not count when text follows it; neither does a
    // later keys step that is not only IME keys: the stop in the middle of a text stays a stop
    const programs: ProgramStep[][] = [
      [{ kind: 'keys', strokes: [group(0x04, 1), imeKey, B] }],
      [{ kind: 'keys', strokes: [group(0x04, 1), imeKey, group(0x05, 2), imeKey] }],
      [
        { kind: 'keys', strokes: [group(0x04, 1), imeKey] },
        { kind: 'keys', strokes: [imeKey, B, imeKey] }
      ]
    ];
    for (const [n, steps] of programs.entries()) {
      for (const interrupt of ['cancel', 'keydown'] as const) {
        const label = `program ${n} ${interrupt}`;
        const t = setup();
        const total = steps.reduce((sum, s) => sum + (s.kind === 'keys' ? s.strokes.length : 0), 0);
        const { result: promise } = await begin(t.engine, steps, PACING.normal);
        await t.clock.advanceAsync(10); // holding the group's only key
        if (interrupt === 'cancel') t.engine.cancel();
        else t.target.dispatchEvent(keydown('KeyQ'));
        expect(t.engine.state, label).toBe('running');

        await t.clock.advanceAsync(300);
        expect(await promise, label).toEqual({
          reason: interrupt === 'cancel' ? 'cancelled' : 'key-interrupt',
          typedStrokes: 1,
          totalStrokes: total
        });
        // the group is finished, and neither the IME key nor anything else follows it
        expect(t.sink.reports, label).toEqual([ZERO, KEY_A, ZERO, ZERO]);
        expect(t.times, label).toEqual([0, 0, 20, 20]);
      }
    }
  });

  it("a stop that is never deferred is not dropped: a click with only 'ime-pre' strokes left stops at once", async () => {
    const stops = [
      ['pointerdown', 'mouse-interrupt'],
      ['pagehide', 'tab-hidden'],
      ['serial', 'serial-error']
    ] as const;
    for (const [type, reason] of stops) {
      const t = setup();
      const { result: promise } = await begin(
        t.engine,
        [{ kind: 'keys', strokes: [group(0x04, 1), group(0x05, 1), imeKey] }],
        PACING.normal
      );
      await t.clock.advanceAsync(10); // holding the group's first key
      if (type === 'serial') t.engine.cancel('serial-error');
      else t.target.dispatchEvent(new Event(type));
      expect(t.lock.isLocked(), type).toBe(false);
      await flushMicrotasks();
      expect(await promise, type).toEqual({ reason, typedStrokes: 0, totalStrokes: 3 });
      expect(t.sink.reports, type).toEqual([ZERO, KEY_A, ZERO]);
    }
  });

  it("a cancel after the last group, while the 'ime-pre' strokes are sent, stops at once as before", async () => {
    // only the cancel deferred inside the group is dropped: nothing holds one back afterwards
    const t = setup();
    const { result: promise } = await begin(
      t.engine,
      [{ kind: 'keys', strokes: [group(0x04, 1), imeKey] }],
      PACING.normal
    );
    await t.clock.advanceAsync(30); // the gap between the group and the IME key
    t.engine.cancel();
    expect(t.lock.isLocked()).toBe(false);
    await flushMicrotasks();
    expect(await promise).toEqual({ reason: 'cancelled', typedStrokes: 1, totalStrokes: 2 });
    expect(t.sink.reports).toEqual([ZERO, KEY_A, ZERO, ZERO]);
    expect(t.times).toEqual([0, 0, 20, 30]);
  });

  it('cancels at once between groups and outside them', async () => {
    const t = setup();
    const { result: promise } = await begin(
      t.engine,
      [{ kind: 'keys', strokes: [group(0x04, 1), group(0x05, 2), A] }],
      PACING.normal
    );
    await t.clock.advanceAsync(30); // the gap after group 1
    t.engine.cancel();
    expect(t.lock.isLocked()).toBe(false);
    await flushMicrotasks();
    expect(await promise).toEqual({ reason: 'cancelled', typedStrokes: 1, totalStrokes: 3 });
    expect(t.times).toEqual([0, 0, 20, 30]);

    // a new run starts with no group open and no deferred reason left over
    const { result: again } = await begin(
      t.engine,
      [{ kind: 'keys', strokes: [A, B] }],
      PACING.normal
    );
    await t.clock.advanceAsync(10);
    t.engine.cancel();
    expect(t.lock.isLocked()).toBe(false);
    await flushMicrotasks();
    expect((await again).reason).toBe('cancelled');
  });
});
