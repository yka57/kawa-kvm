import type { System } from '@/libs/browser';
import type { ImePreKey, NewlineMode } from '@/libs/paste/types';
import type { SpeedPreset } from '@/libs/paste/typing-engine';

/** Host-side chord; structurally identical to `Chord` in remap-config (spec §3.2). */
export interface PasteHotkey {
  code: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** Persisted under `nanokvm-usb-paste-settings` (spec §5.5). Layout comes from targetLayoutAtom. */
export interface PasteSettings {
  version: 1;
  speed: SpeedPreset;
  newline: NewlineMode;
  normalizePunct: boolean;
  stripTrailingNewline: boolean;
  imePreKey: ImePreKey;
  hotkeyEnabled: boolean;
  hotkey: PasteHotkey;
}

export const PASTE_SETTINGS_VERSION = 1;
export const DEFAULT_PASTE_HOTKEY: Readonly<PasteHotkey> = {
  code: 'KeyV',
  meta: true,
  shift: true
};

const SPEEDS: readonly SpeedPreset[] = ['safe', 'normal'];
const NEWLINES: readonly NewlineMode[] = ['enter', 'shift-enter'];
const IME_PRE_KEYS: readonly ImePreKey[] = ['none', 'NonConvert'];
const CHORD_FLAGS = ['meta', 'ctrl', 'alt', 'shift'] as const;

export function defaultPasteSettings(hostOS: System): PasteSettings {
  return {
    version: PASTE_SETTINGS_VERSION,
    speed: 'normal',
    newline: 'enter',
    normalizePunct: true,
    stripTrailingNewline: true,
    imePreKey: 'none',
    hotkeyEnabled: hostOS === 'macOS',
    hotkey: { ...DEFAULT_PASTE_HOTKEY }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Validates a stored chord; null when unusable. Canonical form: `code` plus
 * only the flags that are true, so chords can be compared structurally.
 */
export function normaliseHotkey(raw: unknown): PasteHotkey | null {
  if (!isRecord(raw) || typeof raw.code !== 'string' || raw.code.length === 0) return null;
  const chord: PasteHotkey = { code: raw.code };
  for (const flag of CHORD_FLAGS) {
    if (raw[flag] === true) chord[flag] = true;
  }
  return chord;
}

/**
 * Forward-migrating normaliser: unknown fields are dropped, missing or invalid
 * ones get their default, nothing valid is ever discarded. Also understands
 * the pre-release shape (`normalize: {quotes, dashes, nbsp}` object and
 * `hotkey: null` meaning "hotkey disabled").
 */
export function normalisePasteSettings(raw: unknown, hostOS: System): PasteSettings {
  const defaults = defaultPasteSettings(hostOS);
  if (!isRecord(raw)) return defaults;

  const legacyNormalizePunct = isRecord(raw.normalize)
    ? Boolean(raw.normalize.quotes || raw.normalize.dashes || raw.normalize.nbsp)
    : defaults.normalizePunct;
  const legacyHotkeyEnabled = raw.hotkey === null ? false : defaults.hotkeyEnabled;

  return {
    version: PASTE_SETTINGS_VERSION,
    speed: pickEnum(raw.speed, SPEEDS, defaults.speed),
    newline: pickEnum(raw.newline, NEWLINES, defaults.newline),
    normalizePunct: pickBool(raw.normalizePunct, legacyNormalizePunct),
    stripTrailingNewline: pickBool(raw.stripTrailingNewline, defaults.stripTrailingNewline),
    imePreKey: pickEnum(raw.imePreKey, IME_PRE_KEYS, defaults.imePreKey),
    hotkeyEnabled: pickBool(raw.hotkeyEnabled, legacyHotkeyEnabled),
    hotkey: normaliseHotkey(raw.hotkey) ?? { ...defaults.hotkey }
  };
}
