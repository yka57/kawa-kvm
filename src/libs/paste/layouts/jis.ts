import type { LayoutTable } from '@/libs/paste/types';

import { COMMON_TABLE } from './common';

/**
 * JIS (Japanese 106/109) as the target interprets HID usages. Verified against
 * xkb `jp(106)+common` and JetKVM `ja_JP` (spec §5.1). `! # $ % - ;` come from
 * the common table and are identical to US. `¥` is non-ASCII and intentionally
 * absent; Shift+Digit0 produces nothing on Windows and is never used.
 */
export const JIS_TABLE: LayoutTable = {
  ...COMMON_TABLE,
  '"': { key: 'Digit2', shift: true },
  '&': { key: 'Digit6', shift: true },
  "'": { key: 'Digit7', shift: true },
  '(': { key: 'Digit8', shift: true },
  ')': { key: 'Digit9', shift: true },
  '=': { key: 'Minus', shift: true },
  '^': { key: 'Equal' },
  '~': { key: 'Equal', shift: true },
  '\\': { key: 'IntlRo' },
  _: { key: 'IntlRo', shift: true },
  '|': { key: 'IntlYen', shift: true },
  '@': { key: 'BracketLeft' },
  '`': { key: 'BracketLeft', shift: true },
  '[': { key: 'BracketRight' },
  '{': { key: 'BracketRight', shift: true },
  '+': { key: 'Semicolon', shift: true },
  ':': { key: 'Quote' },
  '*': { key: 'Quote', shift: true },
  ']': { key: 'Backslash' },
  '}': { key: 'Backslash', shift: true }
};
