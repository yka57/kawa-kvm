import { describe, expect, it } from 'vitest';

import { NO_MODS } from '@/test/fakes';

import {
  DEFAULT_REMAP_CONFIG,
  isCtrlKey,
  isRemapActive,
  mapModifier,
  matchChord,
  matchRule,
  normalizeCtrlKeys,
  normalizeRemapConfig,
  REMAP_RULES,
  remapRecordedCode,
  type HostMods,
  type RemapContext
} from './remap-config';

const mods = (partial: Partial<HostMods>): HostMods => ({ ...NO_MODS, ...partial });

const ctx = (active: boolean, cfg: Partial<RemapContext['cfg']> = {}): RemapContext => ({
  cfg: { ...DEFAULT_REMAP_CONFIG, ...cfg },
  active,
  hostActions: []
});

describe('normalizeRemapConfig', () => {
  it('has the documented defaults (remap ON by default in this fork)', () => {
    expect(DEFAULT_REMAP_CONFIG).toEqual({
      version: 1,
      enabled: true,
      navRules: true,
      jisEisuKana: false,
      macCapsLockFix: true,
      tapReleaseMs: 50,
      minPressMs: 30,
      repeatUnderMeta: true,
      cmdSplit: true,
      ctrlKeys: 'ACFVXZ'
    });
  });

  it('fills defaults for undefined, garbage strings, arrays and empty objects', () => {
    for (const raw of [undefined, null, 'garbage', 42, [], {}, '[1,2]']) {
      const cfg = normalizeRemapConfig(raw);
      expect(cfg).toEqual(DEFAULT_REMAP_CONFIG);
      expect(cfg).not.toBe(DEFAULT_REMAP_CONFIG);
    }
  });

  it('keeps known fields, drops unknown ones and ignores wrong types', () => {
    const cfg = normalizeRemapConfig({
      version: 1,
      enabled: false,
      unknown: 1,
      navRules: 'yes',
      tapReleaseMs: '80'
    });
    expect(cfg).toEqual({ ...DEFAULT_REMAP_CONFIG, enabled: false });
    expect('unknown' in cfg).toBe(false);
  });

  it('accepts a JSON string (storage raw value)', () => {
    expect(normalizeRemapConfig('{"enabled":false,"jisEisuKana":true}')).toEqual({
      ...DEFAULT_REMAP_CONFIG,
      enabled: false,
      jisEisuKana: true
    });
  });

  it('clamps tapReleaseMs to 20..200 and minPressMs to 0..100', () => {
    expect(normalizeRemapConfig({ tapReleaseMs: 5 }).tapReleaseMs).toBe(20);
    expect(normalizeRemapConfig({ tapReleaseMs: 1000 }).tapReleaseMs).toBe(200);
    expect(normalizeRemapConfig({ tapReleaseMs: 120 }).tapReleaseMs).toBe(120);
    expect(normalizeRemapConfig({ tapReleaseMs: NaN }).tapReleaseMs).toBe(50);
    expect(normalizeRemapConfig({ tapReleaseMs: Infinity }).tapReleaseMs).toBe(50);
    expect(normalizeRemapConfig({ minPressMs: -5 }).minPressMs).toBe(0);
    expect(normalizeRemapConfig({ minPressMs: 500 }).minPressMs).toBe(100);
    expect(normalizeRemapConfig({ minPressMs: 0 }).minPressMs).toBe(0);
  });
});

describe('ctrlKeys', () => {
  it('normalises to unique uppercase letters and digits', () => {
    expect(normalizeCtrlKeys('a c,f v-x z c 1é')).toBe('ACFVXZ1');
    expect(normalizeRemapConfig({ ctrlKeys: 'zx' }).ctrlKeys).toBe('ZX');
    expect(normalizeRemapConfig({ ctrlKeys: 3 }).ctrlKeys).toBe('ACFVXZ');
    expect(normalizeRemapConfig({ cmdSplit: false }).cmdSplit).toBe(false);
  });

  it('isCtrlKey matches physical letter and digit codes only', () => {
    const cfg = { ...DEFAULT_REMAP_CONFIG, ctrlKeys: 'C1' };
    expect(isCtrlKey(cfg, 'KeyC')).toBe(true);
    expect(isCtrlKey(cfg, 'Digit1')).toBe(true);
    expect(isCtrlKey(cfg, 'KeyS')).toBe(false);
    expect(isCtrlKey(cfg, 'Numpad1')).toBe(false);
  });
});

describe('matchChord', () => {
  const chord = { code: 'KeyV', meta: true, shift: true };

  it('matches only the exact modifier set', () => {
    const ev = { code: 'KeyV', mods: mods({ meta: true, shift: true }), repeat: false };
    expect(matchChord(ev, chord)).toBe(true);
    expect(matchChord({ ...ev, mods: mods({ meta: true, shift: true, ctrl: true }) }, chord)).toBe(
      false
    );
    expect(matchChord({ ...ev, mods: mods({ meta: true }) }, chord)).toBe(false);
    expect(matchChord({ ...ev, code: 'KeyC' }, chord)).toBe(false);
  });

  it('never matches an autorepeat keydown', () => {
    expect(
      matchChord({ code: 'KeyV', mods: mods({ meta: true, shift: true }), repeat: true }, chord)
    ).toBe(false);
  });

  it('treats absent chord modifiers as required-up', () => {
    expect(matchChord({ code: 'KeyA', mods: mods({}), repeat: false }, { code: 'KeyA' })).toBe(
      true
    );
    expect(
      matchChord({ code: 'KeyA', mods: mods({ alt: true }), repeat: false }, { code: 'KeyA' })
    ).toBe(false);
  });
});

describe('mapModifier / remapRecordedCode / isRemapActive', () => {
  it('maps both ⌘ keys to Ctrl only while active', () => {
    expect(mapModifier('MetaLeft', true)).toBe('ControlLeft');
    expect(mapModifier('MetaRight', true)).toBe('ControlRight');
    expect(mapModifier('MetaLeft', false)).toBe('MetaLeft');
    expect(mapModifier('ShiftLeft', true)).toBe('ShiftLeft');
    expect(mapModifier('KeyC', true)).toBe('KeyC');
  });

  it('records ⌘ as Ctrl with the recorder label convention', () => {
    expect(remapRecordedCode('MetaLeft', true)).toEqual({ code: 'ControlLeft', label: 'Ctrl' });
    expect(remapRecordedCode('MetaRight', true)).toEqual({ code: 'ControlRight', label: 'Ctrl' });
    expect(remapRecordedCode('MetaLeft', false)).toEqual({ code: 'MetaLeft', label: 'Win' });
    expect(remapRecordedCode('ShiftRight', true)).toEqual({ code: 'ShiftRight', label: 'Shift' });
    expect(remapRecordedCode('AltLeft', false)).toEqual({ code: 'AltLeft', label: 'Alt' });
    expect(remapRecordedCode('KeyT', true)).toEqual({ code: 'KeyT', label: 'KeyT' });
  });

  it('is active only on a macOS host, when enabled, for a non-macOS target', () => {
    expect(isRemapActive(DEFAULT_REMAP_CONFIG, 'macOS', 'windows')).toBe(true);
    expect(isRemapActive(DEFAULT_REMAP_CONFIG, 'macOS', 'linux')).toBe(true);
    expect(isRemapActive(DEFAULT_REMAP_CONFIG, 'macOS', 'macos')).toBe(false);
    expect(isRemapActive(DEFAULT_REMAP_CONFIG, 'Windows', 'windows')).toBe(false);
    expect(isRemapActive({ ...DEFAULT_REMAP_CONFIG, enabled: false }, 'macOS', 'windows')).toBe(
      false
    );
  });
});

describe('matchRule', () => {
  it('returns null when inactive even for a matching chord', () => {
    expect(matchRule(ctx(false), mods({ meta: true }), 'ArrowLeft')).toBeNull();
  });

  it('cmdArrows: ⌘←/→ → Home/End, ⌘↑/↓ → Ctrl+Home/End, Shift preserved', () => {
    const c = ctx(true);
    expect(matchRule(c, mods({ meta: true }), 'ArrowLeft')).toEqual({
      emit: 'Home',
      mods: { ctrl: false, meta: false }
    });
    expect(matchRule(c, mods({ meta: true }), 'ArrowRight')?.emit).toBe('End');
    expect(matchRule(c, mods({ meta: true }), 'ArrowUp')).toEqual({
      emit: 'Home',
      mods: { ctrl: true, meta: false }
    });
    expect(matchRule(c, mods({ meta: true }), 'ArrowDown')?.emit).toBe('End');
    expect(matchRule(c, mods({ meta: true, shift: true }), 'ArrowLeft')?.emit).toBe('Home');
    expect(matchRule(c, mods({ meta: true, ctrl: true }), 'ArrowLeft')).toBeNull();
  });

  it('⌘⌥← matches cmdTabSwitch (Ctrl+Shift+Tab), not cmdArrows', () => {
    const c = ctx(true);
    expect(matchRule(c, mods({ meta: true, alt: true }), 'ArrowLeft')).toEqual({
      emit: 'Tab',
      mods: { ctrl: true, alt: false, shift: true, meta: false }
    });
    expect(matchRule(c, mods({ meta: true, alt: true }), 'ArrowRight')).toEqual({
      emit: 'Tab',
      mods: { ctrl: true, alt: false, shift: false, meta: false }
    });
  });

  it('cmdTabSwitch: ⌘⇧[ / ⌘⇧] → Ctrl+Shift+Tab / Ctrl+Tab; ⌘[ alone is not a rule', () => {
    const c = ctx(true);
    expect(matchRule(c, mods({ meta: true, shift: true }), 'BracketLeft')).toEqual({
      emit: 'Tab',
      mods: { ctrl: true, shift: true, meta: false }
    });
    expect(matchRule(c, mods({ meta: true, shift: true }), 'BracketRight')).toEqual({
      emit: 'Tab',
      mods: { ctrl: true, shift: false, meta: false }
    });
    expect(matchRule(c, mods({ meta: true }), 'BracketLeft')).toBeNull();
  });

  it('cmdTabSwitch follows the printed character when the event has one (JIS: [ is BracketRight)', () => {
    const c = ctx(true);
    const chord = mods({ meta: true, shift: true });
    const prev = { emit: 'Tab', mods: { ctrl: true, shift: true, meta: false } };
    const next = { emit: 'Tab', mods: { ctrl: true, shift: false, meta: false } };

    // JIS host keyboard: `[` is BracketRight, `]` is Backslash, BracketLeft is `@`
    expect(matchRule(c, chord, 'BracketRight', '[')).toEqual(prev);
    expect(matchRule(c, chord, 'BracketRight', '{')).toEqual(prev);
    expect(matchRule(c, chord, 'Backslash', ']')).toEqual(next);
    expect(matchRule(c, chord, 'Backslash', '}')).toEqual(next);
    expect(matchRule(c, chord, 'BracketLeft', '@')).toBeNull();
    expect(matchRule(c, chord, 'BracketLeft', '`')).toBeNull();

    // US host keyboard
    expect(matchRule(c, chord, 'BracketLeft', '{')).toEqual(prev);
    expect(matchRule(c, chord, 'BracketLeft', '[')).toEqual(prev);
    expect(matchRule(c, chord, 'BracketRight', '}')).toEqual(next);

    // no printable character: the code table decides
    expect(matchRule(c, chord, 'BracketLeft', undefined)).toEqual(prev);
    expect(matchRule(c, chord, 'BracketLeft', 'Dead')).toEqual(prev);
    expect(matchRule(c, chord, 'BracketRight', 'Unidentified')).toEqual(next);

    // rules without a character table ignore the key value
    expect(matchRule(c, mods({ meta: true, alt: true }), 'ArrowLeft', 'ArrowLeft')?.emit).toBe(
      'Tab'
    );
    expect(matchRule(c, mods({ meta: true }), 'ArrowLeft', 'ArrowLeft')?.emit).toBe('Home');
    expect(matchRule(ctx(true, { navRules: false }), chord, 'BracketRight', '[')).toBeNull();
  });

  it('optWord: ⌥←/→/⌫/⌦ → Ctrl+same with Alt suppressed', () => {
    const c = ctx(true);
    for (const code of ['ArrowLeft', 'ArrowRight', 'Backspace', 'Delete']) {
      expect(matchRule(c, mods({ alt: true }), code)).toEqual({
        emit: code,
        mods: { ctrl: true, alt: false }
      });
      expect(matchRule(c, mods({ alt: true, shift: true }), code)?.emit).toBe(code);
    }
    expect(matchRule(c, mods({ alt: true }), 'KeyA')).toBeNull();
  });

  it('navRules off disables the navigation rules only', () => {
    const c = ctx(true, { navRules: false, jisEisuKana: true });
    expect(matchRule(c, mods({ meta: true }), 'ArrowLeft')).toBeNull();
    expect(matchRule(c, mods({ alt: true }), 'Backspace')).toBeNull();
    expect(matchRule(c, mods({ meta: true, shift: true }), 'BracketLeft')).toBeNull();
    expect(matchRule(c, mods({}), 'Lang2')?.emit).toBe('NonConvert');
  });

  it('jisEisuKana: Lang2/Lang1 → NonConvert/Convert without modifiers, off by default', () => {
    expect(matchRule(ctx(true), mods({}), 'Lang2')).toBeNull();
    const c = ctx(true, { jisEisuKana: true });
    expect(matchRule(c, mods({}), 'Lang2')).toEqual({ emit: 'NonConvert', mods: {} });
    expect(matchRule(c, mods({}), 'Lang1')).toEqual({ emit: 'Convert', mods: {} });
    expect(matchRule(c, mods({ meta: true }), 'Lang2')).toBeNull();
  });

  it('plain ⌘ letters and prototype names are not rules', () => {
    expect(matchRule(ctx(true), mods({ meta: true }), 'KeyC')).toBeNull();
    expect(matchRule(ctx(true), mods({ meta: true }), 'constructor')).toBeNull();
    expect(matchRule(ctx(true), mods({ meta: true }), '__proto__')).toBeNull();
  });

  it('exposes the rule table with its ids', () => {
    expect(new Set(REMAP_RULES.map((rule) => rule.id))).toEqual(
      new Set(['cmdArrows', 'optWord', 'cmdTabSwitch', 'jisEisuKana'])
    );
  });
});
