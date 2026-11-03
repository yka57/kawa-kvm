import { atom } from 'jotai';

import * as storage from '@/libs/storage';

// Raw `nanokvm-usb-paste-settings` object as stored (unvalidated) or null when
// absent/malformed. libs/paste/settings normalises it (forward-migrating).
export const pasteSettingsAtom = atom<Record<string, unknown> | null>(
  storage.parseJsonObject(storage.getPasteSettingsRaw())
);

// Why a paste run ended (mirrors the typing engine's StopReason).
export type PasteStopReason =
  | 'completed'
  | 'cancelled'
  | 'key-interrupt'
  | 'mouse-interrupt'
  | 'tab-hidden'
  | 'serial-error'
  | 'lock-busy';

export interface PasteRunState {
  status: 'idle' | 'running' | 'done';
  // strokes typed so far / strokes to type
  done: number;
  total: number;
  // estimated remaining time
  etaMs: number;
  // set once status is 'done'
  reason?: PasteStopReason;
  // unique characters that could not be typed, with their occurrence counts
  skipped?: { char: string; count: number }[];
}

export const IDLE_PASTE_RUN: PasteRunState = { status: 'idle', done: 0, total: 0, etaMs: 0 };

export const pasteRunAtom = atom<PasteRunState>(IDLE_PASTE_RUN);
