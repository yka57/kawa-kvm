import { describe, expect, it } from 'vitest';

import en from '@/i18n/locales/en';
import ja from '@/i18n/locales/ja';
import { matchChord } from '@/libs/keyboard/remap-config';
import { normaliseHotkey } from '@/libs/paste/settings';
import {
  DEFAULT_COMPILE_OPTIONS,
  PASTE_SOFT_LIMIT,
  textToKeySequence
} from '@/libs/paste/text-to-keys';
import { PACING, type StopReason } from '@/libs/paste/typing-engine';

import {
  chordFromKeyEvent,
  classifyClipboardError,
  countSkipped,
  decideStart,
  displayChar,
  estimateRunMs,
  formatChord,
  formatSkippedChars,
  MAX_SKIPPED_SHOWN,
  PILL_ETA_THRESHOLD_MS,
  reasonKey,
  showPill,
  summarizeSkipped
} from './decide';

const compile = (text: string) => textToKeySequence(text, DEFAULT_COMPILE_OPTIONS);

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('decideStart', () => {
  it('refuses when serial is not connected, whatever the text', () => {
    expect(decideStart(compile('abc'), 'disconnected')).toBe('notConnected');
    expect(decideStart(compile(''), 'connecting')).toBe('notConnected');
    expect(decideStart(compile('abc'), 'notSupported')).toBe('notConnected');
  });

  it('nothing when no grapheme is typeable (Japanese-only, empty, IME pre-key alone)', () => {
    expect(decideStart(compile('日本語'), 'connected')).toBe('nothing');
    expect(decideStart(compile(''), 'connected')).toBe('nothing');

    const imeOnly = textToKeySequence('あ', {
      ...DEFAULT_COMPILE_OPTIONS,
      imePreKey: 'NonConvert'
    });
    expect(imeOnly.strokes).toHaveLength(1);
    expect(decideStart(imeOnly, 'connected')).toBe('nothing');
  });

  it('confirms above the soft limit of graphemes, runs otherwise', () => {
    expect(decideStart(compile('a'.repeat(PASTE_SOFT_LIMIT)), 'connected')).toBe('run');
    expect(decideStart(compile('a'.repeat(PASTE_SOFT_LIMIT + 1)), 'connected')).toBe('confirm');
    // skipped graphemes are part of the text and count towards the limit
    expect(decideStart(compile(`a${'あ'.repeat(PASTE_SOFT_LIMIT)}`), 'connected')).toBe('confirm');
    expect(decideStart(compile('a'), 'connected')).toBe('run');
  });
});

describe('estimateRunMs', () => {
  it('sums hold + gap per stroke and the extra pause after Enter', () => {
    const result = compile('ab\nc');
    expect(result.strokes).toHaveLength(4);
    expect(estimateRunMs(result, PACING.normal)).toBe(4 * 40 + 100);
    expect(estimateRunMs(result, PACING.safe)).toBe(4 * 100 + 150);
    expect(estimateRunMs(compile(''), PACING.normal)).toBe(0);
  });
});

describe('classifyClipboardError', () => {
  it('NotAllowedError about focus → noFocus', () => {
    expect(classifyClipboardError(namedError('NotAllowedError', 'Document is not focused.'))).toBe(
      'noFocus'
    );
  });

  it('other NotAllowedError → permDenied', () => {
    expect(classifyClipboardError(namedError('NotAllowedError', 'Read permission denied.'))).toBe(
      'permDenied'
    );
    expect(classifyClipboardError(namedError('NotAllowedError', ''))).toBe('permDenied');
  });

  it('NotFoundError / DataError → empty', () => {
    expect(classifyClipboardError(namedError('NotFoundError', 'No valid data on clipboard.'))).toBe(
      'empty'
    );
    expect(classifyClipboardError(namedError('DataError', ''))).toBe('empty');
  });

  it('anything unexpected counts as blocked access (manual text box)', () => {
    expect(classifyClipboardError(new TypeError('Cannot read properties of undefined'))).toBe(
      'permDenied'
    );
    expect(classifyClipboardError('denied')).toBe('permDenied');
    expect(classifyClipboardError(undefined)).toBe('permDenied');
    expect(classifyClipboardError({ name: 42 })).toBe('permDenied');
  });
});

describe('summarizeSkipped / formatSkippedChars', () => {
  it('unique characters in first-occurrence order with counts; the truncated tail is left out', () => {
    const result = textToKeySequence('aあbいあ\x07', { ...DEFAULT_COMPILE_OPTIONS, maxChars: 5 });
    expect(result.skipped.map((s) => s.reason)).toEqual(['no-key', 'no-key', 'no-key', 'limit']);

    const summary = summarizeSkipped(result.skipped);
    expect(summary).toEqual([
      { char: 'あ', count: 2 },
      { char: 'い', count: 1 }
    ]);
    expect(countSkipped(summary)).toBe(3);
    expect(countSkipped(undefined)).toBe(0);
    expect(countSkipped([])).toBe(0);
  });

  it('formats at most MAX_SKIPPED_SHOWN characters and marks the cut', () => {
    const many = Array.from({ length: MAX_SKIPPED_SHOWN + 5 }, (_, i) => ({
      char: String.fromCodePoint(0x3042 + i),
      count: 1
    }));
    const text = formatSkippedChars(many);
    expect(text.split(' ')).toHaveLength(MAX_SKIPPED_SHOWN + 1);
    expect(text.endsWith(' …')).toBe(true);

    expect(formatSkippedChars(many.slice(0, 3))).toBe('あ ぃ い');
    expect(formatSkippedChars(many.slice(0, MAX_SKIPPED_SHOWN)).endsWith('…')).toBe(false);
    expect(formatSkippedChars([])).toBe('');
  });

  it('shows invisible characters as code points', () => {
    expect(displayChar('\x07')).toBe('U+0007');
    expect(displayChar(' ')).toBe('U+00A0');
    expect(displayChar('​')).toBe('U+200B');
    expect(displayChar(' ')).toBe('U+2028');
    expect(displayChar('日')).toBe('日');
    expect(displayChar('👍')).toBe('👍');
    expect(formatSkippedChars([{ char: '\x1b', count: 1 }])).toBe('U+001B');
  });
});

describe('showPill', () => {
  it('needs a noticeable ETA, a skipped character or an early stop', () => {
    expect(showPill(PILL_ETA_THRESHOLD_MS, 0)).toBe(false);
    expect(showPill(PILL_ETA_THRESHOLD_MS + 1, 0)).toBe(true);
    expect(showPill(0, 0)).toBe(false);
    expect(showPill(0, 1)).toBe(true);
    expect(showPill(0, 0, 'completed')).toBe(false);
    expect(showPill(5000, 0, 'completed')).toBe(true);

    const early: StopReason[] = [
      'cancelled',
      'key-interrupt',
      'mouse-interrupt',
      'tab-hidden',
      'serial-error'
    ];
    for (const reason of early) {
      expect(showPill(0, 0, reason), reason).toBe(true);
    }
  });
});

describe('reasonKey', () => {
  it('maps every stop reason to a key present in both en and ja', () => {
    const reasons: StopReason[] = [
      'completed',
      'cancelled',
      'key-interrupt',
      'mouse-interrupt',
      'tab-hidden',
      'serial-error',
      'lock-busy'
    ];
    const enPaste = en.translation.paste as Record<string, string>;
    const jaPaste = ja.translation.paste as Record<string, string>;
    for (const reason of reasons) {
      const key = reasonKey(reason);
      expect(key.startsWith('paste.')).toBe(true);
      const leaf = key.slice('paste.'.length);
      expect(typeof enPaste[leaf], key).toBe('string');
      expect(typeof jaPaste[leaf], key).toBe('string');
    }
    expect(reasonKey('key-interrupt')).toBe('paste.doneKey');
    expect(reasonKey('completed')).toBe('paste.doneCompleted');
  });
});

describe('formatChord / chordFromKeyEvent', () => {
  it('⌘⇧V on a macOS host, Win/Ctrl/Alt/Shift labels elsewhere', () => {
    expect(formatChord({ code: 'KeyV', meta: true, shift: true }, 'macOS')).toEqual([
      '⌘',
      '⇧',
      'V'
    ]);
    expect(formatChord({ code: 'KeyV', ctrl: true, shift: true }, 'Windows')).toEqual([
      'Ctrl',
      'Shift',
      'V'
    ]);
    expect(
      formatChord({ code: 'KeyV', meta: true, ctrl: true, alt: true, shift: true }, 'macOS')
    ).toEqual(['⌘', '⌃', '⌥', '⇧', 'V']);
    expect(formatChord({ code: 'Digit1', alt: true }, 'Linux')).toEqual(['Alt', '1']);
    expect(formatChord({ code: 'Space', meta: true }, 'Unknown')).toEqual(['Win', 'Space']);
  });

  it('captures a chord only for a non-modifier key held with ⌘/⌃/⌥', () => {
    const base = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(chordFromKeyEvent({ ...base, code: 'KeyV', metaKey: true, shiftKey: true })).toEqual({
      code: 'KeyV',
      meta: true,
      shift: true
    });
    expect(chordFromKeyEvent({ ...base, code: 'F5', ctrlKey: true, altKey: true })).toEqual({
      code: 'F5',
      ctrl: true,
      alt: true
    });
    expect(chordFromKeyEvent({ ...base, code: 'MetaLeft', metaKey: true })).toBeNull();
    expect(chordFromKeyEvent({ ...base, code: 'ShiftRight', ctrlKey: true })).toBeNull();
    expect(chordFromKeyEvent({ ...base, code: 'KeyV' })).toBeNull();
    expect(chordFromKeyEvent({ ...base, code: 'KeyV', shiftKey: true })).toBeNull();
    expect(chordFromKeyEvent({ ...base, code: '', ctrlKey: true })).toBeNull();
  });

  it('a captured chord is canonical and matches the keydown that produced it', () => {
    const chord = chordFromKeyEvent({
      code: 'KeyV',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true
    });
    expect(chord).not.toBeNull();
    expect(normaliseHotkey(chord)).toEqual(chord);
    expect(
      matchChord(
        { code: 'KeyV', mods: { meta: true, ctrl: false, alt: false, shift: true }, repeat: false },
        chord!
      )
    ).toBe(true);
    expect(
      matchChord(
        {
          code: 'KeyV',
          mods: { meta: true, ctrl: false, alt: false, shift: false },
          repeat: false
        },
        chord!
      )
    ).toBe(false);
  });
});
