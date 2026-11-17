import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import { getTable } from '@/libs/paste/layouts';
import type { PlanOptions, PreparedText } from '@/libs/paste/plan';
import { controlStroke, imePreStroke, tableStroke } from '@/libs/paste/text-to-keys';
import type { CompileResult, KeyStroke } from '@/libs/paste/types';

/**
 * Ctrl+Shift+U code point entry for Linux targets (spec v2 §5, pure): IBus,
 * fcitx5, GTK and Chromium read the hex digits after the trigger and commit
 * on Space (Enter could submit a form). One code point per sequence.
 */

/** After the trigger's release. */
export const UNICODE_TRIGGER_SETTLE_MS = 80;
/** After the first trigger of a run: IBus loads its data lazily. */
export const UNICODE_FIRST_TRIGGER_SETTLE_MS = 400;
/** After the committing Space. */
export const UNICODE_COMMIT_SETTLE_MS = 80;

const TRIGGER_MOD = ModifierBits.LeftCtrl | ModifierBits.LeftShift;

/** Main-row key of a lowercase hex digit; never the keypad, whose digits depend on NumLock. */
function hexDigitKey(digit: string): number {
  return digit >= 'a' ? KeycodeMap[`Key${digit.toUpperCase()}`] : KeycodeMap[`Digit${digit}`];
}

/**
 * Ctrl+Shift+U, the code point in lowercase hex (at least four digits),
 * Space; one atomic group so a cancel never leaves the target mid-entry.
 */
export function codePointStrokes(
  cp: number,
  src: number,
  group: number,
  first: boolean
): KeyStroke[] {
  const strokes: KeyStroke[] = [
    {
      mod: TRIGGER_MOD,
      key: KeycodeMap.KeyU,
      src,
      tag: 'unicode',
      afterMs: first ? UNICODE_FIRST_TRIGGER_SETTLE_MS : UNICODE_TRIGGER_SETTLE_MS,
      group
    }
  ];
  for (const digit of cp.toString(16).padStart(4, '0')) {
    strokes.push({ mod: 0, key: hexDigitKey(digit), src, tag: 'unicode', group });
  }
  strokes.push({
    mod: 0,
    key: KeycodeMap.Space,
    src,
    tag: 'unicode',
    afterMs: UNICODE_COMMIT_SETTLE_MS,
    group
  });
  return strokes;
}

/** After Alt goes up: the target commits the character. */
export const ALT_HEX_COMMIT_SETTLE_MS = 30;

/** Alt+numpad digits are read by scan code, whatever NumLock says; a–f are the letter keys. */
function altHexDigitKey(digit: string): number {
  return digit >= 'a' ? KeycodeMap[`Key${digit.toUpperCase()}`] : KeycodeMap[`Numpad${digit}`];
}

/**
 * Windows hex-numpad entry (needs HKCU\Control Panel\Input Method
 * EnableHexNumpad = "1" on the target): Alt stays down over keypad +, the
 * UTF-16 code unit in hex, and goes up with the last digit. One atomic group.
 */
export function altHexUnitStrokes(unit: number, src: number, group: number): KeyStroke[] {
  const alt = ModifierBits.LeftAlt;
  const keys = [KeycodeMap.NumpadAdd, ...[...unit.toString(16)].map(altHexDigitKey)];
  return keys.map((key, i) => {
    const last = i === keys.length - 1;
    const stroke: KeyStroke = { mod: alt, key, src, tag: 'unicode', group };
    if (last) stroke.afterMs = ALT_HEX_COMMIT_SETTLE_MS;
    else stroke.hold = alt;
    return stroke;
  });
}

/** One Alt entry per UTF-16 code unit (a surrogate pair is two entries). */
export function altHexStrokes(cp: number, src: number, group: number): KeyStroke[] {
  const text = String.fromCodePoint(cp);
  const strokes: KeyStroke[] = [];
  for (let i = 0; i < text.length; i++) {
    strokes.push(...altHexUnitStrokes(text.charCodeAt(i), src, group));
  }
  return strokes;
}

/**
 * Optional IME pre-key, then per grapheme: "\n" → Enter (newline mode),
 * "\t" → Tab, a layout-table hit → its direct stroke, anything else → one
 * group per code point: Ctrl+Shift+U, or Alt+numpad hex for 'alt-hex'.
 * `typed` counts graphemes.
 */
export function compileUnicode(prepared: PreparedText, o: PlanOptions): CompileResult {
  const table = getTable(o.layout);
  const strokes: KeyStroke[] = [];
  const pre = imePreStroke(o.imePreKey);
  if (pre) strokes.push(pre);

  // src indexes the segmented text like `skipped` does: skip the indices of removed graphemes
  const removed = new Set(prepared.skipped.map((entry) => entry.index));
  let src = 0;
  let group = 0;
  for (const grapheme of prepared.graphemes) {
    while (removed.has(src)) src++;
    const stroke = controlStroke(grapheme, o.newline, src) ?? tableStroke(table, grapheme, src);
    if (stroke) {
      strokes.push(stroke);
    } else {
      for (const ch of grapheme) {
        const cp = ch.codePointAt(0) ?? 0;
        strokes.push(
          ...(o.method === 'alt-hex'
            ? altHexStrokes(cp, src, group)
            : codePointStrokes(cp, src, group, group === 0))
        );
        group++;
      }
    }
    src++;
  }

  return { strokes, skipped: prepared.skipped, stats: prepared.stats };
}
