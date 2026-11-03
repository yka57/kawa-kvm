import { describe, expect, it } from 'vitest';

import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';

import { prepareRawText, type PlanOptions } from './plan';
import { IME_SETTLE_MS, PASTE_HARD_LIMIT } from './text-to-keys';
import type { KeyStroke } from './types';
import {
  codePointStrokes,
  compileUnicode,
  UNICODE_COMMIT_SETTLE_MS,
  UNICODE_FIRST_TRIGGER_SETTLE_MS,
  UNICODE_TRIGGER_SETTLE_MS
} from './unicode-entry';

const CTRL_SHIFT = ModifierBits.LeftCtrl | ModifierBits.LeftShift;
const KEY_NAMES = new Map(Object.entries(KeycodeMap).map(([name, key]) => [key, name]));

/** Readable stroke names: ^+U for the trigger, the key's code name otherwise. */
const names = (strokes: KeyStroke[]) =>
  strokes.map((s) => (s.mod === CTRL_SHIFT ? '^+' : '') + (KEY_NAMES.get(s.key) ?? s.key));

function compile(text: string, over: Partial<PlanOptions> = {}) {
  const o: PlanOptions = {
    layout: 'us',
    newline: 'enter',
    normalizePunct: false,
    stripTrailingNewline: false,
    imePreKey: 'none',
    method: 'ctrl-shift-u',
    maxChars: PASTE_HARD_LIMIT,
    ...over
  };
  return compileUnicode(prepareRawText(text, o), o);
}

describe('codePointStrokes', () => {
  it('あ → Ctrl+Shift+U 3 0 4 2 Space, one atomic group', () => {
    const strokes = codePointStrokes(0x3042, 7, 3, false);
    expect(names(strokes)).toEqual(['^+KeyU', 'Digit3', 'Digit0', 'Digit4', 'Digit2', 'Space']);
    expect(strokes[0]).toEqual({
      mod: CTRL_SHIFT,
      key: KeycodeMap.KeyU,
      src: 7,
      tag: 'unicode',
      afterMs: UNICODE_TRIGGER_SETTLE_MS,
      group: 3
    });
    expect(strokes[1]).toEqual({
      mod: 0,
      key: KeycodeMap.Digit3,
      src: 7,
      tag: 'unicode',
      group: 3
    });
    expect(strokes[5]).toEqual({
      mod: 0,
      key: KeycodeMap.Space,
      src: 7,
      tag: 'unicode',
      afterMs: UNICODE_COMMIT_SETTLE_MS,
      group: 3
    });
    expect(strokes.every((s) => s.group === 3 && s.src === 7 && s.tag === 'unicode')).toBe(true);
  });

  it('U+20BB7 → 2 0 b b 7 (five digits, lowercase letters on the main row)', () => {
    expect(names(codePointStrokes(0x20bb7, 0, 0, false)).slice(1, -1)).toEqual([
      'Digit2',
      'Digit0',
      'KeyB',
      'KeyB',
      'Digit7'
    ]);
    // letter digits never carry Shift and never use the keypad
    const digits = codePointStrokes(0xabcdef, 0, 0, false).slice(1, -1);
    expect(names(digits)).toEqual(['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF']);
    expect(digits.every((s) => s.mod === 0)).toBe(true);
  });

  it('pads to four digits', () => {
    expect(names(codePointStrokes(0xe9, 0, 0, false)).slice(1, -1)).toEqual([
      'Digit0',
      'Digit0',
      'KeyE',
      'Digit9'
    ]);
  });

  it('the first trigger of a run waits longer (IBus loads lazily)', () => {
    expect(codePointStrokes(0x3042, 0, 0, true)[0].afterMs).toBe(UNICODE_FIRST_TRIGGER_SETTLE_MS);
    expect(codePointStrokes(0x3042, 0, 0, false)[0].afterMs).toBe(UNICODE_TRIGGER_SETTLE_MS);
    expect([
      UNICODE_TRIGGER_SETTLE_MS,
      UNICODE_FIRST_TRIGGER_SETTLE_MS,
      UNICODE_COMMIT_SETTLE_MS
    ]).toEqual([80, 400, 80]);
  });
});

describe('compileUnicode', () => {
  it('types keys directly and every other code point in its own group', () => {
    const result = compile('aあbい');
    expect(names(result.strokes)).toEqual([
      'KeyA',
      ...['^+KeyU', 'Digit3', 'Digit0', 'Digit4', 'Digit2', 'Space'],
      'KeyB',
      ...['^+KeyU', 'Digit3', 'Digit0', 'Digit4', 'Digit4', 'Space']
    ]);
    expect(result.strokes.map((s) => s.group)).toEqual([
      undefined,
      ...Array(6).fill(0),
      undefined,
      ...Array(6).fill(1)
    ]);
    expect(result.strokes.map((s) => s.src)).toEqual([
      0,
      ...Array(6).fill(1),
      2,
      ...Array(6).fill(3)
    ]);
    // only the first trigger of the run gets the long settle
    const triggers = result.strokes.filter((s) => s.key === KeycodeMap.KeyU);
    expect(triggers.map((s) => s.afterMs)).toEqual([
      UNICODE_FIRST_TRIGGER_SETTLE_MS,
      UNICODE_TRIGGER_SETTLE_MS
    ]);
    expect(result.stats).toMatchObject({ chars: 4, typed: 4, skipped: 0 });
  });

  it('enters a multi-code-point grapheme code point by code point, ASCII base included', () => {
    const result = compile('e\u0301');
    const groups = new Set(result.strokes.map((s) => s.group));
    expect(groups).toEqual(new Set([0, 1]));
    expect(names(result.strokes.filter((s) => s.group === 0)).slice(1, -1)).toEqual([
      'Digit0',
      'Digit0',
      'Digit6',
      'Digit5'
    ]);
    expect(names(result.strokes.filter((s) => s.group === 1)).slice(1, -1)).toEqual([
      'Digit0',
      'Digit3',
      'Digit0',
      'Digit1'
    ]);
    expect(result.strokes.every((s) => s.src === 0)).toBe(true);
    expect(result.stats.typed).toBe(1);
  });

  it('newline → Enter (or Shift+Enter), tab → Tab', () => {
    expect(names(compile('あ\n\t').strokes).slice(-2)).toEqual(['Enter', 'Tab']);
    const shifted = compile('\n', { newline: 'shift-enter' }).strokes;
    expect(shifted).toEqual([
      { mod: ModifierBits.LeftShift, key: KeycodeMap.Enter, src: 0, tag: 'enter' }
    ]);
  });

  it('uses the target layout table for direct strokes', () => {
    const jis = compile('@あ', { layout: 'jis' });
    expect(jis.strokes[0]).toEqual({ mod: 0, key: KeycodeMap.BracketLeft, src: 0, tag: 'char' });
    const us = compile('@あ', { layout: 'us' });
    expect(us.strokes[0]).toMatchObject({ mod: ModifierBits.LeftShift, key: KeycodeMap.Digit2 });
  });

  it('starts with the IME pre-key (150 ms settle) when one is set', () => {
    const result = compile('あ', { imePreKey: 'NonConvert' });
    expect(result.strokes[0]).toEqual({
      mod: 0,
      key: KeycodeMap.NonConvert,
      src: -1,
      tag: 'ime-pre',
      afterMs: IME_SETTLE_MS
    });
    expect(IME_SETTLE_MS).toBe(150);
    expect(result.strokes[1].group).toBe(0);
    expect(result.stats.typed).toBe(1);
  });

  it('keeps src in the index space of the skipped list', () => {
    const result = compile('a\x07あ');
    expect(result.skipped).toEqual([{ char: '\x07', index: 1, reason: 'control' }]);
    expect(result.strokes[0].src).toBe(0);
    expect(result.strokes[1].src).toBe(2);
    expect(result.stats).toMatchObject({ chars: 3, typed: 2, skipped: 1 });
  });
});
