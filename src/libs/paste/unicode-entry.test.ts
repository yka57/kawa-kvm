import { describe, expect, it } from 'vitest';

import { HidLock } from '@/libs/keyboard/hid-lock';
import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import { FakeClock, flushMicrotasks } from '@/test/fakes';

import { getTable } from './layouts';
import { prepareRawText, type PlanOptions } from './plan';
import { IME_SETTLE_MS, imePreStroke, PASTE_HARD_LIMIT } from './text-to-keys';
import type { KeyStroke } from './types';
import { estimateProgramMs, PACING, TypingEngine, type Pacing } from './typing-engine';
import {
  ALT_HEX_COMMIT_SETTLE_MS,
  altHexStrokes,
  codePointStrokes,
  compileUnicode,
  IME_CODE_COMMIT,
  IME_CODE_FIRST_F5_SETTLE_MS,
  IME_CODE_MIN_STROKE_MS,
  imeCodeDigits,
  imeCodeUnitStrokes,
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

describe('altHexStrokes (Windows hex numpad)', () => {
  const ALT = ModifierBits.LeftAlt;

  it('あ → Alt held over keypad +, 3 0 4 2 on the keypad; Alt goes up with the last digit', () => {
    const strokes = altHexStrokes(0x3042, 7, 3);
    expect(names(strokes)).toEqual(['NumpadAdd', 'Numpad3', 'Numpad0', 'Numpad4', 'Numpad2']);
    expect(strokes.every((s) => s.mod === ALT && s.group === 3 && s.src === 7)).toBe(true);
    expect(strokes.map((s) => s.hold)).toEqual([ALT, ALT, ALT, ALT, undefined]);
    expect(strokes[4].afterMs).toBe(ALT_HEX_COMMIT_SETTLE_MS);
  });

  it('hex letters use the letter keys (漢 = 6f22)', () => {
    expect(names(altHexStrokes(0x6f22, 0, 0))).toEqual([
      'NumpadAdd',
      'Numpad6',
      'KeyF',
      'Numpad2',
      'Numpad2'
    ]);
  });

  it('a code point above U+FFFF is two entries, one per UTF-16 unit', () => {
    const strokes = altHexStrokes(0x1f600, 0, 0); // d83d de00
    expect(names(strokes)).toEqual([
      'NumpadAdd',
      'KeyD',
      'Numpad8',
      'Numpad3',
      'KeyD',
      'NumpadAdd',
      'KeyD',
      'KeyE',
      'Numpad0',
      'Numpad0'
    ]);
    expect(strokes.filter((s) => s.hold === undefined)).toHaveLength(2);
  });

  it("compileUnicode with method 'alt-hex' mixes direct keys and Alt entries", () => {
    const { strokes } = compile('aあ', { method: 'alt-hex' });
    expect(names(strokes)).toEqual([
      'KeyA',
      'NumpadAdd',
      'Numpad3',
      'Numpad0',
      'Numpad4',
      'Numpad2'
    ]);
    expect(strokes[0].hold).toBeUndefined();
  });
});

describe('IME code input (Windows, Microsoft IME)', () => {
  const CTRL = ModifierBits.LeftCtrl;
  const SHIFT = ModifierBits.LeftShift;
  const { Lang1, Lang2, F5 } = KeycodeMap;

  const ime = (text: string, over: Partial<PlanOptions> = {}) =>
    compile(text, { method: 'ime-code', ...over });

  /** Stroke names with their modifiers (^ Ctrl, + Shift): Digit3, F5, ^KeyM, +Enter. */
  const chords = (strokes: Pick<KeyStroke, 'mod' | 'key'>[]) =>
    strokes.map(
      (s) =>
        (s.mod & CTRL ? '^' : '') + (s.mod & SHIFT ? '+' : '') + (KEY_NAMES.get(s.key) ?? s.key)
    );

  // The commit chord is the compiler's constant everywhere below; one test pins what it is.
  const [COMMIT] = chords([IME_CODE_COMMIT]);
  const isCommit = (s: KeyStroke) => s.mod === IME_CODE_COMMIT.mod && s.key === IME_CODE_COMMIT.key;

  /** One code-input unit as `chords` shows it: 3042 → Digit3 Digit0 Digit4 Digit2 F5 and the commit. */
  const unit = (digits: string) => [
    ...[...digits].map((digit) => (digit >= 'a' ? `Key${digit.toUpperCase()}` : `Digit${digit}`)),
    'F5',
    COMMIT
  ];

  it('the commit chord is Ctrl+M: Left Ctrl (0x01) and M (0x10) in one press report', () => {
    // the only test that pins the chord: every other expectation derives from IME_CODE_COMMIT
    expect(IME_CODE_COMMIT).toStrictEqual({ mod: 0x01, key: 0x10 });
    expect(COMMIT).toBe('^KeyM');
  });

  describe('imeCodeDigits', () => {
    it('U+0000 to U+FFFF: exactly four lower-case digits, zero padded', () => {
      expect(imeCodeDigits(0x3042)).toEqual(['3042']);
      expect(imeCodeDigits(0xe9)).toEqual(['00e9']);
      expect(imeCodeDigits(0xff01)).toEqual(['ff01']);
      expect(imeCodeDigits(0x41)).toEqual(['0041']);
      expect(imeCodeDigits(0xabcd)).toEqual(['abcd']);
      expect(imeCodeDigits(0xffff)).toEqual(['ffff']);
      // a lone surrogate in the text is one four-digit unit like any other
      expect(imeCodeDigits(0xd83d)).toEqual(['d83d']);
    });

    it('U+10000 and above: exactly six digits, zero padded, never five', () => {
      expect(imeCodeDigits(0x1f600)).toEqual(['01f600']);
      expect(imeCodeDigits(0x20bb7)).toEqual(['020bb7']);
      expect(imeCodeDigits(0xe0100)).toEqual(['0e0100']);
      expect(imeCodeDigits(0x10ffff)).toEqual(['10ffff']);
      expect(imeCodeDigits(0x10000)).toEqual(['010000']);
      // as five decimal digits 21516 was read as a JIS X 0213 code (another kanji)
      expect(imeCodeDigits(0x21516)).toEqual(['021516']);
    });

    it('U+30000 to U+3FFFF: the two UTF-16 surrogates as two four-digit units', () => {
      expect(imeCodeDigits(0x3134a)).toEqual(['d884', 'df4a']);
      expect(imeCodeDigits(0x3000a)).toEqual(['d880', 'dc0a']);
      expect(imeCodeDigits(0x30000)).toEqual(['d880', 'dc00']);
      expect(imeCodeDigits(0x3ffff)).toEqual(['d8bf', 'dfff']);
      // the planes on both sides keep the six-digit form
      expect(imeCodeDigits(0x2ffff)).toEqual(['02ffff']);
      expect(imeCodeDigits(0x40000)).toEqual(['040000']);
    });

    it('any code point: four or six lower-case digits per unit, decoding back to it', () => {
      // a sample across all planes; the boundaries are pinned above
      for (let cp = 1; cp <= 0x10ffff; cp += 251) {
        const units = imeCodeDigits(cp);
        const label = `U+${cp.toString(16)}: ${units.join(' ')}`;
        const values = units.map((digits) => parseInt(digits, 16));
        const plane3 = cp >= 0x30000 && cp <= 0x3ffff;
        expect(
          units.every((digits) => /^[0-9a-f]+$/.test(digits)),
          label
        ).toBe(true);
        expect(
          units.map((digits) => digits.length),
          label
        ).toEqual(plane3 ? [4, 4] : [cp > 0xffff ? 6 : 4]);
        expect(plane3 ? String.fromCharCode(...values).codePointAt(0) : values[0], label).toBe(cp);
      }
    });
  });

  describe('imeCodeUnitStrokes', () => {
    it('あ → 3 0 4 2 on the main row, F5, the commit chord as one stroke: all in the given group', () => {
      expect(imeCodeUnitStrokes('3042', 7, 3, false)).toStrictEqual([
        { mod: 0, key: KeycodeMap.Digit3, src: 7, tag: 'unicode', group: 3, minMs: 40 },
        { mod: 0, key: KeycodeMap.Digit0, src: 7, tag: 'unicode', group: 3, minMs: 40 },
        { mod: 0, key: KeycodeMap.Digit4, src: 7, tag: 'unicode', group: 3, minMs: 40 },
        { mod: 0, key: KeycodeMap.Digit2, src: 7, tag: 'unicode', group: 3, minMs: 40 },
        { mod: 0, key: KeycodeMap.F5, src: 7, tag: 'unicode', group: 3, minMs: 40 },
        { ...IME_CODE_COMMIT, src: 7, tag: 'unicode', group: 3, minMs: 40 }
      ]);
    });

    it('the first unit of a stretch waits 100 ms after its F5, and only there', () => {
      expect(imeCodeUnitStrokes('3042', 0, 0, true).map((s) => s.afterMs)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        IME_CODE_FIRST_F5_SETTLE_MS,
        undefined
      ]);
      expect(IME_CODE_FIRST_F5_SETTLE_MS).toBe(100);
    });

    it('every stroke of a unit takes at least 40 ms, the stroke of Normal speed', () => {
      // at 10 ms / 10 ms the commit came 20 ms after F5 and the next digit 20 ms after the
      // commit: too soon for a slow conversion, and that digit was swallowed. With only those two
      // slowed down, a page slow to handle its input events still fell behind digits 20 ms apart
      for (const first of [true, false]) {
        for (const digits of ['3042', '01f600', '0009', 'd884']) {
          const strokes = imeCodeUnitStrokes(digits, 0, 0, first);
          expect(
            strokes.map((s) => s.minMs),
            digits
          ).toEqual(Array(digits.length + 2).fill(IME_CODE_MIN_STROKE_MS));
        }
      }
      // exactly what a stroke takes at Normal, so only a faster preset is slowed down
      expect(IME_CODE_MIN_STROKE_MS).toBe(40);
      expect(IME_CODE_MIN_STROKE_MS).toBe(PACING.normal.holdMs + PACING.normal.gapMs);
    });

    it('hex letters are the letter keys a to f, never shifted and never on the keypad', () => {
      const strokes = [
        ...imeCodeUnitStrokes('01f600', 0, 0, false),
        ...imeCodeUnitStrokes('abcd', 0, 1, false),
        ...imeCodeUnitStrokes('ef89', 0, 2, false)
      ];
      expect(chords(strokes)).toEqual([
        ...['Digit0', 'Digit1', 'KeyF', 'Digit6', 'Digit0', 'Digit0', 'F5', COMMIT],
        ...['KeyA', 'KeyB', 'KeyC', 'KeyD', 'F5', COMMIT],
        ...['KeyE', 'KeyF', 'Digit8', 'Digit9', 'F5', COMMIT]
      ]);
      // the commit's modifier is the only one in a unit, and it is not held over
      expect(strokes.filter(isCommit)).toHaveLength(3);
      expect(strokes.every((s) => s.mod === (isCommit(s) ? IME_CODE_COMMIT.mod : 0))).toBe(true);
      expect(strokes.every((s) => s.hold === undefined)).toBe(true);
    });
  });

  describe("compileUnicode with method 'ime-code'", () => {
    it('a + あ + 😀 + b: the measured recipe, stroke by stroke as HID usages', () => {
      const key = (usage: number, src: number, group: number): KeyStroke => ({
        mod: 0,
        key: usage,
        src,
        tag: 'unicode',
        group,
        minMs: 40
      });
      const result = ime('aあ😀b');
      expect(result.strokes).toStrictEqual([
        // LANG2 = IME off, then the usual settle
        { mod: 0, key: 0x91, src: -1, tag: 'ime-pre', afterMs: 150 },
        { mod: 0, key: 0x04, src: 0, tag: 'char' },
        // LANG1 = IME on, hiragana: from here to the last commit no key is faster than 40 ms
        { mod: 0, key: 0x90, src: -1, tag: 'ime-pre', minMs: 40 },
        // 3 0 4 2, F5 (the first of the stretch), the commit
        key(0x20, 1, 0),
        key(0x27, 1, 0),
        key(0x21, 1, 0),
        key(0x1f, 1, 0),
        { ...key(0x3e, 1, 0), afterMs: 100 },
        { ...IME_CODE_COMMIT, src: 1, tag: 'unicode', group: 0, minMs: 40 },
        // 0 1 f 6 0 0, F5, the commit
        key(0x27, 2, 1),
        key(0x1e, 2, 1),
        key(0x09, 2, 1),
        key(0x23, 2, 1),
        key(0x27, 2, 1),
        key(0x27, 2, 1),
        key(0x3e, 2, 1),
        { ...IME_CODE_COMMIT, src: 2, tag: 'unicode', group: 1, minMs: 40 },
        // LANG2 before the next direct key: at the pace of the preset again
        { mod: 0, key: 0x91, src: -1, tag: 'ime-pre' },
        { mod: 0, key: 0x05, src: 3, tag: 'char' }
      ]);
      expect(result.skipped).toEqual([]);
      expect(result.stats).toMatchObject({ chars: 4, typed: 4, skipped: 0 });
    });

    it('one group per code point, and 100 ms after the first F5 of each stretch only', () => {
      const { strokes } = ime('あいaうえお');
      expect(chords(strokes)).toEqual([
        'Lang2',
        'Lang1',
        ...unit('3042'),
        ...unit('3044'),
        'Lang2',
        'KeyA',
        'Lang1',
        ...unit('3046'),
        ...unit('3048'),
        ...unit('304a'),
        'Lang2'
      ]);
      expect(strokes.map((s) => s.group)).toEqual([
        ...[undefined, undefined],
        ...Array(6).fill(0),
        ...Array(6).fill(1),
        ...[undefined, undefined, undefined],
        ...Array(6).fill(2),
        ...Array(6).fill(3),
        ...Array(6).fill(4),
        undefined
      ]);
      expect(strokes.filter((s) => s.key === F5).map((s) => s.afterMs)).toEqual([
        100,
        undefined,
        100,
        undefined,
        undefined
      ]);
      // nothing else has a pause of its own, except the IME-off key that starts the run
      expect(strokes.filter((s) => s.afterMs !== undefined).map((s) => s.key)).toEqual([
        Lang2,
        F5,
        F5
      ]);
      // the 40 ms floor is on LANG1 and on every stroke of a unit, and on nothing else
      expect(strokes.map((s) => s.minMs)).toEqual(
        strokes.map((s) =>
          s.tag === 'unicode' || s.key === Lang1 ? IME_CODE_MIN_STROKE_MS : undefined
        )
      );
    });

    it('text that starts with Japanese: LANG2 and its settle, then LANG1', () => {
      const { strokes } = ime('あa');
      expect(chords(strokes)).toEqual(['Lang2', 'Lang1', ...unit('3042'), 'Lang2', 'KeyA']);
      expect(strokes[0]).toStrictEqual(imePreStroke('Lang2'));
      expect(strokes[1]).toStrictEqual({
        mod: 0,
        key: Lang1,
        src: -1,
        tag: 'ime-pre',
        minMs: IME_CODE_MIN_STROKE_MS
      });
      expect(strokes[2].group).toBe(0);
    });

    it('text that ends with Japanese: LANG2 is the very last stroke', () => {
      const { strokes } = ime('aあ');
      expect(chords(strokes)).toEqual(['Lang2', 'KeyA', 'Lang1', ...unit('3042'), 'Lang2']);
      expect(strokes[strokes.length - 1]).toStrictEqual({
        mod: 0,
        key: Lang2,
        src: -1,
        tag: 'ime-pre'
      });
      // Japanese only: off, on, the unit, off
      expect(chords(ime('あ').strokes)).toEqual(['Lang2', 'Lang1', ...unit('3042'), 'Lang2']);
    });

    it('text that ends with a direct key needs no closing LANG2; ASCII alone never turns the IME on', () => {
      expect(chords(ime('あa').strokes).slice(-2)).toEqual(['Lang2', 'KeyA']);
      expect(chords(ime('ab').strokes)).toEqual(['Lang2', 'KeyA', 'KeyB']);
      expect(chords(ime('').strokes)).toEqual(['Lang2']);
    });

    it('leaves the IME before a line break and comes back after it, in both newline modes', () => {
      const text = 'あ\nい\nう';
      const expected = (lineBreak: string) => [
        'Lang2',
        'Lang1',
        ...unit('3042'),
        'Lang2',
        lineBreak,
        'Lang1',
        ...unit('3044'),
        'Lang2',
        lineBreak,
        'Lang1',
        ...unit('3046'),
        'Lang2'
      ];
      const enter = ime(text).strokes;
      expect(chords(enter)).toEqual(expected('Enter'));
      const shifted = ime(text, { newline: 'shift-enter' }).strokes;
      expect(chords(shifted)).toEqual(expected('+Enter'));
      // the line breaks are the usual strokes, typed while the IME is off
      expect(shifted.filter((s) => s.tag === 'enter')).toStrictEqual([
        { mod: SHIFT, key: KeycodeMap.Enter, src: 1, tag: 'enter' },
        { mod: SHIFT, key: KeycodeMap.Enter, src: 3, tag: 'enter' }
      ]);
      // three stretches: each one starts with the long F5
      expect(enter.filter((s) => s.key === F5).map((s) => s.afterMs)).toEqual([100, 100, 100]);
    });

    it('never presses the Tab key: a tab is the code unit 0009, inside the stretch', () => {
      // Tab would move the focus out of the field, and the next F5 would reach the application
      // with no composition (a browser reloads the page). Two cells copied from a spreadsheet:
      const cells = ime('列1\t列2');
      expect(chords(cells.strokes)).toEqual([
        'Lang2',
        'Lang1',
        ...unit('5217'),
        'Lang2',
        'Digit1',
        // the IME is off here: LANG1 comes before the tab's unit, and 列 follows in the same stretch
        'Lang1',
        ...unit('0009'),
        ...unit('5217'),
        'Lang2',
        'Digit2'
      ]);
      expect(cells.stats).toMatchObject({ chars: 5, typed: 5, skipped: 0 });

      // between two code-input characters the IME stays on: no LANG2 / LANG1 around the tab
      const { strokes } = ime('あ\tい');
      expect(chords(strokes)).toEqual([
        'Lang2',
        'Lang1',
        ...unit('3042'),
        ...unit('0009'),
        ...unit('3044'),
        'Lang2'
      ]);
      // the tab's unit is a unit like any other: its own group, the src of its grapheme
      const tab = strokes.filter((s) => s.src === 1);
      expect(tab).toStrictEqual(imeCodeUnitStrokes('0009', 1, 1, false));

      // a tab that starts a stretch brings LANG1 and the long first F5; ASCII around it is direct
      const leading = ime('a\tb').strokes;
      expect(chords(leading)).toEqual(['Lang2', 'KeyA', 'Lang1', ...unit('0009'), 'Lang2', 'KeyB']);
      expect(leading.find((s) => s.key === F5)?.afterMs).toBe(IME_CODE_FIRST_F5_SETTLE_MS);

      for (const text of ['列1\t列2', 'あ\tい', 'a\tb', '\t', '\t\tあ\t', 'あ\n\tい']) {
        for (const newline of ['enter', 'shift-enter'] as const) {
          const all = ime(text, { newline }).strokes;
          expect(
            all.some((s) => s.key === KeycodeMap.Tab || s.tag === 'tab'),
            JSON.stringify(text)
          ).toBe(false);
        }
      }
    });

    it('the other methods still press the Tab key', () => {
      for (const method of ['ctrl-shift-u', 'alt-hex'] as const) {
        const { strokes } = compile('あ\tい', { method });
        expect(
          strokes.filter((s) => s.key === KeycodeMap.Tab),
          method
        ).toStrictEqual([{ mod: 0, key: KeycodeMap.Tab, src: 1, tag: 'tab' }]);
      }
    });

    it('sends one LANG2 for a run of line breaks and direct keys', () => {
      expect(chords(ime('あ\n\nab い').strokes)).toEqual([
        'Lang2',
        'Lang1',
        ...unit('3042'),
        ...['Lang2', 'Enter', 'Enter', 'KeyA', 'KeyB', 'Space'],
        'Lang1',
        ...unit('3044'),
        'Lang2'
      ]);
    });

    it('enters a multi-code-point grapheme code point by code point, one unit each', () => {
      // thumbs up + skin tone, heart + U+FE0F, a flag, a ZWJ family: four graphemes
      const text =
        '\u{1f44d}\u{1f3fb}\u2764\ufe0f\u{1f1ef}\u{1f1f5}\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
      const result = ime(text);
      expect(chords(result.strokes)).toEqual([
        'Lang2',
        'Lang1',
        ...[...unit('01f44d'), ...unit('01f3fb')],
        ...[...unit('2764'), ...unit('fe0f')],
        ...[...unit('01f1ef'), ...unit('01f1f5')],
        ...[...unit('01f468'), ...unit('200d'), ...unit('01f469'), ...unit('200d')],
        ...unit('01f467'),
        'Lang2'
      ]);
      // src is the grapheme, the group the code point
      const converts = result.strokes.filter((s) => s.key === F5);
      expect(converts.map((s) => s.src)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 3, 3, 3]);
      expect(converts.map((s) => s.group)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(converts.map((s) => s.afterMs)).toEqual([100, ...Array(10).fill(undefined)]);
      expect(result.stats).toMatchObject({ chars: 4, typed: 4 });
    });

    it('a combining mark takes its ASCII base along, as with the other methods', () => {
      const { strokes } = ime('ae\u0301b');
      expect(chords(strokes)).toEqual([
        'Lang2',
        'KeyA',
        'Lang1',
        ...unit('0065'),
        ...unit('0301'),
        'Lang2',
        'KeyB'
      ]);
      expect(strokes.filter((s) => s.tag === 'unicode').every((s) => s.src === 1)).toBe(true);
    });

    it('a code point of plane 3 is two units, its two surrogates, in one group', () => {
      const { strokes } = ime('\u{3134a}あ');
      expect(chords(strokes)).toEqual([
        'Lang2',
        'Lang1',
        ...unit('d884'),
        ...unit('df4a'),
        ...unit('3042'),
        'Lang2'
      ]);
      const units = strokes.filter((s) => s.tag === 'unicode');
      // both surrogate units share the group of their code point: a deferred cancel waits for
      // the second commit instead of leaving a lone high surrogate on the target
      expect(units.map((s) => s.group)).toEqual([...Array(12).fill(0), ...Array(6).fill(1)]);
      expect(units.map((s) => s.src)).toEqual([...Array(12).fill(0), ...Array(6).fill(1)]);
      // only the first unit of the stretch waits after its F5
      expect(units.filter((s) => s.key === F5).map((s) => s.afterMs)).toEqual([
        100,
        undefined,
        undefined
      ]);

      // the group id advances once per code point, also across graphemes and plane-3 neighbours
      const mixed = ime('あ\u{30ede}\u{3134a}e\u0301\u{20bb7}').strokes;
      expect(mixed.filter((s) => s.key === F5).map((s) => `src ${s.src} group ${s.group}`)).toEqual(
        [
          'src 0 group 0', // あ
          ...['src 1 group 1', 'src 1 group 1'], // U+30EDE: two units, one group
          ...['src 2 group 2', 'src 2 group 2'], // U+3134A
          ...['src 3 group 3', 'src 3 group 4'], // e + U+0301: one grapheme, two code points
          'src 4 group 5' // U+20BB7: six digits, one unit
        ]
      );
    });

    it('keeps src in the index space of the skipped list', () => {
      const result = ime('a\x07あ\x1b\nい');
      expect(result.skipped).toEqual([
        { char: '\x07', index: 1, reason: 'control' },
        { char: '\x1b', index: 3, reason: 'control' }
      ]);
      expect(chords(result.strokes)).toEqual([
        'Lang2',
        'KeyA',
        'Lang1',
        ...unit('3042'),
        'Lang2',
        'Enter',
        'Lang1',
        ...unit('3044'),
        'Lang2'
      ]);
      expect(result.strokes.map((s) => s.src)).toEqual([
        ...[-1, 0, -1],
        ...Array(6).fill(2),
        ...[-1, 4, -1],
        ...Array(6).fill(5),
        -1
      ]);
      expect(result.stats).toMatchObject({ chars: 6, typed: 4, skipped: 2 });
    });

    it('always starts with LANG2, whatever the IME pre-key setting says, and sends no second pre-key', () => {
      for (const imePreKey of ['none', 'NonConvert', 'Lang2'] as const) {
        const { strokes } = ime('aあ', { imePreKey });
        expect(strokes[0], imePreKey).toStrictEqual({
          mod: 0,
          key: Lang2,
          src: -1,
          tag: 'ime-pre',
          afterMs: IME_SETTLE_MS
        });
        expect(chords(strokes), imePreKey).toEqual([
          'Lang2',
          'KeyA',
          'Lang1',
          ...unit('3042'),
          'Lang2'
        ]);
      }
      // the other methods still send what the setting says, or nothing
      expect(
        chords(compile('aあ', { method: 'alt-hex', imePreKey: 'NonConvert' }).strokes)
      ).toEqual(['NonConvert', 'KeyA', 'NumpadAdd', 'Numpad3', 'Numpad0', 'Numpad4', 'Numpad2']);
      expect(names(compile('aあ', { imePreKey: 'none' }).strokes)[0]).toBe('KeyA');
    });

    it('types direct keys through the target layout table', () => {
      expect(ime('@あ', { layout: 'jis' }).strokes[1]).toEqual({
        mod: 0,
        key: KeycodeMap.BracketLeft,
        src: 0,
        tag: 'char'
      });
      expect(ime('@あ', { layout: 'us' }).strokes[1]).toMatchObject({
        mod: SHIFT,
        key: KeycodeMap.Digit2
      });
    });

    // The chat messages of the measurement runs (20 ms / 20 ms and 10 ms / 10 ms, textarea and
    // contenteditable, all exact), with the stroke counts of the sender that typed them there:
    // it was written from the recipe independently of this compiler.
    const MEASURED: [text: string, counts: Record<string, number>][] = [
      [
        'お疲れ様です。明日のMTGは15:00からRoom 3Bでお願いします。\n資料はTeamsに置きました(v2.1)。確認後、OKなら返信ください!',
        { ime: 17, direct: 29, enter: 1, digit: 172, f5: 43, commit: 43 }
      ],
      [
        '了解です。PR #1234 をレビューしました:\nhttps://example.com/a?b=1&c=2 を見てください。カタカナとﾊﾝｶｸ、全角ＡＢＣ１２３も混ぜます。',
        { ime: 7, direct: 40, enter: 1, digit: 184, f5: 46, commit: 46 }
      ],
      [
        '田中さん、売上は前年比+12.5%(約3,400万円)でした😀\n詳細はExcelの「集計」シートにあります。𠮷野さんにもCcしました〜',
        { ime: 15, direct: 20, enter: 1, digit: 188, f5: 46, commit: 46 }
      ],
      [
        'OK\n\n了解 しました\nでは、また明日。bye',
        { ime: 7, direct: 6, enter: 3, digit: 56, f5: 14, commit: 14 }
      ],
      [
        '了解\u{1f44d}\u{1f3fb} ありがとう\u2764\ufe0f \u{1f1ef}\u{1f1f5}旅行\u{1f468}\u200d\u{1f469}\u200d\u{1f467}楽しみ',
        { ime: 7, direct: 2, enter: 0, digit: 106, f5: 23, commit: 23 }
      ]
    ];

    const kindOf = (s: KeyStroke): string => {
      if (s.tag === 'ime-pre') return 'ime';
      if (s.tag === 'enter') return 'enter';
      if (s.tag !== 'unicode') return 'direct';
      if (s.key === F5) return 'f5';
      return isCommit(s) ? 'commit' : 'digit';
    };

    it('compiles the measured chat messages to the strokes that were measured', () => {
      for (const [text, counts] of MEASURED) {
        const { strokes, stats } = ime(text, { layout: 'jis', newline: 'shift-enter' });
        const found: Record<string, number> = { ...counts };
        for (const key of Object.keys(found)) found[key] = 0;
        for (const s of strokes) found[kindOf(s)]++;
        expect(found, text).toEqual(counts);
        expect(stats.skipped, text).toBe(0);
      }
    });

    it('keeps the rules of the recipe in every run', () => {
      const texts = [
        ...MEASURED.map(([text]) => text),
        'aあ😀b',
        'あ',
        '\u{3134a}',
        'a\u{30ede}麺\u{3ffff}\u{30000}b',
        '\nあ\n\n\tい\n',
        'e\u0301 ﾊ\uff9f\u3099 #\ufe0f\u20e3',
        'tab\tあ\tい',
        '列1\t列2\n\t\tx\t'
      ];
      const DIGITS = new Map(
        [...'0123456789abcdef'].map((digit) => [
          KeycodeMap[digit >= 'a' ? `Key${digit.toUpperCase()}` : `Digit${digit}`],
          digit
        ])
      );
      // the direct keys as a US target reads them
      const DIRECT = new Map(
        Object.entries(getTable('us')).map(([char, combo]) => [
          `${combo.shift ? SHIFT : 0}:${KeycodeMap[combo.key]}`,
          char
        ])
      );
      // half a surrogate pair: a code point of the category "surrogate"
      const LONE_SURROGATE = /^\p{Cs}$/u;
      for (const newline of ['enter', 'shift-enter'] as const) {
        for (const text of texts) {
          const { strokes } = ime(text, { newline });
          // a target whose IME works: what it holds in the end, and what each group entered
          let arrived = '';
          const entered = new Map<number | undefined, string>();
          let imeOn = false;
          let digits = '';
          strokes.forEach((s, i) => {
            const at = `${JSON.stringify(text)} stroke ${i}`;
            // the Tab key is never pressed: it would take the focus away from the field
            expect(s.key === KeycodeMap.Tab || s.tag === 'tab', at).toBe(false);
            if (s.tag === 'ime-pre') {
              // never a redundant switch: LANG1 only while off, LANG2 only while on (or first)
              expect(s.key === Lang1 ? !imeOn : imeOn || i === 0, at).toBe(true);
              expect(s.group, at).toBeUndefined();
              // and never inside a unit
              expect(digits, at).toBe('');
              // LANG1 starts a stretch and is paced like it; LANG2 follows the preset
              expect(s.minMs, at).toBe(s.key === Lang1 ? IME_CODE_MIN_STROKE_MS : undefined);
              imeOn = s.key === Lang1;
            } else if (s.tag === 'unicode') {
              // code input only while the IME is on, direct keys only while it is off
              expect(imeOn, at).toBe(true);
              expect(s.group, at).toBeTypeOf('number');
              // no key of a unit is faster than 40 ms, whatever the preset
              expect(s.minMs, at).toBe(IME_CODE_MIN_STROKE_MS);
              if (s.key === F5) {
                // never an F5 without digits typed just before, always the commit right after
                expect(DIGITS.has(strokes[i - 1].key) && strokes[i - 1].mod === 0, at).toBe(true);
                expect(strokes[i - 1].group, at).toBe(s.group);
                expect([4, 6], at).toContain(digits.length);
                expect(strokes[i + 1], at).toStrictEqual({
                  ...IME_CODE_COMMIT,
                  src: s.src,
                  tag: 'unicode',
                  group: s.group,
                  minMs: IME_CODE_MIN_STROKE_MS
                });
              } else if (isCommit(s)) {
                expect(strokes[i - 1].key, at).toBe(F5);
                // four digits are a UTF-16 code unit, six a code point
                const value = parseInt(digits, 16);
                const unitText =
                  digits.length === 4 ? String.fromCharCode(value) : String.fromCodePoint(value);
                arrived += unitText;
                entered.set(s.group, (entered.get(s.group) ?? '') + unitText);
                digits = '';
              } else {
                expect(s.mod, at).toBe(0);
                expect(DIGITS.has(s.key), at).toBe(true);
                digits += DIGITS.get(s.key);
              }
            } else {
              expect(imeOn, at).toBe(false);
              expect(s.group, at).toBeUndefined();
              // the direct keys keep the pace of the preset
              expect(s.minMs, at).toBeUndefined();
              arrived += s.tag === 'enter' ? '\n' : (DIRECT.get(`${s.mod}:${s.key}`) ?? '?');
            }
          });
          // the IME is off again when the run ends, and the target holds exactly the text
          expect(imeOn, text).toBe(false);
          expect(arrived, text).toBe(text);
          // the group ids count up from 0, and a group enters exactly one whole code point:
          // a deferred cancel, which waits for the end of a group, cannot leave a lone surrogate
          expect([...entered.keys()], text).toEqual([...entered.keys()].map((_, n) => n));
          for (const [group, codePoint] of entered) {
            const label = `${JSON.stringify(text)} group ${group}`;
            expect([...codePoint], label).toHaveLength(1);
            expect(LONE_SURROGATE.test(codePoint), label).toBe(false);
          }
        }
      }
    });

    it('costs six strokes per BMP character and eight above: 0.24 s and 0.32 s at Normal and at Fast alike', () => {
      const ms = (text: string, speed: keyof typeof PACING = 'normal') =>
        estimateProgramMs([{ kind: 'keys', strokes: ime(text).strokes }], PACING[speed]);
      expect(ms('ああ') - ms('あ')).toBe(240);
      expect(ms('あ😀') - ms('あ')).toBe(320);
      expect(ms('ああ', 'safe') - ms('あ', 'safe')).toBe(600);
      // Fast: every key of a stretch at 40 ms, as at Normal (not 6 x 20 = 120)
      expect(ms('ああ', 'fast') - ms('あ', 'fast')).toBe(240);
      expect(ms('あ😀', 'fast') - ms('あ', 'fast')).toBe(320);
      // what Fast still speeds up: the direct keys
      expect(ms('あabcd', 'fast') - ms('あ', 'fast')).toBe(4 * 20);
      expect(ms('あabcd') - ms('あ')).toBe(4 * 40);
      // on top: LANG2 and its settle for the run; LANG1, 100 ms and LANG2 for each stretch
      expect(ms('あ')).toBe(40 + IME_SETTLE_MS + 40 + 240 + IME_CODE_FIRST_F5_SETTLE_MS + 40);
      // 300 Japanese characters in one stretch, as the documentation quotes them
      const text = 'あ'.repeat(300);
      expect([ms(text, 'safe'), ms(text, 'normal'), ms(text, 'fast')]).toEqual([
        180550, 72370, 72310
      ]);
    });

    it('no speed preset is faster than 10 ms / 10 ms: below it the previous-generation IME ignores F5', () => {
      for (const [name, pacing] of Object.entries(PACING)) {
        expect(pacing.holdMs, name).toBeGreaterThanOrEqual(10);
        expect(pacing.gapMs, name).toBeGreaterThanOrEqual(10);
      }
    });

    // The engine handed each preset directly: what the stroke floor guarantees by itself. The app
    // types this method at planPacing(), never faster than Normal (plan.test.ts,
    // controller.test.ts): there Fast puts on the wire exactly what Normal does.
    describe('on the wire: the press times of a run', () => {
      /** The strokes through the real engine: every press as `name@ms` since the first report. */
      async function pressTimes(strokes: KeyStroke[], pacing: Pacing): Promise<string[]> {
        const clock = new FakeClock();
        const pressed: string[] = [];
        const engine = new TypingEngine({
          send: (report) => {
            if (report[2] !== 0) {
              const [name] = chords([{ mod: report[0], key: report[2] }]);
              pressed.push(`${name}@${clock.now()}`);
            }
            return Promise.resolve();
          },
          lock: new HidLock(),
          clock,
          interruptTarget: new EventTarget(),
          isInsideOwnUi: () => false
        });
        const done = engine.runProgram([{ kind: 'keys', strokes }], pacing);
        await flushMicrotasks();
        await clock.advanceAsync(estimateProgramMs([{ kind: 'keys', strokes }], pacing) + 100);
        expect(await done).toMatchObject({ reason: 'completed', typedStrokes: strokes.length });
        return pressed;
      }

      /** Milliseconds from each press of `from` to the press that follows it. */
      const intervals = (pressed: string[], from: (name: string) => boolean): number[] => {
        const at = pressed.map((entry) => Number(entry.split('@')[1]));
        return pressed.flatMap((entry, i) =>
          from(entry.split('@')[0]) && i + 1 < pressed.length ? [at[i + 1] - at[i]] : []
        );
      };

      it('Fast: from LANG1 to the last commit every key comes 40 ms after the one before, as at Normal', async () => {
        // "あいう" with every stroke at 10 ms / 10 ms had F5 at 490, the commit at 510 and the
        // next digit at 530: after a focus change the IME was still converting when the commit
        // came, and the digit at 530 was swallowed (あい０４６ arrived). With only F5 and the commit
        // at 40 ms, a page slow to handle its input events still lost digits that came 20 ms apart
        expect(await pressTimes(ime('あいう').strokes, PACING.fast)).toEqual([
          'Lang2@0',
          'Lang1@170',
          ...['Digit3@210', 'Digit0@250', 'Digit4@290', 'Digit2@330', 'F5@370', `${COMMIT}@490`],
          ...['Digit3@530', 'Digit0@570', 'Digit4@610', 'Digit4@650', 'F5@690', `${COMMIT}@730`],
          ...['Digit3@770', 'Digit0@810', 'Digit4@850', 'Digit6@890', 'F5@930', `${COMMIT}@970`],
          'Lang2@1010'
        ]);
      });

      it('Fast, in mid-text: every key after a commit comes 40 ms after it', async () => {
        // a line of the chat message in which, under a page slow to handle its input events, the
        // 9 of 高 (9ad8) was pressed 20 ms after the commit of の and swallowed (あｄ８ arrived)
        const pressed = await pressTimes(ime('・CSV出力の高速化(約3.5倍)').strokes, PACING.fast);
        const at = (i: number) => Number(pressed[i].split('@')[1]);
        const afterCommit = pressed.flatMap((entry, i) =>
          i > 0 && pressed[i - 1].startsWith(`${COMMIT}@`)
            ? [`${entry.split('@')[0]} +${at(i) - at(i - 1)}`]
            : []
        );
        expect(afterCommit).toEqual([
          'Lang2 +40', // ・, then CSV with the IME off
          ...['Digit5 +40', 'Digit3 +40'], // 出 → 力 (529b) → の (306e)
          'Digit9 +40', // の → 高 (9ad8)
          ...['Digit9 +40', 'Digit5 +40'], // 高 → 速 (901f) → 化 (5316)
          ...['Lang2 +40', 'Lang2 +40', 'Lang2 +40'] // 化, 約 and 倍 end their stretches
        ]);
      });

      it('at every speed no key of a stretch is followed sooner than after 40 ms; LANG2 and the direct keys keep the preset', async () => {
        // a mixed text: stretches of one, four and three units, a six-digit unit, a tab unit,
        // direct keys and line breaks in between
        const { strokes } = ime('xあ\nいう\t😀y\nえおか');
        for (const [name, pacing] of Object.entries(PACING)) {
          const pressed = await pressTimes(strokes, pacing);
          const stroke = pacing.holdMs + pacing.gapMs;
          const expected = Math.max(stroke, IME_CODE_MIN_STROKE_MS);
          // F5: the first of each of the three stretches waits 100 ms more
          expect(
            intervals(pressed, (key) => key === 'F5'),
            name
          ).toEqual(
            [100, 100, 0, 0, 0, 100, 0, 0].map((first) => Math.max(stroke + first, expected))
          );
          // the commit: before the next unit and before the LANG2 that ends a stretch alike
          expect(
            intervals(pressed, (key) => key === COMMIT),
            name
          ).toEqual(Array(8).fill(expected));
          // the digits and LANG1 as well: every key of a stretch
          expect(
            new Set(intervals(pressed, (key) => /^(Digit\d|Key[A-F])$/.test(key))),
            name
          ).toEqual(new Set([expected]));
          expect(
            intervals(pressed, (key) => key === 'Lang1'),
            name
          ).toEqual(Array(3).fill(expected));
          // LANG2 (the first with its settle; the last ends the run) and x, y: the preset's pace
          expect(
            intervals(pressed, (key) => key === 'Lang2'),
            name
          ).toEqual([stroke + IME_SETTLE_MS, stroke, stroke]);
          expect(
            intervals(pressed, (key) => key === 'KeyX' || key === 'KeyY'),
            name
          ).toEqual([stroke, stroke]);
        }
      });

      it('Normal and Safe are sent exactly as before: the floor changes nothing at 40 ms a stroke and more', async () => {
        // the measurements at Normal (first pastes after a focus change: 58 of 58 exact) stay valid
        const { strokes } = ime('xあ\nいう\t😀y\nえおか');
        const withoutFloor = strokes.map((s) => {
          const copy = { ...s };
          delete copy.minMs;
          return copy;
        });
        // the 50 strokes of the 8 units and the 3 LANG1
        expect(strokes.filter((s) => s.minMs !== undefined)).toHaveLength(53);
        expect(withoutFloor.some((s) => 'minMs' in s)).toBe(false);
        for (const speed of ['normal', 'safe'] as const) {
          expect(await pressTimes(strokes, PACING[speed]), speed).toEqual(
            await pressTimes(withoutFloor, PACING[speed])
          );
          expect(estimateProgramMs([{ kind: 'keys', strokes }], PACING[speed]), speed).toBe(
            estimateProgramMs([{ kind: 'keys', strokes: withoutFloor }], PACING[speed])
          );
        }
        // and Fast is what differs
        expect(await pressTimes(strokes, PACING.fast)).not.toEqual(
          await pressTimes(withoutFloor, PACING.fast)
        );
      });
    });
  });
});
