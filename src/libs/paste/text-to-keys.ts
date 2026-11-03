import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import { getTable } from '@/libs/paste/layouts';
import { normalizeText, segmentGraphemes } from '@/libs/paste/normalize';
import type {
  CompileOptions,
  CompileResult,
  KeyCombo,
  KeyStroke,
  SkippedChar
} from '@/libs/paste/types';

/** Graphemes beyond this count are reported as skipped with reason 'limit'. */
export const PASTE_HARD_LIMIT = 20000;
/** Above this many graphemes the UI asks for confirmation (with an ETA) first. */
export const PASTE_SOFT_LIMIT = 2000;

export const DEFAULT_COMPILE_OPTIONS: Readonly<CompileOptions> = {
  layout: 'us',
  newline: 'enter',
  normalizePunct: true,
  stripTrailingNewline: true,
  imePreKey: 'none',
  maxChars: PASTE_HARD_LIMIT
};

/** C0 (incl. DEL) and C1 control characters. */
function isControl(codePoint: number): boolean {
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function comboStroke(combo: KeyCombo, src: number): KeyStroke | null {
  const key = KeycodeMap[combo.key];
  if (key === undefined) return null;
  return { mod: combo.shift ? ModifierBits.LeftShift : 0, key, src, tag: 'char' };
}

/**
 * Compiles text into HID strokes (spec §5.1). Per grapheme: "\n" → Enter (or
 * Shift+Enter), "\t" → Tab, table hit → stroke, C0/C1 control → skipped
 * 'control', anything else → skipped 'no-key'. Nothing is dropped silently.
 */
export function textToKeySequence(text: string, o: CompileOptions): CompileResult {
  const normalized = normalizeText(text, { punct: o.normalizePunct });
  const graphemes = segmentGraphemes(normalized);

  let trailingNewlineStripped = false;
  if (o.stripTrailingNewline && graphemes.length > 0 && graphemes[graphemes.length - 1] === '\n') {
    graphemes.pop();
    trailingNewlineStripped = true;
  }

  const limit = Number.isFinite(o.maxChars)
    ? Math.max(0, Math.floor(o.maxChars))
    : PASTE_HARD_LIMIT;
  const truncated = graphemes.length > limit;
  const end = Math.min(graphemes.length, limit);
  const table = getTable(o.layout);
  const enterMod = o.newline === 'shift-enter' ? ModifierBits.LeftShift : 0;

  const strokes: KeyStroke[] = [];
  const skipped: SkippedChar[] = [];
  let typed = 0;

  if (o.imePreKey !== 'none') {
    const key = KeycodeMap[o.imePreKey];
    if (key !== undefined) {
      strokes.push({ mod: 0, key, src: -1, tag: 'ime-pre' });
    }
  }

  for (let i = 0; i < end; i++) {
    const grapheme = graphemes[i];
    if (grapheme === '\n') {
      strokes.push({ mod: enterMod, key: KeycodeMap.Enter, src: i, tag: 'enter' });
      typed++;
      continue;
    }
    if (grapheme === '\t') {
      strokes.push({ mod: 0, key: KeycodeMap.Tab, src: i, tag: 'tab' });
      typed++;
      continue;
    }
    const combo = Object.prototype.hasOwnProperty.call(table, grapheme)
      ? table[grapheme]
      : undefined;
    const stroke = combo ? comboStroke(combo, i) : null;
    if (stroke) {
      strokes.push(stroke);
      typed++;
      continue;
    }
    const codePoint = grapheme.codePointAt(0) ?? 0;
    skipped.push({ char: grapheme, index: i, reason: isControl(codePoint) ? 'control' : 'no-key' });
  }

  for (let i = end; i < graphemes.length; i++) {
    skipped.push({ char: graphemes[i], index: i, reason: 'limit' });
  }

  return {
    strokes,
    skipped,
    stats: {
      chars: graphemes.length,
      typed,
      skipped: skipped.length,
      truncated,
      trailingNewlineStripped
    }
  };
}
