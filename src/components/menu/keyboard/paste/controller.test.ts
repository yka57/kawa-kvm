import { createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { serialStateAtom } from '@/jotai/device';
import { IDLE_PASTE_RUN, pasteRunAtom, pasteSettingsAtom } from '@/jotai/paste';
import { targetLayoutAtom, targetOsAtom, type TargetOs } from '@/jotai/target';
import type { LockState } from '@/libs/device';
import { HidLock } from '@/libs/keyboard/hid-lock';
import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import { FRAME_H, FRAME_W, type Frame, type FrameSampler } from '@/libs/media/frame-probe';
import {
  BRIDGE_PROBE_URL,
  BRIDGE_URL_PREFIX,
  buildBridgeProgram,
  buildBridgeUrl
} from '@/libs/paste/bridge';
import { CAPS_LOCK_TIMEOUT_MS } from '@/libs/paste/caps-lock';
import { getTable } from '@/libs/paste/layouts';
import { PASTE_HARD_LIMIT, PASTE_SOFT_LIMIT } from '@/libs/paste/text-to-keys';
import type { TargetLayout } from '@/libs/paste/types';
import {
  estimateProgramMs,
  PACING,
  TypingEngine,
  ZERO_REPORT,
  type PastePhase
} from '@/libs/paste/typing-engine';
import { IME_CODE_COMMIT } from '@/libs/paste/unicode-entry';
import { FakeClock, FakeSink, flushMicrotasks } from '@/test/fakes';

import {
  isInsideOwnUi,
  PasteController,
  pasteSettingsModalAtom,
  type DriverLike,
  type PasteUi
} from './controller';
import { queueMayContinue } from './decide';

const ZERO = [...ZERO_REPORT];
const press = (key: number, mod = 0): number[] => [mod, 0, key, 0, 0, 0, 0, 0];
const CTRL = ModifierBits.LeftCtrl;
const SHIFT = ModifierBits.LeftShift;

type Screen = 'desktop' | 'window' | 'magenta' | 'lime' | 'red' | 'blue';

function frame(rgb: [number, number, number]): Frame {
  const data = new Uint8ClampedArray(FRAME_W * FRAME_H * 4);
  for (let i = 0; i < FRAME_W * FRAME_H; i++) data.set([...rgb, 255], i * 4);
  return { w: FRAME_W, h: FRAME_H, data };
}

// limited-range HDMI colours, as the capture device delivers them
const FRAMES: Record<Screen, Frame> = {
  desktop: frame([200, 200, 200]),
  window: frame([40, 40, 40]),
  magenta: frame([235, 16, 235]),
  lime: frame([16, 235, 16]),
  red: frame([235, 16, 16]),
  blue: frame([16, 16, 235])
};

interface BrowserScript {
  opensWindow: boolean;
  loadsProbe: boolean;
  /** What a typed bridge URL shows: its page verified (lime) or not (red). */
  payload: 'lime' | 'red';
  /** Ctrl+C on the verified page runs its copy handler, which turns it blue. */
  copies: boolean;
  closesWindow: boolean;
}

const WORKING_BROWSER: BrowserScript = {
  opensWindow: true,
  loadsProbe: true,
  payload: 'lime',
  copies: true,
  closesWindow: true
};

/**
 * The target browser as the bridge sees it through the video: the three
 * open-window chords open a window, Ctrl+L starts a new address, Enter loads
 * it, Ctrl+C on the verified page turns it blue, Ctrl+W closes the window.
 * Typed characters are decoded with the target layout table.
 */
class FakeBrowser {
  shown: Screen = 'desktop';
  /** Every address loaded with Enter, in order. */
  readonly loads: string[] = [];
  script: BrowserScript = WORKING_BROWSER;
  private address = '';
  private chars = new Map<string, string>();

  setLayout(layout: TargetLayout): void {
    this.chars = new Map(
      Object.entries(getTable(layout)).map(([char, combo]) => [
        `${combo.shift ? SHIFT : 0}:${KeycodeMap[combo.key]}`,
        char
      ])
    );
  }

  onReport([mod, , key]: number[]): void {
    if (key === 0) return;
    const opensWindow =
      (mod === (CTRL | SHIFT) && (key === KeycodeMap.KeyN || key === KeycodeMap.KeyP)) ||
      (mod === CTRL && key === KeycodeMap.KeyN);
    if (opensWindow) {
      if (this.script.opensWindow) this.shown = 'window';
    } else if (mod === CTRL && key === KeycodeMap.KeyL) {
      this.address = '';
    } else if (mod === CTRL && key === KeycodeMap.KeyC) {
      if (this.shown === 'lime' && this.script.copies) this.shown = 'blue';
    } else if (mod === CTRL && key === KeycodeMap.KeyW) {
      if (this.script.closesWindow) this.shown = 'desktop';
    } else if (mod === 0 && key === KeycodeMap.Enter) {
      this.loads.push(this.address);
      if (this.address === BRIDGE_PROBE_URL && this.script.loadsProbe) this.shown = 'magenta';
      if (this.address.startsWith(BRIDGE_URL_PREFIX)) this.shown = this.script.payload;
    } else {
      this.address += this.chars.get(`${mod}:${key}`) ?? '';
    }
  }
}

interface HarnessOptions {
  clipboard?: string | (() => Promise<string>);
  serial?: 'connected' | 'disconnected';
  settings?: Record<string, unknown>;
  layout?: 'us' | 'jis';
  targetOs?: TargetOs;
  driver?: DriverLike | null;
  /** The capture video shows the target (default true). */
  video?: boolean;
  browser?: Partial<BrowserScript>;
  /** Successive getLockState() answers, the last one repeating (default: unknown). */
  lockStates?: Array<LockState | null>;
  /** The one-time bridge explanation was accepted earlier (default false: a fresh profile). */
  introAccepted?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const store = createStore();
  store.set(serialStateAtom, options.serial ?? 'connected');
  store.set(pasteSettingsAtom, options.settings ?? null);
  store.set(targetLayoutAtom, options.layout ?? 'us');
  // Linux: the automatic IME pre-key resolves to none, so the sequences below are the bare text
  store.set(targetOsAtom, options.targetOs ?? 'linux');

  const clock = new FakeClock();
  const sink = new FakeSink();
  const lock = new HidLock();
  const target = new EventTarget();
  const browser = new FakeBrowser();
  browser.setLayout(options.layout ?? 'us');
  browser.script = { ...WORKING_BROWSER, ...options.browser };
  const engine = new TypingEngine({
    send: (report) => {
      browser.onReport(report);
      return sink.send(report);
    },
    lock,
    clock,
    interruptTarget: target,
    isInsideOwnUi: () => false
  });

  const notices: Array<{ notice: string; params?: Record<string, string | number> }> = [];
  const confirms: Array<[number, number]> = [];
  const bridgeConfirms: number[] = [];
  let confirmAnswer = true;
  let bridgeAnswer = true;
  const ui: PasteUi = {
    notify: (notice, params) => {
      notices.push({ notice, params });
    },
    confirmLarge: (count, seconds) => {
      confirms.push([count, seconds]);
      return Promise.resolve(confirmAnswer);
    },
    confirmBridge: (seconds) => {
      bridgeConfirms.push(seconds);
      return Promise.resolve(bridgeAnswer);
    }
  };

  let video = options.video ?? true;
  const sampler: FrameSampler = {
    available: () => video,
    sample: () => (video ? FRAMES[browser.shown] : null)
  };
  const lockStates = [...(options.lockStates ?? [null])];
  const getLockState = vi.fn(() =>
    Promise.resolve((lockStates.length > 1 ? lockStates.shift() : lockStates[0]) ?? null)
  );
  let introAccepted = options.introAccepted ?? false;

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
    getDriver: () => options.driver ?? null,
    sampler,
    getLockState,
    isBridgeIntroAccepted: () => introAccepted,
    acceptBridgeIntro: () => {
      introAccepted = true;
    }
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
    bridgeConfirms,
    readClipboard,
    browser,
    sampler,
    getLockState,
    setConfirmAnswer: (answer: boolean) => {
      confirmAnswer = answer;
    },
    setBridgeAnswer: (answer: boolean) => {
      bridgeAnswer = answer;
    },
    setVideo: (on: boolean) => {
      video = on;
    },
    introAccepted: () => introAccepted,
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
    const h = makeHarness({ clipboard: '日本語のテキスト', settings: { unicodeMethod: 'skip' } });
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
    expect(h.run()).toEqual({
      status: 'running',
      done: 0,
      total: 2,
      etaMs: 80,
      skipped: [],
      method: 'direct'
    });
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
      skipped: [],
      method: 'direct'
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

  it('sends the IME-off key (LANG2) first on a Windows target by default, then settles', async () => {
    const h = makeHarness({ clipboard: 'a', targetOs: 'windows' });
    await h.controller.startFromRow();
    // LANG2 hold 20 + gap 20 + IME settle 150, then 'a' hold 20 + gap 20
    expect(h.run()).toMatchObject({ status: 'running', total: 2, etaMs: 230 });
    await finish(h.clock, 7);
    expect(h.sink.reports).toEqual([
      ZERO,
      press(KeycodeMap.Lang2),
      ZERO,
      press(KeycodeMap.KeyA),
      ZERO,
      ZERO
    ]);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'completed', done: 2 });

    const none = makeHarness({
      clipboard: 'a',
      targetOs: 'windows',
      settings: { version: 2, imePreKey: 'none' }
    });
    await none.controller.startFromRow();
    await finish(none.clock, 1);
    expect(none.sink.reports).toEqual([ZERO, press(KeycodeMap.KeyA), ZERO, ZERO]);
  });

  it('reports skipped characters (unique, counted) from the start of the run', async () => {
    const h = makeHarness({ clipboard: 'aあbあい', settings: { unicodeMethod: 'skip' } });
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
    const h = makeHarness({ clipboard: 'clipboard', settings: { unicodeMethod: 'skip' } });
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
      getDriver: () => null,
      sampler: h.sampler,
      getLockState: h.getLockState,
      isBridgeIntroAccepted: () => true,
      acceptBridgeIntro: () => {}
    });
    await expect(controller.startFromRow()).resolves.toBe('declined');
    expect(h.sink.reports).toEqual([]);
    expect(warn).toHaveBeenCalled();

    // the registered UI can be unregistered again
    const off = controller.setUi({
      notify: () => {},
      confirmLarge: () => Promise.resolve(true),
      confirmBridge: () => Promise.resolve(true)
    });
    off();
    h.store.set(serialStateAtom, 'disconnected');
    warn.mockClear();
    await expect(controller.startFromRow()).resolves.toBe('notConnected');
    expect(warn).toHaveBeenCalledWith('[paste]', 'notConnected', '');
  });
});

const CAPS_ON: LockState = { num: true, caps: true, scroll: false, version: 0x38 };
const CAPS_OFF: LockState = { ...CAPS_ON, caps: false };

type Harness = ReturnType<typeof makeHarness>;

/** Advances the clock until the run is over (a bridge run takes seconds). */
async function settle(h: Harness): Promise<void> {
  await flushMicrotasks();
  for (let i = 0; i < 300 && h.engine.state !== 'idle'; i++) await h.clock.advanceAsync(100);
}

/** The ETA the dialogs show for a bridge run with the default settings. */
function bridgeSeconds(text: string, sampler: FrameSampler): number {
  const program = buildBridgeProgram(buildBridgeUrl(text), {
    sampler,
    layout: 'us',
    imeOff: 'Lang2',
    window: 'chromium-private'
  });
  return Math.ceil(estimateProgramMs(program, PACING.normal) / 1000);
}

/** Every key press on the wire so far, in order (the release reports left out). */
function presses(h: Harness): number[][] {
  return h.sink.reports.filter((report) => report[2] !== 0);
}

/** Advances the clock until `key` has gone down `count` times: that stroke is being held. */
async function untilPressed(h: Harness, key: number, count: number): Promise<void> {
  const seen = () => h.sink.reports.filter((report) => report[2] === key).length;
  for (let i = 0; i < 2000 && seen() < count; i++) await h.clock.advanceAsync(5);
  expect(seen()).toBe(count);
}

/** The presses of one IME code-input unit: its hex digits, F5 and the commit chord. */
function imeUnit(digits: string): number[][] {
  return [
    ...[...digits].map((digit) =>
      press(KeycodeMap[digit >= 'a' ? `Key${digit.toUpperCase()}` : `Digit${digit}`])
    ),
    press(KeycodeMap.F5),
    press(IME_CODE_COMMIT.key, IME_CODE_COMMIT.mod)
  ];
}

/** The first key press on the wire (a bridge run sends its first after the still-screen check). */
async function firstPress(h: Harness): Promise<number[] | undefined> {
  for (let elapsed = 0; elapsed <= 1000; elapsed += 5) {
    const press = h.sink.reports.find((report) => report[2] !== 0);
    if (press !== undefined) return press;
    await h.clock.advanceAsync(5);
  }
  return undefined;
}

describe('PasteController: methods, bridge and Caps Lock (spec v2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Japanese on a Windows target goes through the browser bridge, phase by phase', async () => {
    const h = makeHarness({
      clipboard: '日本語',
      targetOs: 'windows',
      settings: { speed: 'fast' }
    });
    const phases: PastePhase[] = [];
    h.store.sub(pasteRunAtom, () => {
      const { phase } = h.run();
      if (phase !== undefined && phase !== phases[phases.length - 1]) phases.push(phase);
    });

    await expect(h.controller.startFromRow()).resolves.toBe('started');
    expect(h.run()).toMatchObject({ status: 'running', method: 'bridge', skipped: [] });
    await settle(h);

    expect(h.browser.loads).toEqual([BRIDGE_PROBE_URL, buildBridgeUrl('日本語')]);
    expect(h.sink.reports[1]).toEqual(press(KeycodeMap.KeyN, CTRL | SHIFT));
    expect(h.sink.reports.slice(-3)).toEqual([press(KeycodeMap.KeyV, CTRL), ZERO, ZERO]);
    expect(phases).toEqual(['window', 'probe', 'type', 'verify', 'copy', 'close', 'paste']);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'completed', method: 'bridge' });
    expect(h.run().phase).toBeUndefined();
  });

  it('Japanese on a Linux target is typed with Ctrl+Shift+U, the hex digits and Space', async () => {
    const h = makeHarness({ clipboard: 'aあ' });
    await h.controller.startFromRow();
    expect(h.run()).toMatchObject({ status: 'running', method: 'unicode' });
    await settle(h);
    expect(h.sink.reports.filter((report) => report[2] !== 0)).toEqual([
      press(KeycodeMap.KeyA),
      press(KeycodeMap.KeyU, CTRL | SHIFT),
      press(KeycodeMap.Digit3),
      press(KeycodeMap.Digit0),
      press(KeycodeMap.Digit4),
      press(KeycodeMap.Digit2),
      press(KeycodeMap.Space)
    ]);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'completed', skipped: [] });
  });

  it('IME code input on a Windows target: LANG2, the direct key, LANG1, digits, F5, the commit, LANG2', async () => {
    const h = makeHarness({
      clipboard: 'aあ',
      targetOs: 'windows',
      settings: { unicodeMethod: 'ime-code' },
      // no window is opened and nothing is watched: neither the video nor the bridge dialog is needed
      video: false
    });
    await expect(h.controller.startFromRow()).resolves.toBe('started');
    // ten strokes of 20 + 20 ms, the settle after the first LANG2 and 100 ms after the first F5
    expect(h.run()).toMatchObject({
      status: 'running',
      method: 'unicode',
      total: 10,
      etaMs: 10 * 40 + 150 + 100
    });
    await settle(h);
    expect(presses(h)).toEqual([
      press(KeycodeMap.Lang2),
      press(KeycodeMap.KeyA),
      press(KeycodeMap.Lang1),
      press(KeycodeMap.Digit3),
      press(KeycodeMap.Digit0),
      press(KeycodeMap.Digit4),
      press(KeycodeMap.Digit2),
      press(KeycodeMap.F5),
      // the commit chord: its modifier and its key go down in one report
      press(IME_CODE_COMMIT.key, IME_CODE_COMMIT.mod),
      press(KeycodeMap.Lang2)
    ]);
    // every press is followed by an all-zero release: no modifier is held between strokes
    expect(h.sink.reports.filter((report) => report[2] === 0).every((r) => r[0] === 0)).toBe(true);
    expect(h.bridgeConfirms).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'completed', done: 10, skipped: [] });
  });

  it('IME code input at Fast is typed exactly as at Normal: every key held 20 ms, 40 ms apart', async () => {
    const h = makeHarness({
      clipboard: 'あいう',
      targetOs: 'windows',
      settings: { speed: 'fast', unicodeMethod: 'ime-code' }
    });
    await expect(h.controller.startFromRow()).resolves.toBe('started');
    // 21 strokes of 20 + 20 ms, the settle after the first LANG2 and 100 ms after the first F5:
    // the estimate of Normal
    expect(h.run()).toMatchObject({
      status: 'running',
      method: 'unicode',
      total: 21,
      etaMs: 21 * 40 + 150 + 100
    });

    // when each report goes out, in ms since the start of the run
    const stamps: number[] = [];
    const note = () => {
      while (stamps.length < h.sink.reports.length) stamps.push(h.clock.now());
    };
    note();
    for (let i = 0; i < 2000 && h.engine.state !== 'idle'; i++) {
      await h.clock.advanceAsync(1);
      note();
    }
    expect(presses(h)).toEqual([
      press(KeycodeMap.Lang2),
      press(KeycodeMap.Lang1),
      ...imeUnit('3042'),
      ...imeUnit('3044'),
      ...imeUnit('3046'),
      press(KeycodeMap.Lang2)
    ]);
    const down = h.sink.reports.flatMap((report, i) => (report[2] !== 0 ? [i] : []));
    const times = down.map((i) => stamps[i]);
    const holds = down.map((i) => stamps[i + 1] - stamps[i]);
    // with every stroke 20 ms apart the second unit had F5 at 490, its commit at 510 and the next
    // digit at 530: on the target that digit was lost after a focus change (あい０４６ arrived).
    // Keys 40 ms apart but held only 10 ms still lost one on a slow destination: so Fast sends
    // the timeline of Normal
    expect(times).toEqual([
      ...[0, 190],
      ...[230, 270, 310, 350, 390, 530],
      ...[570, 610, 650, 690, 730, 770],
      ...[810, 850, 890, 930, 970, 1010],
      1050
    ]);
    // every key is held for 20 ms, not for the 10 ms of Fast
    expect(new Set(holds)).toEqual(new Set([20]));
    expect(h.run()).toMatchObject({ status: 'done', reason: 'completed', done: 21 });
  });

  it('IME code input: a cancel inside a character still sends its F5 and commit, then stops before LANG2', async () => {
    for (const interrupt of ['cancel', 'keydown'] as const) {
      const h = makeHarness({
        clipboard: 'あい',
        targetOs: 'windows',
        settings: { unicodeMethod: 'ime-code' }
      });
      await h.controller.startFromRow();
      // until the first digit of あ is down: its unit (digits, F5, commit) is open
      await untilPressed(h, KeycodeMap.Digit3, 1);
      if (interrupt === 'cancel') h.controller.cancel();
      else keydown(h.target, 'KeyQ');
      expect(h.engine.state, interrupt).toBe('running');
      await settle(h);

      expect(presses(h), interrupt).toEqual([
        press(KeycodeMap.Lang2),
        press(KeycodeMap.Lang1),
        ...imeUnit('3042')
      ]);
      // あ is committed, い is not started, and the closing LANG2 is not sent: the target IME stays on
      expect(h.run(), interrupt).toMatchObject({
        status: 'done',
        reason: interrupt === 'cancel' ? 'cancelled' : 'key-interrupt',
        done: 8,
        total: 15
      });
    }
  });

  it('IME code input: a cancel during the last character finishes the run: closing LANG2 sent, completed', async () => {
    // nothing but the IME-off key is left after that character: the whole text is on the target
    for (const interrupt of ['cancel', 'keydown'] as const) {
      const h = makeHarness({
        clipboard: 'あい',
        targetOs: 'windows',
        settings: { unicodeMethod: 'ime-code' }
      });
      await h.controller.startFromRow();
      // until the first digit of い, the last character, is down
      await untilPressed(h, KeycodeMap.Digit3, 2);
      if (interrupt === 'cancel') h.controller.cancel();
      else keydown(h.target, 'KeyQ');
      expect(h.engine.state, interrupt).toBe('running');
      await settle(h);

      expect(presses(h), interrupt).toEqual([
        press(KeycodeMap.Lang2),
        press(KeycodeMap.Lang1),
        ...imeUnit('3042'),
        ...imeUnit('3044'),
        // the target IME is off again
        press(KeycodeMap.Lang2)
      ]);
      expect(h.sink.reports[h.sink.reports.length - 1], interrupt).toEqual(ZERO);
      // completed, but marked: the dictation bar must not send its next chunk after this run
      expect(h.run(), interrupt).toMatchObject({
        status: 'done',
        reason: 'completed',
        done: 15,
        total: 15,
        stopRequested: true
      });
      expect(queueMayContinue(h.run()), interrupt).toBe(false);
      expect(h.lock.isLocked(), interrupt).toBe(false);
    }
  });

  it('IME code input: a cancel inside a plane-3 character waits for both of its surrogate units', async () => {
    // U+30EDE is entered as d883 and dede, each with its own F5 and commit: a stop between the
    // two would leave a lone high surrogate in the field
    for (const interrupt of ['cancel', 'keydown'] as const) {
      const h = makeHarness({
        clipboard: 'a\u{30ede}b',
        targetOs: 'windows',
        settings: { unicodeMethod: 'ime-code' }
      });
      await h.controller.startFromRow();
      // until the first digit of the first unit (d) is down
      await untilPressed(h, KeycodeMap.KeyD, 1);
      if (interrupt === 'cancel') h.controller.cancel();
      else keydown(h.target, 'KeyQ');
      expect(h.engine.state, interrupt).toBe('running');
      await settle(h);

      expect(presses(h), interrupt).toEqual([
        press(KeycodeMap.Lang2),
        press(KeycodeMap.KeyA),
        press(KeycodeMap.Lang1),
        ...imeUnit('d883'),
        ...imeUnit('dede')
      ]);
      expect(h.run(), interrupt).toMatchObject({
        status: 'done',
        reason: interrupt === 'cancel' ? 'cancelled' : 'key-interrupt',
        done: 15,
        total: 17
      });
    }
  });

  it('IME code input: a click or a hidden tab inside a character stops at once, in the middle of its unit', async () => {
    const stops = [
      ['pointerdown', 'mouse-interrupt'],
      ['pagehide', 'tab-hidden']
    ] as const;
    for (const [type, reason] of stops) {
      const h = makeHarness({
        clipboard: 'あい',
        targetOs: 'windows',
        settings: { unicodeMethod: 'ime-code' }
      });
      await h.controller.startFromRow();
      await untilPressed(h, KeycodeMap.Digit3, 1);
      h.target.dispatchEvent(new Event(type));
      await settle(h);

      // a click reaches the target, so nothing may follow it: not the rest of the unit (its F5
      // would arrive wherever the click put the focus) and not the closing LANG2
      expect(presses(h), type).toEqual([
        press(KeycodeMap.Lang2),
        press(KeycodeMap.Lang1),
        press(KeycodeMap.Digit3)
      ]);
      expect(h.sink.reports[h.sink.reports.length - 1], type).toEqual(ZERO);
      expect(h.run(), type).toMatchObject({ status: 'done', reason, done: 2, total: 15 });
    }
  });

  it('IME code input never presses the Tab key in a text that goes by code input', async () => {
    const h = makeHarness({
      clipboard: '列1\t列2',
      targetOs: 'windows',
      settings: { unicodeMethod: 'ime-code' }
    });
    await h.controller.startFromRow();
    await settle(h);
    expect(presses(h)).toEqual([
      press(KeycodeMap.Lang2),
      press(KeycodeMap.Lang1),
      ...imeUnit('5217'),
      press(KeycodeMap.Lang2),
      press(KeycodeMap.Digit1),
      press(KeycodeMap.Lang1),
      // the tab character by its code: the focus stays in the field for the F5 that follows
      ...imeUnit('0009'),
      ...imeUnit('5217'),
      press(KeycodeMap.Lang2),
      press(KeycodeMap.Digit2)
    ]);
    expect(h.sink.reports.some((report) => report[2] === KeycodeMap.Tab)).toBe(false);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'completed', method: 'unicode' });
  });

  it('IME code input: an ASCII-only text starts with LANG2 as well, whatever the IME pre-key setting', async () => {
    const typed = async (unicodeMethod: string, imePreKey: string) => {
      const h = makeHarness({
        clipboard: 'a\tb',
        targetOs: 'windows',
        settings: { version: 2, unicodeMethod, imePreKey }
      });
      await expect(h.controller.startFromRow()).resolves.toBe('started');
      expect(h.run().method, unicodeMethod).toBe('direct');
      await settle(h);
      expect(h.run().reason, unicodeMethod).toBe('completed');
      return presses(h);
    };
    const text = [press(KeycodeMap.KeyA), press(KeycodeMap.Tab), press(KeycodeMap.KeyB)];
    // "Don't send": the method that can leave the IME on turns it off anyway
    expect(await typed('ime-code', 'none')).toEqual([press(KeycodeMap.Lang2), ...text]);
    expect(await typed('ime-code', 'NonConvert')).toEqual([press(KeycodeMap.Lang2), ...text]);
    expect(await typed('ime-code', 'auto')).toEqual([press(KeycodeMap.Lang2), ...text]);
    // the other methods do what the setting says
    for (const unicodeMethod of ['auto', 'bridge', 'ctrl-shift-u', 'alt-hex', 'skip']) {
      expect(await typed(unicodeMethod, 'none'), unicodeMethod).toEqual(text);
      expect(await typed(unicodeMethod, 'NonConvert'), unicodeMethod).toEqual([
        press(KeycodeMap.NonConvert),
        ...text
      ]);
    }
  });

  it('resolves the method from the setting and the target OS', async () => {
    const start = async (options: HarnessOptions) => {
      const h = makeHarness({ clipboard: 'aあ', ...options });
      await expect(h.controller.startFromRow()).resolves.toBe('started');
      const { method, skipped } = h.run();
      const first = await firstPress(h);
      h.controller.cancel();
      await settle(h);
      return { method, skipped, first };
    };
    const openWindow = press(KeycodeMap.KeyN, CTRL | SHIFT);
    const skippedA = [{ char: 'あ', count: 1 }];

    // auto: the bridge on Windows, Ctrl+Shift+U on Linux, v1 skipping on macOS
    expect(await start({ targetOs: 'windows' })).toEqual({
      method: 'bridge',
      skipped: [],
      first: openWindow
    });
    expect(await start({ targetOs: 'linux' })).toMatchObject({ method: 'unicode', skipped: [] });
    expect(await start({ targetOs: 'macos' })).toEqual({
      method: 'direct',
      skipped: skippedA,
      first: press(KeycodeMap.KeyA)
    });
    // explicit choices; both Unicode methods use Ctrl chords, which a macOS target ignores
    const explicit = (targetOs: TargetOs, unicodeMethod: string) =>
      start({ targetOs, settings: { unicodeMethod } });
    expect(await explicit('linux', 'bridge')).toMatchObject({
      method: 'bridge',
      first: openWindow
    });
    expect(await explicit('windows', 'ctrl-shift-u')).toMatchObject({
      method: 'unicode',
      first: press(KeycodeMap.Lang2)
    });
    expect(await explicit('windows', 'skip')).toEqual({
      method: 'direct',
      skipped: skippedA,
      first: press(KeycodeMap.Lang2)
    });
    expect(await explicit('macos', 'bridge')).toMatchObject({
      method: 'direct',
      skipped: skippedA
    });
    // the Windows methods that open no window are explicit choices as well
    for (const unicodeMethod of ['ime-code', 'alt-hex']) {
      expect(await explicit('windows', unicodeMethod)).toEqual({
        method: 'unicode',
        skipped: [],
        first: press(KeycodeMap.Lang2)
      });
      expect(await explicit('macos', unicodeMethod)).toMatchObject({
        method: 'direct',
        skipped: skippedA
      });
    }
  });

  it('without video the bridge is refused: a notice, no dialog, nothing sent', async () => {
    const h = makeHarness({ clipboard: 'あ', targetOs: 'windows', video: false });
    await expect(h.controller.startFromRow()).resolves.toBe('noVideo');
    expect(h.notices).toEqual([{ notice: 'noVideo', params: undefined }]);
    expect(h.bridgeConfirms).toEqual([]);
    expect(h.getLockState).not.toHaveBeenCalled();
    expect(h.sink.reports).toEqual([]);
    expect(h.lock.isLocked()).toBe(false);
    expect(h.run()).toEqual(IDLE_PASTE_RUN);

    // the other paths do not need the video
    await expect(h.controller.startFromText('abc')).resolves.toBe('started');
    await settle(h);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'completed', method: 'direct' });
  });

  it('explains the bridge with its ETA before the first run only; declining sends nothing', async () => {
    const h = makeHarness({ clipboard: 'あ', targetOs: 'windows' });
    const seconds = bridgeSeconds('あ', h.sampler);

    h.setBridgeAnswer(false);
    await expect(h.controller.startFromRow()).resolves.toBe('declined');
    expect(h.bridgeConfirms).toEqual([seconds]);
    expect(h.introAccepted()).toBe(false);
    expect(h.sink.reports).toEqual([]);
    expect(h.lock.isLocked()).toBe(false);

    h.setBridgeAnswer(true);
    await expect(h.controller.startFromRow()).resolves.toBe('started');
    expect(h.introAccepted()).toBe(true);
    h.controller.cancel();
    await settle(h);

    await expect(h.controller.startFromRow()).resolves.toBe('started');
    expect(h.bridgeConfirms).toEqual([seconds, seconds]);
  });

  it('a large bridge paste explains the bridge, then confirms the size, both with the program ETA', async () => {
    const text = 'あ'.repeat(PASTE_SOFT_LIMIT + 1);
    const h = makeHarness({ clipboard: text, targetOs: 'windows' });
    h.setConfirmAnswer(false);
    await expect(h.controller.startFromRow()).resolves.toBe('declined');

    const seconds = bridgeSeconds(text, h.sampler);
    expect(h.bridgeConfirms).toEqual([seconds]);
    expect(h.confirms).toEqual([[PASTE_SOFT_LIMIT + 1, seconds]]);
    expect(h.sink.reports).toEqual([]);
  });

  it('a bridge that sees no new window stops before any URL is typed', async () => {
    const h = makeHarness({
      clipboard: 'あ',
      targetOs: 'windows',
      browser: { opensWindow: false },
      introAccepted: true
    });
    await h.controller.startFromRow();
    await settle(h);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'bridge-no-window', method: 'bridge' });
    expect(h.sink.reports).toEqual([ZERO, press(KeycodeMap.KeyN, CTRL | SHIFT), ZERO, ZERO]);
    expect(h.browser.loads).toEqual([]);
  });

  it('types the probe page before the payload on every run (spec v2 §14.1)', async () => {
    const h = makeHarness({ clipboard: 'あ', targetOs: 'windows', introAccepted: true });
    const paste = async () => {
      h.store.set(pasteSettingsAtom, { version: 2, speed: 'fast' });
      await expect(h.controller.startFromRow()).resolves.toBe('started');
      await settle(h);
      return h.run().reason;
    };
    const payload = buildBridgeUrl('あ');

    expect(await paste()).toBe('completed');
    expect(await paste()).toBe('completed');
    expect(h.browser.loads).toEqual([BRIDGE_PROBE_URL, payload, BRIDGE_PROBE_URL, payload]);

    // a failed probe stops before the payload; the next run probes again
    h.browser.script = { ...WORKING_BROWSER, loadsProbe: false };
    expect(await paste()).toBe('bridge-probe-failed');
    h.browser.shown = 'desktop';
    h.browser.script = WORKING_BROWSER;
    expect(await paste()).toBe('completed');
    expect(h.browser.loads.slice(4)).toEqual([BRIDGE_PROBE_URL, BRIDGE_PROBE_URL, payload]);
  });

  it('re-checks the video right before the run: a capture lost meanwhile sends nothing', async () => {
    const h = makeHarness({ clipboard: 'あ', targetOs: 'windows', introAccepted: true });
    // the lock-state query is the last asynchronous step before the launch
    h.getLockState.mockImplementation(() => {
      h.setVideo(false);
      return Promise.resolve(null);
    });
    await expect(h.controller.startFromRow()).resolves.toBe('noVideo');
    expect(h.getLockState).toHaveBeenCalledTimes(1);
    expect(h.notices).toEqual([{ notice: 'noVideo', params: undefined }]);
    expect(h.sink.reports).toEqual([]);
    expect(h.lock.isLocked()).toBe(false);
    expect(h.run()).toEqual(IDLE_PASTE_RUN);

    // the other paths do not need the video
    h.getLockState.mockResolvedValue(null);
    await expect(h.controller.startFromText('abc')).resolves.toBe('started');
    await settle(h);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'completed', method: 'direct' });
  });

  it('a page that never reports the copy stops before Ctrl+W and Ctrl+V', async () => {
    const h = makeHarness({
      clipboard: 'あ',
      targetOs: 'windows',
      browser: { copies: false },
      introAccepted: true
    });
    await h.controller.startFromRow();
    await settle(h);
    expect(h.run()).toMatchObject({
      status: 'done',
      reason: 'bridge-copy-failed',
      method: 'bridge'
    });
    const presses = h.sink.reports.filter((report) => report[2] !== 0);
    expect(presses.slice(-1)).toEqual([press(KeycodeMap.KeyC, CTRL)]);
    expect(h.browser.shown).toBe('lime');
  });

  it('turns Caps Lock off first: Shift+CapsLock on JIS, a bare CapsLock on US', async () => {
    for (const [layout, mod] of [
      ['jis', SHIFT],
      ['us', 0]
    ] as const) {
      const h = makeHarness({ clipboard: 'a', layout, lockStates: [CAPS_ON, CAPS_ON, CAPS_OFF] });
      await expect(h.controller.startFromRow()).resolves.toBe('started');
      await settle(h);
      expect(h.sink.reports).toEqual([
        ZERO,
        press(KeycodeMap.CapsLock, mod),
        ZERO,
        press(KeycodeMap.KeyA),
        ZERO,
        ZERO
      ]);
      // the query before the run, then polls until the device reports Caps Lock off
      expect(h.getLockState).toHaveBeenCalledTimes(3);
      expect(h.run()).toMatchObject({ status: 'done', reason: 'completed', done: 2, total: 2 });
    }
  });

  it('runs the Caps Lock pre-flight before the bridge as well', async () => {
    const h = makeHarness({
      clipboard: 'あ',
      targetOs: 'windows',
      layout: 'jis',
      lockStates: [CAPS_ON, CAPS_OFF],
      settings: { speed: 'fast' },
      introAccepted: true
    });
    await h.controller.startFromRow();
    await settle(h);
    expect(h.sink.reports.filter((report) => report[2] !== 0).slice(0, 2)).toEqual([
      press(KeycodeMap.CapsLock, SHIFT),
      press(KeycodeMap.KeyN, CTRL | SHIFT)
    ]);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'completed', method: 'bridge' });
  });

  it('stops with caps-lock when Caps Lock is still on after the timeout; nothing else is typed', async () => {
    const h = makeHarness({ clipboard: 'abc', lockStates: [CAPS_ON] });
    await h.controller.startFromRow();
    await flushMicrotasks();
    await h.clock.advanceAsync(CAPS_LOCK_TIMEOUT_MS - 100);
    expect(h.run().status).toBe('running');
    await h.clock.advanceAsync(200);
    expect(h.run()).toMatchObject({ status: 'done', reason: 'caps-lock', done: 1, total: 4 });
    expect(h.sink.reports).toEqual([ZERO, press(KeycodeMap.CapsLock), ZERO, ZERO]);
  });

  it('no pre-flight when the lock state is unknown, the query fails or the setting is off', async () => {
    const plain = [ZERO, press(KeycodeMap.KeyA), ZERO, ZERO];

    const unknown = makeHarness({ clipboard: 'a', lockStates: [null] });
    await unknown.controller.startFromRow();
    await settle(unknown);
    expect(unknown.sink.reports).toEqual(plain);
    expect(unknown.getLockState).toHaveBeenCalledTimes(1);

    const failing = makeHarness({ clipboard: 'a', lockStates: [CAPS_ON] });
    failing.getLockState.mockRejectedValueOnce(new Error('no reply'));
    await expect(failing.controller.startFromRow()).resolves.toBe('started');
    await settle(failing);
    expect(failing.sink.reports).toEqual(plain);

    const off = makeHarness({
      clipboard: 'a',
      lockStates: [CAPS_ON],
      settings: { fixCapsLock: false }
    });
    await off.controller.startFromRow();
    await settle(off);
    expect(off.sink.reports).toEqual(plain);
    expect(off.getLockState).not.toHaveBeenCalled();
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
