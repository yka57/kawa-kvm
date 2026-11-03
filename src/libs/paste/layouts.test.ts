import { describe, expect, it } from 'vitest';

import { KeycodeMap, ModifierMap } from '@/libs/keyboard/keymap';
import type { TargetLayout } from '@/libs/paste/types';
import { CharCodes, ShiftChars } from '@/test/legacy-char-codes';

import { COMMON_TABLE, getTable, JIS_TABLE, LAYOUT_TABLES, US_TABLE } from './layouts';

const PRINTABLE_ASCII = Array.from({ length: 0x7f - 0x20 }, (_, i) =>
  String.fromCharCode(0x20 + i)
);
const LAYOUTS: TargetLayout[] = ['us', 'jis'];

describe('layout tables', () => {
  it.each(LAYOUTS)('%s: every key exists in KeycodeMap and is not a modifier', (layout) => {
    for (const [char, combo] of Object.entries(getTable(layout))) {
      expect(KeycodeMap[combo.key], `${layout} ${JSON.stringify(char)} → ${combo.key}`).toBeTypeOf(
        'number'
      );
      expect(combo.key in ModifierMap, `${combo.key} is a modifier`).toBe(false);
      expect(char.length).toBe(1);
      expect(combo.shift === undefined || combo.shift === true).toBe(true);
    }
  });

  it.each(LAYOUTS)('%s: covers all 95 printable ASCII characters and nothing else', (layout) => {
    const table = getTable(layout);
    for (const char of PRINTABLE_ASCII) {
      expect(table[char], `${layout} lacks ${JSON.stringify(char)}`).toBeDefined();
    }
    expect(Object.keys(table).sort()).toEqual([...PRINTABLE_ASCII].sort());
  });

  it('common table is contained verbatim in both layouts', () => {
    for (const [char, combo] of Object.entries(COMMON_TABLE)) {
      expect(US_TABLE[char]).toEqual(combo);
      expect(JIS_TABLE[char]).toEqual(combo);
    }
    expect(Object.keys(COMMON_TABLE)).toHaveLength(26 + 26 + 10 + 1 + 12);
  });

  it('getTable resolves both layouts and falls back to US', () => {
    expect(getTable('us')).toBe(US_TABLE);
    expect(getTable('jis')).toBe(JIS_TABLE);
    expect(getTable('azerty' as TargetLayout)).toBe(US_TABLE);
    expect(LAYOUT_TABLES).toEqual({ us: US_TABLE, jis: JIS_TABLE });
  });
});

describe('US table parity with the upstream paste table (src/test/legacy-char-codes.ts)', () => {
  it('reproduces CharCodes/ShiftChars for every printable char they define', () => {
    let checked = 0;
    for (const [codeText, hid] of Object.entries(CharCodes)) {
      const code = Number(codeText);
      if (code === 9 || code === 10) continue; // Tab / Enter are compiler rules (text-to-keys tests)
      const char = String.fromCharCode(code);
      const combo = US_TABLE[char];
      expect(combo, `missing ${JSON.stringify(char)}`).toBeDefined();
      expect(KeycodeMap[combo.key], `usage for ${JSON.stringify(char)}`).toBe(hid);
      const legacyShift = (code >= 65 && code <= 90) || ShiftChars[code] === true;
      expect(Boolean(combo.shift), `shift for ${JSON.stringify(char)}`).toBe(legacyShift);
      checked++;
    }
    expect(checked).toBe(PRINTABLE_ASCII.length);
  });

  it('legacy tables define exactly Tab, Enter and the printable range', () => {
    const codes = Object.keys(CharCodes)
      .map(Number)
      .sort((a, b) => a - b);
    expect(codes).toEqual([9, 10, ...PRINTABLE_ASCII.map((c) => c.charCodeAt(0))]);
    expect(CharCodes[9]).toBe(KeycodeMap.Tab);
    expect(CharCodes[10]).toBe(KeycodeMap.Enter);
    for (const code of Object.keys(ShiftChars).map(Number)) {
      expect(US_TABLE[String.fromCharCode(code)].shift).toBe(true);
    }
  });
});

describe('JIS table', () => {
  const expected: Array<[char: string, usage: number, shift: boolean]> = [
    ['"', 0x1f, true],
    ['&', 0x23, true],
    ["'", 0x24, true],
    ['(', 0x25, true],
    [')', 0x26, true],
    ['=', 0x2d, true],
    ['^', 0x2e, false],
    ['~', 0x2e, true],
    ['\\', 0x87, false],
    ['_', 0x87, true],
    ['|', 0x89, true],
    ['@', 0x2f, false],
    ['`', 0x2f, true],
    ['[', 0x30, false],
    ['{', 0x30, true],
    [';', 0x33, false],
    ['+', 0x33, true],
    [':', 0x34, false],
    ['*', 0x34, true],
    [']', 0x31, false],
    ['}', 0x31, true]
  ];

  it('maps the documented characters to the spec usages', () => {
    for (const [char, usage, shift] of expected) {
      const combo = JIS_TABLE[char];
      expect(KeycodeMap[combo.key], `usage for ${JSON.stringify(char)}`).toBe(usage);
      expect(Boolean(combo.shift), `shift for ${JSON.stringify(char)}`).toBe(shift);
    }
  });

  it('keeps ! # $ % on Shift+Digit1/3/4/5 and - on Minus like US', () => {
    expect(JIS_TABLE['!']).toEqual({ key: 'Digit1', shift: true });
    expect(JIS_TABLE['#']).toEqual({ key: 'Digit3', shift: true });
    expect(JIS_TABLE['$']).toEqual({ key: 'Digit4', shift: true });
    expect(JIS_TABLE['%']).toEqual({ key: 'Digit5', shift: true });
    expect(JIS_TABLE['-']).toEqual({ key: 'Minus' });
    expect(JIS_TABLE['¥']).toBeUndefined();
    expect(Object.values(JIS_TABLE).some((c) => c.key === 'Digit0' && c.shift)).toBe(false);
  });

  it('diverges from US exactly on the documented set', () => {
    const divergent = PRINTABLE_ASCII.filter(
      (char) =>
        US_TABLE[char].key !== JIS_TABLE[char].key ||
        Boolean(US_TABLE[char].shift) !== Boolean(JIS_TABLE[char].shift)
    ).sort();
    const documented = expected
      .map(([char]) => char)
      .filter((char) => char !== ';')
      .sort();
    expect(divergent).toEqual(documented);
    expect(divergent).toHaveLength(20);
  });
});
