import { createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { serialStateAtom } from '@/jotai/device';
import { IDLE_PASTE_RUN, pasteRunAtom, pasteSettingsAtom } from '@/jotai/paste';
import { targetLayoutAtom } from '@/jotai/target';
import { HidLock } from '@/libs/keyboard/hid-lock';
import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import { PASTE_HARD_LIMIT, PASTE_SOFT_LIMIT } from '@/libs/paste/text-to-keys';
import { TypingEngine, ZERO_REPORT } from '@/libs/paste/typing-engine';
import { FakeClock, FakeSink, flushMicrotasks } from '@/test/fakes';

import {
  isInsideOwnUi,
  PasteController,
  pasteSettingsModalAtom,
  type DriverLike,
  type PasteUi
} from './controller';

const ZERO = [...ZERO_REPORT];
const press = (key: number, mod = 0): number[] => [mod, 0, key, 0, 0, 0, 0, 0];

interface HarnessOptions {
  clipboard?: string | (() => Promise<string>);
  serial?: 'connected' | 'disconnected';
  settings?: Record<string, unknown>;
  layout?: 'us' | 'jis';
  driver?: DriverLike | null;
}

function makeHarness(options: HarnessOptions = {}) {
  const store = createStore();
  store.set(serialStateAtom, options.serial ?? 'connected');
  store.set(pasteSettingsAtom, options.settings ?? null);
  store.set(targetLayoutAtom, options.layout ?? 'us');

  const clock = new FakeClock();
  const sink = new FakeSink();
  const lock = new HidLock();
  const target = new EventTarget();
  const engine = new TypingEngine({
    send: sink.send,
    lock,
    clock,
    interruptTarget: target,
    isInsideOwnUi: () => false
  });

  const notices: Array<{ notice: string; params?: Record<string, string | number> }> = [];
  const confirms: Array<[number, number]> = [];
  let confirmAnswer = true;
  const ui: PasteUi = {
    notify: (notice, params) => {
      notices.push({ notice, params });
    },
    confirmLarge: (count, seconds) => {
      confirms.push([count, seconds]);
      return Promise.resolve(confirmAnswer);
    }
  };

  const clipboard = options.clipboard ?? '';
  const readClipboard = vi.fn(
    typeof clipboard === 'function' ? clipboard : () => Promise.resolve(clipboard)
  );
  const controller = new PasteController({
    store,
    getEngine: () => engine,
    lock,
    readClipboard,
    hostOS: 'macOS',
    getDriver: () => options.driver ?? null
  });
  controller.setUi(ui);

  return {
    store,
    clock,
    sink,
    lock,
    target,
    engine,
    controller,
    notices,
    confirms,
    readClipboard,
    setConfirmAnswer: (answer: boolean) => {
      confirmAnswer = answer;
    },
    run: () => store.get(pasteRunAtom)
  };
}

/** A host keydown on the engine's interrupt target (no KeyboardEvent in node). */
function keydown(target: EventTarget, code: string): void {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { code, repeat: false });
  target.dispatchEvent(event);
}

/** Lets a run of up to `strokes` characters finish at normal pacing. */
async function finish(clock: FakeClock, strokes: number): Promise<void> {
  await flushMicrotasks();
  await clock.advanceAsync(strokes * 40 + 50);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PasteController', () => {
  it('refuses without a serial connection: no clipboard read, one notice, nothing sent', async () => {
    const h = makeHarness({ serial: 'disconnected', clipboard: 'abc' });
    await expect(h.controller.startFromRow()).resolves.toBe('notConnected');
    expect(h.readClipboard).not.toHaveBeenCalled();
    expect(h.notices).toEqual([{ notice: 'notConnected', params: undefined }]);
    expect(h.sink.reports).toEqual([]);
    expect(h.run()).toEqual(IDLE_PASTE_RUN);
  });

  it('classifies clipboard failures: focus → toast, blocked → settings modal, no text → empty', async () => {
    const focus = Object.assign(new Error('Document is not focused.'), { name: 'NotAllowedError' });
    let h = makeHarness({ clipboard: () => Promise.reject(focus) });
    await expect(h.controller.startFromHotkey()).resolves.toBe('clipboard');
    expect(h.notices.map((n) => n.notice)).toEqual(['noFocus']);
    expect(h.store.get(pasteSettingsModalAtom).open).toBe(false);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const denied = Object.assign(new Error('Read permission denied.'), { name: 'NotAllowedError' });
    h = makeHarness({ clipboard: () => Promise.reject(denied) });
    await expect(h.controller.startFromRow()).resolves.toBe('clipboard');
    expect(h.notices).toEqual([]);
    expect(h.store.get(pasteSettingsModalAtom)).toEqual({ open: true, permDenied: true });

    h = makeHarness({ clipboard: '' });
    await expect(h.controller.startFromRow()).resolves.toBe('clipboard');
    expect(h.notices.map((n) => n.notice)).toEqual(['empty']);
    expect(h.sink.reports).toEqual([]);
  });

  it('nothing typeable: notice, no lock, nothing on the wire', async () => {
    const h = makeHarness({ clipboard: '日本語のテキスト' });
    await expect(h.controller.startFromRow()).resolves.toBe('nothing');
    expect(h.notices.map((n) => n.notice)).toEqual(['nothingTypeable']);
    expect(h.lock.isLocked()).toBe(false);
    expect(h.sink.reports).toEqual([]);
    expect(h.run()).toEqual(IDLE_PASTE_RUN);
  });

  it('types the clipboard: ARM zero, press/release per stroke, final zero; state running → done', async () => {
    const h = makeHarness({ clipboard: 'ab' });
    await expect(h.controller.startFromRow()).resolves.toBe('started');
    expect(h.readClipboard).toHaveBeenCalledTimes(1);
    expect(h.run()).toEqual({ status: 'running', done: 0, total: 2, etaMs: 80, skipped: [] });
    expect(h.lock.owner).toBe('paste');

    await finish(h.clock, 2);
    expect(h.sink.reports).toEqual([
      ZERO,
      press(KeycodeMap.KeyA),
      ZERO,
      press(KeycodeMap.KeyB),
      ZERO,
      ZERO
    ]);
    expect(h.run()).toEqual({
      status: 'done',
      done: 2,
      total: 2,
      etaMs: 0,
      reason: 'completed',
      skipped: []
    });
    expect(h.lock.isLocked()).toBe(false);
    expect(h.engine.state).toBe('idle');
    expect(h.notices).toEqual([]);
  });

  it('uses the target layout atom and the stored settings (JIS table, safe pacing)', async () => {
    const h = makeHarness({ clipboard: '@', layout: 'jis', settings: { speed: 'safe' } });
    await h.controller.startFromRow();
    await flushMicrotasks();
    expect(h.sink.reports).toEqual([ZERO, press(KeycodeMap.BracketLeft)]);
    await h.clock.advanceAsync(49);
    expect(h.sink.reports).toHaveLength(2);
    await h.clock.advanceAsync(1);
    // released after the 50 ms hold; the last stroke is followed at once by the final zero
    expect(h.sink.reports).toEqual([ZERO, press(KeycodeMap.BracketLeft), ZERO, ZERO]);

    const us = makeHarness({ clipboard: '@' });
    await us.controller.startFromRow();
    await flushMicrotasks();
    expect(us.sink.reports[1]).toEqual(press(KeycodeMap.Digit2, ModifierBits.LeftShift));
  });

  it('reports skipped characters (unique, counted) from the start of the run', async () => {
    const h = makeHarness({ clipboard: 'aあbあい' });
    await h.controller.startFromRow();
    const skipped = [
      { char: 'あ', count: 2 },
      { char: 'い', count: 1 }
    ];
    expect(h.run()).toMatchObject({ status: 'running', total: 2, skipped });
    await finish(h.clock, 2);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'completed', done: 2, skipped });
  });

  it('asks before a large paste with the grapheme count and the ETA; declined → nothing happens', async () => {
    const h = makeHarness({ clipboard: 'a'.repeat(PASTE_SOFT_LIMIT + 1) });
    h.setConfirmAnswer(false);
    await expect(h.controller.startFromRow()).resolves.toBe('declined');
    expect(h.confirms).toEqual([
      [PASTE_SOFT_LIMIT + 1, Math.ceil(((PASTE_SOFT_LIMIT + 1) * 40) / 1000)]
    ]);
    expect(h.sink.reports).toEqual([]);
    expect(h.lock.isLocked()).toBe(false);
    expect(h.run()).toEqual(IDLE_PASTE_RUN);
  });

  it('an accepted large paste runs; the truncation notice names the hard limit', async () => {
    const h = makeHarness({ clipboard: 'a'.repeat(PASTE_HARD_LIMIT + 1) });
    await expect(h.controller.startFromRow()).resolves.toBe('started');
    expect(h.notices).toEqual([{ notice: 'truncated', params: { max: PASTE_HARD_LIMIT } }]);
    expect(h.confirms).toEqual([[PASTE_HARD_LIMIT + 1, (PASTE_HARD_LIMIT * 40) / 1000]]);
    expect(h.run()).toMatchObject({ status: 'running', total: PASTE_HARD_LIMIT });

    h.controller.cancel();
    await finish(h.clock, 1);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'cancelled' });
  });

  it('a second trigger while running cancels: lock released synchronously, reason cancelled', async () => {
    const h = makeHarness({ clipboard: 'abcdef' });
    await h.controller.startFromRow();
    await flushMicrotasks();

    await expect(h.controller.startFromHotkey()).resolves.toBe('cancelled');
    expect(h.lock.isLocked()).toBe(false);
    expect(h.readClipboard).toHaveBeenCalledTimes(1);

    await finish(h.clock, 1);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'cancelled', total: 6 });
    expect(h.run().done).toBeLessThan(6);
    expect(h.sink.reports[h.sink.reports.length - 1]).toEqual(ZERO);
    expect(h.engine.state).toBe('idle');
  });

  it('a trigger during the clipboard read is ignored, not queued', async () => {
    let resolveRead: (text: string) => void = () => {};
    const h = makeHarness({
      clipboard: () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        })
    });
    const first = h.controller.startFromRow();
    await expect(h.controller.startFromHotkey()).resolves.toBe('busy');
    resolveRead('ab');
    await expect(first).resolves.toBe('started');
    expect(h.readClipboard).toHaveBeenCalledTimes(1);

    await finish(h.clock, 2);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'completed', done: 2 });
  });

  it('cancel(serial-error) from the disconnect hook ends the run with that reason', async () => {
    const h = makeHarness({ clipboard: 'abc' });
    await h.controller.startFromRow();
    h.controller.cancel('serial-error');
    expect(h.lock.isLocked()).toBe(false);
    await finish(h.clock, 1);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'serial-error' });

    // idle: a cancel is a no-op
    h.controller.cancel('serial-error');
    h.controller.cancel();
    expect(h.run()).toMatchObject({ status: 'done', reason: 'serial-error' });
  });

  it('shows "cancelled" when the user cancels after the engine already saw the key', async () => {
    const h = makeHarness({ clipboard: 'abc' });
    await h.controller.startFromRow();
    await flushMicrotasks();

    // the engine's own window listener stops first (key-interrupt) ...
    keydown(h.target, 'KeyV');
    expect(h.engine.state).toBe('stopping');
    expect(h.controller.isBusy()).toBe(true);
    // ... then the keyboard adapter recognises the paste hotkey
    h.controller.cancel();

    await finish(h.clock, 1);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'cancelled' });
    expect(h.controller.isBusy()).toBe(false);
  });

  it('a plain key interrupt keeps its reason', async () => {
    const h = makeHarness({ clipboard: 'abc' });
    await h.controller.startFromRow();
    await flushMicrotasks();
    keydown(h.target, 'KeyX');
    await finish(h.clock, 1);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'key-interrupt' });
  });

  it('re-syncs a chord still held on the physical keyboard, after an early stop only', async () => {
    const setMuted = vi.fn();
    const held: DriverLike = {
      lastReport: () => [ModifierBits.LeftCtrl | ModifierBits.LeftShift, 0, 0, 0, 0, 0, 0, 0],
      isMuted: () => false,
      isDryRun: () => false,
      setMuted
    };

    let h = makeHarness({ clipboard: 'abc', driver: held });
    await h.controller.startFromRow();
    await flushMicrotasks();
    h.controller.cancel();
    expect(setMuted).not.toHaveBeenCalled(); // only once the final zero report is out
    await finish(h.clock, 1);
    expect(setMuted.mock.calls).toEqual([[true], [false]]);

    setMuted.mockClear();
    h = makeHarness({ clipboard: 'a', driver: held });
    await h.controller.startFromRow();
    await finish(h.clock, 1);
    expect(h.run().reason).toBe('completed');
    expect(setMuted).not.toHaveBeenCalled();

    const released: DriverLike = { ...held, lastReport: () => [...ZERO] };
    h = makeHarness({ clipboard: 'abc', driver: released });
    await h.controller.startFromRow();
    h.controller.cancel();
    await finish(h.clock, 1);
    expect(setMuted).not.toHaveBeenCalled();

    const muted: DriverLike = { ...held, isMuted: () => true };
    h = makeHarness({ clipboard: 'abc', driver: muted });
    await h.controller.startFromRow();
    h.controller.cancel();
    await finish(h.clock, 1);
    expect(setMuted).not.toHaveBeenCalled();
  });

  it('startFromText shares the path without touching the clipboard', async () => {
    const h = makeHarness({ clipboard: 'clipboard' });
    await expect(h.controller.startFromText('hi')).resolves.toBe('started');
    expect(h.readClipboard).not.toHaveBeenCalled();
    await finish(h.clock, 2);
    expect(h.sink.reports).toEqual([
      ZERO,
      press(KeycodeMap.KeyH),
      ZERO,
      press(KeycodeMap.KeyI),
      ZERO,
      ZERO
    ]);

    await expect(h.controller.startFromText('あ')).resolves.toBe('nothing');
    expect(h.notices.map((n) => n.notice)).toEqual(['nothingTypeable']);
  });

  it('settings modal state and result dismissal go through the store', async () => {
    const h = makeHarness({ clipboard: 'a' });
    h.controller.openSettings();
    expect(h.store.get(pasteSettingsModalAtom)).toEqual({ open: true, permDenied: false });
    h.controller.closeSettings();
    expect(h.store.get(pasteSettingsModalAtom)).toEqual({ open: false });

    await h.controller.startFromRow();
    h.controller.dismissResult(); // ignored while busy
    expect(h.run().status).toBe('running');
    await finish(h.clock, 1);
    expect(h.run().status).toBe('done');
    h.controller.dismissResult();
    expect(h.run()).toEqual(IDLE_PASTE_RUN);
  });

  it('without a mounted UI a large paste is not started and notices go to the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = makeHarness({ clipboard: 'a'.repeat(PASTE_SOFT_LIMIT + 1) });
    const controller = new PasteController({
      store: h.store,
      getEngine: () => h.engine,
      lock: h.lock,
      readClipboard: h.readClipboard,
      hostOS: 'macOS',
      getDriver: () => null
    });
    await expect(controller.startFromRow()).resolves.toBe('declined');
    expect(h.sink.reports).toEqual([]);
    expect(warn).toHaveBeenCalled();

    // the registered UI can be unregistered again
    const off = controller.setUi({ notify: () => {}, confirmLarge: () => Promise.resolve(true) });
    off();
    h.store.set(serialStateAtom, 'disconnected');
    warn.mockClear();
    await expect(controller.startFromRow()).resolves.toBe('notConnected');
    expect(warn).toHaveBeenCalledWith('[paste]', 'notConnected', '');
  });
});

describe('isInsideOwnUi', () => {
  const element = (hit: boolean) => ({
    nodeType: 1,
    parentElement: null,
    closest: (selector: string) => (hit && selector === '[data-paste-ui]' ? {} : null)
  });

  it('is true only below a data-paste-ui ancestor', () => {
    expect(isInsideOwnUi(element(true) as unknown as EventTarget)).toBe(true);
    expect(isInsideOwnUi(element(false) as unknown as EventTarget)).toBe(false);
    expect(isInsideOwnUi(null)).toBe(false);
    // window/document-like targets without nodeType
    expect(isInsideOwnUi(new EventTarget())).toBe(false);
  });

  it('resolves a text node through its parent element', () => {
    const text = { nodeType: 3, parentElement: element(true) };
    expect(isInsideOwnUi(text as unknown as EventTarget)).toBe(true);
    expect(isInsideOwnUi({ nodeType: 3, parentElement: null } as unknown as EventTarget)).toBe(
      false
    );
  });
});
