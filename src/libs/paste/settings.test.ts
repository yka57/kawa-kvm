import { describe, expect, it } from 'vitest';

import type { System } from '@/libs/browser';

import {
  DEFAULT_PASTE_HOTKEY,
  defaultPasteSettings,
  normaliseHotkey,
  normalisePasteSettings,
  PASTE_SETTINGS_VERSION,
  type PasteSettings
} from './settings';

const KEYS = [
  'version',
  'speed',
  'newline',
  'normalizePunct',
  'stripTrailingNewline',
  'imePreKey',
  'hotkeyEnabled',
  'hotkey'
].sort();

describe('defaultPasteSettings', () => {
  it('enables the hotkey only on macOS hosts', () => {
    const hosts: System[] = ['Windows', 'macOS', 'Linux', 'Unknown'];
    for (const host of hosts) {
      expect(defaultPasteSettings(host)).toEqual({
        version: 1,
        speed: 'normal',
        newline: 'enter',
        normalizePunct: true,
        stripTrailingNewline: true,
        imePreKey: 'none',
        hotkeyEnabled: host === 'macOS',
        hotkey: { code: 'KeyV', meta: true, shift: true }
      });
    }
    expect(PASTE_SETTINGS_VERSION).toBe(1);
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
      version: 1,
      speed: 'safe',
      newline: 'shift-enter',
      normalizePunct: false,
      stripTrailingNewline: false,
      imePreKey: 'NonConvert',
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
        speed: 'fast',
        newline: 'cr',
        imePreKey: 'Lang2',
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
      version: 1,
      speed: 'normal',
      newline: 'enter',
      normalizePunct: true,
      stripTrailingNewline: true,
      imePreKey: 'none',
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

  it('produces the PasteSettings type with the literal version 1', () => {
    const settings: PasteSettings = normalisePasteSettings({}, 'macOS');
    expect(settings.version).toBe(1);
  });
});
