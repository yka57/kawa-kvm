/**
 * Tiny event bus (spec §3.6): the "Release all keys" row asks the mounted
 * mouse component to release every held button. Pure: no DOM, no timers.
 */
export type MouseReleaseListener = () => void;

const listeners = new Set<MouseReleaseListener>();

/** Subscribe to release requests; returns the unsubscribe function. */
export function onMouseRelease(listener: MouseReleaseListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ask every subscriber to send a buttons-up report. A throwing listener never blocks the others. */
export function emitMouseRelease(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error) {
      console.error('[mouse] release listener threw', error);
    }
  }
}

/** Number of current subscribers (tests / diagnostics). */
export function mouseReleaseListenerCount(): number {
  return listeners.size;
}
