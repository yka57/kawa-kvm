import type { System } from '@/libs/browser';
import type { ImePreKey, NewlineMode } from '@/libs/paste/types';
import type { SpeedPreset } from '@/libs/paste/typing-engine';
import type { TargetOs } from '@/libs/storage';

/** Host-side chord; structurally identical to `Chord` in remap-config (spec §3.2). */
export interface PasteHotkey {
  code: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** IME pre-key as stored; 'auto' is resolved per target OS by resolveImePreKey. */
export type ImePreKeySetting = ImePreKey | 'auto';
/** How text without a key in the target layout is entered, as stored (spec §1.2). */
export type UnicodeMethodSetting =
  'auto' | 'bridge' | 'ime-code' | 'ctrl-shift-u' | 'alt-hex' | 'skip';
/** The resolved Unicode method a paste uses. */
export type UnicodeMethod = 'bridge' | 'ime-code' | 'ctrl-shift-u' | 'alt-hex' | 'skip';
/** Window the bridge opens in the target browser (spec §4.2). */
export type BridgeWindow = 'chromium-private' | 'firefox-private' | 'new-window';

/** Persisted under `nanokvm-usb-paste-settings` (spec v2 §2). Layout comes from targetLayoutAtom. */
export interface PasteSettings {
  version: 2;
  speed: SpeedPreset;
  newline: NewlineMode;
  /** Direct path only: the bridge and the code point entry paths are byte-exact. */
  normalizePunct: boolean;
  stripTrailingNewline: boolean;
  imePreKey: ImePreKeySetting;
  unicodeMethod: UnicodeMethodSetting;
  bridgeWindow: BridgeWindow;
  /** Turn the target Caps Lock off before typing when the device reports it on. */
  fixCapsLock: boolean;
  hotkeyEnabled: boolean;
  hotkey: PasteHotkey;
}

export const PASTE_SETTINGS_VERSION = 2;
export const DEFAULT_PASTE_HOTKEY: Readonly<PasteHotkey> = {
  code: 'KeyV',
  meta: true,
  shift: true
};

const SPEEDS: readonly SpeedPreset[] = ['safe', 'normal', 'fast'];
const NEWLINES: readonly NewlineMode[] = ['enter', 'shift-enter'];
const IME_PRE_KEYS: readonly ImePreKeySetting[] = ['auto', 'none', 'NonConvert', 'Lang2'];
const UNICODE_METHODS: readonly UnicodeMethodSetting[] = [
  'auto',
  'bridge',
  'ime-code',
  'ctrl-shift-u',
  'alt-hex',
  'skip'
];
const BRIDGE_WINDOWS: readonly BridgeWindow[] = [
  'chromium-private',
  'firefox-private',
  'new-window'
];
const CHORD_FLAGS = ['meta', 'ctrl', 'alt', 'shift'] as const;

/** Off macOS the browser never sees a ⌘ / Win chord reliably (the OS takes it). */
export const DEFAULT_PASTE_HOTKEY_OTHER: Readonly<PasteHotkey> = {
  code: 'KeyV',
  ctrl: true,
  shift: true
};

/** ⌘⇧V on a macOS host, Ctrl+Shift+V elsewhere; a fresh object each time. */
export function defaultPasteHotkey(hostOS: System): PasteHotkey {
  return { ...(hostOS === 'macOS' ? DEFAULT_PASTE_HOTKEY : DEFAULT_PASTE_HOTKEY_OTHER) };
}

function sameChord(a: PasteHotkey, b: PasteHotkey): boolean {
  return a.code === b.code && CHORD_FLAGS.every((flag) => !!a[flag] === !!b[flag]);
}

/**
 * Whether the host hotkey can work at all: on a macOS host it rides on the
 * ⌘ remap (the chord is consumed there), on other hosts it is always usable.
 */
export function isPasteHotkeyUsable(hostOS: System, remapActive: boolean): boolean {
  return hostOS !== 'macOS' || remapActive;
}

export function defaultPasteSettings(hostOS: System): PasteSettings {
  return {
    version: PASTE_SETTINGS_VERSION,
    speed: 'normal',
    newline: 'enter',
    normalizePunct: true,
    stripTrailingNewline: true,
    imePreKey: 'auto',
    unicodeMethod: 'auto',
    bridgeWindow: 'chromium-private',
    fixCapsLock: true,
    hotkeyEnabled: hostOS === 'macOS',
    hotkey: defaultPasteHotkey(hostOS)
  };
}

/** 'auto' sends LANG2 (IME off on Windows 10 2004+/11) to Windows targets and nothing elsewhere. */
export function resolveImePreKey(setting: ImePreKeySetting, targetOs: TargetOs): ImePreKey {
  if (setting !== 'auto') return setting;
  return targetOs === 'windows' ? 'Lang2' : 'none';
}

/**
 * 'auto' picks the bridge on Windows and Ctrl+Shift+U on Linux ('alt-hex' is
 * never automatic: it needs a registry value on the target; 'ime-code' is
 * never automatic either: it needs the Japanese Microsoft IME as the target's
 * active input method). macOS targets always skip: both methods drive the
 * target with Ctrl chords.
 */
export function resolveUnicodeMethod(
  method: UnicodeMethodSetting,
  targetOs: TargetOs
): UnicodeMethod {
  if (targetOs === 'macos') return 'skip';
  if (method !== 'auto') return method;
  return targetOs === 'windows' ? 'bridge' : 'ctrl-shift-u';
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
 * The stored chord; off macOS the macOS default (⌘⇧V, stored before other
 * hosts had a hotkey of their own) counts as "not chosen".
 */
function storedHotkey(raw: unknown, hostOS: System): PasteHotkey | null {
  const chord = normaliseHotkey(raw);
  if (chord && hostOS !== 'macOS' && sameChord(chord, DEFAULT_PASTE_HOTKEY)) return null;
  return chord;
}

/**
 * Forward-migrating normaliser: unknown fields are dropped, missing or invalid
 * ones get their default, nothing valid is ever discarded. Also understands
 * the pre-release shape (`normalize: {quotes, dashes, nbsp}` object and
 * `hotkey: null` meaning "hotkey disabled"). Always returns version 2.
 */
export function normalisePasteSettings(raw: unknown, hostOS: System): PasteSettings {
  const defaults = defaultPasteSettings(hostOS);
  if (!isRecord(raw)) return defaults;

  const legacyNormalizePunct = isRecord(raw.normalize)
    ? Boolean(raw.normalize.quotes || raw.normalize.dashes || raw.normalize.nbsp)
    : defaults.normalizePunct;
  const legacyHotkeyEnabled = raw.hotkey === null ? false : defaults.hotkeyEnabled;
  // v1 stored 'none' as its default and offered only 無変換, so a v1 'none'
  // was never a choice against LANG2: it becomes 'auto'
  const imePreKey =
    raw.version !== PASTE_SETTINGS_VERSION && raw.imePreKey === 'none'
      ? 'auto'
      : pickEnum(raw.imePreKey, IME_PRE_KEYS, defaults.imePreKey);

  return {
    version: PASTE_SETTINGS_VERSION,
    speed: pickEnum(raw.speed, SPEEDS, defaults.speed),
    newline: pickEnum(raw.newline, NEWLINES, defaults.newline),
    normalizePunct: pickBool(raw.normalizePunct, legacyNormalizePunct),
    stripTrailingNewline: pickBool(raw.stripTrailingNewline, defaults.stripTrailingNewline),
    imePreKey,
    unicodeMethod: pickEnum(raw.unicodeMethod, UNICODE_METHODS, defaults.unicodeMethod),
    bridgeWindow: pickEnum(raw.bridgeWindow, BRIDGE_WINDOWS, defaults.bridgeWindow),
    fixCapsLock: pickBool(raw.fixCapsLock, defaults.fixCapsLock),
    hotkeyEnabled: pickBool(raw.hotkeyEnabled, legacyHotkeyEnabled),
    hotkey: storedHotkey(raw.hotkey, hostOS) ?? { ...defaults.hotkey }
  };
}
