export interface NormalizeOptions {
  /** Fold typographic punctuation to its ASCII equivalent and drop invisible characters. */
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
 * Invisible characters that would otherwise send an all-ASCII text through
 * the browser bridge (spec v2 §14.9): soft hyphen U+00AD, zero-width space
 * U+200B, (non-)joiners U+200C/U+200D, word joiner U+2060 and a BOM (zero-width
 * no-break space) U+FEFF anywhere in the text.
 */
const INVISIBLE_RE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;

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
 * With `punct`: fold smart quotes, dashes, NBSP and ellipsis to ASCII and
 * remove the invisible characters of INVISIBLE_RE. Only the direct (v1)
 * path normalises; the raw paths keep every character.
 */
export function normalizeText(text: string, options: NormalizeOptions): string {
  let t = foldLineBreaks(text).normalize('NFC');
  if (options.punct) {
    t = t.replace(PUNCT_RE, (ch) => PUNCT_MAP[ch] ?? ch).replace(INVISIBLE_RE, '');
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
