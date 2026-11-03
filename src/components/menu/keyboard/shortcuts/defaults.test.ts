import { describe, expect, it } from 'vitest';

import { getKeycode, isModifier } from '@/libs/keyboard/keymap.ts';

import { DEFAULT_SHORTCUTS } from './defaults.ts';

describe('DEFAULT_SHORTCUTS', () => {
  it('matches the shipped list (upstream pair first, then Alt+Tab, Ctrl+Shift+Esc, Win)', () => {
    const compact = DEFAULT_SHORTCUTS.map((shortcut) =>
      shortcut.keys.map((key) => `${key.code}:${key.label}`).join(' + ')
    );
    expect(compact).toMatchInlineSnapshot(`
      [
        "MetaLeft:Win + Tab:Tab",
        "ControlLeft:Ctrl + AltLeft:Alt + Delete:⌫",
        "AltLeft:Alt + Tab:Tab",
        "ControlLeft:Ctrl + ShiftLeft:Shift + Escape:Esc",
        "MetaLeft:Win",
      ]
    `);
  });

  it('keeps the first two entries byte-identical to upstream', () => {
    expect(DEFAULT_SHORTCUTS.slice(0, 2)).toEqual([
      {
        keys: [
          { code: 'MetaLeft', label: 'Win' },
          { code: 'Tab', label: 'Tab' }
        ]
      },
      {
        keys: [
          { code: 'ControlLeft', label: 'Ctrl' },
          { code: 'AltLeft', label: 'Alt' },
          { code: 'Delete', label: '⌫' }
        ]
      }
    ]);
  });

  it('uses the stored shortcut shape and only codes the HID keymap knows', () => {
    for (const shortcut of DEFAULT_SHORTCUTS) {
      expect(Object.keys(shortcut)).toEqual(['keys']);
      expect(shortcut.keys.length).toBeGreaterThan(0);
      for (const key of shortcut.keys) {
        expect(Object.keys(key).sort()).toEqual(['code', 'label']);
        expect(isModifier(key.code) || getKeycode(key.code) !== undefined, key.code).toBe(true);
      }
    }
  });
});
