import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useMediaQuery } from 'react-responsive';

import { createInitialTouchState, createTouchHandlers } from '@/components/mouse/touchpad.ts';
import { MouseAbsoluteEvent } from '@/components/mouse/types.ts';
import { videoRotationAtom } from '@/jotai/device.ts';
import { scrollDirectionAtom, scrollIntervalAtom, scrollPxPerNotchAtom } from '@/jotai/mouse.ts';
import { device } from '@/libs/device';
import { MouseAbsoluteRelative } from '@/libs/mouse';
import { mouseJiggler } from '@/libs/mouse-jiggler';
import { onMouseRelease } from '@/libs/mouse/release-bus';
import { mapClientToVideo } from '@/libs/pointer/absolute-map';
import { MoveQueue } from '@/libs/pointer/move-queue';
import {
  applyButtonsMask,
  clampWheelNotches,
  disableEvent,
  isMouseLikePointer,
  pointerButtonsMask
} from '@/libs/pointer/pointer-events';
import { WheelAccumulator } from '@/libs/pointer/wheel';

/** Payload prefix of absolute reports (`device.sendMouseData` picks cmd 0x04). */
const ABS_PREFIX = 0x02;

// Cast as upstream did: the element may still be missing, callers guard for it
function getVideoElement(): HTMLVideoElement {
  return document.getElementById('video') as HTMLVideoElement;
}

function videoSize(video: HTMLVideoElement): { width: number; height: number } | null {
  return video.videoWidth && video.videoHeight
    ? { width: video.videoWidth, height: video.videoHeight }
    : null;
}

function heldButtons(mouse: MouseAbsoluteRelative): number {
  return mouse.buildButtonReport(0, 0)[0];
}

function logSendError(error: unknown): void {
  console.error('[mouse] absolute report failed', error);
}

/**
 * Absolute mouse mode (spec §4.2). Mouse and pen input comes in as pointer
 * events with pointer capture, so a drag released outside the video still
 * releases the button; touch keeps upstream's TouchEvent handlers. Every
 * report goes through one MoveQueue: MOVE reports coalesce (latest wins) while
 * a serial write is in flight, button/wheel/release reports are never dropped.
 */
export const Absolute = () => {
  const isBigScreen = useMediaQuery({ minWidth: 650 });

  const scrollDirection = useAtomValue(scrollDirectionAtom);
  const scrollInterval = useAtomValue(scrollIntervalAtom);
  const scrollPxPerNotch = useAtomValue(scrollPxPerNotchAtom);
  const videoRotation = useAtomValue(videoRotationAtom);

  const mouseRef = useRef(new MouseAbsoluteRelative());
  const lastPosRef = useRef({ x: 0.5, y: 0.5 });
  const touchStateRef = useRef(createInitialTouchState());
  const screenRef = useRef<HTMLVideoElement | null>(null);
  const rotationRef = useRef(videoRotation);
  const wheelRef = useRef(
    new WheelAccumulator({
      direction: scrollDirection < 0 ? -1 : 1,
      minIntervalMs: scrollInterval,
      pxPerNotch: scrollPxPerNotch
    })
  );
  const queueRef = useRef(
    new MoveQueue((payload) => device.sendMouseData(payload), { onError: logSendError })
  );

  // Settings reach the pointer listeners through refs / the accumulator, so the
  // pointer effect registers once per mount (spec §1).
  useEffect(() => {
    wheelRef.current.update({
      direction: scrollDirection < 0 ? -1 : 1,
      minIntervalMs: scrollInterval,
      pxPerNotch: scrollPxPerNotch
    });
  }, [scrollDirection, scrollInterval, scrollPxPerNotch]);

  useEffect(() => {
    rotationRef.current = videoRotation;
  }, [videoRotation]);

  // Pointer path (mouse and pen)
  useEffect(() => {
    const screen = getVideoElement();
    if (!screen) return;
    screenRef.current = screen;
    const wheel = wheelRef.current;

    screen.addEventListener('pointerdown', handlePointerDown);
    screen.addEventListener('pointerup', handlePointerUp);
    screen.addEventListener('pointermove', handlePointerMove);
    screen.addEventListener('pointercancel', handlePointerCancel);
    screen.addEventListener('lostpointercapture', handleLostPointerCapture);
    screen.addEventListener('wheel', handleWheel);
    // The pointer events above are never cancelled: a cancelled pointerdown
    // suppresses the compatibility mousedown (Pointer Events, mouse mapping),
    // which the paste engine's and antd's window-capture listeners rely on.
    // The browser defaults (focus/selection, context menu) are suppressed on
    // the mouse events instead, exactly as upstream did.
    screen.addEventListener('mousedown', disableEvent);
    screen.addEventListener('click', disableEvent);
    screen.addEventListener('contextmenu', disableEvent);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const unsubscribeRelease = onMouseRelease(handleReleaseRequest);

    // Pointer down: capture so moves and the release reach us off-element
    function handlePointerDown(e: PointerEvent): void {
      if (!isMouseLikePointer(e)) return;

      try {
        screen.setPointerCapture(e.pointerId);
      } catch {
        // pointer already gone; the button report below is still sent
      }
      syncPointer(e, false);
    }

    // Pointer up (last button released): report, then drop the capture
    function handlePointerUp(e: PointerEvent): void {
      if (!isMouseLikePointer(e)) return;

      syncPointer(e, false);
      try {
        if (screen.hasPointerCapture(e.pointerId)) {
          screen.releasePointerCapture(e.pointerId);
        }
      } catch {
        // capture already released
      }
    }

    // Pointer move: a MOVE report, or a button report when the mask changed (chords)
    function handlePointerMove(e: PointerEvent): void {
      if (!isMouseLikePointer(e)) return;
      syncPointer(e, true);
    }

    // Position comes from the event itself; a changed `buttons` mask is a
    // button report carrying that position, otherwise a plain move.
    function syncPointer(e: PointerEvent, isMove: boolean): void {
      const pos = getCoordinate(e);
      const buttons = pointerButtonsMask(e);
      if (buttons !== heldButtons(mouseRef.current)) {
        lastPosRef.current = pos;
        handleMouseEvent({ type: 'buttons', buttons });
      } else if (isMove) {
        handleMouseEvent({ type: 'move', x: pos.x, y: pos.y });
      }
    }

    function handlePointerCancel(e: PointerEvent): void {
      if (!isMouseLikePointer(e)) return;
      releaseHeld();
    }

    // Also fires right after our own releasePointerCapture(): nothing held then, no report
    function handleLostPointerCapture(e: PointerEvent): void {
      if (!isMouseLikePointer(e)) return;
      releaseHeld();
    }

    // Mouse wheel event: pixels accumulate into notches (trackpad nudges, momentum)
    function handleWheel(e: WheelEvent): void {
      disableEvent(e);

      const notches = wheel.feed({
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode as 0 | 1 | 2,
        t: e.timeStamp
      });
      if (notches === 0) {
        return;
      }

      handleMouseEvent({ type: 'wheel', deltaY: clampWheelNotches(notches) });
    }

    // Release held buttons when the window loses focus
    function handleBlur(): void {
      releaseHeld();
      wheel.reset();
    }

    // Release held buttons when the tab is hidden
    function handleVisibilityChange(): void {
      if (document.hidden) {
        releaseHeld();
        wheel.reset();
      }
    }

    // "Release all keys" row: always send the all-up report
    function handleReleaseRequest(): void {
      handleMouseEvent({ type: 'release', force: true });
    }

    function releaseHeld(): void {
      handleMouseEvent({ type: 'release' });
    }

    return () => {
      screen.removeEventListener('pointerdown', handlePointerDown);
      screen.removeEventListener('pointerup', handlePointerUp);
      screen.removeEventListener('pointermove', handlePointerMove);
      screen.removeEventListener('pointercancel', handlePointerCancel);
      screen.removeEventListener('lostpointercapture', handleLostPointerCapture);
      screen.removeEventListener('wheel', handleWheel);
      screen.removeEventListener('mousedown', disableEvent);
      screen.removeEventListener('click', disableEvent);
      screen.removeEventListener('contextmenu', disableEvent);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unsubscribeRelease();

      releaseHeld();
      wheel.reset();
      screenRef.current = null;
    };
  }, []);

  // Touch path: upstream's handlers and deps, unchanged
  useEffect(() => {
    const screen = getVideoElement();
    if (!screen) return;

    // Create touch handlers
    const touchState = touchStateRef.current;
    const touchHandlers = createTouchHandlers(touchState, {
      scrollDirection,
      scrollInterval,
      getCoordinate,
      handleMouseEvent,
      disableEvent
    });

    // Add touch event listeners (only on big screens)
    if (isBigScreen) {
      screen.addEventListener('touchstart', touchHandlers.handleTouchStart);
      screen.addEventListener('touchmove', touchHandlers.handleTouchMove);
      screen.addEventListener('touchend', touchHandlers.handleTouchEnd);
      screen.addEventListener('touchcancel', touchHandlers.handleTouchCancel);
    }

    return () => {
      screen.removeEventListener('touchstart', touchHandlers.handleTouchStart);
      screen.removeEventListener('touchmove', touchHandlers.handleTouchMove);
      screen.removeEventListener('touchend', touchHandlers.handleTouchEnd);
      screen.removeEventListener('touchcancel', touchHandlers.handleTouchCancel);

      touchHandlers.cleanup();
    };
  }, [isBigScreen, scrollDirection, scrollInterval]);

  // Calculate mouse coordinate (letterbox + rotation aware, spec §4.1)
  function getCoordinate(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const screen = screenRef.current ?? getVideoElement();
    if (!screen) {
      return lastPosRef.current;
    }
    return mapClientToVideo(
      event,
      screen.getBoundingClientRect(),
      videoSize(screen),
      rotationRef.current
    );
  }

  // Mouse event handler, shared by the pointer and touch paths. MOVE reports
  // coalesce while a write is in flight; everything else is never dropped and
  // is sent after any move queued before it (override 3).
  function handleMouseEvent(event: MouseAbsoluteEvent): void {
    const mouse = mouseRef.current;
    const queue = queueRef.current;
    const { x, y } = lastPosRef.current;
    const send = (report: number[]): void => {
      void queue.send([ABS_PREFIX, ...report]);
    };

    switch (event.type) {
      case 'move':
        lastPosRef.current = { x: event.x, y: event.y };
        queue.moveAbsolute([ABS_PREFIX, ...mouse.buildReport(event.x, event.y)]);
        break;
      case 'mousedown':
        mouse.buttonDown(event.button);
        send(mouse.buildButtonReport(x, y));
        break;
      case 'mouseup':
        mouse.buttonUp(event.button);
        send(mouse.buildButtonReport(x, y));
        break;
      case 'buttons':
        if (applyButtonsMask(mouse, heldButtons(mouse), event.buttons)) {
          send(mouse.buildButtonReport(x, y));
        }
        break;
      case 'wheel':
        send(mouse.buildReport(x, y, event.deltaY));
        break;
      case 'release':
        if (heldButtons(mouse) === 0 && !event.force) {
          return;
        }
        mouse.reset();
        send(mouse.buildReport(x, y));
        break;
    }

    mouseJiggler.moveEventCallback();
  }

  return <></>;
};
