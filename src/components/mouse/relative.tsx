import { useEffect, useRef } from 'react';
import { message } from 'antd';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';

import { MouseRelativeEvent } from '@/components/mouse/types.ts';
import {
  mouseSensitivityAtom,
  scrollDirectionAtom,
  scrollIntervalAtom,
  scrollPxPerNotchAtom
} from '@/jotai/mouse.ts';
import { device } from '@/libs/device';
import { hidLock } from '@/libs/keyboard/hid-lock';
import { MouseReportRelative } from '@/libs/mouse';
import { mouseJiggler } from '@/libs/mouse-jiggler';
import { onMouseRelease } from '@/libs/mouse/release-bus';
import { MoveQueue } from '@/libs/pointer/move-queue';
import {
  applyButtonsMask,
  clampWheelNotches,
  disableEvent,
  dropWhileHidLocked,
  isMouseLikePointer,
  pointerButtonsMask
} from '@/libs/pointer/pointer-events';
import { RelativeMotion } from '@/libs/pointer/relative-motion';
import { WheelAccumulator } from '@/libs/pointer/wheel';

/** Payload prefix of relative reports (`device.sendMouseData` picks cmd 0x05). */
const REL_PREFIX = 0x01;

/**
 * Upstream forwarded buttons, moves and wheel while the pointer was NOT
 * locked, so the click that acquires the lock also clicked on the target
 * (spec §4.2 / §8). Nothing is forwarded until the lock is held.
 */
const FORWARD_WHEN_UNLOCKED = false;

/** Lock failures worth a hint to the user; anything else is only logged. */
const LOCK_ERRORS_TO_REPORT = new Set(['NotSupportedError', 'SecurityError', 'NotAllowedError']);

type MessageKey = 'requestPointer' | 'pointerLockFailed';

// Cast as upstream did: the element may still be missing, callers guard for it
function getVideoElement(): HTMLVideoElement {
  return document.getElementById('video') as HTMLVideoElement;
}

function heldButtons(mouse: MouseReportRelative): number {
  return mouse.buildButtonReport()[0];
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';
}

function logSendError(error: unknown): void {
  console.error('[mouse] relative report failed', error);
}

/**
 * Relative mouse mode (spec §4.2): a click requests the pointer lock; while
 * locked, pointer deltas go through RelativeMotion (gain + carried
 * remainders) and the MoveQueue (summed while a write is in flight, split
 * into int8 chunks on the wire, so flicks keep their full distance).
 */
export const Relative = () => {
  const { t } = useTranslation();
  const [messageApi, contextHolder] = message.useMessage();

  const scrollDirection = useAtomValue(scrollDirectionAtom);
  const scrollInterval = useAtomValue(scrollIntervalAtom);
  const scrollPxPerNotch = useAtomValue(scrollPxPerNotchAtom);
  const mouseSensitivity = useAtomValue(mouseSensitivityAtom);

  const mouseRef = useRef(new MouseReportRelative());
  const isLockedRef = useRef(false);
  const lockPendingRef = useRef(false);
  const motionRef = useRef(new RelativeMotion(mouseSensitivity));
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

  function showMessage(key: MessageKey): void {
    messageApi.open({
      key: 'requestPointer',
      type: 'info',
      content: t(`mouse.${key}`),
      duration: 3,
      style: {
        marginTop: '40vh'
      }
    });
  }

  // showMessage closes over render-scoped values (t, messageApi); the mount
  // effect reaches it through a ref refreshed after every render.
  const showMessageRef = useRef(showMessage);
  useEffect(() => {
    showMessageRef.current = showMessage;
  });

  useEffect(() => {
    motionRef.current.setGain(mouseSensitivity);
  }, [mouseSensitivity]);

  useEffect(() => {
    wheelRef.current.update({
      direction: scrollDirection < 0 ? -1 : 1,
      minIntervalMs: scrollInterval,
      pxPerNotch: scrollPxPerNotch
    });
  }, [scrollDirection, scrollInterval, scrollPxPerNotch]);

  useEffect(() => {
    const screen = getVideoElement();
    if (!screen) return;
    const wheel = wheelRef.current;
    const motion = motionRef.current;

    showMessageRef.current('requestPointer');

    screen.addEventListener('click', handleClick);
    screen.addEventListener('pointerdown', handlePointerDown);
    screen.addEventListener('pointerup', handlePointerUp);
    screen.addEventListener('pointermove', handlePointerMove);
    screen.addEventListener('wheel', handleWheel);
    // The pointer events above are never cancelled: a cancelled pointerdown
    // suppresses the compatibility mousedown (Pointer Events, mouse mapping),
    // which the paste engine's and antd's window-capture listeners rely on.
    // The browser defaults are suppressed on the mouse events instead (upstream).
    screen.addEventListener('mousedown', disableEvent);
    screen.addEventListener('contextmenu', disableEvent);
    document.addEventListener('pointerlockchange', handlePointerLockChange);
    const unsubscribeRelease = onMouseRelease(handleReleaseRequest);

    // Click only requests the pointer lock; it is never forwarded
    function handleClick(event: MouseEvent): void {
      disableEvent(event);

      if (isLockedRef.current || lockPendingRef.current) return;
      void requestLock();
    }

    // Errors are caught and reported once; no retry loop (the next click retries)
    async function requestLock(): Promise<void> {
      lockPendingRef.current = true;
      try {
        await screen.requestPointerLock();
      } catch (error) {
        if (document.pointerLockElement !== screen) {
          console.warn('[mouse] pointer lock request failed', error);
          if (LOCK_ERRORS_TO_REPORT.has(errorName(error))) {
            showMessageRef.current('pointerLockFailed');
          }
        }
      } finally {
        lockPendingRef.current = false;
      }
    }

    function mayForward(): boolean {
      return isLockedRef.current || FORWARD_WHEN_UNLOCKED;
    }

    // Button pressed (first of a chord)
    function handlePointerDown(e: PointerEvent): void {
      if (!isMouseLikePointer(e)) return;
      if (!mayForward()) return;

      handleMouseEvent({ type: 'buttons', buttons: pointerButtonsMask(e) });
    }

    // Last button released
    function handlePointerUp(e: PointerEvent): void {
      if (!isMouseLikePointer(e)) return;
      if (!mayForward()) return;

      handleMouseEvent({ type: 'buttons', buttons: pointerButtonsMask(e) });
    }

    // Pointer move: chord changes arrive here too; deltas get the gain applied
    function handlePointerMove(e: PointerEvent): void {
      if (!isMouseLikePointer(e)) return;
      if (!mayForward()) return;

      const buttons = pointerButtonsMask(e);
      if (buttons !== heldButtons(mouseRef.current)) {
        handleMouseEvent({ type: 'buttons', buttons });
      }

      const { dx, dy } = motion.feed(e.movementX, e.movementY);
      if (dx === 0 && dy === 0) return;

      handleMouseEvent({ type: 'move', deltaX: dx, deltaY: dy });
    }

    // Mouse wheel event
    function handleWheel(e: WheelEvent): void {
      disableEvent(e);
      if (!mayForward()) return;

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

    // Pointer lock state change: losing the lock releases held buttons
    function handlePointerLockChange(): void {
      const locked = document.pointerLockElement === screen;
      isLockedRef.current = locked;

      if (!locked) {
        handleMouseEvent({ type: 'release' });
        motion.reset();
        wheel.reset();
      }
    }

    // "Release all keys" row: always send the all-up report
    function handleReleaseRequest(): void {
      handleMouseEvent({ type: 'release', force: true });
    }

    return (): void => {
      // Exit pointer lock when component unmounts
      if (document.pointerLockElement === screen) {
        document.exitPointerLock();
      }

      screen.removeEventListener('click', handleClick);
      screen.removeEventListener('pointerdown', handlePointerDown);
      screen.removeEventListener('pointerup', handlePointerUp);
      screen.removeEventListener('pointermove', handlePointerMove);
      screen.removeEventListener('wheel', handleWheel);
      screen.removeEventListener('mousedown', disableEvent);
      screen.removeEventListener('contextmenu', disableEvent);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      unsubscribeRelease();

      isLockedRef.current = false;
      handleMouseEvent({ type: 'release' });
      motion.reset();
      wheel.reset();
    };
  }, []);

  // Mouse handler: MOVE deltas coalesce while a write is in flight and are
  // split into int8 reports on the wire; everything else is never dropped.
  // While a paste run holds the HID lock, moves and wheel are dropped (spec v2 §14.7).
  function handleMouseEvent(event: MouseRelativeEvent): void {
    if (dropWhileHidLocked(event, hidLock.isLocked())) return;
    const mouse = mouseRef.current;
    const queue = queueRef.current;
    const send = (report: number[]): void => {
      void queue.send([REL_PREFIX, ...report]);
    };

    switch (event.type) {
      case 'move':
        queue.moveRelative(heldButtons(mouse), event.deltaX, event.deltaY);
        break;
      case 'mousedown':
        mouse.buttonDown(event.button);
        send(mouse.buildButtonReport());
        break;
      case 'mouseup':
        mouse.buttonUp(event.button);
        send(mouse.buildButtonReport());
        break;
      case 'buttons':
        if (applyButtonsMask(mouse, heldButtons(mouse), event.buttons)) {
          send(mouse.buildButtonReport());
        }
        break;
      case 'wheel':
        send(mouse.buildReport(0, 0, event.deltaY));
        break;
      case 'release':
        if (heldButtons(mouse) === 0 && !event.force) {
          return;
        }
        send(mouse.reset());
        break;
    }

    mouseJiggler.moveEventCallback();
  }

  return <>{contextHolder}</>;
};
