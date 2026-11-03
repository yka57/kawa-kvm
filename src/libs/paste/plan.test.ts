import { describe, expect, it } from 'vitest';

import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';

import { planPaste, prepareRawText, type PlanOptions } from './plan';
import { PASTE_HARD_LIMIT, textToKeySequence } from './text-to-keys';

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
    for (const method of ['bridge', 'ctrl-shift-u', 'skip'] as const) {
      const plan = planPaste('Hello, world!\n', opts({ method }));
      expect(plan).toEqual({
        kind: 'direct',
        compiled: textToKeySequence('Hello, world!\n', opts({ method }))
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

  it('passes the IME pre-key and the newline mode to the Ctrl+Shift+U compile', () => {
    const plan = planPaste('あ\nb', opts({ method: 'ctrl-shift-u', imePreKey: 'Lang2' }));
    if (plan.kind !== 'unicode') throw new Error(plan.kind);
    expect(plan.compiled.strokes[0]).toMatchObject({ key: KeycodeMap.Lang2, tag: 'ime-pre' });
    expect(plan.compiled.strokes.map((s) => s.tag).slice(-2)).toEqual(['enter', 'char']);
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
