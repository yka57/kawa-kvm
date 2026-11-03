import { describe, expect, it } from 'vitest';

import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import type { CompileOptions, KeyStroke } from '@/libs/paste/types';
import { CharCodes, ShiftChars } from '@/test/legacy-char-codes';

import {
  DEFAULT_COMPILE_OPTIONS,
  IME_SETTLE_MS,
  PASTE_HARD_LIMIT,
  PASTE_SOFT_LIMIT,
  textToKeySequence
} from './text-to-keys';

const SHIFT = ModifierBits.LeftShift;

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

function opts(over: Partial<CompileOptions> = {}): CompileOptions {
  return {
    layout: 'us',
    newline: 'enter',
    normalizePunct: false,
    stripTrailingNewline: false,
    imePreKey: 'none',
    maxChars: PASTE_HARD_LIMIT,
    ...over
  };
}

const pairs = (strokes: KeyStroke[]) => strokes.map((s) => [s.mod, s.key]);

/** The upstream paste loop (components/menu/keyboard/paste.tsx) as a reference. */
function legacyPairs(text: string): number[][] {
  const out: number[][] = [];
  for (const char of text) {
    const ascii = char.charCodeAt(0);
    const code = CharCodes[ascii];
    if (!code) continue;
    let modifier = 0;
    if ((ascii >= 65 && ascii <= 90) || ShiftChars[ascii]) {
      modifier |= SHIFT;
    }
    out.push([modifier, code]);
  }
  return out;
}

describe('textToKeySequence', () => {
  it('compiles "a\\r\\nb" to KeyA, Enter, KeyB with the Segmenter and with the fallback', () => {
    const expected = [
      [0, KeycodeMap.KeyA],
      [0, KeycodeMap.Enter],
      [0, KeycodeMap.KeyB]
    ];
    const withSegmenter = textToKeySequence('a\r\nb', opts());
    expect(pairs(withSegmenter.strokes)).toEqual(expected);
    expect(withSegmenter.strokes.map((s) => s.tag)).toEqual(['char', 'enter', 'char']);
    expect(withSegmenter.strokes.map((s) => s.src)).toEqual([0, 1, 2]);
    expect(withSegmenter.stats).toEqual({
      chars: 3,
      typed: 3,
      skipped: 0,
      truncated: false,
      trailingNewlineStripped: false
    });

    const fallback = withoutSegmenter(() => textToKeySequence('a\r\nb', opts()));
    expect(fallback).toEqual(withSegmenter);
  });

  it('counts CRLF, CR and LF as one Enter each', () => {
    const result = textToKeySequence('x\r\ny\rz\n', opts());
    const enters = result.strokes.filter((s) => s.tag === 'enter');
    expect(enters).toHaveLength(3);
    expect(result.strokes).toHaveLength(6);
    expect(result.stats.chars).toBe(6);
    expect(result.strokes[1]).toEqual({ mod: 0, key: KeycodeMap.Enter, src: 1, tag: 'enter' });
  });

  it('types Shift+Enter when asked', () => {
    const result = textToKeySequence('\n', opts({ newline: 'shift-enter' }));
    expect(result.strokes).toEqual([{ mod: SHIFT, key: KeycodeMap.Enter, src: 0, tag: 'enter' }]);
  });

  it('types Tab for \\t', () => {
    const result = textToKeySequence('\t', opts());
    expect(result.strokes).toEqual([{ mod: 0, key: KeycodeMap.Tab, src: 0, tag: 'tab' }]);
    expect(result.skipped).toEqual([]);
  });

  it('reports Japanese characters as skipped no-key instead of dropping them', () => {
    const result = textToKeySequence('aあb', opts());
    expect(pairs(result.strokes)).toEqual([
      [0, KeycodeMap.KeyA],
      [0, KeycodeMap.KeyB]
    ]);
    expect(result.strokes.map((s) => s.src)).toEqual([0, 2]);
    expect(result.skipped).toEqual([{ char: 'あ', index: 1, reason: 'no-key' }]);
    expect(result.stats).toEqual({
      chars: 3,
      typed: 2,
      skipped: 1,
      truncated: false,
      trailingNewlineStripped: false
    });
  });

  it('counts an emoji ZWJ sequence and a decomposed é as one skipped grapheme each', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const result = textToKeySequence(`x${family}éy`, opts());
    expect(pairs(result.strokes)).toEqual([
      [0, KeycodeMap.KeyX],
      [0, KeycodeMap.KeyY]
    ]);
    expect(result.skipped).toEqual([
      { char: family, index: 1, reason: 'no-key' },
      { char: 'é', index: 2, reason: 'no-key' }
    ]);
    expect(result.stats.chars).toBe(4);
    expect(result.stats.skipped).toBe(2);
  });

  it('classifies C0/C1 controls as control', () => {
    const result = textToKeySequence('a\x07b\x7fc\x85d\x0b', opts());
    expect(result.strokes).toHaveLength(4);
    expect(result.skipped).toEqual([
      { char: '\x07', index: 1, reason: 'control' },
      { char: '\x7f', index: 3, reason: 'control' },
      { char: '\x85', index: 5, reason: 'control' },
      { char: '\x0b', index: 7, reason: 'control' }
    ]);
  });

  it('truncates at maxChars and reports the tail as skipped limit', () => {
    const result = textToKeySequence('abcdef', opts({ maxChars: 4 }));
    expect(pairs(result.strokes)).toEqual([
      [0, KeycodeMap.KeyA],
      [0, KeycodeMap.KeyB],
      [0, KeycodeMap.KeyC],
      [0, KeycodeMap.KeyD]
    ]);
    expect(result.skipped).toEqual([
      { char: 'e', index: 4, reason: 'limit' },
      { char: 'f', index: 5, reason: 'limit' }
    ]);
    expect(result.stats).toEqual({
      chars: 6,
      typed: 4,
      skipped: 2,
      truncated: true,
      trailingNewlineStripped: false
    });
    expect(textToKeySequence('abcd', opts({ maxChars: 4 })).stats.truncated).toBe(false);
  });

  it('treats a non-finite maxChars as the hard limit', () => {
    const result = textToKeySequence('abc', opts({ maxChars: Number.NaN }));
    expect(result.strokes).toHaveLength(3);
    expect(result.stats.truncated).toBe(false);
    expect(PASTE_HARD_LIMIT).toBe(20000);
    expect(PASTE_SOFT_LIMIT).toBe(2000);
    expect(DEFAULT_COMPILE_OPTIONS.maxChars).toBe(PASTE_HARD_LIMIT);
  });

  it('strips exactly one trailing newline when enabled and keeps it when disabled', () => {
    const stripped = textToKeySequence('ab\n', opts({ stripTrailingNewline: true }));
    expect(stripped.strokes.map((s) => s.tag)).toEqual(['char', 'char']);
    expect(stripped.stats).toEqual({
      chars: 2,
      typed: 2,
      skipped: 0,
      truncated: false,
      trailingNewlineStripped: true
    });

    const crlf = textToKeySequence('ab\r\n', opts({ stripTrailingNewline: true }));
    expect(crlf.strokes).toHaveLength(2);
    expect(crlf.stats.trailingNewlineStripped).toBe(true);

    const double = textToKeySequence('ab\n\n', opts({ stripTrailingNewline: true }));
    expect(double.strokes.map((s) => s.tag)).toEqual(['char', 'char', 'enter']);

    const kept = textToKeySequence('ab\n', opts({ stripTrailingNewline: false }));
    expect(kept.strokes.map((s) => s.tag)).toEqual(['char', 'char', 'enter']);
    expect(kept.stats.trailingNewlineStripped).toBe(false);

    const onlyNewline = textToKeySequence('\n', opts({ stripTrailingNewline: true }));
    expect(onlyNewline.strokes).toEqual([]);
    expect(onlyNewline.stats.chars).toBe(0);
    expect(DEFAULT_COMPILE_OPTIONS.stripTrailingNewline).toBe(true);
  });

  it('emits the IME pre-key as the very first stroke and does not count it as typed', () => {
    const result = textToKeySequence('ab', opts({ imePreKey: 'NonConvert' }));
    expect(result.strokes[0]).toEqual({
      mod: 0,
      key: 0x8b,
      src: -1,
      tag: 'ime-pre',
      afterMs: IME_SETTLE_MS
    });
    expect(result.strokes).toHaveLength(3);
    expect(result.stats.typed).toBe(2);

    const empty = textToKeySequence('', opts({ imePreKey: 'NonConvert' }));
    expect(empty.strokes).toHaveLength(1);
    expect(empty.stats.typed).toBe(0);
  });

  it('applies Shift for uppercase and shifted punctuation', () => {
    const result = textToKeySequence('A!', opts());
    expect(pairs(result.strokes)).toEqual([
      [SHIFT, KeycodeMap.KeyA],
      [SHIFT, KeycodeMap.Digit1]
    ]);
  });

  it('uses the JIS table when selected', () => {
    const us = textToKeySequence('@"\\', opts({ layout: 'us' }));
    const jis = textToKeySequence('@"\\', opts({ layout: 'jis' }));
    expect(pairs(us.strokes)).toEqual([
      [SHIFT, 0x1f],
      [SHIFT, 0x34],
      [0, 0x31]
    ]);
    expect(pairs(jis.strokes)).toEqual([
      [0, 0x2f],
      [SHIFT, 0x1f],
      [0, 0x87]
    ]);
  });

  it('folds punctuation only when normalizePunct is on', () => {
    const folded = textToKeySequence('“a”', opts({ normalizePunct: true }));
    expect(pairs(folded.strokes)).toEqual([
      [SHIFT, KeycodeMap.Quote],
      [0, KeycodeMap.KeyA],
      [SHIFT, KeycodeMap.Quote]
    ]);
    const raw = textToKeySequence('“a”', opts({ normalizePunct: false }));
    expect(raw.strokes).toHaveLength(1);
    expect(raw.skipped.map((s) => s.reason)).toEqual(['no-key', 'no-key']);
  });

  it('never looks up inherited object properties', () => {
    const result = textToKeySequence('constructor', opts());
    expect(result.strokes).toHaveLength('constructor'.length);
    expect(result.skipped).toEqual([]);
  });

  it('reproduces the legacy paste output for every character the legacy table defines (US)', () => {
    const text = Object.keys(CharCodes)
      .map((code) => String.fromCharCode(Number(code)))
      .join('');
    const result = textToKeySequence(text, opts());
    expect(pairs(result.strokes)).toEqual(legacyPairs(text));
    expect(result.skipped).toEqual([]);
    expect(result.stats.typed).toBe(text.length);
  });

  it('keeps chars === typed + skipped', () => {
    const result = textToKeySequence('ab\x07あ\n\tZ', opts({ maxChars: 5 }));
    expect(result.stats.chars).toBe(result.stats.typed + result.stats.skipped);
    expect(result.stats.truncated).toBe(true);
  });
});
