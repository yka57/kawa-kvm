import type { System } from '@/libs/browser';
import { realClock, type Clock, type TimerHandle } from '@/libs/clock';

import { KeyboardReport } from './keyboard';
import {
  createRemapState,
  translateKeyEvent,
  type HidAction,
  type HostKeyEvent,
  type RemapState
} from './remap';
import type { HostAction, RemapContext } from './remap-config';

/** One Key-test line: the host event, the HID codes it produced and the report afterwards. */
export interface TraceEntry {
  seq: number;
  at: number;
  ev: HostKeyEvent;
  /** `+Code` press, `-Code` release, `reset` (empty when nothing changed on the wire). */
  sent: string[];
  report: number[];
}

export interface DriverDeps {
  send(report: number[]): Promise<void>;
  hostOS: System;
  getContext(): RemapContext;
  /** Injectable clock (now/setTimeout/clearTimeout); defaults to the real one. */
  clock?: Clock;
  onHostAction?(id: HostAction['id']): void;
  onHint?(id: string): void;
  onTrace?(t: TraceEntry): void;
  /** Send failures are reported here once per failure streak (default: console.error). */
  onError?(error: unknown): void;
}

const EMPTY_REPORT = [0, 0, 0, 0, 0, 0, 0, 0];

/**
 * Keyboard driver (spec §3.4): owns the remap state, the tap timers, the
 * KeyboardReport and one ordered send queue. DOM-free; the React adapter only
 * translates events into `dispatch()` calls.
 */
export class KeyboardDriver {
  /** The single source of what the target sees from the physical-keyboard path. */
  readonly report = new KeyboardReport();

  private readonly deps: DriverDeps;
  private readonly clock: Clock;
  private readonly state: RemapState;
  private readonly timers = new Map<string, TimerHandle>();
  private queue: Promise<void> = Promise.resolve();
  private dryRun = false;
  private muted = false;
  private last: number[] = [...EMPTY_REPORT];
  private failing = false;
  private seq = 0;

  constructor(deps: DriverDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? realClock;
    this.state = createRemapState(deps.hostOS);
  }

  /** Translate the event and run its actions in order; reports are computed synchronously. */
  dispatch(ev: HostKeyEvent): void {
    const actions = translateKeyEvent(this.state, ev, this.deps.getContext());
    for (const action of actions) this.run(action);
  }

  /** Cancel every timer, reset the report (one all-zero report) and the state. */
  releaseAll(): void {
    this.dispatch({ type: 'release-all' });
  }

  /** Key test: the state machine and traces keep running, nothing is sent. */
  setDryRun(on: boolean): void {
    if (on === this.dryRun) return;
    if (on) {
      this.releaseAll();
      this.dryRun = true;
    } else {
      this.dryRun = false;
      this.releaseAll();
    }
  }

  /** HID lock: modifiers stay tracked, sends are suppressed; unmute sends the current report once. */
  setMuted(on: boolean): void {
    if (on === this.muted) return;
    this.muted = on;
    if (!on && !this.dryRun) this.send(this.last);
  }

  isMuted(): boolean {
    return this.muted;
  }

  isDryRun(): boolean {
    return this.dryRun;
  }

  /** Last report computed by this path (also while muted or in dry-run). */
  lastReport(): number[] {
    return [...this.last];
  }

  /** Resolves once every report queued so far has been handed to `send` (never rejects). */
  whenIdle(): Promise<void> {
    return this.queue;
  }

  private run(action: HidAction): void {
    switch (action.type) {
      case 'press':
        this.emit(this.report.keyDown(action.code));
        break;
      case 'release':
        this.emit(this.report.keyUp(action.code));
        break;
      case 'reset':
        this.emit(this.report.reset());
        break;
      case 'release-after':
        this.arm(action.code, action.ms);
        break;
      case 'cancel-release':
        this.disarm(action.code);
        break;
      case 'cancel-all-timers':
        for (const handle of this.timers.values()) this.clock.clearTimeout(handle);
        this.timers.clear();
        break;
      case 'host-action':
        this.notify(() => this.deps.onHostAction?.(action.id));
        break;
      case 'hint':
        this.notify(() => this.deps.onHint?.(action.id));
        break;
      case 'trace':
        this.notify(() =>
          this.deps.onTrace?.({
            seq: ++this.seq,
            at: this.clock.now(),
            ev: action.ev,
            sent: action.sent,
            report: [...this.last]
          })
        );
        break;
    }
  }

  private emit(report: number[]): void {
    this.last = [...report];
    if (this.dryRun || this.muted) return;
    this.send(report);
  }

  /** One promise chain keeps the serial writes in action order; failures never reach the caller. */
  private send(report: number[]): void {
    const bytes = [...report];
    this.queue = this.queue
      .then(() => this.deps.send(bytes))
      .then(
        () => {
          this.failing = false;
        },
        (error: unknown) => {
          if (this.failing) return;
          this.failing = true;
          this.reportError(error);
        }
      );
  }

  private arm(code: string, ms: number): void {
    this.disarm(code);
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(code);
      this.dispatch({ type: 'timer', code, timeStamp: this.clock.now() });
    }, ms);
    this.timers.set(code, handle);
  }

  private disarm(code: string): void {
    if (!this.timers.has(code)) return;
    this.clock.clearTimeout(this.timers.get(code));
    this.timers.delete(code);
  }

  /** Callbacks run inside DOM handlers; a throwing listener must not break key handling. */
  private notify(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    if (this.deps.onError) {
      this.deps.onError(error);
    } else {
      console.error('[keyboard] HID send failed', error);
    }
  }
}
