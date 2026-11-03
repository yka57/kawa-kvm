import type { Clock, TimerHandle } from '@/libs/clock';
import type { HidInterruptReason, HidLock } from '@/libs/keyboard/hid-lock';
import { isModifier } from '@/libs/keyboard/keymap';
import type { CompileResult, KeyStroke } from '@/libs/paste/types';

/**
 * Typing engine (spec §5.2): replays a CompileResult as press/release HID
 * reports with fixed pacing, owns the HID lock while running and stops on
 * host activity. Everything impure (serial sink, clock, EventTarget) is
 * injected, so it runs under vitest in node with fakes.
 */

export type SpeedPreset = 'safe' | 'normal';

export interface Pacing {
  holdMs: number;
  gapMs: number;
  afterEnterMs: number;
}

export const PACING: Record<SpeedPreset, Pacing> = {
  safe: { holdMs: 50, gapMs: 50, afterEnterMs: 150 },
  normal: { holdMs: 20, gapMs: 20, afterEnterMs: 100 }
};

export type StopReason =
  | 'completed'
  | 'cancelled'
  | 'key-interrupt'
  | 'mouse-interrupt'
  | 'tab-hidden'
  | 'serial-error'
  | 'lock-busy';

export type EngineState = 'idle' | 'running' | 'stopping';

export interface EngineDeps {
  /** Writes one 8-byte keyboard report (prod: device.sendKeyboardData). */
  send(report: number[]): Promise<void>;
  lock: HidLock;
  clock: Clock;
  /** Where interrupt listeners are installed in the capture phase (prod: window). */
  interruptTarget: EventTarget;
  /** True when an event target belongs to the paste UI (progress pill, settings modal). */
  isInsideOwnUi(target: EventTarget | null): boolean;
  /** A single `send` slower than this is a serial error (default 1000). */
  writeTimeoutMs?: number;
  /** Cancel when no report could be sent for this long (default 3000). */
  watchdogMs?: number;
}

export interface EngineEvent {
  type: 'start' | 'progress' | 'stop';
  done: number;
  total: number;
  etaMs: number;
  reason?: StopReason;
}

export type EngineListener = (event: EngineEvent) => void;

export interface EngineResult {
  reason: StopReason;
  typedStrokes: number;
  totalStrokes: number;
}

export const ZERO_REPORT: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0];
export const DEFAULT_WRITE_TIMEOUT_MS = 1000;
export const DEFAULT_WATCHDOG_MS = 3000;

const PROGRESS_MIN_INTERVAL_MS = 50;
const PROGRESS_EVERY_STROKES = 10;
const OWNER = 'paste';

export class WriteTimeoutError extends Error {
  constructor(ms: number) {
    super(`serial write timed out after ${ms} ms`);
    this.name = 'WriteTimeoutError';
  }
}

function strokeDurationMs(stroke: KeyStroke, pacing: Pacing): number {
  return pacing.holdMs + pacing.gapMs + (stroke.tag === 'enter' ? pacing.afterEnterMs : 0);
}

function pressReport(stroke: KeyStroke): number[] {
  return [stroke.mod, 0, stroke.key, 0, 0, 0, 0, 0];
}

/**
 * Keydown interrupt rule of spec §5.2, shared with the keyboard adapter's
 * HID-lock branch so both paths agree: a run stops on a non-modifier,
 * non-CapsLock keydown that is not host autorepeat (holding the ⌘⇧V chord
 * past the repeat delay must not cancel the paste it just started) and that
 * happens outside the paste UI, Escape excepted.
 */
export function isInterruptingKeyDown(
  key: { code: string; repeat: boolean; target: EventTarget | null },
  isInsideOwnUi: (target: EventTarget | null) => boolean
): boolean {
  if (key.repeat) return false;
  if (isModifier(key.code) || key.code === 'CapsLock') return false;
  if (key.code !== 'Escape' && isInsideOwnUi(key.target)) return false;
  return true;
}

/** `visibilitychange` targets the document; fall back to the global one. */
function readVisibility(event: Event): string | undefined {
  const target = event.target as unknown as { visibilityState?: unknown } | null;
  if (target && typeof target.visibilityState === 'string') return target.visibilityState;
  if (typeof document !== 'undefined') return document.visibilityState;
  return undefined;
}

export class TypingEngine {
  private _state: EngineState = 'idle';
  private readonly listeners = new Set<EngineListener>();
  private stopReason: StopReason | null = null;
  /** Aborts the wait currently in progress (a sleep or a guarded send). */
  private wake: (() => void) | null = null;
  private watchdog: TimerHandle | null = null;
  private readonly writeTimeoutMs: number;
  private readonly watchdogMs: number;

  constructor(private readonly deps: EngineDeps) {
    this.writeTimeoutMs = deps.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.watchdogMs = deps.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  }

  get state(): EngineState {
    return this._state;
  }

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Stops the current run. The HID lock is released synchronously so the
   * keyboard driver resumes at once; the pending sleep/send wait is aborted
   * and the run finishes with a best-effort ZERO report. First reason wins.
   */
  cancel(reason: StopReason = 'cancelled'): void {
    if (this._state !== 'running') return;
    this.stopReason = reason;
    this._state = 'stopping';
    this.deps.lock.release(OWNER);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /**
   * ARM (lock, interrupt listeners, ZERO) → one press + release per stroke
   * with hold/gap pacing → FINISH (ZERO, listeners off, lock released, stop).
   * Resolves 'lock-busy' without touching the wire when a run is in progress
   * or somebody else holds the lock.
   */
  async run(compiled: CompileResult, pacing: Pacing): Promise<EngineResult> {
    const total = compiled.strokes.length;
    if (this._state !== 'idle' || !this.deps.lock.acquire(OWNER)) {
      return { reason: 'lock-busy', typedStrokes: 0, totalStrokes: total };
    }
    this._state = 'running';
    this.stopReason = null;

    const { clock, lock } = this.deps;
    const durations = compiled.strokes.map((stroke) => strokeDurationMs(stroke, pacing));
    let etaMs = durations.reduce((sum, ms) => sum + ms, 0);
    let typed = 0;
    let lastProgressAt = clock.now();
    let lastProgressDone = 0;

    const removeInterrupts = this.installInterrupts();
    const removeLockHandler = lock.onInterrupt((reason) => this.onLockInterrupt(reason));
    this.emit({ type: 'start', done: 0, total, etaMs });

    try {
      this.kickWatchdog();
      await this.guardedSend([...ZERO_REPORT], true);
      for (let i = 0; i < total && this.stopReason === null; i++) {
        const stroke = compiled.strokes[i];
        await this.guardedSend(pressReport(stroke), true);
        if (this.stopReason !== null) break;
        await this.sleep(pacing.holdMs);
        if (this.stopReason !== null) break;
        await this.guardedSend([...ZERO_REPORT], true);
        if (this.stopReason !== null) break;
        typed = i + 1;
        etaMs -= durations[i];
        const now = clock.now();
        if (
          typed === total ||
          typed - lastProgressDone >= PROGRESS_EVERY_STROKES ||
          now - lastProgressAt >= PROGRESS_MIN_INTERVAL_MS
        ) {
          lastProgressAt = now;
          lastProgressDone = typed;
          this.emit({ type: 'progress', done: typed, total, etaMs: Math.max(0, etaMs) });
        }
        if (typed < total) {
          await this.sleep(pacing.gapMs + (stroke.tag === 'enter' ? pacing.afterEnterMs : 0));
        }
      }
    } catch (error) {
      if (this.stopReason === null) {
        this.stopReason = 'serial-error';
        console.error('[paste] typing stopped: serial error', error);
      }
    } finally {
      // Finishing: cancel() is a no-op from here (first reason wins, a fully
      // typed run stays 'completed') and the watchdog is not re-armed.
      this._state = 'stopping';
      this.clearWatchdog();
      this.wake = null;
      try {
        await this.guardedSend([...ZERO_REPORT], false);
      } catch {
        // best effort: the wire may already be gone
      }
      this.clearWatchdog();
      removeInterrupts();
      removeLockHandler();
      if (lock.owner === OWNER) lock.release(OWNER);
    }

    const reason = this.stopReason ?? 'completed';
    this.stopReason = null;
    this._state = 'idle';
    this.emit({ type: 'stop', done: typed, total, etaMs: 0, reason });
    return { reason, typedStrokes: typed, totalStrokes: total };
  }

  private onLockInterrupt(reason: HidInterruptReason): void {
    this.cancel(reason === 'keydown' ? 'key-interrupt' : 'serial-error');
  }

  /**
   * Host activity that stops a run: a keydown passing isInterruptingKeyDown,
   * a pointerdown/mousedown/touchstart outside our UI (pointerdown as well,
   * so a mouse component cancelling it cannot hide the click), the tab being
   * hidden or unloaded.
   */
  private installInterrupts(): () => void {
    const { interruptTarget, isInsideOwnUi } = this.deps;

    const onKeyDown = (event: Event): void => {
      const key = event as KeyboardEvent;
      const code = typeof key.code === 'string' ? key.code : '';
      const repeat = key.repeat === true;
      if (!isInterruptingKeyDown({ code, repeat, target: event.target }, isInsideOwnUi)) return;
      this.cancel('key-interrupt');
    };
    const onPointerDown = (event: Event): void => {
      if (isInsideOwnUi(event.target)) return;
      this.cancel('mouse-interrupt');
    };
    const onVisibilityChange = (event: Event): void => {
      if (readVisibility(event) === 'hidden') this.cancel('tab-hidden');
    };
    const onPageHide = (): void => {
      this.cancel('tab-hidden');
    };

    const options: AddEventListenerOptions = { capture: true, passive: true };
    interruptTarget.addEventListener('keydown', onKeyDown, options);
    interruptTarget.addEventListener('pointerdown', onPointerDown, options);
    interruptTarget.addEventListener('mousedown', onPointerDown, options);
    interruptTarget.addEventListener('touchstart', onPointerDown, options);
    interruptTarget.addEventListener('visibilitychange', onVisibilityChange, options);
    interruptTarget.addEventListener('pagehide', onPageHide, options);

    return () => {
      interruptTarget.removeEventListener('keydown', onKeyDown, true);
      interruptTarget.removeEventListener('pointerdown', onPointerDown, true);
      interruptTarget.removeEventListener('mousedown', onPointerDown, true);
      interruptTarget.removeEventListener('touchstart', onPointerDown, true);
      interruptTarget.removeEventListener('visibilitychange', onVisibilityChange, true);
      interruptTarget.removeEventListener('pagehide', onPageHide, true);
    };
  }

  /** Abortable timer; cancel() resolves it early. */
  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    const { clock } = this.deps;
    return new Promise<void>((resolve) => {
      let timer: TimerHandle | null = null;
      const abort = (): void => {
        if (timer !== null) clock.clearTimeout(timer);
        timer = null;
        resolve();
      };
      timer = clock.setTimeout(() => {
        timer = null;
        if (this.wake === abort) this.wake = null;
        resolve();
      }, ms);
      this.wake = abort;
    });
  }

  /**
   * `send` raced against the write timeout. When `abortable`, cancel() makes
   * it resolve early (the caller then sees stopReason). The underlying write
   * is never awaited past the race, so a hung serial port cannot wedge a run.
   */
  private guardedSend(report: number[], abortable: boolean): Promise<void> {
    const { clock } = this.deps;
    let sendPromise: Promise<void>;
    try {
      sendPromise = Promise.resolve(this.deps.send(report));
    } catch (error) {
      return Promise.reject(error);
    }
    sendPromise.catch(() => undefined); // the race may have settled already; never leave it unhandled

    return new Promise<void>((resolve, reject) => {
      let timer: TimerHandle | null = null;
      let settled = false;
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clock.clearTimeout(timer);
        if (this.wake === abort) this.wake = null;
        finish();
      };
      const abort = (): void => settle(resolve);

      timer = clock.setTimeout(
        () => settle(() => reject(new WriteTimeoutError(this.writeTimeoutMs))),
        this.writeTimeoutMs
      );
      if (abortable) this.wake = abort;
      sendPromise.then(
        () =>
          settle(() => {
            this.kickWatchdog();
            resolve();
          }),
        (error: unknown) => settle(() => reject(error))
      );
    });
  }

  private kickWatchdog(): void {
    this.clearWatchdog();
    if (this._state !== 'running') return;
    this.watchdog = this.deps.clock.setTimeout(() => {
      this.watchdog = null;
      this.cancel('serial-error');
    }, this.watchdogMs);
  }

  private clearWatchdog(): void {
    if (this.watchdog === null) return;
    this.deps.clock.clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /** Subscriber exceptions never reach the run loop. */
  private emit(event: EngineEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        console.error('[paste] engine subscriber threw', error);
      }
    }
  }
}
