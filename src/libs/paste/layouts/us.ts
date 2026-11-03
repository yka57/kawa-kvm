import type { LayoutTable } from '@/libs/paste/types';

import { COMMON_TABLE } from './common';

/** US-ANSI. Must stay identical to src/test/legacy-char-codes.ts (upstream table, parity test). */
export const US_TABLE: LayoutTable = {
  ...COMMON_TABLE,
  '@': { key: 'Digit2', shift: true },
  '^': { key: 'Digit6', shift: true },
  '&': { key: 'Digit7', shift: true },
  '*': { key: 'Digit8', shift: true },
  '(': { key: 'Digit9', shift: true },
  ')': { key: 'Digit0', shift: true },
  _: { key: 'Minus', shift: true },
  '=': { key: 'Equal' },
  '+': { key: 'Equal', shift: true },
  '[': { key: 'BracketLeft' },
  '{': { key: 'BracketLeft', shift: true },
  ']': { key: 'BracketRight' },
  '}': { key: 'BracketRight', shift: true },
  '\\': { key: 'Backslash' },
  '|': { key: 'Backslash', shift: true },
  ':': { key: 'Semicolon', shift: true },
  "'": { key: 'Quote' },
  '"': { key: 'Quote', shift: true },
  '`': { key: 'Backquote' },
  '~': { key: 'Backquote', shift: true }
};
