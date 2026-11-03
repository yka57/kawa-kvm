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
 * Always: strip a leading BOM, fold CRLF / lone CR to LF, apply NFC.
 * With `punct`: fold smart quotes, dashes, NBSP and ellipsis to ASCII.
 * CRLF folding happens here on purpose: Intl.Segmenter treats "\r\n" as ONE
 * grapheme, so the compiler must never see a raw CR.
 */
export function normalizeText(text: string, options: NormalizeOptions): string {
  let t = text;
  if (t.charCodeAt(0) === 0xfeff) {
    t = t.slice(1);
  }
  t = t.replace(/\r\n?/g, '\n');
  t = t.normalize('NFC');
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
