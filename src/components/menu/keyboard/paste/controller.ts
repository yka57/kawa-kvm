import { atom, getDefaultStore, type createStore } from 'jotai';

import { getKeyboardDriver } from '@/components/keyboard/driver-registry';
import { serialStateAtom } from '@/jotai/device.ts';
import {
  IDLE_PASTE_RUN,
  pasteRunAtom,
  pasteSettingsAtom,
  type PasteRunState
} from '@/jotai/paste.ts';
import { targetLayoutAtom } from '@/jotai/target.ts';
import { getOperatingSystem, type System } from '@/libs/browser';
import { realClock } from '@/libs/clock';
import { device } from '@/libs/device';
import type { KeyboardDriver } from '@/libs/keyboard/driver';
import { hidLock, type HidLock } from '@/libs/keyboard/hid-lock';
import { normalisePasteSettings } from '@/libs/paste/settings';
import { PASTE_HARD_LIMIT, textToKeySequence } from '@/libs/paste/text-to-keys';
import type { CompileResult } from '@/libs/paste/types';
import {
  PACING,
  TypingEngine,
  type EngineEvent,
  type Pacing,
  type StopReason
} from '@/libs/paste/typing-engine';

import {
  classifyClipboardError,
  decideStart,
  estimateRunMs,
  summarizeSkipped,
  type SkippedSummary
} from './decide.ts';

/**
 * Paste controller (spec §5.4): one path for the menu row, the ⌘⇧V hotkey
 * and the manual text box. Reads the jotai store directly so the hotkey
 * (which arrives from the keyboard driver, outside React) shares it. No
 * React or antd here: toasts and the confirm dialog go through a UI bridge
 * registered by the progress pill.
 */

export type Store = ReturnType<typeof createStore>;

/** Attribute marking the paste UI; host events inside it never interrupt a run. */
export const PASTE_UI_ATTR = 'data-paste-ui';

/** `isInsideOwnUi` of the typing engine: walks up to a `data-paste-ui` ancestor. */
export function isInsideOwnUi(target: EventTarget | null): boolean {
  const node = target as Node | null;
  if (!node || typeof node.nodeType !== 'number') return false;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return Boolean(element?.closest(`[${PASTE_UI_ATTR}]`));
}

let engine: TypingEngine | null = null;

/** The app-wide typing engine, created on first use (its interrupt target is `window`). */
export function getTypingEngine(): TypingEngine {
  if (engine === null) {
    engine = new TypingEngine({
      send: (report) => device.sendKeyboardData(report),
      lock: hidLock,
      clock: realClock,
      interruptTarget: window,
      isInsideOwnUi
    });
  }
  return engine;
}

export interface PasteSettingsModalState {
  open: boolean;
  /** Clipboard access was blocked: show the hint above the manual text box. */
  permDenied?: boolean;
}

export const pasteSettingsModalAtom = atom<PasteSettingsModalState>({ open: false });

export type PasteNotice = 'notConnected' | 'noFocus' | 'empty' | 'nothingTypeable' | 'truncated';

/** Implemented by the mounted React side (toasts + the large-paste confirm). */
export interface PasteUi {
  notify(notice: PasteNotice, params?: Record<string, string | number>): void;
  confirmLarge(count: number, seconds: number): Promise<boolean>;
}

export type DriverLike = Pick<KeyboardDriver, 'lastReport' | 'isMuted' | 'isDryRun' | 'setMuted'>;

export interface PasteControllerDeps {
  store: Store;
  getEngine(): TypingEngine;
  lock: HidLock;
  /** prod: navigator.clipboard.readText() */
  readClipboard(): Promise<string>;
  hostOS: System;
  /** The mounted physical-keyboard driver, if any (resync after an early stop). */
  getDriver(): DriverLike | null;
}

export type StartOutcome =
  'started' | 'cancelled' | 'busy' | 'notConnected' | 'clipboard' | 'nothing' | 'declined';

export class PasteController {
  private ui: PasteUi | null = null;
  private engine: TypingEngine | null = null;
  /** True between a trigger and the run start (clipboard read, confirm dialog). */
  private pending = false;
  /** The user asked for the stop (row, pill or hotkey), whatever interrupt the engine saw first. */
  private explicitCancel = false;
  private skipped: SkippedSummary[] = [];

  constructor(private readonly deps: PasteControllerDeps) {}

  /** Registers the React side; returns the unregister function. */
  setUi(ui: PasteUi): () => void {
    this.ui = ui;
    return () => {
      if (this.ui === ui) this.ui = null;
    };
  }

  /** Running or still sending its final report. */
  isBusy(): boolean {
    return this.engine !== null && this.engine.state !== 'idle';
  }

  startFromRow(): Promise<StartOutcome> {
    return this.guarded(this.start(null));
  }

  startFromHotkey(): Promise<StartOutcome> {
    return this.guarded(this.start(null));
  }

  /** Manual fallback: the text box of the settings modal. */
  startFromText(text: string): Promise<StartOutcome> {
    return this.guarded(this.start(text));
  }

  /** Stops the current run; 'cancelled' marks a user request (shown as such even after a key/mouse interrupt). */
  cancel(reason: StopReason = 'cancelled'): void {
    if (!this.isBusy()) return;
    if (reason === 'cancelled') this.explicitCancel = true;
    this.engine?.cancel(reason);
  }

  openSettings(options: { permDenied?: boolean } = {}): void {
    this.deps.store.set(pasteSettingsModalAtom, {
      open: true,
      permDenied: options.permDenied === true
    });
  }

  closeSettings(): void {
    this.deps.store.set(pasteSettingsModalAtom, { open: false });
  }

  /** Clears the finished-run state (pill closed or auto-hidden). */
  dismissResult(): void {
    if (this.isBusy()) return;
    this.deps.store.set(pasteRunAtom, IDLE_PASTE_RUN);
  }

  /** Callers are DOM handlers that do not await: unexpected failures are logged, never unhandled. */
  private guarded(outcome: Promise<StartOutcome>): Promise<StartOutcome> {
    return outcome.catch((error: unknown) => {
      console.error('[paste] start failed', error);
      return 'busy';
    });
  }

  private async start(text: string | null): Promise<StartOutcome> {
    if (this.isBusy()) {
      this.cancel('cancelled');
      return 'cancelled';
    }
    if (this.pending) return 'busy';

    const { store } = this.deps;
    if (store.get(serialStateAtom) !== 'connected') {
      this.notify('notConnected');
      return 'notConnected';
    }

    this.pending = true;
    try {
      let source = text;
      if (source === null) {
        try {
          source = await this.deps.readClipboard();
        } catch (error) {
          const failure = classifyClipboardError(error);
          if (failure === 'permDenied') {
            console.warn('[paste] clipboard read blocked', error);
            this.openSettings({ permDenied: true });
          } else {
            this.notify(failure);
          }
          return 'clipboard';
        }
      }
      if (source.length === 0) {
        this.notify('empty');
        return 'clipboard';
      }

      const settings = normalisePasteSettings(store.get(pasteSettingsAtom), this.deps.hostOS);
      const compiled = textToKeySequence(source, {
        layout: store.get(targetLayoutAtom),
        newline: settings.newline,
        normalizePunct: settings.normalizePunct,
        stripTrailingNewline: settings.stripTrailingNewline,
        imePreKey: settings.imePreKey,
        maxChars: PASTE_HARD_LIMIT
      });
      const pacing = PACING[settings.speed];

      // the clipboard read was asynchronous: serial may have dropped meanwhile
      const decision = decideStart(compiled, store.get(serialStateAtom));
      if (decision === 'notConnected') {
        this.notify('notConnected');
        return 'notConnected';
      }
      if (decision === 'nothing') {
        this.notify('nothingTypeable');
        return 'nothing';
      }
      if (compiled.stats.truncated) {
        this.notify('truncated', { max: PASTE_HARD_LIMIT });
      }
      if (decision === 'confirm') {
        const seconds = Math.ceil(estimateRunMs(compiled, pacing) / 1000);
        const confirmed = await this.confirmLarge(compiled.stats.chars, seconds);
        if (!confirmed) return 'declined';
        if (store.get(serialStateAtom) !== 'connected') {
          this.notify('notConnected');
          return 'notConnected';
        }
      }

      return this.launch(compiled, pacing);
    } finally {
      this.pending = false;
    }
  }

  private launch(compiled: CompileResult, pacing: Pacing): StartOutcome {
    const engine = this.ensureEngine();
    if (engine.state !== 'idle' || this.deps.lock.isLocked()) return 'busy';

    this.skipped = summarizeSkipped(compiled.skipped);
    this.explicitCancel = false;
    // 'start' is emitted synchronously inside run(); the result arrives through the 'stop' event
    engine.run(compiled, pacing).then(
      (result) => {
        if (result.reason === 'lock-busy') console.warn('[paste] HID lock busy, nothing typed');
      },
      (error: unknown) => {
        console.error('[paste] run failed', error);
      }
    );
    return 'started';
  }

  private ensureEngine(): TypingEngine {
    if (this.engine === null) {
      this.engine = this.deps.getEngine();
      this.engine.subscribe((event) => this.onEngineEvent(event));
    }
    return this.engine;
  }

  private onEngineEvent(event: EngineEvent): void {
    const { store } = this.deps;
    if (event.type === 'start' || event.type === 'progress') {
      const state: PasteRunState = {
        status: 'running',
        done: event.done,
        total: event.total,
        etaMs: event.etaMs,
        skipped: this.skipped
      };
      store.set(pasteRunAtom, state);
      return;
    }

    const reason = event.reason ?? 'completed';
    if (reason === 'lock-busy') return;
    const shown =
      this.explicitCancel && (reason === 'key-interrupt' || reason === 'mouse-interrupt')
        ? 'cancelled'
        : reason;
    store.set(pasteRunAtom, {
      status: 'done',
      done: event.done,
      total: event.total,
      etaMs: 0,
      reason: shown,
      skipped: this.skipped
    });
    if (reason !== 'completed') this.resyncDriver();
  }

  /**
   * An early stop releases the HID lock before the engine's final all-zero
   * report, so the driver's unmute resend is overwritten on the wire. Put a
   * chord the user still holds back once the run is over (spec §5.3).
   */
  private resyncDriver(): void {
    const driver = this.deps.getDriver();
    if (!driver || driver.isMuted() || driver.isDryRun()) return;
    if (driver.lastReport().every((byte) => byte === 0)) return;
    driver.setMuted(true);
    driver.setMuted(false);
  }

  private notify(notice: PasteNotice, params?: Record<string, string | number>): void {
    if (this.ui) {
      this.ui.notify(notice, params);
    } else {
      console.warn('[paste]', notice, params ?? '');
    }
  }

  private confirmLarge(count: number, seconds: number): Promise<boolean> {
    if (!this.ui) {
      console.warn('[paste] no UI mounted to confirm a large paste');
      return Promise.resolve(false);
    }
    return this.ui.confirmLarge(count, seconds);
  }
}

export const pasteController = new PasteController({
  store: getDefaultStore(),
  getEngine: getTypingEngine,
  lock: hidLock,
  readClipboard: () => navigator.clipboard.readText(),
  hostOS: getOperatingSystem(),
  getDriver: getKeyboardDriver
});
