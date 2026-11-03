import { buildRelativeReports } from '@/libs/mouse';

/**
 * In-flight coalescing for mouse MOVE reports (one queue per mouse component).
 *
 * The serial writer is strictly FIFO and `await write()` is the only back
 * pressure, so while one write is pending we keep at most one MOVE item per
 * run behind it: absolute moves are replaced by the newest (latest wins),
 * relative moves are summed and split into int8 chunks at send time.
 * Button and wheel reports are never dropped and are sent after any move
 * queued before them, so ordering on the wire is preserved. When the queue is
 * idle a report is handed to `send` synchronously (no added latency).
 *
 * Keyboard reports do not go through this queue. Pure: no DOM, no timers.
 */
export type MoveQueueSend = (payload: number[]) => Promise<void>;

export interface MoveQueueOptions {
  /** Called when `send` rejects; the queue keeps going. Default: ignore. */
  onError?: (error: unknown) => void;
}

export interface MoveQueueStats {
  enqueued: number;
  merged: number;
  sent: number;
  failed: number;
  /** Items waiting behind the in-flight write. */
  pending: number;
  /** A write is in flight. */
  busy: boolean;
}

/** Payload prefix for relative reports (`device.sendMouseData` picks cmd 0x05). */
const REL_PREFIX = 0x01;

interface AbsMoveItem {
  kind: 'abs';
  /** Complete payload: [0x02, buttons, xLo, xHi, yLo, yHi, 0]. */
  payload: number[];
}

interface RelMoveItem {
  kind: 'rel';
  buttons: number;
  dx: number;
  dy: number;
}

interface ReportItem {
  kind: 'report';
  payload: number[];
  resolve: () => void;
}

type QueueItem = AbsMoveItem | RelMoveItem | ReportItem;

function encode(item: QueueItem): number[][] {
  if (item.kind === 'rel') {
    return buildRelativeReports(item.buttons, item.dx, item.dy).map((report) => [
      REL_PREFIX,
      ...report
    ]);
  }
  return [item.payload];
}

export class MoveQueue {
  private readonly queue: QueueItem[] = [];
  private busy = false;
  private drainWaiters: Array<() => void> = [];
  private readonly counters = { enqueued: 0, merged: 0, sent: 0, failed: 0 };

  constructor(
    private readonly sendPayload: MoveQueueSend,
    private readonly options: MoveQueueOptions = {}
  ) {}

  /**
   * Absolute MOVE report (full payload, wheel byte 0). While a write is in
   * flight only the newest position with the same buttons byte survives.
   */
  moveAbsolute(payload: number[]): void {
    this.counters.enqueued++;
    const tail = this.tail();
    if (tail?.kind === 'abs' && tail.payload[1] === payload[1]) {
      tail.payload = payload;
      this.counters.merged++;
    } else {
      this.queue.push({ kind: 'abs', payload });
    }
    this.pump();
  }

  /**
   * Relative MOVE (raw integer deltas). While a write is in flight deltas with
   * the same buttons byte are summed; at send time they are split into
   * [0x01, buttons, dx, dy, 0] chunks of at most ±127 each.
   */
  moveRelative(buttons: number, dx: number, dy: number): void {
    this.counters.enqueued++;
    const tail = this.tail();
    if (tail?.kind === 'rel' && tail.buttons === buttons) {
      tail.dx += dx;
      tail.dy += dy;
      this.counters.merged++;
    } else {
      this.queue.push({ kind: 'rel', buttons, dx, dy });
    }
    this.pump();
  }

  /**
   * Any non-move report (button, wheel, release-all). Never dropped or merged;
   * sent after everything queued before it. Resolves once the write settled
   * (failures go to `onError`, the promise never rejects).
   */
  send(payload: number[]): Promise<void> {
    this.counters.enqueued++;
    return new Promise<void>((resolve) => {
      this.queue.push({ kind: 'report', payload, resolve });
      this.pump();
    });
  }

  /** Resolves when nothing is queued and no write is in flight. */
  flush(): Promise<void> {
    if (!this.busy && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  /** Drop everything still queued (not the in-flight write). For disconnect/unmount. */
  clear(): void {
    const dropped = this.queue.splice(0, this.queue.length);
    dropped.forEach((item) => {
      if (item.kind === 'report') {
        item.resolve();
      }
    });
  }

  stats(): MoveQueueStats {
    return { ...this.counters, pending: this.queue.length, busy: this.busy };
  }

  private tail(): QueueItem | undefined {
    return this.queue[this.queue.length - 1];
  }

  private pump(): void {
    if (this.busy) {
      return;
    }
    this.busy = true;
    // Runs synchronously up to the first await, so an idle queue hands the
    // payload to `send` before this call returns.
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      let item: QueueItem | undefined;
      while ((item = this.queue.shift()) !== undefined) {
        for (const payload of encode(item)) {
          try {
            await this.sendPayload(payload);
            this.counters.sent++;
          } catch (error) {
            this.counters.failed++;
            this.options.onError?.(error);
          }
        }
        if (item.kind === 'report') {
          item.resolve();
        }
      }
    } finally {
      this.busy = false;
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }
}
