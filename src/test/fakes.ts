import type { Clock, TimerHandle } from '@/libs/clock';

interface FakeTimer {
  id: number;
  due: number;
  fn: () => void;
}

/**
 * Deterministic clock: timers fire in due-time order (ties: creation order)
 * when `advance()` is called. `now()` is frozen between advances.
 */
export class FakeClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers: FakeTimer[] = [];

  now = (): number => this.t;

  setTimeout = (fn: () => void, ms: number): TimerHandle => {
    const id = ++this.seq;
    this.timers.push({ id, due: this.t + Math.max(0, ms), fn });
    return id;
  };

  clearTimeout = (handle: TimerHandle): void => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };

  /** Advance time by `ms`, firing every timer that becomes due, in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers
        .filter((timer) => timer.due <= end)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!next) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.t = next.due;
      next.fn();
    }
    this.t = end;
  }

  /** Like advance(), but drains microtasks between timers (for async code under test). */
  async advanceAsync(ms: number, step = 1): Promise<void> {
    let remaining = ms;
    while (remaining > 0) {
      const delta = Math.min(step, remaining);
      this.advance(delta);
      remaining -= delta;
      await flushMicrotasks();
    }
    await flushMicrotasks();
  }

  pendingTimers(): number {
    return this.timers.length;
  }
}

export async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/**
 * Records every report handed to `send`. Can reject or hang on the Nth call
 * (1-based) to simulate serial failures.
 */
export class FakeSink {
  reports: number[][] = [];
  rejectAt: number | null = null;
  hangAt: number | null = null;
  private hung: Array<() => void> = [];

  send = async (report: number[]): Promise<void> => {
    const n = this.reports.length + 1;
    this.reports.push([...report]);
    if (this.rejectAt === n) {
      throw new Error('fake serial error');
    }
    if (this.hangAt === n) {
      await new Promise<void>((resolve) => this.hung.push(resolve));
    }
  };

  /** Resolve every hung write. */
  releaseHung(): void {
    const pending = this.hung;
    this.hung = [];
    pending.forEach((resolve) => resolve());
  }

  reset(): void {
    this.reports = [];
    this.rejectAt = null;
    this.hangAt = null;
    this.releaseHung();
  }
}

export interface FakeHostMods {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface FakeKeyDown {
  type: 'keydown';
  code: string;
  key?: string;
  repeat: boolean;
  timeStamp: number;
  mods: FakeHostMods;
}

export interface FakeKeyUp {
  type: 'keyup';
  code: string;
  timeStamp: number;
  mods: FakeHostMods;
}

export const NO_MODS: FakeHostMods = { meta: false, ctrl: false, alt: false, shift: false };

/** Build a keydown/keyup host event with sensible defaults (structurally matches HostKeyEvent). */
export function makeKeyEvent(partial: Partial<FakeKeyDown> & { code: string }): FakeKeyDown;
export function makeKeyEvent(
  partial: Partial<FakeKeyUp> & { code: string; type: 'keyup' }
): FakeKeyUp;
export function makeKeyEvent(
  partial: (Partial<FakeKeyDown> | Partial<FakeKeyUp>) & { code: string }
): FakeKeyDown | FakeKeyUp {
  const mods = { ...NO_MODS, ...(partial.mods ?? {}) };
  if (partial.type === 'keyup') {
    return { type: 'keyup', code: partial.code, timeStamp: partial.timeStamp ?? 0, mods };
  }
  const down = partial as Partial<FakeKeyDown>;
  return {
    type: 'keydown',
    code: partial.code,
    key: down.key,
    repeat: down.repeat ?? false,
    timeStamp: partial.timeStamp ?? 0,
    mods
  };
}

/** Flatten a nested locale object into sorted dotted key paths (leaf strings only). */
export function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') {
    return prefix ? [prefix] : [];
  }
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      keys.push(...flattenKeys(value, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}
