/**
 * Exclusive owner of the HID keyboard wire (spec §5.3). While locked, the
 * keyboard driver is muted, the virtual keyboard and shortcut rows ignore
 * input, and a physical non-modifier keydown calls `interrupt()` so the owner
 * (the typing engine) can stop. Pure: no DOM, no timers.
 */
export type HidOwner = 'paste';
export type HidInterruptReason = 'keydown' | 'serial-error';
export type HidChangeListener = (owner: HidOwner | null) => void;
export type HidInterruptHandler = (reason: HidInterruptReason) => void;

export class HidLock {
  private _owner: HidOwner | null = null;
  private readonly changeListeners = new Set<HidChangeListener>();
  private readonly interruptHandlers = new Set<HidInterruptHandler>();

  get owner(): HidOwner | null {
    return this._owner;
  }

  /** False when the lock is already held (by anyone, including the same owner). */
  acquire(owner: HidOwner): boolean {
    if (this._owner !== null) return false;
    this._owner = owner;
    this.notify();
    return true;
  }

  /** Ignored unless `owner` currently holds the lock. */
  release(owner: HidOwner): void {
    if (this._owner !== owner) return;
    this._owner = null;
    this.notify();
  }

  isLocked(): boolean {
    return this._owner !== null;
  }

  /**
   * Fires synchronously after every ownership change. The signature also fits
   * `useSyncExternalStore(subscribe, getSnapshot)` with `isLocked` as snapshot.
   */
  onChange(listener: HidChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Registers the handler `interrupt()` dispatches to (the running engine). */
  onInterrupt(handler: HidInterruptHandler): () => void {
    this.interruptHandlers.add(handler);
    return () => {
      this.interruptHandlers.delete(handler);
    };
  }

  /** Asks the current owner to stop; a no-op when nobody is listening. */
  interrupt(reason: HidInterruptReason = 'keydown'): void {
    for (const handler of Array.from(this.interruptHandlers)) {
      try {
        handler(reason);
      } catch (error) {
        console.error('[hid-lock] interrupt handler threw', error);
      }
    }
  }

  private notify(): void {
    const owner = this._owner;
    for (const listener of Array.from(this.changeListeners)) {
      try {
        listener(owner);
      } catch (error) {
        console.error('[hid-lock] change listener threw', error);
      }
    }
  }
}

export const hidLock = new HidLock();
