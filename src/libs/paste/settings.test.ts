import { describe, expect, it } from 'vitest';

import type { System } from '@/libs/browser';
import type { TargetOs } from '@/libs/storage';

import {
  DEFAULT_PASTE_HOTKEY,
  defaultPasteSettings,
  normaliseHotkey,
  normalisePasteSettings,
  PASTE_SETTINGS_VERSION,
  resolveImePreKey,
  resolveUnicodeMethod,
  type ImePreKeySetting,
  type PasteSettings,
  type UnicodeMethodSetting
} from './settings';

const KEYS = [
  'version',
  'speed',
  'newline',
  'normalizePunct',
  'stripTrailingNewline',
  'imePreKey',
  'unicodeMethod',
  'bridgeWindow',
  'fixCapsLock',
  'hotkeyEnabled',
  'hotkey'
].sort();

describe('defaultPasteSettings', () => {
  it('enables the hotkey only on macOS hosts', () => {
    const hosts: System[] = ['Windows', 'macOS', 'Linux', 'Unknown'];
    for (const host of hosts) {
      expect(defaultPasteSettings(host)).toEqual({
        version: 2,
        speed: 'normal',
        newline: 'enter',
        normalizePunct: true,
        stripTrailingNewline: true,
        imePreKey: 'auto',
        unicodeMethod: 'auto',
        bridgeWindow: 'chromium-private',
        fixCapsLock: true,
        hotkeyEnabled: host === 'macOS',
        hotkey: { code: 'KeyV', meta: true, shift: true }
      });
    }
    expect(PASTE_SETTINGS_VERSION).toBe(2);
    expect(DEFAULT_PASTE_HOTKEY).toEqual({ code: 'KeyV', meta: true, shift: true });
  });

  it('returns a fresh hotkey object each time', () => {
    const a = defaultPasteSettings('macOS');
    const b = defaultPasteSettings('macOS');
    expect(a.hotkey).not.toBe(b.hotkey);
    expect(a.hotkey).not.toBe(DEFAULT_PASTE_HOTKEY);
  });
});

describe('normalisePasteSettings', () => {
  it('returns defaults for anything that is not an object', () => {
    for (const raw of [null, undefined, 'x', 42, true, [], JSON.stringify({ speed: 'safe' })]) {
      expect(normalisePasteSettings(raw, 'macOS')).toEqual(defaultPasteSettings('macOS'));
      expect(normalisePasteSettings(raw, 'Windows')).toEqual(defaultPasteSettings('Windows'));
    }
  });

  it('keeps valid fields and drops unknown ones', () => {
    const result = normalisePasteSettings(
      {
        version: 1,
        speed: 'safe',
        newline: 'shift-enter',
        normalizePunct: false,
        stripTrailingNewline: false,
        imePreKey: 'NonConvert',
        hotkeyEnabled: true,
        hotkey: { code: 'KeyP', ctrl: true, alt: true },
        targetOs: 'windows',
        layout: 'jis',
        foo: { bar: 1 }
      },
      'Linux'
    );
    expect(result).toEqual({
      version: 2,
      speed: 'safe',
      newline: 'shift-enter',
      normalizePunct: false,
      stripTrailingNewline: false,
      imePreKey: 'NonConvert',
      unicodeMethod: 'auto',
      bridgeWindow: 'chromium-private',
      fixCapsLock: true,
      hotkeyEnabled: true,
      hotkey: { code: 'KeyP', ctrl: true, alt: true }
    });
    expect(Object.keys(result).sort()).toEqual(KEYS);
  });

  it('fills missing fields with the host defaults (forward migration)', () => {
    expect(normalisePasteSettings({}, 'macOS')).toEqual(defaultPasteSettings('macOS'));
    expect(normalisePasteSettings({ speed: 'safe' }, 'Windows')).toEqual({
      ...defaultPasteSettings('Windows'),
      speed: 'safe'
    });
    expect(normalisePasteSettings({ version: 99, hotkeyEnabled: false }, 'macOS')).toEqual({
      ...defaultPasteSettings('macOS'),
      hotkeyEnabled: false
    });
    expect(normalisePasteSettings({ hotkeyEnabled: true }, 'Windows').hotkeyEnabled).toBe(true);
  });

  it('resets invalid enums and non-boolean flags to their defaults', () => {
    const result = normalisePasteSettings(
      {
        speed: 'turbo',
        newline: 'cr',
        imePreKey: 'Lang1',
        normalizePunct: 'yes',
        stripTrailingNewline: 0,
        hotkeyEnabled: 'true'
      },
      'macOS'
    );
    expect(result).toEqual(defaultPasteSettings('macOS'));
  });

  it('migrates the pre-release shape', () => {
    const old = {
      version: 1,
      targetOs: 'windows',
      layout: 'jis',
      speed: 'fast',
      custom: { holdMs: 8, gapMs: 8 },
      nonAscii: 'skip',
      winCodePage: 932,
      normalize: { quotes: true, dashes: false, nbsp: false, fullwidthAscii: false },
      imePreKey: 'Lang2',
      hotkey: null,
      cmdVTypesClipboard: false,
      reviewFirst: true
    };
    expect(normalisePasteSettings(old, 'macOS')).toEqual({
      version: 2,
      speed: 'fast',
      newline: 'enter',
      normalizePunct: true,
      stripTrailingNewline: true,
      imePreKey: 'Lang2',
      unicodeMethod: 'auto',
      bridgeWindow: 'chromium-private',
      fixCapsLock: true,
      hotkeyEnabled: false,
      hotkey: { code: 'KeyV', meta: true, shift: true }
    });
    expect(
      normalisePasteSettings(
        { ...old, normalize: { quotes: false, dashes: false, nbsp: false } },
        'macOS'
      ).normalizePunct
    ).toBe(false);
    expect(
      normalisePasteSettings({ ...old, hotkey: { code: 'KeyV', meta: true } }, 'macOS')
    ).toMatchObject({ hotkeyEnabled: true, hotkey: { code: 'KeyV', meta: true } });
  });

  it('normalises the hotkey chord to its canonical form', () => {
    expect(
      normaliseHotkey({ code: 'KeyP', meta: true, shift: false, alt: 'yes', ctrl: 1, extra: 1 })
    ).toEqual({ code: 'KeyP', meta: true });
    expect(normaliseHotkey({ code: 'F5' })).toEqual({ code: 'F5' });
    expect(normaliseHotkey({ code: '' })).toBeNull();
    expect(normaliseHotkey({ meta: true })).toBeNull();
    expect(normaliseHotkey('KeyV')).toBeNull();
    expect(normaliseHotkey(null)).toBeNull();

    const result = normalisePasteSettings({ hotkey: { code: '' } }, 'macOS');
    expect(result.hotkey).toEqual(DEFAULT_PASTE_HOTKEY);
    expect(result.hotkey).not.toBe(DEFAULT_PASTE_HOTKEY);
  });

  it('is idempotent and survives a JSON round trip', () => {
    const once = normalisePasteSettings(
      { speed: 'safe', hotkey: { code: 'KeyB', shift: true } },
      'Windows'
    );
    expect(normalisePasteSettings(once, 'Windows')).toEqual(once);
    expect(normalisePasteSettings(JSON.parse(JSON.stringify(once)), 'Windows')).toEqual(once);
  });

  it('produces the PasteSettings type with the literal version 2', () => {
    const settings: PasteSettings = normalisePasteSettings({}, 'macOS');
    expect(settings.version).toBe(2);
  });
});

describe('v1 → v2 migration', () => {
  it("reads a v1 (or unversioned) 'none' IME pre-key as 'auto' and keeps 無変換", () => {
    expect(normalisePasteSettings({ version: 1, imePreKey: 'none' }, 'macOS').imePreKey).toBe(
      'auto'
    );
    expect(normalisePasteSettings({ imePreKey: 'none' }, 'macOS').imePreKey).toBe('auto');
    expect(normalisePasteSettings({ version: 1, imePreKey: 'NonConvert' }, 'macOS').imePreKey).toBe(
      'NonConvert'
    );
    // in v2 'none' is an explicit choice
    expect(normalisePasteSettings({ version: 2, imePreKey: 'none' }, 'macOS').imePreKey).toBe(
      'none'
    );
  });

  it('turns a stored v1 object into v2 with the new fields at their defaults, idempotently', () => {
    const v1 = {
      version: 1,
      speed: 'safe',
      newline: 'enter',
      normalizePunct: true,
      stripTrailingNewline: false,
      imePreKey: 'none',
      hotkeyEnabled: true,
      hotkey: { code: 'KeyV', meta: true, shift: true }
    };
    const v2 = normalisePasteSettings(v1, 'macOS');
    expect(v2).toEqual({
      ...defaultPasteSettings('macOS'),
      speed: 'safe',
      stripTrailingNewline: false
    });
    expect(Object.keys(v2).sort()).toEqual(KEYS);
    // what a writer stores is read back unchanged
    expect(normalisePasteSettings(JSON.parse(JSON.stringify(v2)), 'macOS')).toEqual(v2);
  });

  it('keeps every valid v2 value and resets invalid new fields to their defaults', () => {
    const stored: PasteSettings = {
      version: 2,
      speed: 'fast',
      newline: 'shift-enter',
      normalizePunct: false,
      stripTrailingNewline: false,
      imePreKey: 'Lang2',
      unicodeMethod: 'ctrl-shift-u',
      bridgeWindow: 'firefox-private',
      fixCapsLock: false,
      hotkeyEnabled: false,
      hotkey: { code: 'KeyB', ctrl: true }
    };
    expect(normalisePasteSettings(stored, 'Windows')).toEqual(stored);
    for (const unicodeMethod of ['auto', 'bridge', 'ctrl-shift-u', 'skip']) {
      expect(normalisePasteSettings({ unicodeMethod }, 'Windows').unicodeMethod).toBe(
        unicodeMethod
      );
    }
    for (const bridgeWindow of ['chromium-private', 'firefox-private', 'new-window']) {
      expect(normalisePasteSettings({ bridgeWindow }, 'Windows').bridgeWindow).toBe(bridgeWindow);
    }

    expect(
      normalisePasteSettings(
        { version: 2, unicodeMethod: 'alt-x', bridgeWindow: 'tab', fixCapsLock: 'yes' },
        'Windows'
      )
    ).toEqual(defaultPasteSettings('Windows'));
  });
});

describe('resolveImePreKey / resolveUnicodeMethod', () => {
  const OSES: TargetOs[] = ['windows', 'linux', 'macos'];

  it("'auto' sends LANG2 to Windows targets only; explicit keys are unchanged", () => {
    expect(resolveImePreKey('auto', 'windows')).toBe('Lang2');
    expect(resolveImePreKey('auto', 'linux')).toBe('none');
    expect(resolveImePreKey('auto', 'macos')).toBe('none');
    const explicit: ImePreKeySetting[] = ['none', 'NonConvert', 'Lang2'];
    for (const os of OSES) {
      for (const key of explicit) expect(resolveImePreKey(key, os)).toBe(key);
    }
  });

  it("'auto' is the bridge on Windows, Ctrl+Shift+U on Linux and skip on macOS", () => {
    expect(resolveUnicodeMethod('auto', 'windows')).toBe('bridge');
    expect(resolveUnicodeMethod('auto', 'linux')).toBe('ctrl-shift-u');
    expect(resolveUnicodeMethod('auto', 'macos')).toBe('skip');
  });

  it('macOS targets always skip (both methods use Ctrl chords); elsewhere explicit wins', () => {
    const methods: UnicodeMethodSetting[] = ['bridge', 'ctrl-shift-u', 'skip'];
    for (const method of methods) {
      expect(resolveUnicodeMethod(method, 'macos')).toBe('skip');
      expect(resolveUnicodeMethod(method, 'windows')).toBe(method);
      expect(resolveUnicodeMethod(method, 'linux')).toBe(method);
    }
  });
});
