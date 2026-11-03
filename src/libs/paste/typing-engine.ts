import type { Clock, TimerHandle } from '@/libs/clock';
import type { HidInterruptReason, HidLock } from '@/libs/keyboard/hid-lock';
import { isModifier } from '@/libs/keyboard/keymap';
import type { CompileResult, KeyStroke } from '@/libs/paste/types';

/**
 * Typing engine (spec v1 §5.2, v2 §6): runs a program of key strokes,
 * sleeps, screen waits, callbacks and phase markers as press/release HID
 * reports with fixed pacing, owns the HID lock while running and stops on
 * host activity. A CompileResult is the one-step program. Everything impure
 * (serial sink, clock, EventTarget) is injected, so it runs under vitest in
 * node with fakes.
 */

export type SpeedPreset = 'safe' | 'normal' | 'fast';

export interface Pacing {
  holdMs: number;
  gapMs: number;
  afterEnterMs: number;
}

export const PACING: Record<SpeedPreset, Pacing> = {
  safe: { holdMs: 50, gapMs: 50, afterEnterMs: 150 },
  normal: { holdMs: 20, gapMs: 20, afterEnterMs: 100 },
  fast: { holdMs: 10, gapMs: 10, afterEnterMs: 60 }
};

export type StopReason =
  | 'completed'
  | 'cancelled'
  | 'key-interrupt'
  | 'mouse-interrupt'
  | 'tab-hidden'
  | 'serial-error'
  | 'lock-busy'
  | 'bridge-no-window'
  | 'bridge-probe-failed'
  | 'bridge-load-failed'
  | 'bridge-verify-failed'
  | 'bridge-close-failed'
  | 'caps-lock';

/** Stage of a bridge run, shown by the progress pill (spec §4.2). */
export type PastePhase = 'window' | 'probe' | 'type' | 'verify' | 'copy' | 'close' | 'paste';

export type WaitVerdict = 'ok' | 'pending' | 'fail';

/** Polls `check()` until 'ok' (next step), 'fail' or the timeout (both stop the run). */
export interface WaitStep {
  kind: 'wait';
  /** A throw or a rejection counts as 'pending'. */
  check(): WaitVerdict | Promise<WaitVerdict>;
  timeoutMs: number;
  /** Pause between polls (default DEFAULT_WAIT_INTERVAL_MS). */
  intervalMs?: number;
  /** Expected duration, for the ETA only. */
  estimateMs: number;
  timeoutReason: StopReason;
  /** Stop reason after a 'fail' verdict (default: timeoutReason). */
  failReason?: StopReason;
  /** Sent best-effort after a 'fail' verdict, before stopping (not counted as progress). */
  onFail?: KeyStroke[];
}

export type ProgramStep =
  | { kind: 'keys'; strokes: KeyStroke[] }
  | { kind: 'sleep'; ms: number }
  | WaitStep
  | { kind: 'run'; fn(): void }
  | { kind: 'phase'; phase: PastePhase };

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
  /** Cancel when no report could be sent for this long while sending keys (default 3000). */
  watchdogMs?: number;
}

export interface EngineEvent {
  type: 'start' | 'progress' | 'stop';
  /** Strokes of `keys` steps typed so far / in the program. */
  done: number;
  total: number;
  etaMs: number;
  reason?: StopReason;
  /** The latest `phase` step, once the program has passed one. */
  phase?: PastePhase;
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
export const DEFAULT_WAIT_INTERVAL_MS = 100;

const PROGRESS_MIN_INTERVAL_MS = 50;
const PROGRESS_EVERY_STROKES = 10;
const OWNER = 'paste';

export class WriteTimeoutError extends Error {
  constructor(ms: number) {
    super(`serial write timed out after ${ms} ms`);
    this.name = 'WriteTimeoutError';
  }
}

/** Pause after a stroke's release: the gap, Enter's extra pause and the stroke's own settle time. */
function gapAfterMs(stroke: KeyStroke, pacing: Pacing): number {
  return pacing.gapMs + (stroke.tag === 'enter' ? pacing.afterEnterMs : 0) + (stroke.afterMs ?? 0);
}

function strokeDurationMs(stroke: KeyStroke, pacing: Pacing): number {
  return pacing.holdMs + gapAfterMs(stroke, pacing);
}

/**
 * Wall-clock estimate of a program (the ETA of its 'start' event): every
 * stroke's hold and gap, the sleeps and the waits' estimates.
 */
export function estimateProgramMs(steps: readonly ProgramStep[], pacing: Pacing): number {
  let total = 0;
  for (const step of steps) {
    if (step.kind === 'keys') {
      for (const stroke of step.strokes) total += strokeDurationMs(stroke, pacing);
    } else if (step.kind === 'sleep') {
      total += step.ms;
    } else if (step.kind === 'wait') {
      total += step.estimateMs;
    }
  }
  return total;
}

function countStrokes(steps: readonly ProgramStep[]): number {
  return steps.reduce((sum, step) => (step.kind === 'keys' ? sum + step.strokes.length : sum), 0);
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

/** Counters of the run in progress. */
interface RunContext {
  pacing: Pacing;
  total: number;
  done: number;
  etaMs: number;
  phase?: PastePhase;
  lastProgressAt: number;
  lastProgressDone: number;
}

export class TypingEngine {
  private _state: EngineState = 'idle';
  private readonly listeners = new Set<EngineListener>();
  private stopReason: StopReason | null = null;
  /** Aborts the wait currently in progress (a sleep, a guarded send or a pending check). */
  private wake: (() => void) | null = null;
  private watchdog: TimerHandle | null = null;
  /** Between the first press and the last release of an atomic group. */
  private groupOpen = false;
  /** First cancel reason received while a group was open; applied when it closes. */
  private deferredReason: StopReason | null = null;
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
   * keyboard driver resumes at once; the pending sleep/send/check is aborted
   * and the run finishes with a best-effort ZERO report. First reason wins.
   * Inside an atomic group every reason but 'serial-error' is deferred to the
   * group's last release: half a Ctrl+Shift+U sequence would leave the target
   * input method waiting for hex digits.
   */
  cancel(reason: StopReason = 'cancelled'): void {
    if (this._state !== 'running') return;
    if (this.groupOpen && reason !== 'serial-error') {
      if (this.deferredReason === null) this.deferredReason = reason;
      return;
    }
    this.stopReason = reason;
    this._state = 'stopping';
    this.deps.lock.release(OWNER);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** The v1 entry point: the compiled strokes as a one-step program. */
  run(compiled: CompileResult, pacing: Pacing): Promise<EngineResult> {
    return this.runProgram([{ kind: 'keys', strokes: compiled.strokes }], pacing);
  }

  /**
   * ARM (lock, interrupt listeners, ZERO) → the steps in order → FINISH (ZERO,
   * listeners off, lock released, stop). Resolves 'lock-busy' without
   * touching the wire when a run is in progress or somebody else holds the
   * lock.
   */
  async runProgram(steps: ProgramStep[], pacing: Pacing): Promise<EngineResult> {
    const total = countStrokes(steps);
    if (this._state !== 'idle' || !this.deps.lock.acquire(OWNER)) {
      return { reason: 'lock-busy', typedStrokes: 0, totalStrokes: total };
    }
    this._state = 'running';
    this.stopReason = null;

    const { clock, lock } = this.deps;
    const run: RunContext = {
      pacing,
      total,
      done: 0,
      etaMs: estimateProgramMs(steps, pacing),
      lastProgressAt: clock.now(),
      lastProgressDone: 0
    };

    const removeInterrupts = this.installInterrupts();
    const removeLockHandler = lock.onInterrupt((reason) => this.onLockInterrupt(reason));
    this.emit(this.event('start', run));

    try {
      this.kickWatchdog();
      await this.guardedSend([...ZERO_REPORT], true);
      for (const step of steps) {
        if (this.stopReason !== null) break;
        await this.runStep(step, run);
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
      this.groupOpen = false;
      this.deferredReason = null;
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
    this.emit(this.event('stop', run, reason));
    return { reason, typedStrokes: run.done, totalStrokes: total };
  }

  /**
   * The watchdog guards serial writes only: sleeps, screen waits and
   * callbacks may legitimately take longer than watchdogMs, so they clear it
   * and the next send re-arms it.
   */
  private async runStep(step: ProgramStep, run: RunContext): Promise<void> {
    switch (step.kind) {
      case 'keys':
        return this.runKeys(step.strokes, run);
      case 'sleep':
        this.clearWatchdog();
        await this.sleep(step.ms);
        if (this.stopReason === null) this.advance(run, step.ms);
        return;
      case 'wait':
        this.clearWatchdog();
        return this.runWait(step, run);
      case 'run':
        this.clearWatchdog();
        try {
          step.fn();
        } catch (error) {
          console.error('[paste] program step threw', error);
        }
        return;
      case 'phase':
        run.phase = step.phase;
        this.progress(run, true);
        return;
    }
  }

  /** Press, hold, release (all-zero), then the gap; no gap after the program's last stroke. */
  private async runKeys(strokes: readonly KeyStroke[], run: RunContext): Promise<void> {
    const { pacing } = run;
    for (let i = 0; i < strokes.length && this.stopReason === null; i++) {
      const stroke = strokes[i];
      const previousGroup = i > 0 ? strokes[i - 1].group : undefined;
      const nextGroup = i + 1 < strokes.length ? strokes[i + 1].group : undefined;
      if (stroke.group !== undefined && stroke.group !== previousGroup) this.groupOpen = true;

      await this.guardedSend(pressReport(stroke), true);
      if (this.stopReason !== null) return;
      await this.sleep(pacing.holdMs);
      if (this.stopReason !== null) return;
      await this.guardedSend([...ZERO_REPORT], true);
      if (this.stopReason !== null) return;

      run.done++;
      run.etaMs -= strokeDurationMs(stroke, pacing);
      this.progress(run, false);
      if (this.groupOpen && stroke.group !== nextGroup) this.closeGroup();
      if (this.stopReason === null && run.done < run.total) {
        await this.sleep(gapAfterMs(stroke, pacing));
      }
    }
  }

  /** Leaves the atomic group; a cancel deferred inside it takes effect now. */
  private closeGroup(): void {
    this.groupOpen = false;
    const deferred = this.deferredReason;
    this.deferredReason = null;
    if (deferred !== null) this.cancel(deferred);
  }

  private async runWait(step: WaitStep, run: RunContext): Promise<void> {
    const verdict = await this.poll(step);
    if (this.stopReason !== null) return;
    if (verdict === 'ok') {
      this.advance(run, step.estimateMs);
    } else if (verdict === 'fail') {
      this.stopFromProgram(step.failReason ?? step.timeoutReason);
      await this.sendBestEffort(step.onFail ?? [], run.pacing);
    } else {
      this.stopFromProgram(step.timeoutReason);
    }
  }

  /** The first non-pending verdict, or 'pending' once the deadline passed (or a cancel). */
  private async poll(step: WaitStep): Promise<WaitVerdict> {
    const { clock } = this.deps;
    const deadline = clock.now() + step.timeoutMs;
    const intervalMs = step.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
    for (;;) {
      const verdict = await this.check(step, deadline - clock.now());
      if (verdict !== 'pending' || this.stopReason !== null) return verdict;
      const remaining = deadline - clock.now();
      if (remaining <= 0) return 'pending';
      await this.sleep(Math.min(intervalMs, remaining));
      if (this.stopReason !== null) return 'pending';
    }
  }

  /** One check; a throw, a rejection, an unknown value or a check outliving the deadline is 'pending'. */
  private async check(step: WaitStep, remainingMs: number): Promise<WaitVerdict> {
    let result: WaitVerdict | Promise<WaitVerdict>;
    try {
      result = step.check();
    } catch {
      return 'pending';
    }
    const verdict = typeof result === 'string' ? result : await this.raceWake(result, remainingMs);
    return verdict === 'ok' || verdict === 'fail' ? verdict : 'pending';
  }

  /**
   * A stop the program decided (a wait failed or timed out). Unlike cancel()
   * the lock stays held until FINISH, so the failure keys and the final ZERO
   * cannot interleave with the user's keys; later cancels are ignored.
   */
  private stopFromProgram(reason: StopReason): void {
    this.stopReason = reason;
    this._state = 'stopping';
  }

  /** Keys sent after a failed wait: no cancel can abort them and errors end them quietly. */
  private async sendBestEffort(strokes: readonly KeyStroke[], pacing: Pacing): Promise<void> {
    for (let i = 0; i < strokes.length; i++) {
      try {
        await this.guardedSend(pressReport(strokes[i]), false);
        await this.sleep(pacing.holdMs);
        await this.guardedSend([...ZERO_REPORT], false);
      } catch (error) {
        console.error('[paste] failure keys not sent', error);
        return;
      }
      if (i + 1 < strokes.length) await this.sleep(gapAfterMs(strokes[i], pacing));
    }
  }

  /** A sleep or a wait finished: its share of the ETA is spent. */
  private advance(run: RunContext, ms: number): void {
    run.etaMs -= ms;
    this.progress(run, false);
  }

  /** Throttled progress event; `force` for phase changes, which the pill must show at once. */
  private progress(run: RunContext, force: boolean): void {
    const now = this.deps.clock.now();
    if (
      !force &&
      run.done !== run.total &&
      run.done - run.lastProgressDone < PROGRESS_EVERY_STROKES &&
      now - run.lastProgressAt < PROGRESS_MIN_INTERVAL_MS
    ) {
      return;
    }
    run.lastProgressAt = now;
    run.lastProgressDone = run.done;
    this.emit(this.event('progress', run));
  }

  private event(type: EngineEvent['type'], run: RunContext, reason?: StopReason): EngineEvent {
    const event: EngineEvent = {
      type,
      done: run.done,
      total: run.total,
      etaMs: type === 'stop' ? 0 : Math.max(0, run.etaMs)
    };
    if (reason !== undefined) event.reason = reason;
    if (run.phase !== undefined) event.phase = run.phase;
    return event;
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
   * Settles with the promise's value, or undefined after `ms` or on cancel().
   * A check that never settles is left behind, like a hung write.
   */
  private raceWake<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    const { clock } = this.deps;
    return new Promise<T | undefined>((resolve) => {
      let timer: TimerHandle | null = null;
      let settled = false;
      const settle = (value: T | undefined): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clock.clearTimeout(timer);
        if (this.wake === abort) this.wake = null;
        resolve(value);
      };
      const abort = (): void => settle(undefined);

      timer = clock.setTimeout(abort, Math.max(0, ms));
      this.wake = abort;
      promise.then(settle, () => settle(undefined));
    });
  }

  /**
   * `send` raced against the write timeout. When `abortable`, cancel() makes
   * it resolve early (the caller then sees stopReason). The underlying write
   * is never awaited past the race, so a hung serial port cannot wedge a run.
   */
  private guardedSend(report: number[], abortable: boolean): Promise<void> {
    const { clock } = this.deps;
    // the first send after a sleep, wait or run step re-arms the watchdog
    if (this.watchdog === null) this.kickWatchdog();
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
