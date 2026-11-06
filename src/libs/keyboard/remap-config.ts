import { isModifier } from './keymap';

/**
 * Configuration of the ⌘ remap feature (spec §3.2). Pure: no DOM, no React.
 */
export interface KeyboardRemapConfig {
  version: 1;
  /** ⌘ → Ctrl on macOS hosts (inactive on other hosts and when the target OS is macOS). */
  enabled: boolean;
  /** cmdArrows / optWord / cmdTabSwitch navigation rules. */
  navRules: boolean;
  /** 英数/かな (Lang2/Lang1) → 無変換/変換 (NonConvert/Convert). */
  jisEisuKana: boolean;
  /** Tap CapsLock on both keydown and keyup on a macOS host (effective only when active). */
  macCapsLockFix: boolean;
  /** Auto-release delay for keys tapped under ⌘ (clamped 20..200). */
  tapReleaseMs: number;
  /** Minimum press time honoured by the ⌘-up sweep (clamped 0..100). */
  minPressMs: number;
  /** Host autorepeat under ⌘ re-taps once the previous tap finished. */
  repeatUnderMeta: boolean;
  /**
   * ⌘ split: ⌘ + one of `ctrlKeys` is sent as Ctrl, ⌘ + any other key as Win,
   * ⌘ alone as a Win tap. false = every ⌘ is Ctrl (v1 behaviour).
   */
  cmdSplit: boolean;
  /** Keys (A–Z, 0–9) that ⌘ sends as Ctrl in split mode, e.g. "ACFVXZ". */
  ctrlKeys: string;
}

export const DEFAULT_REMAP_CONFIG: KeyboardRemapConfig = {
  version: 1,
  enabled: true,
  navRules: true,
  jisEisuKana: false,
  macCapsLockFix: true,
  tapReleaseMs: 50,
  minPressMs: 30,
  repeatUnderMeta: true,
  cmdSplit: true,
  ctrlKeys: 'ACFVXZ'
};

/** Uppercase A–Z / 0–9 only, each once, in input order. */
export function normalizeCtrlKeys(value: string): string {
  let out = '';
  for (const ch of value.toUpperCase()) {
    if (/^[A-Z0-9]$/.test(ch) && !out.includes(ch)) out += ch;
  }
  return out;
}

/** Physical key code → its ctrlKeys character (KeyC → 'C', Digit1 → '1'), or null. */
function ctrlKeyChar(code: string): string | null {
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  return m ? (m[1] ?? m[2]) : null;
}

/** Split mode: does ⌘ + this physical key go out as Ctrl? */
export function isCtrlKey(cfg: KeyboardRemapConfig, code: string): boolean {
  const ch = ctrlKeyChar(code);
  return ch !== null && cfg.ctrlKeys.includes(ch);
}

export const TAP_RELEASE_MS_RANGE = { min: 20, max: 200 } as const;
export const MIN_PRESS_MS_RANGE = { min: 0, max: 100 } as const;

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Tolerant normaliser: accepts a parsed object or a JSON string; anything else
 * (or malformed JSON) yields the defaults. Unknown fields are dropped, missing
 * fields are defaulted, numbers are clamped. Never throws.
 */
export function normalizeRemapConfig(raw: unknown): KeyboardRemapConfig {
  let source: unknown = raw;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      source = null;
    }
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return { ...DEFAULT_REMAP_CONFIG };
  }
  const o = source as Record<string, unknown>;
  const d = DEFAULT_REMAP_CONFIG;
  return {
    version: 1,
    enabled: pickBoolean(o.enabled, d.enabled),
    navRules: pickBoolean(o.navRules, d.navRules),
    jisEisuKana: pickBoolean(o.jisEisuKana, d.jisEisuKana),
    macCapsLockFix: pickBoolean(o.macCapsLockFix, d.macCapsLockFix),
    tapReleaseMs: pickNumber(
      o.tapReleaseMs,
      d.tapReleaseMs,
      TAP_RELEASE_MS_RANGE.min,
      TAP_RELEASE_MS_RANGE.max
    ),
    minPressMs: pickNumber(
      o.minPressMs,
      d.minPressMs,
      MIN_PRESS_MS_RANGE.min,
      MIN_PRESS_MS_RANGE.max
    ),
    repeatUnderMeta: pickBoolean(o.repeatUnderMeta, d.repeatUnderMeta),
    cmdSplit: pickBoolean(o.cmdSplit, d.cmdSplit),
    ctrlKeys: typeof o.ctrlKeys === 'string' ? normalizeCtrlKeys(o.ctrlKeys) : d.ctrlKeys
  };
}

/** Host modifier flags of a DOM key event (metaKey/ctrlKey/altKey/shiftKey). */
export interface HostMods {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface Chord {
  code: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface HostAction {
  id: 'paste-host-clipboard';
  chord: Chord;
  enabled: boolean;
}

export interface RemapContext {
  cfg: KeyboardRemapConfig;
  /** hostOS === 'macOS' && cfg.enabled && targetOs !== 'macos' (see isRemapActive). */
  active: boolean;
  hostActions: HostAction[];
}

/** Spec §3.1: active iff the host is macOS, the remap is enabled and the target is not macOS. */
export function isRemapActive(cfg: KeyboardRemapConfig, hostOS: string, targetOs: string): boolean {
  return hostOS === 'macOS' && cfg.enabled && targetOs !== 'macos';
}

/** Exact modifier match on the chord; never matches an autorepeat keydown. */
export function matchChord(
  ev: { code: string; mods: HostMods; repeat: boolean },
  c: Chord
): boolean {
  if (ev.repeat || ev.code !== c.code) return false;
  return (
    ev.mods.meta === !!c.meta &&
    ev.mods.ctrl === !!c.ctrl &&
    ev.mods.alt === !!c.alt &&
    ev.mods.shift === !!c.shift
  );
}

/** MetaLeft→ControlLeft, MetaRight→ControlRight while active; identity otherwise. */
export function mapModifier(code: string, active: boolean): string {
  if (!active) return code;
  if (code === 'MetaLeft') return 'ControlLeft';
  if (code === 'MetaRight') return 'ControlRight';
  return code;
}

function modifierLabel(code: string): string {
  if (code.startsWith('Control')) return 'Ctrl';
  if (code.startsWith('Shift')) return 'Shift';
  if (code.startsWith('Alt')) return 'Alt';
  return 'Win';
}

/**
 * Shortcut-recorder helper: the code to store (⌘ recorded as Ctrl while active)
 * and the label the recorder uses for modifiers. Non-modifiers pass through
 * with their code as label (the recorder keeps its own key labelling).
 */
export function remapRecordedCode(code: string, active: boolean): { code: string; label: string } {
  const mapped = mapModifier(code, active);
  if (isModifier(mapped)) {
    return { code: mapped, label: modifierLabel(mapped) };
  }
  return { code: mapped, label: mapped };
}

export type ModifierOverride = Partial<Record<'ctrl' | 'alt' | 'shift' | 'meta', boolean>>;

export interface RuleOutput {
  /** HID code to emit instead of the host code. */
  emit: string;
  /** true = force that logical modifier down, false = force every code of it up, absent = keep. */
  mods: ModifierOverride;
}

export type RemapRuleId = 'cmdArrows' | 'optWord' | 'cmdTabSwitch' | 'jisEisuKana';

interface RuleTrigger {
  meta: boolean;
  alt: boolean;
  ctrl: boolean;
  /** Only compared when given. */
  shift?: boolean;
}

export interface RemapRule {
  id: RemapRuleId;
  /** Config flag that enables the rule. */
  flag: 'navRules' | 'jisEisuKana';
  trigger: RuleTrigger;
  keys: Record<string, RuleOutput>;
  /**
   * Matched on the printed character (`event.key`) instead of `keys` whenever
   * the event carries one: Chrome's own ⌘⇧[ / ⌘⇧] bindings follow the
   * character, and on a JIS Mac the key printed `[` has the code BracketRight
   * (`]` is Backslash, BracketLeft is `@`).
   */
  chars?: Record<string, RuleOutput>;
}

const CMD_ARROW_KEYS: Record<string, RuleOutput> = {
  ArrowLeft: { emit: 'Home', mods: { ctrl: false, meta: false } },
  ArrowRight: { emit: 'End', mods: { ctrl: false, meta: false } },
  ArrowUp: { emit: 'Home', mods: { ctrl: true, meta: false } },
  ArrowDown: { emit: 'End', mods: { ctrl: true, meta: false } }
};

const OPT_WORD_KEYS: Record<string, RuleOutput> = {
  ArrowLeft: { emit: 'ArrowLeft', mods: { ctrl: true, alt: false } },
  ArrowRight: { emit: 'ArrowRight', mods: { ctrl: true, alt: false } },
  Backspace: { emit: 'Backspace', mods: { ctrl: true, alt: false } },
  Delete: { emit: 'Delete', mods: { ctrl: true, alt: false } }
};

const CMD_TAB_PREV: RuleOutput = { emit: 'Tab', mods: { ctrl: true, shift: true, meta: false } };
const CMD_TAB_NEXT: RuleOutput = { emit: 'Tab', mods: { ctrl: true, shift: false, meta: false } };

/** Rule table of spec §3.2; exact match on physical meta/alt/ctrl, shift only where given. */
export const REMAP_RULES: readonly RemapRule[] = [
  {
    id: 'cmdArrows',
    flag: 'navRules',
    trigger: { meta: true, alt: false, ctrl: false },
    keys: CMD_ARROW_KEYS
  },
  {
    id: 'optWord',
    flag: 'navRules',
    trigger: { meta: false, alt: true, ctrl: false },
    keys: OPT_WORD_KEYS
  },
  {
    id: 'cmdTabSwitch',
    flag: 'navRules',
    trigger: { meta: true, alt: false, ctrl: false, shift: true },
    keys: { BracketLeft: CMD_TAB_PREV, BracketRight: CMD_TAB_NEXT },
    chars: { '[': CMD_TAB_PREV, '{': CMD_TAB_PREV, ']': CMD_TAB_NEXT, '}': CMD_TAB_NEXT }
  },
  {
    id: 'cmdTabSwitch',
    flag: 'navRules',
    trigger: { meta: true, alt: true, ctrl: false },
    keys: {
      ArrowLeft: { emit: 'Tab', mods: { ctrl: true, alt: false, shift: true, meta: false } },
      ArrowRight: { emit: 'Tab', mods: { ctrl: true, alt: false, shift: false, meta: false } }
    }
  },
  {
    id: 'jisEisuKana',
    flag: 'jisEisuKana',
    trigger: { meta: false, alt: false, ctrl: false },
    keys: {
      Lang2: { emit: 'NonConvert', mods: {} },
      Lang1: { emit: 'Convert', mods: {} }
    }
  }
];

const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

/** `event.key` of a printable key is one character; named keys ('ArrowLeft', 'Dead', 'Process') are longer. */
function printableChar(key: string | undefined): string | null {
  return typeof key === 'string' && key.length === 1 ? key : null;
}

/**
 * First enabled rule whose trigger matches the PHYSICAL host modifiers; null
 * when inactive. `key` is the event's `key` value: a rule with a character
 * table is decided by it when the event carries a printable character (the
 * code table would lie on a non-US host layout) and by the code table otherwise.
 */
export function matchRule(
  ctx: RemapContext,
  mods: HostMods,
  code: string,
  key?: string
): RuleOutput | null {
  if (!ctx.active) return null;
  const char = printableChar(key);
  for (const rule of REMAP_RULES) {
    if (!ctx.cfg[rule.flag]) continue;
    const t = rule.trigger;
    if (t.meta !== mods.meta || t.alt !== mods.alt || t.ctrl !== mods.ctrl) continue;
    if (t.shift !== undefined && t.shift !== mods.shift) continue;
    if (rule.chars && char !== null) {
      if (hasOwn(rule.chars, char)) return rule.chars[char];
      continue;
    }
    if (hasOwn(rule.keys, code)) return rule.keys[code];
  }
  return null;
}
