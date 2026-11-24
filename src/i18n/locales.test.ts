import { afterEach, describe, expect, it, vi } from 'vitest';

import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import { IME_CODE_COMMIT } from '@/libs/paste/unicode-entry';
import { flattenKeys } from '@/test/fakes';

import languages from './languages';
import be from './locales/be';
import de from './locales/de';
import en from './locales/en';
import ja from './locales/ja';
import ko from './locales/ko';
import nl from './locales/nl';
import pl from './locales/pl';
import pt_br from './locales/pt_br';
import ru from './locales/ru';
import zh from './locales/zh';
import zh_tw from './locales/zh_tw';

const locales: Record<string, unknown> = { be, de, en, ja, ko, nl, pl, pt_br, ru, zh, zh_tw };

function leaves(obj: unknown, prefix = ''): [string, unknown][] {
  if (obj === null || typeof obj !== 'object') return prefix ? [[prefix, obj]] : [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) =>
    leaves(value, prefix ? `${prefix}.${key}` : key)
  );
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]).sort();
}

/** A key chord as the texts spell it: modifier names, then the key's code name without "Key". */
function chordLabel(chord: { mod: number; key: number }): string {
  const modifiers = [
    [ModifierBits.LeftCtrl, 'Ctrl'],
    [ModifierBits.LeftShift, 'Shift'],
    [ModifierBits.LeftAlt, 'Alt']
  ] as const;
  const code = Object.keys(KeycodeMap).find((name) => KeycodeMap[name] === chord.key) ?? '';
  return [
    ...modifiers.filter(([bit]) => (chord.mod & bit) !== 0).map(([, name]) => name),
    code.replace(/^Key/, '')
  ].join('+');
}

describe('locale parity', () => {
  const enKeys = flattenKeys(en);
  // keys as t() sees them (without the 'translation.' namespace wrapper)
  const enLeafKeys = flattenKeys(en.translation);

  it('ja has exactly the key set of en', () => {
    expect(flattenKeys(ja)).toEqual(enKeys);
  });

  it('every en and ja leaf is a non-empty string', () => {
    for (const [key, value] of [...leaves(en), ...leaves(ja)]) {
      expect(typeof value, key).toBe('string');
      expect((value as string).trim().length, key).toBeGreaterThan(0);
    }
  });

  it('ja keeps the same {{placeholders}} as en for every key', () => {
    const jaMap = new Map(leaves(ja));
    for (const [key, value] of leaves(en)) {
      expect(placeholders(jaMap.get(key) as string), key).toEqual(placeholders(value as string));
    }
  });

  it('en contains every key the spec lists for the new features', () => {
    const required = [
      'target.os',
      'target.layout',
      'target.windows',
      'target.linux',
      'target.macos',
      'target.us',
      'target.jis',
      'keyboard.remap.title',
      'keyboard.remap.off',
      'keyboard.remap.on',
      'keyboard.remap.inactiveMacTarget',
      'keyboard.remap.nav',
      'keyboard.remap.jis',
      'keyboard.remap.capsLock',
      'keyboard.remap.help',
      'keyboard.remap.helpWindow',
      'keyboard.remap.helpFullscreen',
      'keyboard.remap.helpNever',
      'keyboard.remap.sideEffects',
      'keyboard.remap.enterFullscreen',
      'keyboard.remap.keyTest',
      'keyboard.remap.keyTestHint',
      'keyboard.remap.releaseAll',
      'keyboard.remap.recordAsCtrl',
      'keyboard.remap.imeHint',
      'mouse.scrollSensitivity',
      'mouse.pointerSpeed',
      'mouse.relativeOnly',
      'paste.title',
      'paste.settings',
      'paste.cancel',
      'paste.typeText',
      'paste.textPlaceholder',
      'paste.speed',
      'paste.speedSafe',
      'paste.speedNormal',
      'paste.newline',
      'paste.newlineEnter',
      'paste.newlineShiftEnter',
      'paste.normalize',
      'paste.stripTrailingNewline',
      'paste.hotkey',
      'paste.hotkeyNeedsRemap',
      'paste.change',
      'paste.progress',
      'paste.skipped',
      'paste.skippedList',
      'paste.nothingTypeable',
      'paste.doneCompleted',
      'paste.doneCancelled',
      'paste.doneKey',
      'paste.doneMouse',
      'paste.doneHidden',
      'paste.doneSerial',
      'paste.confirmLarge',
      'paste.truncated',
      'paste.permDenied',
      'paste.noFocus',
      'paste.empty',
      'paste.notConnected',
      'paste.capsHint',
      'debug.hidLog',
      'debug.copy',
      'debug.clear'
    ];
    const missing = required.filter((key) => !enLeafKeys.includes(key));
    expect(missing).toEqual([]);
    // the first-run badge was dropped on purpose
    expect(enLeafKeys).not.toContain('keyboard.remap.badgeTip');
  });

  it('en contains every paste key of spec v2 §10, and the old IME checkbox key is gone', () => {
    const required = [
      'speedFast',
      'unicodeMethod',
      'unicodeAuto',
      'unicodeBridge',
      'unicodeCtrlShiftU',
      'unicodeSkip',
      'bridgeHint',
      'unicodeHint',
      'bridgeWindow',
      'bridgeChromium',
      'bridgeFirefox',
      'bridgeNewWindow',
      'imePreKey',
      'imeAuto',
      'imeLang2',
      'imeNonConvert',
      'imeNone',
      'fixCapsLock',
      'bridgeIntroTitle',
      'bridgeIntro',
      'phaseWindow',
      'phaseProbe',
      'phaseType',
      'phaseVerify',
      'phaseCopy',
      'phaseClose',
      'phasePaste',
      'doNotTouch',
      'doneNoWindow',
      'doneProbeFailed',
      'doneLoadFailed',
      'doneVerifyFailed',
      'doneCloseFailed',
      'doneCapsLock',
      'noVideo'
    ].map((key) => `paste.${key}`);
    const missing = required.filter((key) => !enLeafKeys.includes(key));
    expect(missing).toEqual([]);
    expect(enLeafKeys).not.toContain('paste.imeOff');
  });

  it('en contains every paste key of spec v2 §14 (new stop reasons and hints)', () => {
    const required = [
      'doneNoVideo',
      'doneBusyScreen',
      'doneProbeRed',
      'doneCopyFailed',
      'bridgeWindowHint',
      'capsOffHint'
    ].map((key) => `paste.${key}`);
    const missing = required.filter((key) => !enLeafKeys.includes(key));
    expect(missing).toEqual([]);
  });

  it('en and ja contain the keys of the Windows methods that open no window; the Alt + numpad hint names its conditions', () => {
    const required = ['unicodeImeCode', 'imeCodeHint', 'unicodeAltHex', 'altHexHint'].map(
      (key) => `paste.${key}`
    );
    const missing = required.filter((key) => !enLeafKeys.includes(key));
    expect(missing).toEqual([]);

    const hints = [en.translation.paste, ja.translation.paste];
    for (const { altHexHint } of hints) {
      // Alt + numpad types nothing with NumLock off under the default Microsoft IME
      expect(altHexHint).toContain('NumLock');
      expect(altHexHint).toContain('EnableHexNumpad');
    }
  });

  it('the IME code input hint keeps its warnings, and claims nothing that was not measured', () => {
    const enHint = en.translation.paste.imeCodeHint;
    const jaHint = ja.translation.paste.imeCodeHint;

    // the sequence it describes ends with the chord the compiler really sends ("Ctrl+M")
    const commit = chordLabel(IME_CODE_COMMIT);
    expect(enHint).toContain(`F5, ${commit})`);
    expect(jaHint).toContain(`F5 → ${commit}）`);

    // kana input: wrong characters, without any error
    expect(enHint).toMatch(/romaji input[^.]*: with kana input every character comes out wrong\./);
    expect(jaHint).toMatch(/ローマ字入力[^。]*かな入力だと、すべて違う文字になります/);
    // IME unavailable: the digits and F5 reach the application
    expect(enHint).toMatch(/IME is unavailable: the digits and F5 would reach the application/);
    expect(jaHint).toMatch(/IME が使えない欄では数字と F5 がそのまま届く/);
    // a lasting change on the target
    expect(enHint).toContain(
      "Every character is added to the target IME's input history (prediction suggestions)."
    );
    expect(jaHint).toContain('確定した文字は操作先の IME の入力履歴（予測候補）に残ります。');
    // a lost key shows as full-width digits or letters: the way out is the Safe speed
    expect(enHint).toMatch(/arrives as full-width digits or letters[^.]*: set the speed to Safe\./);
    expect(jaHint).toMatch(/全角の数字や英字のまま入るときは[^。]*速度を「安全」にしてください。/);
    // code input is never typed faster than Normal
    expect(enHint).toContain('About 0.25 s per character: Fast is typed at the pace of Normal.');
    expect(jaHint).toContain(
      '目安は 1 文字 0.25 秒です（「高速」を選んでも「標準」の速さで打ちます）。'
    );
    // measured in a virtual machine on Windows 11 only (Edge and Notepad)...
    expect(enHint).toMatch(/Measured on Windows 11 in a virtual machine only \(Edge and Notepad\)/);
    expect(jaHint).toMatch(/測定したのは仮想マシンの Windows 11（Edge とメモ帳）だけ/);
    // ...so neither hint may say anything about Teams or Windows 10: the READMEs list them as
    // not measured, and a hint that names them would read as a claim that they work
    for (const hint of [enHint, jaHint]) {
      expect(hint).not.toMatch(/Teams|Windows\s*10/i);
    }
  });

  it('every other locale is a subset of en (extra keys only warn)', () => {
    const enSet = new Set(enKeys);
    for (const [name, locale] of Object.entries(locales)) {
      if (name === 'en' || name === 'ja') continue;
      const extra = flattenKeys(locale).filter((key) => !enSet.has(key));
      if (extra.length > 0) {
        console.warn(`locale ${name} has keys unknown to en: ${extra.join(', ')}`);
      }
      // upstream locales fall back to en for missing keys; only the structure must match
      expect(typeof (locale as { translation?: unknown }).translation, name).toBe('object');
    }
  });

  it('languages.ts lists exactly the locale files, including ja', () => {
    const keys = languages.map((language) => language.key).sort();
    expect(keys).toEqual(Object.keys(locales).sort());
    expect(languages.find((language) => language.key === 'ja')?.name).toBe('日本語');
  });
});

describe('i18n bootstrap', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('auto-selects ja for navigator.language ja-JP when no language is stored', async () => {
    const map = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key)
    });
    vi.stubGlobal('navigator', { language: 'ja-JP' });
    vi.resetModules();

    const { default: i18n } = await import('./index');

    expect(i18n.language).toBe('ja');
    expect(i18n.t('keyboard.virtualKeyboard')).toBe('仮想キーボード');
    expect(i18n.t('target.os')).toBe('操作先 OS');
    expect(i18n.t('paste.progress', { done: 3, total: 10, eta: 2 })).toBe('3 / 10 · 残り約2秒');
  });
});
