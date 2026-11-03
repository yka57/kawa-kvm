import { atom, getDefaultStore, type createStore } from 'jotai';

import { getKeyboardDriver } from '@/components/keyboard/driver-registry';
import { serialStateAtom } from '@/jotai/device.ts';
import {
  IDLE_PASTE_RUN,
  pasteRunAtom,
  pasteSettingsAtom,
  type PasteMethod,
  type PasteRunState
} from '@/jotai/paste.ts';
import { targetLayoutAtom, targetOsAtom, type TargetOs } from '@/jotai/target.ts';
import { getOperatingSystem, type System } from '@/libs/browser';
import { realClock } from '@/libs/clock';
import { device, type LockState } from '@/libs/device';
import type { KeyboardDriver } from '@/libs/keyboard/driver';
import { hidLock, type HidLock } from '@/libs/keyboard/hid-lock';
import { createVideoSampler, type FrameSampler } from '@/libs/media/frame-probe';
import { buildBridgeProgram, buildBridgeUrl } from '@/libs/paste/bridge';
import { buildCapsLockPreflight } from '@/libs/paste/caps-lock';
import { planPaste } from '@/libs/paste/plan';
import {
  normalisePasteSettings,
  resolveImePreKey,
  resolveUnicodeMethod,
  type BridgeWindow
} from '@/libs/paste/settings';
import { PASTE_HARD_LIMIT } from '@/libs/paste/text-to-keys';
import type { ImePreKey, SkippedChar, TargetLayout } from '@/libs/paste/types';
import {
  estimateProgramMs,
  PACING,
  TypingEngine,
  type EngineEvent,
  type Pacing,
  type ProgramStep,
  type StopReason
} from '@/libs/paste/typing-engine';
import * as storage from '@/libs/storage';

import {
  classifyClipboardError,
  decideStart,
  summarizeSkipped,
  type SkippedSummary
} from './decide.ts';

/**
 * Paste controller (spec v1 §5.4, v2 §9): one path for the menu row, the
 * ⌘⇧V hotkey and the manual text box. Plans the text (v1 keystrokes,
 * Ctrl+Shift+U or the browser bridge), asks what has to be asked and runs
 * the result as one typing-engine program. Reads the jotai store directly so
 * the hotkey (which arrives from the keyboard driver, outside React) shares
 * it. No React or antd here: toasts and dialogs go through a UI bridge
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

export type PasteNotice =
  'notConnected' | 'noFocus' | 'empty' | 'nothingTypeable' | 'truncated' | 'noVideo';

/** Implemented by the mounted React side (toasts, the large-paste confirm, the bridge intro). */
export interface PasteUi {
  notify(notice: PasteNotice, params?: Record<string, string | number>): void;
  confirmLarge(count: number, seconds: number): Promise<boolean>;
  /** The one-time explanation before the first bridge run; true when accepted. */
  confirmBridge(seconds: number): Promise<boolean>;
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
  /** The target screen the bridge watches; prod: the capture video (spec v2 §7). */
  sampler: FrameSampler;
  /** The target's keyboard LEDs, null when unknown; prod: device.getLockState() (spec v2 §8.3). */
  getLockState(): Promise<LockState | null>;
  /** prod: storage, `nanokvm-usb-paste-bridge-intro` */
  isBridgeIntroAccepted(): boolean;
  acceptBridgeIntro(): void;
}

export type StartOutcome =
  | 'started'
  | 'cancelled'
  | 'busy'
  | 'notConnected'
  | 'clipboard'
  | 'nothing'
  | 'declined'
  | 'noVideo';

interface BridgeTarget {
  layout: TargetLayout;
  imeOff: ImePreKey;
  window: BridgeWindow;
  targetOs: TargetOs;
}

/** The ETA a dialog shows, in whole seconds. */
function etaSeconds(steps: readonly ProgramStep[], pacing: Pacing): number {
  return Math.ceil(estimateProgramMs(steps, pacing) / 1000);
}

export class PasteController {
  private ui: PasteUi | null = null;
  private engine: TypingEngine | null = null;
  /** True between a trigger and the run start (clipboard read, dialogs, lock-state query). */
  private pending = false;
  /** The user asked for the stop (row, pill or hotkey), whatever interrupt the engine saw first. */
  private explicitCancel = false;
  private skipped: SkippedSummary[] = [];
  private method: PasteMethod = 'direct';
  /**
   * Probe-cache key of the last successful probe page (spec v2 §9.3): in
   * memory only, so a page reload probes again.
   */
  private probedKey: string | null = null;

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
      const layout = store.get(targetLayoutAtom);
      const targetOs = store.get(targetOsAtom);
      const imePreKey = resolveImePreKey(settings.imePreKey, targetOs);
      const plan = planPaste(source, {
        layout,
        newline: settings.newline,
        normalizePunct: settings.normalizePunct,
        stripTrailingNewline: settings.stripTrailingNewline,
        imePreKey,
        method: resolveUnicodeMethod(settings.unicodeMethod, targetOs),
        maxChars: PASTE_HARD_LIMIT
      });
      const { stats, skipped } = plan.kind === 'bridge' ? plan : plan.compiled;
      const pacing = PACING[settings.speed];

      // the clipboard read was asynchronous: serial may have dropped meanwhile
      const decision = decideStart({ stats }, store.get(serialStateAtom));
      if (decision === 'notConnected') {
        this.notify('notConnected');
        return 'notConnected';
      }
      if (decision === 'nothing') {
        this.notify('nothingTypeable');
        return 'nothing';
      }

      let steps: ProgramStep[];
      if (plan.kind === 'bridge') {
        // the bridge sees the target window and its check page only through the video
        if (!this.deps.sampler.available()) {
          this.notify('noVideo');
          return 'noVideo';
        }
        steps = this.bridgeProgram(plan.text, {
          layout,
          imeOff: imePreKey,
          window: settings.bridgeWindow,
          targetOs
        });
        if (!this.deps.isBridgeIntroAccepted()) {
          const accepted = await this.confirmBridge(etaSeconds(steps, pacing));
          if (!accepted) return 'declined';
          this.deps.acceptBridgeIntro();
        }
      } else {
        steps = [{ kind: 'keys', strokes: plan.compiled.strokes }];
      }

      if (stats.truncated) {
        this.notify('truncated', { max: PASTE_HARD_LIMIT });
      }
      if (decision === 'confirm') {
        const confirmed = await this.confirmLarge(stats.chars, etaSeconds(steps, pacing));
        if (!confirmed) return 'declined';
      }
      if (settings.fixCapsLock) {
        steps = [...(await this.capsLockPreflight(layout)), ...steps];
      }
      // dialogs and the lock-state query are asynchronous as well
      if (store.get(serialStateAtom) !== 'connected') {
        this.notify('notConnected');
        return 'notConnected';
      }

      return this.launch(steps, pacing, plan.kind, skipped);
    } finally {
      this.pending = false;
    }
  }

  /**
   * The bridge program (spec v2 §4.2). Its probe page runs until a probe
   * succeeded for this layout, window, IME-off key and target OS (§9.3).
   */
  private bridgeProgram(text: string, target: BridgeTarget): ProgramStep[] {
    const probeKey = [target.layout, target.window, target.imeOff, target.targetOs].join('|');
    return buildBridgeProgram(buildBridgeUrl(text), {
      sampler: this.deps.sampler,
      layout: target.layout,
      imeOff: target.imeOff,
      window: target.window,
      probe: probeKey !== this.probedKey,
      onProbeOk: () => {
        this.probedKey = probeKey;
      }
    });
  }

  /**
   * Caps Lock pre-flight (spec v2 §8.3), on every path: a toggle and a wait
   * when the device reports Caps Lock on; nothing when the state is unknown.
   */
  private async capsLockPreflight(layout: TargetLayout): Promise<ProgramStep[]> {
    const getLockState = () => this.deps.getLockState();
    const state = await getLockState().catch(() => null);
    return state?.caps === true ? buildCapsLockPreflight(layout, getLockState) : [];
  }

  private launch(
    steps: ProgramStep[],
    pacing: Pacing,
    method: PasteMethod,
    skipped: readonly SkippedChar[]
  ): StartOutcome {
    const engine = this.ensureEngine();
    if (engine.state !== 'idle' || this.deps.lock.isLocked()) return 'busy';

    this.skipped = summarizeSkipped(skipped);
    this.method = method;
    this.explicitCancel = false;
    // 'start' is emitted synchronously inside runProgram(); the result arrives through the 'stop' event
    engine.runProgram(steps, pacing).then(
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
        skipped: this.skipped,
        method: this.method
      };
      if (event.phase !== undefined) state.phase = event.phase;
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
      skipped: this.skipped,
      method: this.method
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

  private confirmBridge(seconds: number): Promise<boolean> {
    if (!this.ui) {
      console.warn('[paste] no UI mounted to explain the browser bridge');
      return Promise.resolve(false);
    }
    return this.ui.confirmBridge(seconds);
  }
}

export const pasteController = new PasteController({
  store: getDefaultStore(),
  getEngine: getTypingEngine,
  lock: hidLock,
  readClipboard: () => navigator.clipboard.readText(),
  hostOS: getOperatingSystem(),
  getDriver: getKeyboardDriver,
  sampler: createVideoSampler(() => document.getElementById('video') as HTMLVideoElement | null),
  getLockState: () => device.getLockState(),
  isBridgeIntroAccepted: () => storage.getPasteBridgeIntroAccepted(),
  acceptBridgeIntro: () => storage.setPasteBridgeIntroAccepted(true)
});
