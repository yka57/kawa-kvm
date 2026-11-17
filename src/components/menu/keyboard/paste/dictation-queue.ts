/**
 * Send queue of the dictation bar (pure): chunks leave in order, one run at a
 * time. `take` hands out the next chunk only while nothing is being typed;
 * `drain` returns what was never sent so the bar can put it back.
 */
export class DictationQueue {
  private items: string[] = [];

  get size(): number {
    return this.items.length;
  }

  push(text: string): void {
    if (text.length > 0) this.items.push(text);
  }

  /** Next chunk, or null when the queue is empty or a run is in progress. */
  take(busy: boolean): string | null {
    if (busy || this.items.length === 0) return null;
    return this.items.shift() ?? null;
  }

  /** Everything still queued, joined in order; the queue is empty afterwards. */
  drain(): string {
    const rest = this.items.join('');
    this.items = [];
    return rest;
  }
}
