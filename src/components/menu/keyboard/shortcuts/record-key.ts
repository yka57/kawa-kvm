import { isModifier } from '@/libs/keyboard/keymap.ts';
import { remapRecordedCode } from '@/libs/keyboard/remap-config';

import type { KeyInfo } from './types.ts';

const SpecialKeyMap: Record<string, string> = {
  Space: 'Space',
  Backspace: '⌫',
  Enter: '↵',
  Tab: 'Tab',
  CapsLock: 'Caps',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Delete: 'Del',
  Insert: 'Ins',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn'
};

const PunctuationMap: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/'
};

/** Upstream's recorder label for a key (verbatim). */
export function formatKeyDisplay(key: string, code: string): string {
  if (isModifier(code)) {
    if (code.startsWith('Control')) {
      return 'Ctrl';
    }
    if (code.startsWith('Shift')) {
      return 'Shift';
    }
    if (code.startsWith('Alt')) {
      return 'Alt';
    }
    if (code.startsWith('Meta')) {
      return 'Win';
    }
  }

  if (code.startsWith('Digit')) {
    return code.replace('Digit', '');
  }
  if (code.startsWith('Key')) {
    return code.replace('Key', '');
  }
  if (code.startsWith('Numpad')) {
    const numpadKey = code.replace('Numpad', '');
    return `Num${numpadKey}`;
  }
  if (code.startsWith('F') && /^F\d+$/.test(code)) {
    return code; // F1, F2, etc.
  }

  if (SpecialKeyMap[code]) {
    return SpecialKeyMap[code];
  }
  if (PunctuationMap[code]) {
    return PunctuationMap[code];
  }

  return key.toUpperCase();
}

/**
 * The key the recorder stores for a keydown. With `recordAsCtrl` (the
 * "Record ⌘ as Ctrl" checkbox) ⌘ is stored as the Ctrl code it is sent as,
 * so replay stays literal; everything else keeps upstream's code and label.
 */
export function toRecordedKey(key: string, code: string, recordAsCtrl: boolean): KeyInfo {
  const mapped = remapRecordedCode(code, recordAsCtrl);
  if (isModifier(mapped.code)) {
    return mapped;
  }
  return { code, label: formatKeyDisplay(key, code) };
}
