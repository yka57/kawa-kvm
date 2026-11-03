import { describe, expect, it } from 'vitest';

import { normalizeText, segmentGraphemes } from './normalize';

const BOM = '\ufeff';
const NBSP = '\u00a0';
const FAMILY = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';

/** Runs `fn` with Intl.Segmenter hidden so the Array.from fallback is exercised. */
function withoutSegmenter<T>(fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
  Object.defineProperty(Intl, 'Segmenter', {
    value: undefined,
    configurable: true,
    writable: true
  });
  try {
    return fn();
  } finally {
    if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor);
  }
}

describe('normalizeText', () => {
  it('always strips a leading BOM', () => {
    expect(normalizeText(`${BOM}abc`, { punct: false })).toBe('abc');
    expect(normalizeText(`${BOM}abc`, { punct: true })).toBe('abc');
    expect(normalizeText(`a${BOM}b`, { punct: false })).toBe(`a${BOM}b`);
  });

  it('removes soft hyphens, zero-width characters, word joiners and BOMs only with the flag', () => {
    const text = 'a\u00adb\u200bc\u200cd\u200de\u2060f\ufeffg';
    expect(normalizeText(text, { punct: true })).toBe('abcdefg');
    expect(normalizeText(text, { punct: false })).toBe(text);
    expect(normalizeText(`${BOM}${BOM}x`, { punct: true })).toBe('x');
    // other invisible or format characters are not folded
    expect(normalizeText('a\u200eb\u00a0c', { punct: true })).toBe('a\u200eb c');
  });

  it('always folds CRLF and lone CR to LF', () => {
    expect(normalizeText('a\r\nb\rc\n\r\n', { punct: false })).toBe('a\nb\nc\n\n');
    expect(normalizeText('a\r\nb', { punct: true })).toBe('a\nb');
  });

  it('always applies NFC', () => {
    expect(normalizeText('e\u0301', { punct: false })).toBe('\u00e9');
    expect(normalizeText('\u30ab\u3099', { punct: false })).toBe('\u30ac'); // KA + dakuten -> GA
  });

  it('folds smart quotes, dashes, NBSP and ellipsis only with the flag', () => {
    const input = `\u201cHi\u201d \u2018x\u2019 \u201ay a\u2013b c\u2014d e\u2015f g${NBSP}h\u2026`;
    expect(normalizeText(input, { punct: true })).toBe(`"Hi" 'x' 'y a-b c-d e-f g h...`);
    expect(normalizeText(input, { punct: false })).toBe(input);
    expect(normalizeText(`${NBSP}${NBSP}`, { punct: true })).toBe('  ');
    expect(normalizeText(`${NBSP}${NBSP}`, { punct: false })).toBe(`${NBSP}${NBSP}`);
  });

  it('leaves ASCII and Japanese text alone', () => {
    const text = 'ascii !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ ABC xyz 123 \u65e5\u672c\u8a9e';
    expect(normalizeText(text, { punct: true })).toBe(text);
    expect(normalizeText(text, { punct: false })).toBe(text);
  });

  it('does not fold full-width characters (out of scope)', () => {
    expect(normalizeText('\uff21\u3000', { punct: true })).toBe('\uff21\u3000');
  });
});

describe('segmentGraphemes', () => {
  it('uses Intl.Segmenter when present (CRLF and ZWJ sequences are single graphemes)', () => {
    expect(typeof Intl.Segmenter).toBe('function');
    expect(segmentGraphemes('a\r\nb')).toEqual(['a', '\r\n', 'b']);
    expect(segmentGraphemes(`x${FAMILY}y`)).toEqual(['x', FAMILY, 'y']);
    expect(segmentGraphemes('e\u0301')).toEqual(['e\u0301']);
    expect(segmentGraphemes('')).toEqual([]);
  });

  it('falls back to code points without Intl.Segmenter', () => {
    withoutSegmenter(() => {
      expect(Intl.Segmenter).toBeUndefined();
      expect(segmentGraphemes('a\r\nb')).toEqual(['a', '\r', '\n', 'b']);
      expect(segmentGraphemes('x\u{1f468}\u200dy')).toEqual(['x', '\u{1f468}', '\u200d', 'y']);
      expect(segmentGraphemes('e\u0301')).toEqual(['e', '\u0301']);
    });
    expect(typeof Intl.Segmenter).toBe('function');
  });

  it('agrees on normalized ASCII text in both paths', () => {
    const text = normalizeText('a\r\nb\tc', { punct: false });
    const withSegmenter = segmentGraphemes(text);
    const fallback = withoutSegmenter(() => segmentGraphemes(text));
    expect(withSegmenter).toEqual(['a', '\n', 'b', '\t', 'c']);
    expect(fallback).toEqual(withSegmenter);
  });
});
