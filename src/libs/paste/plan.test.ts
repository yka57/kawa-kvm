import { describe, expect, it } from 'vitest';

import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';

import {
  IME_CODE_FASTEST_SPEED,
  planPacing,
  planPaste,
  prepareRawText,
  type PlanOptions
} from './plan';
import { IME_SETTLE_MS, PASTE_HARD_LIMIT, textToKeySequence } from './text-to-keys';
import { estimateProgramMs, PACING, type SpeedPreset } from './typing-engine';
import {
  IME_CODE_COMMIT,
  IME_CODE_FIRST_F5_SETTLE_MS,
  IME_CODE_MIN_STROKE_MS
} from './unicode-entry';

const CTRL_SHIFT = ModifierBits.LeftCtrl | ModifierBits.LeftShift;

function opts(over: Partial<PlanOptions> = {}): PlanOptions {
  return {
    layout: 'us',
    newline: 'enter',
    normalizePunct: true,
    stripTrailingNewline: true,
    imePreKey: 'none',
    method: 'bridge',
    maxChars: PASTE_HARD_LIMIT,
    ...over
  };
}

describe('planPaste', () => {
  it('stays on the direct (v1) path when the layout can type everything', () => {
    for (const method of ['bridge', 'ime-code', 'ctrl-shift-u', 'alt-hex', 'skip'] as const) {
      expect(planPaste('Hello, world!\n', opts({ method })).kind, method).toBe('direct');
    }
    // the v1 compile as it is, with the IME pre-key the options say (ime-code: the next test)
    for (const method of ['bridge', 'ctrl-shift-u', 'alt-hex', 'skip'] as const) {
      for (const imePreKey of ['none', 'NonConvert', 'Lang2'] as const) {
        const plan = planPaste('Hello, world!\n', opts({ method, imePreKey }));
        expect(plan, `${method} ${imePreKey}`).toEqual({
          kind: 'direct',
          compiled: textToKeySequence('Hello, world!\n', opts({ method, imePreKey }))
        });
      }
    }
  });

  it('ime-code: the direct plan starts with LANG2 too, whatever the IME pre-key setting says', () => {
    // the one method that can leave the target IME on (a run stopped inside a stretch): with
    // "Don't send", the next ASCII-only text would be typed into the IME
    const withLang2 = textToKeySequence('abc', opts({ method: 'ime-code', imePreKey: 'Lang2' }));
    expect(withLang2.strokes.map((s) => s.key)).toEqual([
      KeycodeMap.Lang2,
      KeycodeMap.KeyA,
      KeycodeMap.KeyB,
      KeycodeMap.KeyC
    ]);
    for (const imePreKey of ['none', 'NonConvert', 'Lang2'] as const) {
      const plan = planPaste('abc', opts({ method: 'ime-code', imePreKey }));
      expect(plan, imePreKey).toEqual({ kind: 'direct', compiled: withLang2 });
      if (plan.kind !== 'direct') throw new Error(plan.kind);
      // exactly one pre-key: the setting's own key is not sent on top
      expect(plan.compiled.strokes.filter((s) => s.tag === 'ime-pre')).toEqual([
        { mod: 0, key: KeycodeMap.Lang2, src: -1, tag: 'ime-pre', afterMs: IME_SETTLE_MS }
      ]);
    }
    // the other methods keep following the setting for the same text
    for (const method of ['bridge', 'ctrl-shift-u', 'alt-hex', 'skip'] as const) {
      const none = planPaste('abc', opts({ method, imePreKey: 'none' }));
      if (none.kind !== 'direct') throw new Error(none.kind);
      expect(none.compiled.strokes[0], method).toEqual({
        mod: 0,
        key: KeycodeMap.KeyA,
        src: 0,
        tag: 'char'
      });
      const nonConvert = planPaste('abc', opts({ method, imePreKey: 'NonConvert' }));
      if (nonConvert.kind !== 'direct') throw new Error(nonConvert.kind);
      expect(nonConvert.compiled.strokes[0], method).toMatchObject({ key: KeycodeMap.NonConvert });
    }
  });

  it('ime-code: Tab stays a key on the direct plan and becomes the code unit 0009 otherwise', () => {
    // nothing but keys: no F5 follows, so a Tab that moves the focus does no harm
    const direct = planPaste('a\tb', opts({ method: 'ime-code' }));
    if (direct.kind !== 'direct') throw new Error(direct.kind);
    expect(direct.compiled.strokes.map((s) => s.key)).toEqual([
      KeycodeMap.Lang2,
      KeycodeMap.KeyA,
      KeycodeMap.Tab,
      KeycodeMap.KeyB
    ]);

    // one character without a key: the text goes by code input, and so does its tab
    const mixed = planPaste('a\tあ', opts({ method: 'ime-code' }));
    if (mixed.kind !== 'unicode') throw new Error(mixed.kind);
    expect(mixed.compiled.strokes.map((s) => s.key)).toEqual([
      KeycodeMap.Lang2,
      KeycodeMap.KeyA,
      KeycodeMap.Lang1,
      ...[KeycodeMap.Digit0, KeycodeMap.Digit0, KeycodeMap.Digit0, KeycodeMap.Digit9],
      ...[KeycodeMap.F5, IME_CODE_COMMIT.key],
      ...[KeycodeMap.Digit3, KeycodeMap.Digit0, KeycodeMap.Digit4, KeycodeMap.Digit2],
      ...[KeycodeMap.F5, IME_CODE_COMMIT.key],
      KeycodeMap.Lang2
    ]);
    expect(mixed.compiled.strokes.some((s) => s.tag === 'tab')).toBe(false);
    expect(mixed.compiled.stats).toMatchObject({ chars: 3, typed: 3, skipped: 0 });

    // the other code point methods press the key, as before
    for (const method of ['ctrl-shift-u', 'alt-hex'] as const) {
      const plan = planPaste('a\tあ', opts({ method }));
      if (plan.kind !== 'unicode') throw new Error(plan.kind);
      expect(plan.compiled.strokes[1], method).toEqual({
        mod: 0,
        key: KeycodeMap.Tab,
        src: 1,
        tag: 'tab'
      });
    }
  });

  it('folds punctuation on the direct path only', () => {
    // folded to ASCII quotes: typable directly
    const folded = planPaste('“a”…', opts());
    expect(folded.kind).toBe('direct');

    // without folding the quotes have no key: the bridge carries them byte-exact
    expect(planPaste('“a”…', opts({ normalizePunct: false }))).toMatchObject({
      kind: 'bridge',
      text: '“a”…'
    });

    // one non-ASCII character sends the whole text to the raw path, unfolded
    expect(planPaste('“a” あ', opts())).toMatchObject({ kind: 'bridge', text: '“a” あ' });
  });

  it('one character without a key (°) sends the whole text to the bridge; skip types the rest', () => {
    const text = 'Set the oven to 180°C';
    expect(planPaste(text, opts())).toMatchObject({ kind: 'bridge', text });
    const skip = planPaste(text, opts({ method: 'skip' }));
    if (skip.kind !== 'direct') throw new Error(skip.kind);
    expect(skip.compiled.skipped).toEqual([{ char: '°', index: 19, reason: 'no-key' }]);
    expect(skip.compiled.stats.typed).toBe(text.length - 1);
  });

  it('drops invisible characters on the direct path only (spec v2 §14.9)', () => {
    // soft hyphen, zero-width space, ZWNJ, ZWJ, word joiner, BOM inside the text
    const text = 'a\u00adb\u200bc\u200cd\u200de\u2060f\ufeffg';
    const direct = planPaste(text, opts());
    if (direct.kind !== 'direct') throw new Error(direct.kind);
    expect(direct.compiled.skipped).toEqual([]);
    expect(direct.compiled.stats).toMatchObject({ chars: 7, typed: 7 });

    // without folding they have no key: the bridge carries them byte-exact
    expect(planPaste(text, opts({ normalizePunct: false }))).toMatchObject({
      kind: 'bridge',
      text
    });
    // a raw path keeps them even with folding on
    expect(planPaste(`${text}あ`, opts())).toMatchObject({ kind: 'bridge', text: `${text}あ` });
    const unicode = planPaste('a\u200bあ', opts({ method: 'ctrl-shift-u' }));
    if (unicode.kind !== 'unicode') throw new Error(unicode.kind);
    expect(unicode.compiled.stats).toMatchObject({ chars: 3, typed: 3 });
  });

  it('skip keeps the v1 behaviour: Japanese is reported as skipped no-key', () => {
    const plan = planPaste('aあb', opts({ method: 'skip' }));
    expect(plan.kind).toBe('direct');
    if (plan.kind !== 'direct') return;
    expect(plan.compiled.skipped).toEqual([{ char: 'あ', index: 1, reason: 'no-key' }]);
    expect(plan.compiled.stats.typed).toBe(2);
  });

  it('bridge: the whole text, ASCII included, with raw stats', () => {
    expect(planPaste('aあb\n', opts())).toEqual({
      kind: 'bridge',
      text: 'aあb',
      skipped: [],
      stats: { chars: 3, typed: 3, skipped: 0, truncated: false, trailingNewlineStripped: true }
    });
  });

  it('ctrl-shift-u: direct strokes for keys, one Ctrl+Shift+U group per other code point', () => {
    const plan = planPaste('aあ', opts({ method: 'ctrl-shift-u' }));
    expect(plan.kind).toBe('unicode');
    if (plan.kind !== 'unicode') return;
    const { strokes, stats } = plan.compiled;
    expect(strokes[0]).toEqual({ mod: 0, key: KeycodeMap.KeyA, src: 0, tag: 'char' });
    expect(strokes[1]).toMatchObject({ mod: CTRL_SHIFT, key: KeycodeMap.KeyU, src: 1, group: 0 });
    expect(strokes).toHaveLength(1 + 6);
    expect(stats).toEqual({
      chars: 2,
      typed: 2,
      skipped: 0,
      truncated: false,
      trailingNewlineStripped: false
    });
  });

  it('applies no NFC on the raw paths: U+FA10 and a decomposed é survive', () => {
    // U+FA10 is a compatibility ideograph that NFC replaces with U+585A
    expect('\ufa10'.normalize('NFC')).toBe('\u585a');
    expect(planPaste('\ufa10', opts())).toMatchObject({ kind: 'bridge', text: '\ufa10' });
    expect(planPaste('e\u0301', opts())).toMatchObject({ kind: 'bridge', text: 'e\u0301' });

    const unicode = planPaste('\ufa10', opts({ method: 'ctrl-shift-u' }));
    if (unicode.kind !== 'unicode') throw new Error(unicode.kind);
    const digits = unicode.compiled.strokes.slice(1, 5).map((s) => s.key);
    expect(digits).toEqual([
      KeycodeMap.KeyF,
      KeycodeMap.KeyA,
      KeycodeMap.Digit1,
      KeycodeMap.Digit0
    ]);
  });

  it('ime-code: the unicode plan kind, LANG2 first, direct strokes for keys, code units between LANG1 and LANG2', () => {
    // opts() says imePreKey 'none': this method sends its LANG2 anyway
    const plan = planPaste('aあ', opts({ method: 'ime-code' }));
    expect(plan.kind).toBe('unicode');
    if (plan.kind !== 'unicode') return;
    const { strokes, stats, skipped } = plan.compiled;
    expect(strokes.map((s) => s.key)).toEqual([
      KeycodeMap.Lang2,
      KeycodeMap.KeyA,
      KeycodeMap.Lang1,
      ...[KeycodeMap.Digit3, KeycodeMap.Digit0, KeycodeMap.Digit4, KeycodeMap.Digit2],
      KeycodeMap.F5,
      IME_CODE_COMMIT.key,
      KeycodeMap.Lang2
    ]);
    expect(strokes[0]).toMatchObject({ tag: 'ime-pre', src: -1 });
    expect(strokes[1]).toEqual({ mod: 0, key: KeycodeMap.KeyA, src: 0, tag: 'char' });
    // every key of the stretch carries the floor that keeps it at 40 ms a stroke at every speed
    expect(strokes[2]).toEqual({
      mod: 0,
      key: KeycodeMap.Lang1,
      src: -1,
      tag: 'ime-pre',
      minMs: IME_CODE_MIN_STROKE_MS
    });
    expect(strokes[3]).toEqual({
      mod: 0,
      key: KeycodeMap.Digit3,
      src: 1,
      tag: 'unicode',
      group: 0,
      minMs: IME_CODE_MIN_STROKE_MS
    });
    expect(strokes[7]).toEqual({
      mod: 0,
      key: KeycodeMap.F5,
      src: 1,
      tag: 'unicode',
      group: 0,
      afterMs: IME_CODE_FIRST_F5_SETTLE_MS,
      minMs: IME_CODE_MIN_STROKE_MS
    });
    expect(strokes[8]).toEqual({
      ...IME_CODE_COMMIT,
      src: 1,
      tag: 'unicode',
      group: 0,
      minMs: IME_CODE_MIN_STROKE_MS
    });
    expect(skipped).toEqual([]);
    expect(stats).toEqual({
      chars: 2,
      typed: 2,
      skipped: 0,
      truncated: false,
      trailingNewlineStripped: false
    });
  });

  it('ime-code works on the raw text: no punctuation folding, no NFC, the newline mode applies', () => {
    // the curly quotes stay what they are (201c, 201d) although folding is on
    const quotes = planPaste('“a”あ', opts({ method: 'ime-code' }));
    if (quotes.kind !== 'unicode') throw new Error(quotes.kind);
    expect(quotes.compiled.strokes.filter((s) => s.key === KeycodeMap.F5)).toHaveLength(3);
    expect(quotes.compiled.strokes.slice(2, 6).map((s) => s.key)).toEqual([
      KeycodeMap.Digit2,
      KeycodeMap.Digit0,
      KeycodeMap.Digit1,
      KeycodeMap.KeyC
    ]);

    // U+FA10 is not replaced by its NFC form U+585A
    const compat = planPaste('\u{fa10}', opts({ method: 'ime-code' }));
    if (compat.kind !== 'unicode') throw new Error(compat.kind);
    expect(compat.compiled.strokes.slice(2, 6).map((s) => s.key)).toEqual([
      KeycodeMap.KeyF,
      KeycodeMap.KeyA,
      KeycodeMap.Digit1,
      KeycodeMap.Digit0
    ]);

    const lines = planPaste('あ\nb', opts({ method: 'ime-code', newline: 'shift-enter' }));
    if (lines.kind !== 'unicode') throw new Error(lines.kind);
    expect(lines.compiled.strokes.slice(-3)).toEqual([
      { mod: 0, key: KeycodeMap.Lang2, src: -1, tag: 'ime-pre' },
      { mod: ModifierBits.LeftShift, key: KeycodeMap.Enter, src: 1, tag: 'enter' },
      { mod: 0, key: KeycodeMap.KeyB, src: 2, tag: 'char' }
    ]);
  });

  it('passes the IME pre-key and the newline mode to the Ctrl+Shift+U compile', () => {
    const plan = planPaste('あ\nb', opts({ method: 'ctrl-shift-u', imePreKey: 'Lang2' }));
    if (plan.kind !== 'unicode') throw new Error(plan.kind);
    expect(plan.compiled.strokes[0]).toMatchObject({ key: KeycodeMap.Lang2, tag: 'ime-pre' });
    expect(plan.compiled.strokes.map((s) => s.tag).slice(-2)).toEqual(['enter', 'char']);
  });
});

describe('planPacing', () => {
  const SPEEDS: SpeedPreset[] = ['safe', 'normal', 'fast'];

  it('a text entered by IME code input is typed no faster than Normal: Fast is Normal', () => {
    // measured: with the keys of a code held 10 ms (Fast) the first digit after a commit was
    // lost on the target now and then; at 20 ms / 20 ms it was not
    const plan = planPaste('aあ\nb', opts({ method: 'ime-code' }));
    expect(plan).toMatchObject({ kind: 'unicode', method: 'ime-code' });
    expect(IME_CODE_FASTEST_SPEED).toBe('normal');
    expect(planPacing(plan, 'fast')).toBe(PACING.normal);
    expect(planPacing(plan, 'normal')).toBe(PACING.normal);
    // Safe is slower and stays what it is
    expect(planPacing(plan, 'safe')).toBe(PACING.safe);
    // the whole text goes at that pace, its direct keys and line breaks included
    if (plan.kind !== 'unicode') return;
    const steps = [{ kind: 'keys' as const, strokes: plan.compiled.strokes }];
    expect(estimateProgramMs(steps, planPacing(plan, 'fast'))).toBe(
      estimateProgramMs(steps, PACING.normal)
    );
  });

  it('every other plan keeps the preset', () => {
    // a text the layout types completely is a direct plan, also with IME code input selected
    const plans = [
      planPaste('Hello, world!', opts({ method: 'ime-code' })),
      planPaste('aあ', opts({ method: 'ctrl-shift-u' })),
      planPaste('aあ', opts({ method: 'alt-hex' })),
      planPaste('aあ', opts({ method: 'bridge' })),
      planPaste('aあ', opts({ method: 'skip' }))
    ];
    expect(plans.map((plan) => (plan.kind === 'unicode' ? plan.method : plan.kind))).toEqual([
      'direct',
      'ctrl-shift-u',
      'alt-hex',
      'bridge',
      'direct'
    ]);
    for (const plan of plans) {
      for (const speed of SPEEDS) {
        expect(planPacing(plan, speed), `${plan.kind} ${speed}`).toBe(PACING[speed]);
      }
    }
  });
});

describe('prepareRawText', () => {
  const prepare = (
    text: string,
    over: { stripTrailingNewline?: boolean; maxChars?: number } = {}
  ) => prepareRawText(text, { stripTrailingNewline: true, maxChars: PASTE_HARD_LIMIT, ...over });

  it('strips a leading BOM and folds CRLF and lone CR to LF', () => {
    expect(prepare('\ufeffあ\r\nb\rc', { stripTrailingNewline: false }).text).toBe('あ\nb\nc');
    expect(prepare('a\ufeffb').text).toBe('a\ufeffb');
  });

  it('drops exactly one trailing newline when asked', () => {
    expect(prepare('あ\n\n')).toMatchObject({
      text: 'あ\n',
      stats: { chars: 2, trailingNewlineStripped: true }
    });
    expect(prepare('あ\r\n').text).toBe('あ');
    expect(prepare('あ\n', { stripTrailingNewline: false })).toMatchObject({
      text: 'あ\n',
      stats: { chars: 2, trailingNewlineStripped: false }
    });
  });

  it('keeps a leading newline, tabs and newlines; removes other controls as skipped', () => {
    const prepared = prepare('\nあ\t\x07b\x7f\x85\x1b[0m', { stripTrailingNewline: false });
    expect(prepared.text).toBe('\nあ\tb[0m');
    expect(prepared.graphemes).toEqual(['\n', 'あ', '\t', 'b', '[', '0', 'm']);
    expect(prepared.skipped).toEqual([
      { char: '\x07', index: 3, reason: 'control' },
      { char: '\x7f', index: 5, reason: 'control' },
      { char: '\x85', index: 6, reason: 'control' },
      { char: '\x1b', index: 7, reason: 'control' }
    ]);
    expect(prepared.stats).toEqual({
      chars: 11,
      typed: 7,
      skipped: 4,
      truncated: false,
      trailingNewlineStripped: false
    });
  });

  it('skips graphemes past maxChars as limit and counts graphemes, not code units', () => {
    const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
    const prepared = prepare(`あ${family}いう`, { maxChars: 2 });
    expect(prepared.text).toBe(`あ${family}`);
    expect(prepared.skipped).toEqual([
      { char: 'い', index: 2, reason: 'limit' },
      { char: 'う', index: 3, reason: 'limit' }
    ]);
    expect(prepared.stats).toEqual({
      chars: 4,
      typed: 2,
      skipped: 2,
      truncated: true,
      trailingNewlineStripped: false
    });
    expect(prepared.stats.chars).toBe(prepared.stats.typed + prepared.stats.skipped);
  });

  it('treats a non-finite maxChars as the hard limit', () => {
    expect(prepare('あい', { maxChars: Number.NaN }).stats.truncated).toBe(false);
  });

  it('flows into the bridge plan: truncation and controls are reported, not typed', () => {
    const plan = planPaste('あ\x07いう', opts({ maxChars: 3 }));
    expect(plan).toEqual({
      kind: 'bridge',
      text: 'あい',
      skipped: [
        { char: '\x07', index: 1, reason: 'control' },
        { char: 'う', index: 3, reason: 'limit' }
      ],
      stats: { chars: 4, typed: 2, skipped: 2, truncated: true, trailingNewlineStripped: false }
    });
  });
});
