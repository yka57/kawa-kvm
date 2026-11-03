import { describe, expect, it } from 'vitest';

import { formatKeyDisplay, toRecordedKey } from './record-key.ts';
import type { KeyInfo } from './types.ts';

describe('formatKeyDisplay (upstream labels)', () => {
  it.each([
    ['Control', 'ControlLeft', 'Ctrl'],
    ['Control', 'ControlRight', 'Ctrl'],
    ['Shift', 'ShiftLeft', 'Shift'],
    ['Alt', 'AltLeft', 'Alt'],
    ['Meta', 'MetaLeft', 'Win'],
    ['Meta', 'MetaRight', 'Win'],
    ['t', 'KeyT', 'T'],
    ['1', 'Digit1', '1'],
    ['1', 'Numpad1', 'Num1'],
    ['F5', 'F5', 'F5'],
    [' ', 'Space', 'Space'],
    ['Backspace', 'Backspace', '⌫'],
    ['Escape', 'Escape', 'Esc'],
    ['ArrowLeft', 'ArrowLeft', '←'],
    ['[', 'BracketLeft', '['],
    ['Dead', 'IntlRo', 'DEAD']
  ])('key %j code %s → %s', (key, code, label) => {
    expect(formatKeyDisplay(key, code)).toBe(label);
  });
});

describe('toRecordedKey', () => {
  const record = (chord: [string, string][], recordAsCtrl: boolean): KeyInfo[] => {
    // same dedupe as the recorder: by the stored code
    const keys: KeyInfo[] = [];
    for (const [key, code] of chord) {
      const info = toRecordedKey(key, code, recordAsCtrl);
      if (!keys.some((k) => k.code === info.code)) keys.push(info);
    }
    return keys;
  };

  const cmdShiftT: [string, string][] = [
    ['Meta', 'MetaLeft'],
    ['Shift', 'ShiftLeft'],
    ['t', 'KeyT']
  ];

  it('records ⌘⇧T as ControlLeft + ShiftLeft + KeyT labelled Ctrl Shift T with the checkbox on', () => {
    expect(record(cmdShiftT, true)).toEqual([
      { code: 'ControlLeft', label: 'Ctrl' },
      { code: 'ShiftLeft', label: 'Shift' },
      { code: 'KeyT', label: 'T' }
    ]);
  });

  it('keeps upstream output (MetaLeft labelled Win) with the checkbox off', () => {
    expect(record(cmdShiftT, false)).toEqual([
      { code: 'MetaLeft', label: 'Win' },
      { code: 'ShiftLeft', label: 'Shift' },
      { code: 'KeyT', label: 'T' }
    ]);
  });

  it('maps the right ⌘ to ControlRight and leaves other modifiers alone', () => {
    expect(toRecordedKey('Meta', 'MetaRight', true)).toEqual({
      code: 'ControlRight',
      label: 'Ctrl'
    });
    expect(toRecordedKey('Alt', 'AltRight', true)).toEqual({ code: 'AltRight', label: 'Alt' });
    expect(toRecordedKey('Control', 'ControlLeft', true)).toEqual({
      code: 'ControlLeft',
      label: 'Ctrl'
    });
  });

  it('dedupes ⌘ and ⌃ into one Ctrl while the checkbox is on', () => {
    expect(
      record(
        [
          ['Meta', 'MetaLeft'],
          ['Control', 'ControlLeft'],
          ['c', 'KeyC']
        ],
        true
      )
    ).toEqual([
      { code: 'ControlLeft', label: 'Ctrl' },
      { code: 'KeyC', label: 'C' }
    ]);
  });

  it('never touches non-modifier codes or their labels', () => {
    expect(toRecordedKey('[', 'BracketLeft', true)).toEqual({ code: 'BracketLeft', label: '[' });
    expect(toRecordedKey('Enter', 'Enter', true)).toEqual({ code: 'Enter', label: '↵' });
  });
});
