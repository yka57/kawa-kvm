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

/**
 * Optional IME pre-key, then per grapheme: "\n" → Enter (newline mode),
 * "\t" → Tab, a layout-table hit → its direct stroke, anything else → one
 * Ctrl+Shift+U group per code point. `typed` counts graphemes.
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
        strokes.push(...codePointStrokes(ch.codePointAt(0) ?? 0, src, group, group === 0));
        group++;
      }
    }
    src++;
  }

  return { strokes, skipped: prepared.skipped, stats: prepared.stats };
}
