import type { Resolution, Rotation } from '@/types';

const LANGUAGE_KEY = 'nanokvm-usb-language';
const VIDEO_DEVICE_ID_KEY = 'nanokvm-usb-video-device-id';
const VIDEO_RESOLUTION_KEY = 'nanokvm-usb-video-resolution';
const CUSTOM_RESOLUTION_KEY = 'nanokvm-usb-custom-resolution';
const VIDEO_SCALE_KEY = 'nanokvm-usb-video-scale';
const VIDEO_ROTATION_KEY = 'nanokvm-usb-video-rotation';
const IS_MENU_OPEN_KEY = 'nanokvm-is-menu-open';
const MOUSE_STYLE_KEY = 'nanokvm-usb-mouse-style';
const MOUSE_MODE_KEY = 'nanokvm-usb-mouse-mode';
const MOUSE_SCROLL_DIRECTION_KEY = 'nanokvm-usb-mouse-scroll-direction';
const MOUSE_SCROLL_INTERVAL_KEY = 'nanokvm-usb-mouse-scroll-interval';
const MOUSE_JIGGLER_MODE_KEY = 'nanokvm-usb-mouse-jiggler-mode';
const KEYBOARD_SHORTCUT_KEY = 'nanokvm-usb-keyboard-shortcut';

export function getLanguage() {
  return localStorage.getItem(LANGUAGE_KEY);
}

export function setLanguage(language: string) {
  localStorage.setItem(LANGUAGE_KEY, language);
}

export function setVideoDevice(id: string) {
  localStorage.setItem(VIDEO_DEVICE_ID_KEY, id);
}

export function getVideoDevice() {
  return localStorage.getItem(VIDEO_DEVICE_ID_KEY);
}

export function setVideoResolution(width: number, height: number) {
  localStorage.setItem(VIDEO_RESOLUTION_KEY, window.JSON.stringify({ width, height }));
}

export function getVideoResolution() {
  const resolution = localStorage.getItem(VIDEO_RESOLUTION_KEY);
  if (!resolution) return;
  return window.JSON.parse(resolution) as Resolution;
}

export function getCustomResolutions() {
  const resolution = localStorage.getItem(CUSTOM_RESOLUTION_KEY);
  if (!resolution) return;
  return window.JSON.parse(resolution) as Resolution[];
}

export function setCustomResolution(width: number, height: number) {
  const resolutions = getCustomResolutions();
  if (resolutions?.some((r) => r.width === width && r.height === height)) {
    return;
  }

  const data = resolutions ? [...resolutions, { width, height }] : [{ width, height }];
  localStorage.setItem(CUSTOM_RESOLUTION_KEY, window.JSON.stringify(data));
}

export function removeCustomResolutions() {
  localStorage.removeItem(CUSTOM_RESOLUTION_KEY);
}

export function getVideoScale(): number | null {
  const scale = localStorage.getItem(VIDEO_SCALE_KEY);
  if (scale && Number(scale)) {
    return Number(scale);
  }
  return null;
}

export function setVideoScale(scale: number): void {
  localStorage.setItem(VIDEO_SCALE_KEY, String(scale));
}

export function getVideoRotation(): Rotation | null {
  const rotation = localStorage.getItem(VIDEO_ROTATION_KEY);
  if (rotation) {
    const value = Number(rotation);
    if (value === 0 || value === 90 || value === 180 || value === 270) {
      return value as Rotation;
    }
  }
  return null;
}

export function setVideoRotation(rotation: Rotation): void {
  localStorage.setItem(VIDEO_ROTATION_KEY, String(rotation));
}

export function getIsMenuOpen(): boolean {
  const state = localStorage.getItem(IS_MENU_OPEN_KEY);
  if (!state) {
    return true;
  }
  return state === 'true';
}

export function setIsMenuOpen(isOpen: boolean) {
  localStorage.setItem(IS_MENU_OPEN_KEY, isOpen ? 'true' : 'false');
}

export function getMouseStyle() {
  return localStorage.getItem(MOUSE_STYLE_KEY);
}

export function setMouseStyle(mouse: string) {
  localStorage.setItem(MOUSE_STYLE_KEY, mouse);
}

export function getMouseMode() {
  return localStorage.getItem(MOUSE_MODE_KEY);
}

export function setMouseMode(mouse: string) {
  localStorage.setItem(MOUSE_MODE_KEY, mouse);
}

export function getMouseScrollDirection(): number | null {
  const direction = localStorage.getItem(MOUSE_SCROLL_DIRECTION_KEY);
  if (direction && Number(direction)) {
    return Number(direction);
  }
  return null;
}

export function setMouseScrollDirection(direction: number): void {
  localStorage.setItem(MOUSE_SCROLL_DIRECTION_KEY, String(direction));
}

export function getMouseScrollInterval(): number | null {
  const interval = localStorage.getItem(MOUSE_SCROLL_INTERVAL_KEY);
  if (interval && Number(interval)) {
    return Number(interval);
  }
  return null;
}

export function setMouseScrollInterval(interval: number): void {
  localStorage.setItem(MOUSE_SCROLL_INTERVAL_KEY, String(interval));
}

export function getShortcuts(): string | null {
  return localStorage.getItem(KEYBOARD_SHORTCUT_KEY);
}

export function setShortcuts(shortcuts: string): void {
  localStorage.setItem(KEYBOARD_SHORTCUT_KEY, shortcuts);
}

export function getMouseJigglerMode(): 'enable' | 'disable' {
  const jiggler = localStorage.getItem(MOUSE_JIGGLER_MODE_KEY);
  return jiggler && jiggler === 'enable' ? 'enable' : 'disable';
}

export function setMouseJigglerMode(jiggler: 'enable' | 'disable'): void {
  localStorage.setItem(MOUSE_JIGGLER_MODE_KEY, jiggler);
}

// ---------------------------------------------------------------------------
// Fork additions (spec §2.1 / §2.2). Every getter below validates the stored
// value, falls back to a documented default and never throws (storage may be
// missing, disabled or hold garbage). Existing keys above keep upstream semantics.
// ---------------------------------------------------------------------------

export type TargetOs = 'windows' | 'linux' | 'macos';
export type TargetLayout = 'us' | 'jis';

const TARGET_OS_KEY = 'nanokvm-usb-target-os';
const TARGET_LAYOUT_KEY = 'nanokvm-usb-target-layout';
const KEYBOARD_REMAP_KEY = 'nanokvm-usb-keyboard-remap';
const MOUSE_SCROLL_PX_PER_NOTCH_KEY = 'nanokvm-usb-mouse-scroll-px-per-notch';
const MOUSE_SENSITIVITY_KEY = 'nanokvm-usb-mouse-sensitivity';
const PASTE_SETTINGS_KEY = 'nanokvm-usb-paste-settings';
const PASTE_BRIDGE_INTRO_KEY = 'nanokvm-usb-paste-bridge-intro';
const DEBUG_HID_KEY = 'nanokvm-usb-debug-hid';

interface NumberRange {
  min: number;
  max: number;
  default: number;
}

/** Host pixels of wheel travel per emitted notch. */
export const SCROLL_PX_PER_NOTCH_RANGE: NumberRange = { min: 20, max: 400, default: 100 };
/** Relative-mode pointer gain. */
export const MOUSE_SENSITIVITY_RANGE: NumberRange = { min: 0.25, max: 4, default: 1 };

function readItem(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    // Storage disabled or quota exceeded: the setting simply does not persist.
  }
}

function removeItem(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function readNumber(key: string, range: NumberRange): number {
  const raw = readItem(key);
  if (raw === null || raw.trim() === '') return range.default;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < range.min || value > range.max) return range.default;
  return value;
}

function writeNumber(key: string, value: number, range: NumberRange): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  writeItem(key, String(Math.min(range.max, Math.max(range.min, value))));
}

function serializeJson(value: string | object): string | null {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : null;
  } catch {
    return null;
  }
}

/**
 * Parse a stored JSON document. Returns the object, or null when the value is
 * absent, malformed or not a plain object (arrays and primitives are rejected).
 */
export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The UI language the way i18n resolves it: stored choice, then navigator.language, else 'en'. */
function detectLanguage(): string {
  const stored = readItem(LANGUAGE_KEY);
  if (stored) return stored;
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
      return navigator.language;
    }
  } catch {
    // ignore
  }
  return 'en';
}

export function getTargetOs(): TargetOs {
  const os = readItem(TARGET_OS_KEY);
  return os === 'windows' || os === 'linux' || os === 'macos' ? os : 'windows';
}

export function setTargetOs(os: TargetOs): void {
  writeItem(TARGET_OS_KEY, os);
}

/** Stored layout, else 'jis' when the UI language is Japanese and 'us' otherwise. */
export function getTargetLayout(language: string = detectLanguage()): TargetLayout {
  const layout = readItem(TARGET_LAYOUT_KEY);
  if (layout === 'us' || layout === 'jis') return layout;
  return language.toLowerCase().startsWith('ja') ? 'jis' : 'us';
}

export function setTargetLayout(layout: TargetLayout): void {
  writeItem(TARGET_LAYOUT_KEY, layout);
}

/** Raw JSON string of the ⌘ remap config (normalisation lives in libs/keyboard/remap-config). */
export function getKeyboardRemapRaw(): string | null {
  return readItem(KEYBOARD_REMAP_KEY);
}

/** Accepts the config object or an already serialised JSON string. */
export function setKeyboardRemap(config: string | object): void {
  const json = serializeJson(config);
  if (json !== null) writeItem(KEYBOARD_REMAP_KEY, json);
}

export function getScrollPxPerNotch(): number {
  return readNumber(MOUSE_SCROLL_PX_PER_NOTCH_KEY, SCROLL_PX_PER_NOTCH_RANGE);
}

export function setScrollPxPerNotch(px: number): void {
  writeNumber(MOUSE_SCROLL_PX_PER_NOTCH_KEY, px, SCROLL_PX_PER_NOTCH_RANGE);
}

export function getMouseSensitivity(): number {
  return readNumber(MOUSE_SENSITIVITY_KEY, MOUSE_SENSITIVITY_RANGE);
}

export function setMouseSensitivity(gain: number): void {
  writeNumber(MOUSE_SENSITIVITY_KEY, gain, MOUSE_SENSITIVITY_RANGE);
}

/** Raw JSON string of the paste settings (normalisation lives in libs/paste/settings). */
export function getPasteSettingsRaw(): string | null {
  return readItem(PASTE_SETTINGS_KEY);
}

/** Accepts the settings object or an already serialised JSON string. */
export function setPasteSettings(settings: string | object): void {
  const json = serializeJson(settings);
  if (json !== null) writeItem(PASTE_SETTINGS_KEY, json);
}

/**
 * `'1'` once the user accepted the one-time explanation of the browser bridge
 * (spec v2 §9.1); per browser profile, like every key here.
 */
export function getPasteBridgeIntroAccepted(): boolean {
  return readItem(PASTE_BRIDGE_INTRO_KEY) === '1';
}

export function setPasteBridgeIntroAccepted(accepted: boolean): void {
  if (accepted) {
    writeItem(PASTE_BRIDGE_INTRO_KEY, '1');
  } else {
    removeItem(PASTE_BRIDGE_INTRO_KEY);
  }
}

/** `'1'` enables the HID log overlay (the `?debug=hid` query is handled by the overlay itself). */
export function getDebugHid(): boolean {
  return readItem(DEBUG_HID_KEY) === '1';
}

export function setDebugHid(enabled: boolean): void {
  if (enabled) {
    writeItem(DEBUG_HID_KEY, '1');
  } else {
    removeItem(DEBUG_HID_KEY);
  }
}
