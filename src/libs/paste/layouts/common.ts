import type { LayoutTable } from '@/libs/paste/types';

/**
 * Characters that sit on the same physical key, with the same shift state,
 * on US-ANSI and JIS keyboards: letters, digits, space and some punctuation.
 */
function buildCommonTable(): LayoutTable {
  const table: LayoutTable = {};

  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(0x61 + i);
    const upper = lower.toUpperCase();
    table[lower] = { key: `Key${upper}` };
    table[upper] = { key: `Key${upper}`, shift: true };
  }

  for (let digit = 0; digit <= 9; digit++) {
    table[String(digit)] = { key: `Digit${digit}` };
  }

  table[' '] = { key: 'Space' };
  table[','] = { key: 'Comma' };
  table['<'] = { key: 'Comma', shift: true };
  table['.'] = { key: 'Period' };
  table['>'] = { key: 'Period', shift: true };
  table['/'] = { key: 'Slash' };
  table['?'] = { key: 'Slash', shift: true };
  table['-'] = { key: 'Minus' };
  table[';'] = { key: 'Semicolon' };
  table['!'] = { key: 'Digit1', shift: true };
  table['#'] = { key: 'Digit3', shift: true };
  table['$'] = { key: 'Digit4', shift: true };
  table['%'] = { key: 'Digit5', shift: true };

  return table;
}

export const COMMON_TABLE: LayoutTable = buildCommonTable();
