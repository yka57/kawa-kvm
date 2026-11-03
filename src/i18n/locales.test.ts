import { afterEach, describe, expect, it, vi } from 'vitest';

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
