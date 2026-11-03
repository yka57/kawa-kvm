export interface NormalizeOptions {
  /** Fold typographic punctuation to its ASCII equivalent. */
  punct: boolean;
}

/**
 * Typographic character -> ASCII replacement: single quotes U+2018/2019/201A,
 * double quotes U+201C/201D/201E, dashes U+2013/2014/2015, NBSP U+00A0 and
 * the ellipsis U+2026. Kept as escapes on purpose (lint forbids a literal NBSP).
 */
const PUNCT_MAP: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u00a0': ' ',
  '\u2026': '...'
};

const PUNCT_RE = /[\u2018\u2019\u201a\u201c\u201d\u201e\u2013\u2014\u2015\u00a0\u2026]/g;

/**
 * Strips a leading BOM and folds CRLF / lone CR to LF. Every compiler path
 * needs this before segmenting: Intl.Segmenter treats "\r\n" as ONE
 * grapheme, so a compiler must never see a raw CR.
 */
export function foldLineBreaks(text: string): string {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return t.replace(/\r\n?/g, '\n');
}

/**
 * Always: foldLineBreaks, then NFC.
 * With `punct`: fold smart quotes, dashes, NBSP and ellipsis to ASCII.
 */
export function normalizeText(text: string, options: NormalizeOptions): string {
  let t = foldLineBreaks(text).normalize('NFC');
  if (options.punct) {
    t = t.replace(PUNCT_RE, (ch) => PUNCT_MAP[ch] ?? ch);
  }
  return t;
}

/** Grapheme clusters via Intl.Segmenter when available, otherwise code points. */
export function segmentGraphemes(text: string): string[] {
  const Segmenter: typeof Intl.Segmenter | undefined = Intl.Segmenter;
  if (typeof Segmenter === 'function') {
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}
