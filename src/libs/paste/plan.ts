import { foldLineBreaks, segmentGraphemes } from '@/libs/paste/normalize';
import type { UnicodeMethod } from '@/libs/paste/settings';
import { charLimit, isControl, textToKeySequence } from '@/libs/paste/text-to-keys';
import type { CompileOptions, CompileResult, CompileStats, SkippedChar } from '@/libs/paste/types';
import { PACING, type Pacing, type SpeedPreset } from '@/libs/paste/typing-engine';
import { compileUnicode } from '@/libs/paste/unicode-entry';

/**
 * Paste planning (spec v2 §3, pure): the v1 compiler when the target layout
 * can type the whole text, otherwise the resolved Unicode method on the RAW
 * text (no punctuation folding, no NFC: what the user copied is what arrives).
 */

export interface PlanOptions extends CompileOptions {
  method: UnicodeMethod;
}

/** The methods that enter a code point by its code, stroke by stroke. */
export type CodeEntryMethod = Extract<UnicodeMethod, 'ctrl-shift-u' | 'alt-hex' | 'ime-code'>;

export type PastePlan =
  | { kind: 'direct'; compiled: CompileResult }
  /** Ctrl+Shift+U (spec §5), Alt+numpad hex or Microsoft IME code-input strokes. */
  | { kind: 'unicode'; method: CodeEntryMethod; compiled: CompileResult }
  | { kind: 'bridge'; text: string; stats: CompileStats; skipped: SkippedChar[] };

export interface PreparedText {
  /** The kept graphemes joined. */
  text: string;
  /** The kept graphemes, in order. */
  graphemes: string[];
  /** Controls ('control') and the truncated tail ('limit'), indexed like CompileResult.skipped. */
  skipped: SkippedChar[];
  stats: CompileStats;
}

/**
 * The raw-path text: leading BOM stripped and line breaks folded to LF (as
 * everywhere), one trailing newline dropped when asked, then graphemes past
 * `maxChars` and C0/C1 controls other than "\n" and "\t" are skipped.
 */
export function prepareRawText(
  text: string,
  o: { stripTrailingNewline: boolean; maxChars: number }
): PreparedText {
  const all = segmentGraphemes(foldLineBreaks(text));
  let trailingNewlineStripped = false;
  if (o.stripTrailingNewline && all.length > 0 && all[all.length - 1] === '\n') {
    all.pop();
    trailingNewlineStripped = true;
  }

  const limit = charLimit(o.maxChars);
  const graphemes: string[] = [];
  const skipped: SkippedChar[] = [];
  all.forEach((grapheme, index) => {
    if (index >= limit) {
      skipped.push({ char: grapheme, index, reason: 'limit' });
    } else if (grapheme !== '\n' && grapheme !== '\t' && isControl(grapheme.codePointAt(0) ?? 0)) {
      skipped.push({ char: grapheme, index, reason: 'control' });
    } else {
      graphemes.push(grapheme);
    }
  });

  return {
    text: graphemes.join(''),
    graphemes,
    skipped,
    stats: {
      chars: all.length,
      typed: graphemes.length,
      skipped: skipped.length,
      truncated: all.length > limit,
      trailingNewlineStripped
    }
  };
}

/**
 * 'direct' when the layout can type the whole text (or the method is 'skip'),
 * otherwise the method's plan for the raw text. 'ime-code' is the one method
 * that can leave the target IME on (a run stopped inside a stretch of code
 * units), so its direct plan starts with LANG2 too, whatever the pre-key
 * setting says: the next text, were it only ASCII, would otherwise be typed
 * into the IME.
 */
export function planPaste(text: string, o: PlanOptions): PastePlan {
  const compiled = textToKeySequence(
    text,
    o.method === 'ime-code' ? { ...o, imePreKey: 'Lang2' } : o
  );
  if (o.method === 'skip' || !compiled.skipped.some((entry) => entry.reason === 'no-key')) {
    return { kind: 'direct', compiled };
  }
  const prepared = prepareRawText(text, o);
  if (o.method === 'ctrl-shift-u' || o.method === 'alt-hex' || o.method === 'ime-code') {
    return { kind: 'unicode', method: o.method, compiled: compileUnicode(prepared, o) };
  }
  return { kind: 'bridge', text: prepared.text, stats: prepared.stats, skipped: prepared.skipped };
}

/** The fastest speed preset a text entered by IME code input is typed at. */
export const IME_CODE_FASTEST_SPEED: SpeedPreset = 'normal';

/**
 * The pace a plan is typed at: the speed preset, except that a text entered by
 * IME code input is typed no faster than 'normal' (20 ms / 20 ms). The whole
 * text, its direct keys included: with 'fast' selected, exactly what 'normal'
 * sends goes out. A text the layout types completely (a direct plan) keeps
 * the preset, as with every other method.
 *
 * Measured (Windows 11, new Microsoft IME, CKEditor 5; the failure is always
 * the same: the first digit after a commit gets no keydown, and the character
 * arrives as its last three keys, unconverted):
 * - every key at 10 ms / 10 ms: 20 of 200 first pastes after a focus change
 *   lost a digit (the IME's second conversion then takes 23–30 ms, not 5);
 * - F5 and the commit at 40 ms, the digits still at 10 ms / 10 ms: a page
 *   that needs 30 ms for every input event lost one in 10 of 84 runs;
 * - every key of a stretch 40 ms apart but held for 10 ms: 2 of 20 first
 *   pastes after a load of that slow page lost one, against none of 20 at
 *   20 ms / 20 ms.
 * At 20 ms / 20 ms none of the three happened. A destination slower still
 * (45 ms or more per input event) lost digits at 20 ms / 20 ms too (5 of 46
 * runs) and none at 50 ms / 50 ms, the 'safe' preset (30 of 30).
 */
export function planPacing(plan: PastePlan, speed: SpeedPreset): Pacing {
  const codeInput = plan.kind === 'unicode' && plan.method === 'ime-code';
  return PACING[codeInput && speed === 'fast' ? IME_CODE_FASTEST_SPEED : speed];
}
