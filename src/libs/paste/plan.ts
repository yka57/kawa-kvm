import { foldLineBreaks, segmentGraphemes } from '@/libs/paste/normalize';
import type { UnicodeMethod } from '@/libs/paste/settings';
import { charLimit, isControl, textToKeySequence } from '@/libs/paste/text-to-keys';
import type { CompileOptions, CompileResult, CompileStats, SkippedChar } from '@/libs/paste/types';
import { compileUnicode } from '@/libs/paste/unicode-entry';

/**
 * Paste planning (spec v2 §3, pure): the v1 compiler when the target layout
 * can type the whole text, otherwise the resolved Unicode method on the RAW
 * text (no punctuation folding, no NFC: what the user copied is what arrives).
 */

export interface PlanOptions extends CompileOptions {
  method: UnicodeMethod;
}

export type PastePlan =
  | { kind: 'direct'; compiled: CompileResult }
  /** Ctrl+Shift+U strokes (spec §5). */
  | { kind: 'unicode'; compiled: CompileResult }
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

export function planPaste(text: string, o: PlanOptions): PastePlan {
  const compiled = textToKeySequence(text, o);
  if (o.method === 'skip' || !compiled.skipped.some((entry) => entry.reason === 'no-key')) {
    return { kind: 'direct', compiled };
  }
  const prepared = prepareRawText(text, o);
  if (o.method === 'ctrl-shift-u') {
    return { kind: 'unicode', compiled: compileUnicode(prepared, o) };
  }
  return { kind: 'bridge', text: prepared.text, stats: prepared.stats, skipped: prepared.skipped };
}
