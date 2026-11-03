import { describe, expect, it } from 'vitest';

import { KeyboardReport } from './keyboard';

describe('KeyboardReport (upstream baseline)', () => {
  it('builds an 8-byte report with modifier bitmap and keycodes', () => {
    const kb = new KeyboardReport();
    expect(kb.keyDown('ControlLeft')).toEqual([0x01, 0, 0, 0, 0, 0, 0, 0]);
    expect(kb.keyDown('KeyC')).toEqual([0x01, 0, 0x06, 0, 0, 0, 0, 0]);
    expect(kb.keyUp('KeyC')).toEqual([0x01, 0, 0, 0, 0, 0, 0, 0]);
    expect(kb.reset()).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
