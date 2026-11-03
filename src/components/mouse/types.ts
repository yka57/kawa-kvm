export enum MouseButton {
  Left = 0,
  Middle = 1,
  Right = 2,
  Back = 3,
  Forward = 4
}

interface MouseMoveAbsoluteEvent {
  type: 'move';
  x: number;
  y: number;
}

interface MouseMoveRelativeEvent {
  type: 'move';
  deltaX: number;
  deltaY: number;
}

interface MouseButtonEvent {
  type: 'mousedown' | 'mouseup';
  button: number;
}

interface MouseWheelEvent {
  type: 'wheel';
  /** Signed wheel notches for one report (direction already applied). */
  deltaY: number;
}

/**
 * The held-button bitmask changed (DOM `buttons` layout = HID buttons byte).
 * Pointer events deliver chords this way: a second button pressed while one
 * is held arrives as a `pointermove` with a new mask.
 */
interface MouseButtonsEvent {
  type: 'buttons';
  buttons: number;
}

/**
 * Release every held button in one report (pointer capture lost, window blur,
 * tab hidden, pointer lock lost, unmount). `force` sends the all-up report
 * even when nothing is tracked as held (the "Release all keys" row).
 */
interface MouseReleaseEvent {
  type: 'release';
  force?: boolean;
}

export type MouseAbsoluteEvent =
  | MouseMoveAbsoluteEvent
  | MouseButtonEvent
  | MouseButtonsEvent
  | MouseWheelEvent
  | MouseReleaseEvent;

export type MouseRelativeEvent =
  | MouseMoveRelativeEvent
  | MouseButtonEvent
  | MouseButtonsEvent
  | MouseWheelEvent
  | MouseReleaseEvent;
