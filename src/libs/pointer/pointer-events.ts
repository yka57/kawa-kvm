/**
 * Helpers for translating DOM pointer events in the mouse components (spec
 * §4.2). Pure: only the event-shaped arguments are touched, nothing at import
 * time, so the mapping is unit-tested in node.
 */

/** Touch stays with the TouchEvent handlers in `touchpad.ts`; pens act as a mouse. */
export function isMouseLikePointer(event: { pointerType: string }): boolean {
  return event.pointerType === 'mouse' || event.pointerType === 'pen';
}

/**
 * The DOM `buttons` bit layout (1 left, 2 right, 4 middle, 8 back, 16 forward)
 * is the CH9329/HID buttons byte, bit for bit. Pointer events report chords
 * through this mask (a second button pressed while one is held arrives as a
 * `pointermove` with a new mask, not as a `pointerdown`), so the components
 * track the mask instead of individual `button` indices.
 */
export const BUTTONS_MASK = 0x1f;

export function pointerButtonsMask(event: { buttons: number }): number {
  return (event.buttons & BUTTONS_MASK) >>> 0;
}

/** Browser `button` index for each mask bit: left, right, middle, back, forward. */
const BUTTON_INDEX_BY_BIT = [0, 2, 1, 3, 4] as const;

export interface ButtonTracker {
  buttonDown(button: number): void;
  buttonUp(button: number): void;
}

/**
 * Move a button tracker (MouseAbsoluteRelative / MouseReportRelative) from the
 * mask it currently holds to `next`, one buttonDown/buttonUp per changed bit.
 * Returns true when something changed (= a button report must be sent).
 */
export function applyButtonsMask(tracker: ButtonTracker, current: number, next: number): boolean {
  const from = current & BUTTONS_MASK;
  const to = next & BUTTONS_MASK;
  if (from === to) {
    return false;
  }
  BUTTON_INDEX_BY_BIT.forEach((button, bit) => {
    const was = (from >> bit) & 1;
    const is = (to >> bit) & 1;
    if (is && !was) {
      tracker.buttonDown(button);
    } else if (was && !is) {
      tracker.buttonUp(button);
    }
  });
  return true;
}

/** Wheel byte range of one report (spec §4.2: `|notches| > 127` is clamped). */
export const MAX_WHEEL_NOTCHES = 127;

export function clampWheelNotches(notches: number): number {
  if (!Number.isFinite(notches)) {
    return 0;
  }
  return Math.max(-MAX_WHEEL_NOTCHES, Math.min(MAX_WHEEL_NOTCHES, Math.trunc(notches)));
}

/**
 * While a paste run holds the HID lock (spec v2 §14.7) the target screen has
 * to stay still for the browser bridge: wheel reports (a trackpad's momentum
 * tail included) and pure moves are dropped. Button presses still go through
 * (a press stops the run) and so do releases, which must never be lost.
 */
export function dropWhileHidLocked(event: { type: string }, hidLocked: boolean): boolean {
  return hidLocked && (event.type === 'move' || event.type === 'wheel');
}

/** Suppress the browser default and stop bubbling (upstream's `disableEvent`). */
export function disableEvent(event: { preventDefault(): void; stopPropagation(): void }): void {
  event.preventDefault();
  event.stopPropagation();
}
