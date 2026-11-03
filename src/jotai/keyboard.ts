import { atom } from 'jotai';

import { normalizeRemapConfig, type KeyboardRemapConfig } from '@/libs/keyboard/remap-config';
import * as storage from '@/libs/storage';

export const isKeyboardEnableAtom = atom(true);

export const isKeyboardOpenAtom = atom(false);

// Raw `nanokvm-usb-keyboard-remap` object as stored (unvalidated) or null when
// absent/malformed. libs/keyboard/remap-config normalises it.
export const keyboardRemapRawAtom = atom<Record<string, unknown> | null>(
  storage.parseJsonObject(storage.getKeyboardRemapRaw())
);

// Validated remap config (spec §3.2), derived from the raw atom so it is
// correct from module load. Writers set keyboardRemapRawAtom (+ storage).
export const keyboardRemapAtom = atom<KeyboardRemapConfig>((get) =>
  normalizeRemapConfig(get(keyboardRemapRawAtom))
);

export interface KeyTraceMods {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

// Shape of the host event part of a trace; structurally compatible with the
// keyboard state machine's HostKeyEvent so traces can be stored as-is.
export interface KeyTraceEvent {
  type: 'keydown' | 'keyup' | 'timer' | 'release-all';
  code?: string;
  key?: string;
  repeat?: boolean;
  timeStamp?: number;
  mods?: KeyTraceMods;
}

// One line of the Key test: the host event and the HID codes it produced.
// The driver's TraceEntry also carries seq/at/report (optional here).
export interface KeyTrace {
  ev: KeyTraceEvent;
  sent: string[];
  // monotonic per driver, so consecutive identical traces are still distinct
  seq?: number;
  at?: number;
  // 8-byte report after the event ([modifier, 0, k1..k6])
  report?: number[];
}

export const keyTraceAtom = atom<KeyTrace | null>(null);

// true while the Key test modal is open (the driver runs in dry-run mode then)
export const isKeyTestOpenAtom = atom(false);
