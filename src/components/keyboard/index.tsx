import { useEffect, useMemo, useRef } from 'react';
import { message } from 'antd';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';

import { isInsideOwnUi, pasteController } from '@/components/menu/keyboard/paste/controller';
import {
  isKeyboardEnableAtom,
  isKeyTestOpenAtom,
  keyboardRemapAtom,
  keyTraceAtom
} from '@/jotai/keyboard';
import { pasteSettingsAtom } from '@/jotai/paste';
import { targetOsAtom } from '@/jotai/target';
import { getOperatingSystem } from '@/libs/browser';
import { device } from '@/libs/device';
import { KeyboardDriver, type TraceEntry } from '@/libs/keyboard/driver';
import { hidLock } from '@/libs/keyboard/hid-lock';
import { isModifier } from '@/libs/keyboard/keymap';
import {
  isRemapActive,
  matchChord,
  type HostMods,
  type RemapContext
} from '@/libs/keyboard/remap-config';
import { normalisePasteSettings } from '@/libs/paste/settings';
import { isInterruptingKeyDown } from '@/libs/paste/typing-engine';

import { setKeyboardDriver } from './driver-registry';

// The driver reports 'ime-composing' on every keydown with key === 'Process';
// the hint is shown at most once per interval.
const IME_HINT_INTERVAL_MS = 5000;

function modsOf(event: KeyboardEvent): HostMods {
  return { meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey };
}

/**
 * Thin DOM adapter of the physical-keyboard path (spec §3.5): registers the
 * listeners, translates DOM events into driver dispatches and feeds the
 * current settings to the driver through refs.
 */
export const Keyboard = () => {
  const hostOS = getOperatingSystem();
  const { t } = useTranslation();
  const [messageApi, contextHolder] = message.useMessage();
  const isKeyboardEnabled = useAtomValue(isKeyboardEnableAtom);
  const isKeyTestOpen = useAtomValue(isKeyTestOpenAtom);
  const remapConfig = useAtomValue(keyboardRemapAtom);
  const targetOs = useAtomValue(targetOsAtom);
  const pasteSettings = useAtomValue(pasteSettingsAtom);
  const setKeyTrace = useSetAtom(keyTraceAtom);

  // Settings reach the listeners through refs (spec §1): the listener effect
  // must never re-run on a config change, since that would release every key.
  const context = useMemo<RemapContext>(() => {
    const paste = normalisePasteSettings(pasteSettings, hostOS);
    return {
      cfg: remapConfig,
      active: isRemapActive(remapConfig, hostOS, targetOs),
      hostActions: [
        { id: 'paste-host-clipboard', chord: paste.hotkey, enabled: paste.hotkeyEnabled }
      ]
    };
  }, [remapConfig, hostOS, targetOs, pasteSettings]);

  const contextRef = useRef(context);
  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  const isComposing = useRef(false);
  const lastImeHintAt = useRef(0);

  function onHostAction(id: string): void {
    // The driver consumed the chord (never forwarded, repeats swallowed); a
    // fresh press during a run cancels it (spec §5.4).
    if (id === 'paste-host-clipboard') {
      pasteController.startFromHotkey();
    }
  }

  function onHint(id: string): void {
    if (id !== 'ime-composing') return;

    const now = performance.now();
    if (now - lastImeHintAt.current < IME_HINT_INTERVAL_MS) return;
    lastImeHintAt.current = now;

    messageApi.open({
      key: 'imeHint',
      type: 'warning',
      content: t('keyboard.remap.imeHint'),
      duration: 4
    });
  }

  function onTrace(trace: TraceEntry): void {
    setKeyTrace(trace);
  }

  // Callbacks close over render-scoped values (t, messageApi); the driver
  // reaches them through a ref that is refreshed after every render.
  const callbacksRef = useRef({ onHostAction, onHint, onTrace });
  useEffect(() => {
    callbacksRef.current = { onHostAction, onHint, onTrace };
  });

  // One driver per mount (spec §3.5); its deps read the refs at call time.
  const driverRef = useRef<KeyboardDriver | null>(null);
  if (driverRef.current === null) {
    driverRef.current = new KeyboardDriver({
      send: (report) => device.sendKeyboardData(report),
      hostOS,
      getContext: () => contextRef.current,
      onHostAction: (id) => callbacksRef.current.onHostAction(id),
      onHint: (id) => callbacksRef.current.onHint(id),
      onTrace: (trace) => callbacksRef.current.onTrace(trace)
    });
  }

  // Expose the driver to the release-all row and the paste controller.
  useEffect(() => {
    setKeyboardDriver(driverRef.current);

    return () => {
      setKeyboardDriver(null);
    };
  }, []);

  // HID lock (spec §5.3): muted while the paste engine owns the wire. The
  // state machine keeps tracking modifiers and the unmute re-sends the current
  // report, so a chord still held after a short run is restored on the target.
  useEffect(() => {
    driverRef.current?.setMuted(hidLock.isLocked());

    return hidLock.onChange((owner) => {
      driverRef.current?.setMuted(owner !== null);
    });
  }, []);

  // Key test (help modal): the state machine and traces keep running in
  // dry-run mode, nothing reaches the target; closing it restores sending.
  useEffect(() => {
    driverRef.current?.setDryRun(isKeyTestOpen);
  }, [isKeyTestOpen]);

  useEffect(() => {
    // host OS read here (not from render scope) so the effect keeps its single dependency
    const os = getOperatingSystem();

    if (!isKeyboardEnabled) {
      driverRef.current?.releaseAll();
      return;
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('compositionstart', handleCompositionStart);
    document.addEventListener('compositionend', handleCompositionEnd);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Key down event
    function handleKeyDown(event: KeyboardEvent): void {
      if (!isKeyboardEnabled) return;

      // Skip during IME composition
      if (isComposing.current || event.isComposing) return;

      event.preventDefault();
      event.stopPropagation();

      const code = normalizeKeyCode(event, os);
      if (!code) {
        return;
      }

      // HID lock (spec §3.5/§5.3): while the paste engine owns the wire (or is
      // still sending its final report) a non-modifier keydown is swallowed and
      // stops the run under the engine's own interrupt rule (never on host
      // autorepeat: holding the ⌘⇧V chord past the repeat delay must not cancel
      // the paste it just started); modifiers still reach the driver so its
      // shadow state stays right for the unmute resend. The engine's own window
      // listener usually stops the run first, hence the isBusy() check.
      if (!isModifier(code) && (hidLock.isLocked() || pasteController.isBusy())) {
        const key = { code, repeat: event.repeat, target: event.target };
        if (isInterruptingKeyDown(key, isInsideOwnUi)) hidLock.interrupt();
        const mods = modsOf(event);
        const isPasteHotkey = contextRef.current.hostActions.some(
          (action) =>
            action.enabled && matchChord({ code, mods, repeat: event.repeat }, action.chord)
        );
        // the paste hotkey pressed again during a run is an explicit cancel
        if (isPasteHotkey && contextRef.current.active) pasteController.cancel();
        return;
      }

      driverRef.current?.dispatch({
        type: 'keydown',
        code,
        key: event.key,
        repeat: event.repeat,
        timeStamp: event.timeStamp,
        mods: modsOf(event)
      });
    }

    // Key up event
    function handleKeyUp(event: KeyboardEvent): void {
      if (!isKeyboardEnabled) return;

      if (isComposing.current || event.isComposing) return;

      event.preventDefault();
      event.stopPropagation();

      const code = normalizeKeyCode(event, os);
      if (!code) {
        return;
      }

      driverRef.current?.dispatch({
        type: 'keyup',
        code,
        timeStamp: event.timeStamp,
        mods: modsOf(event)
      });
    }

    // Composition start event
    function handleCompositionStart(): void {
      isComposing.current = true;
    }

    // Composition end event
    function handleCompositionEnd(): void {
      isComposing.current = false;
    }

    // Release all keys when window loses focus
    function handleBlur(): void {
      driverRef.current?.releaseAll();
    }

    // Release all keys before window closes
    function handleVisibilityChange(): void {
      if (document.hidden) {
        driverRef.current?.releaseAll();
      }
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('compositionstart', handleCompositionStart);
      document.removeEventListener('compositionend', handleCompositionEnd);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);

      driverRef.current?.releaseAll();
    };
  }, [isKeyboardEnabled]);

  function normalizeKeyCode(event: KeyboardEvent, os?: string): string {
    if (event.code) {
      return event.code;
    }

    // Fallback: use event.key + event.location to determine the key
    // event.location: 1 = left, 2 = right, 0 = standard (non-positional)
    if (event.key === 'Shift') {
      if (event.location === 0 && os === 'Windows') {
        return 'ShiftRight';
      }
      return event.location === 2 ? 'ShiftRight' : 'ShiftLeft';
    }

    if (event.key === 'Control') {
      return event.location === 2 ? 'ControlRight' : 'ControlLeft';
    }
    if (event.key === 'Alt') {
      return event.location === 2 ? 'AltRight' : 'AltLeft';
    }
    if (event.key === 'Meta') {
      return event.location === 2 ? 'MetaRight' : 'MetaLeft';
    }

    return event.code;
  }

  return <>{contextHolder}</>;
};
