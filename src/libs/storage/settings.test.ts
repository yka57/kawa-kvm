import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as storage from './index';

/** Minimal Map-backed Storage stand-in (vitest runs in node, no DOM). */
class MemoryStorage {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('navigator', { language: 'en-US' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('target OS', () => {
  it('defaults to windows and rejects unknown values', () => {
    expect(storage.getTargetOs()).toBe('windows');
    store.setItem('nanokvm-usb-target-os', 'solaris');
    expect(storage.getTargetOs()).toBe('windows');
    store.setItem('nanokvm-usb-target-os', '');
    expect(storage.getTargetOs()).toBe('windows');
  });

  it('round-trips every valid value', () => {
    for (const os of ['macos', 'linux', 'windows'] as const) {
      storage.setTargetOs(os);
      expect(storage.getTargetOs()).toBe(os);
      expect(store.getItem('nanokvm-usb-target-os')).toBe(os);
    }
  });
});

describe('target layout', () => {
  it('defaults by UI language: jis for ja-*, us otherwise', () => {
    expect(storage.getTargetLayout()).toBe('us');

    vi.stubGlobal('navigator', { language: 'ja-JP' });
    expect(storage.getTargetLayout()).toBe('jis');

    vi.stubGlobal('navigator', { language: 'ja' });
    expect(storage.getTargetLayout()).toBe('jis');

    vi.stubGlobal('navigator', { language: 'zh-CN' });
    expect(storage.getTargetLayout()).toBe('us');
  });

  it('prefers the stored UI language over navigator.language, like i18n does', () => {
    store.setItem('nanokvm-usb-language', 'ja');
    expect(storage.getTargetLayout()).toBe('jis');

    store.setItem('nanokvm-usb-language', 'en');
    vi.stubGlobal('navigator', { language: 'ja-JP' });
    expect(storage.getTargetLayout()).toBe('us');
  });

  it('accepts an explicit language argument', () => {
    expect(storage.getTargetLayout('ja')).toBe('jis');
    expect(storage.getTargetLayout('JA-JP')).toBe('jis');
    expect(storage.getTargetLayout('en')).toBe('us');
    expect(storage.getTargetLayout('')).toBe('us');
  });

  it('a stored layout wins over the language default and garbage falls back', () => {
    vi.stubGlobal('navigator', { language: 'ja-JP' });
    storage.setTargetLayout('us');
    expect(storage.getTargetLayout()).toBe('us');

    store.setItem('nanokvm-usb-target-layout', 'dvorak');
    expect(storage.getTargetLayout()).toBe('jis');

    storage.setTargetLayout('jis');
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(storage.getTargetLayout()).toBe('jis');
  });

  it('does not need navigator at all', () => {
    vi.stubGlobal('navigator', undefined);
    expect(storage.getTargetLayout()).toBe('us');
  });
});

describe('scroll px per notch (20..400, default 100)', () => {
  const KEY = 'nanokvm-usb-mouse-scroll-px-per-notch';

  it('returns the default for absent, blank, NaN, infinite and out-of-range values', () => {
    expect(storage.getScrollPxPerNotch()).toBe(100);
    for (const raw of [
      '',
      '  ',
      'abc',
      'NaN',
      'Infinity',
      '-Infinity',
      '19',
      '19.99',
      '401',
      '-100',
      '1e9'
    ]) {
      store.setItem(KEY, raw);
      expect(storage.getScrollPxPerNotch(), `raw=${JSON.stringify(raw)}`).toBe(100);
    }
  });

  it('accepts the boundaries and fractional values inside the range', () => {
    for (const [raw, expected] of [
      ['20', 20],
      ['400', 400],
      ['150', 150],
      ['33.5', 33.5]
    ] as const) {
      store.setItem(KEY, raw);
      expect(storage.getScrollPxPerNotch()).toBe(expected);
    }
  });

  it('setter round-trips, clamps into range and ignores non-finite input', () => {
    storage.setScrollPxPerNotch(150);
    expect(storage.getScrollPxPerNotch()).toBe(150);
    expect(store.getItem(KEY)).toBe('150');

    storage.setScrollPxPerNotch(1000);
    expect(storage.getScrollPxPerNotch()).toBe(400);
    storage.setScrollPxPerNotch(0);
    expect(storage.getScrollPxPerNotch()).toBe(20);

    storage.setScrollPxPerNotch(NaN);
    expect(storage.getScrollPxPerNotch()).toBe(20);
    storage.setScrollPxPerNotch(Infinity);
    expect(storage.getScrollPxPerNotch()).toBe(20);
  });
});

describe('mouse sensitivity (0.25..4, default 1)', () => {
  const KEY = 'nanokvm-usb-mouse-sensitivity';

  it('returns the default for absent, malformed and out-of-range values', () => {
    expect(storage.getMouseSensitivity()).toBe(1);
    for (const raw of ['', 'fast', 'NaN', '0.1', '0.2499', '4.01', '5', '-1']) {
      store.setItem(KEY, raw);
      expect(storage.getMouseSensitivity(), `raw=${JSON.stringify(raw)}`).toBe(1);
    }
  });

  it('accepts values inside the range and round-trips through the setter', () => {
    for (const gain of [0.25, 0.5, 1, 2.5, 4]) {
      storage.setMouseSensitivity(gain);
      expect(storage.getMouseSensitivity()).toBe(gain);
    }
    storage.setMouseSensitivity(10);
    expect(storage.getMouseSensitivity()).toBe(4);
    storage.setMouseSensitivity(0);
    expect(storage.getMouseSensitivity()).toBe(0.25);
    storage.setMouseSensitivity(NaN);
    expect(storage.getMouseSensitivity()).toBe(0.25);
  });
});

describe('JSON documents (keyboard remap, paste settings)', () => {
  it('raw getters return null when absent and the stored string otherwise', () => {
    expect(storage.getKeyboardRemapRaw()).toBeNull();
    expect(storage.getPasteSettingsRaw()).toBeNull();
    store.setItem('nanokvm-usb-keyboard-remap', '{bad json');
    expect(storage.getKeyboardRemapRaw()).toBe('{bad json');
  });

  it('setters accept objects (serialised) or strings (verbatim) and round-trip', () => {
    storage.setKeyboardRemap({ version: 1, enabled: true });
    expect(storage.getKeyboardRemapRaw()).toBe('{"version":1,"enabled":true}');
    storage.setKeyboardRemap('{"enabled":false}');
    expect(storage.getKeyboardRemapRaw()).toBe('{"enabled":false}');

    storage.setPasteSettings({ version: 1, speed: 'safe' });
    expect(storage.getPasteSettingsRaw()).toBe('{"version":1,"speed":"safe"}');
    expect(storage.parseJsonObject(storage.getPasteSettingsRaw())).toEqual({
      version: 1,
      speed: 'safe'
    });
  });

  it('setters ignore values that cannot be serialised instead of poisoning storage', () => {
    storage.setKeyboardRemap({ enabled: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    storage.setKeyboardRemap(circular);
    expect(storage.getKeyboardRemapRaw()).toBe('{"enabled":true}');
  });

  it('parseJsonObject tolerates malformed input and rejects non-objects', () => {
    expect(storage.parseJsonObject(null)).toBeNull();
    expect(storage.parseJsonObject(undefined)).toBeNull();
    expect(storage.parseJsonObject('')).toBeNull();
    expect(storage.parseJsonObject('{bad')).toBeNull();
    expect(storage.parseJsonObject('null')).toBeNull();
    expect(storage.parseJsonObject('[1,2]')).toBeNull();
    expect(storage.parseJsonObject('"text"')).toBeNull();
    expect(storage.parseJsonObject('42')).toBeNull();
    expect(storage.parseJsonObject('{"a":{"b":[1]}}')).toEqual({ a: { b: [1] } });
  });
});

describe('debug HID flag', () => {
  it("is on only for the literal '1' and the setter removes the key when turned off", () => {
    expect(storage.getDebugHid()).toBe(false);
    store.setItem('nanokvm-usb-debug-hid', 'true');
    expect(storage.getDebugHid()).toBe(false);
    storage.setDebugHid(true);
    expect(storage.getDebugHid()).toBe(true);
    expect(store.getItem('nanokvm-usb-debug-hid')).toBe('1');
    storage.setDebugHid(false);
    expect(storage.getDebugHid()).toBe(false);
    expect(store.getItem('nanokvm-usb-debug-hid')).toBeNull();
  });
});

describe('paste bridge intro flag', () => {
  it("is accepted only for the literal '1'; the setter removes the key when cleared", () => {
    expect(storage.getPasteBridgeIntroAccepted()).toBe(false);
    store.setItem('nanokvm-usb-paste-bridge-intro', 'true');
    expect(storage.getPasteBridgeIntroAccepted()).toBe(false);
    storage.setPasteBridgeIntroAccepted(true);
    expect(storage.getPasteBridgeIntroAccepted()).toBe(true);
    expect(store.getItem('nanokvm-usb-paste-bridge-intro')).toBe('1');
    storage.setPasteBridgeIntroAccepted(false);
    expect(storage.getPasteBridgeIntroAccepted()).toBe(false);
    expect(store.getItem('nanokvm-usb-paste-bridge-intro')).toBeNull();
  });

  it('never throws without localStorage or when storage access throws', () => {
    vi.unstubAllGlobals();
    expect(storage.getPasteBridgeIntroAccepted()).toBe(false);
    expect(() => storage.setPasteBridgeIntroAccepted(true)).not.toThrow();

    const fail = () => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: fail, setItem: fail, removeItem: fail });
    expect(storage.getPasteBridgeIntroAccepted()).toBe(false);
    expect(() => {
      storage.setPasteBridgeIntroAccepted(true);
      storage.setPasteBridgeIntroAccepted(false);
    }).not.toThrow();
  });
});

describe('robustness', () => {
  function expectDefaults() {
    expect(storage.getTargetOs()).toBe('windows');
    expect(storage.getTargetLayout('en')).toBe('us');
    expect(storage.getScrollPxPerNotch()).toBe(100);
    expect(storage.getMouseSensitivity()).toBe(1);
    expect(storage.getKeyboardRemapRaw()).toBeNull();
    expect(storage.getPasteSettingsRaw()).toBeNull();
    expect(storage.getDebugHid()).toBe(false);
  }

  it('getters return defaults and setters do not throw when localStorage is missing', () => {
    vi.unstubAllGlobals();
    expect(typeof localStorage).toBe('undefined');
    expectDefaults();
    expect(() => {
      storage.setTargetOs('macos');
      storage.setTargetLayout('jis');
      storage.setScrollPxPerNotch(200);
      storage.setMouseSensitivity(2);
      storage.setKeyboardRemap({ enabled: true });
      storage.setPasteSettings({ version: 1 });
      storage.setDebugHid(true);
      storage.setDebugHid(false);
    }).not.toThrow();
  });

  it('getters return defaults and setters do not throw when storage access throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      }
    };
    vi.stubGlobal('localStorage', throwing);
    expectDefaults();
    expect(() => {
      storage.setTargetOs('linux');
      storage.setScrollPxPerNotch(50);
      storage.setDebugHid(false);
    }).not.toThrow();
  });
});
