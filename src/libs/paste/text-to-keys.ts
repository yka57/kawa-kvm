import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import { getTable } from '@/libs/paste/layouts';
import { normalizeText, segmentGraphemes } from '@/libs/paste/normalize';
import type {
  CompileOptions,
  CompileResult,
  ImePreKey,
  KeyStroke,
  LayoutTable,
  NewlineMode,
  SkippedChar
} from '@/libs/paste/types';

/** Graphemes beyond this count are reported as skipped with reason 'limit'. */
export const PASTE_HARD_LIMIT = 20000;
/** Above this many graphemes the UI asks for confirmation (with an ETA) first. */
export const PASTE_SOFT_LIMIT = 2000;
/** Pause after the IME pre-key so the target IME has switched before the first character (spec §6). */
export const IME_SETTLE_MS = 150;

export const DEFAULT_COMPILE_OPTIONS: Readonly<CompileOptions> = {
  layout: 'us',
  newline: 'enter',
  normalizePunct: true,
  stripTrailingNewline: true,
  imePreKey: 'none',
  maxChars: PASTE_HARD_LIMIT
};

/** C0 (incl. DEL) and C1 control characters. */
export function isControl(codePoint: number): boolean {
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/** Grapheme cap of a compile; a non-finite `maxChars` means the hard limit. */
export function charLimit(maxChars: number): number {
  return Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : PASTE_HARD_LIMIT;
}

/** Enter (or Shift+Enter) for "\n", Tab for "\t"; null for any other grapheme. */
export function controlStroke(
  grapheme: string,
  newline: NewlineMode,
  src: number
): KeyStroke | null {
  if (grapheme === '\n') {
    const mod = newline === 'shift-enter' ? ModifierBits.LeftShift : 0;
    return { mod, key: KeycodeMap.Enter, src, tag: 'enter' };
  }
  if (grapheme === '\t') return { mod: 0, key: KeycodeMap.Tab, src, tag: 'tab' };
  return null;
}

/** The layout table's stroke for a grapheme; null when the target layout has no key for it. */
export function tableStroke(table: LayoutTable, grapheme: string, src: number): KeyStroke | null {
  // own properties only: "constructor" must not resolve to Object.prototype
  const combo = Object.prototype.hasOwnProperty.call(table, grapheme) ? table[grapheme] : undefined;
  const key = combo ? KeycodeMap[combo.key] : undefined;
  if (!combo || key === undefined) return null;
  return { mod: combo.shift ? ModifierBits.LeftShift : 0, key, src, tag: 'char' };
}

/** The stroke that turns the target IME off before typing; null for 'none'. */
export function imePreStroke(preKey: ImePreKey, afterMs: number = IME_SETTLE_MS): KeyStroke | null {
  const key = preKey === 'none' ? undefined : KeycodeMap[preKey];
  if (key === undefined) return null;
  return { mod: 0, key, src: -1, tag: 'ime-pre', afterMs };
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

  const limit = charLimit(o.maxChars);
  const truncated = graphemes.length > limit;
  const end = Math.min(graphemes.length, limit);
  const table = getTable(o.layout);

  const strokes: KeyStroke[] = [];
  const skipped: SkippedChar[] = [];
  let typed = 0;

  const pre = imePreStroke(o.imePreKey);
  if (pre) strokes.push(pre);

  for (let i = 0; i < end; i++) {
    const grapheme = graphemes[i];
    const stroke = controlStroke(grapheme, o.newline, i) ?? tableStroke(table, grapheme, i);
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
