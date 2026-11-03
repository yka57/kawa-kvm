import { describe, expect, it } from 'vitest';

import type { KeyTrace } from '@/jotai/keyboard';
import { NO_MODS } from '@/test/fakes';

import {
  formatMods,
  formatReport,
  formatTraceEvent,
  formatTraceSent,
  isKeyupUnderMeta
} from './key-test.ts';

const trace = (ev: KeyTrace['ev'], sent: string[] = [], report?: number[]): KeyTrace => ({
  ev,
  sent,
  report
});

describe('formatMods', () => {
  it('prints ⌘⌃⌥⇧ in that order and a dash for none', () => {
    expect(formatMods(undefined)).toBe('–');
    expect(formatMods(NO_MODS)).toBe('–');
    expect(formatMods({ meta: true, ctrl: true, alt: true, shift: true })).toBe('⌘⌃⌥⇧');
    expect(formatMods({ ...NO_MODS, shift: true, meta: true })).toBe('⌘⇧');
  });
});

describe('formatTraceEvent', () => {
  it('shows type · code · key · mods for keydown', () => {
    const ev: KeyTrace['ev'] = {
      type: 'keydown',
      code: 'KeyC',
      key: 'c',
      repeat: false,
      timeStamp: 1,
      mods: { ...NO_MODS, meta: true }
    };
    expect(formatTraceEvent(trace(ev))).toBe('keydown · KeyC · c · ⌘');
    expect(formatTraceEvent(trace({ ...ev, repeat: true }))).toBe(
      'keydown (repeat) · KeyC · c · ⌘'
    );
  });

  it('shows keyup, timer and release-all compactly', () => {
    expect(
      formatTraceEvent(trace({ type: 'keyup', code: 'KeyC', timeStamp: 2, mods: NO_MODS }))
    ).toBe('keyup · KeyC · –');
    expect(formatTraceEvent(trace({ type: 'timer', code: 'KeyC', timeStamp: 3 }))).toBe(
      'timer · KeyC'
    );
    expect(formatTraceEvent(trace({ type: 'release-all' }))).toBe('release-all');
  });
});

describe('formatTraceSent / formatReport', () => {
  it('joins the sent codes and dashes an empty list', () => {
    expect(formatTraceSent(trace({ type: 'release-all' }, ['+ControlLeft', '+KeyC']))).toBe(
      '+ControlLeft +KeyC'
    );
    expect(formatTraceSent(trace({ type: 'release-all' }, []))).toBe('–');
  });

  it('prints the report as two-digit hex bytes', () => {
    expect(formatReport([1, 0, 6, 0, 0, 0, 0, 0])).toBe('01 00 06 00 00 00 00 00');
    expect(formatReport([0x81, 0, 0x2b, 0, 0, 0, 0, 0])).toBe('81 00 2b 00 00 00 00 00');
    expect(formatReport(undefined)).toBe('');
  });
});

describe('isKeyupUnderMeta (assumption A1 counter)', () => {
  it('counts only non-modifier keyups while ⌘ is held', () => {
    const meta = { ...NO_MODS, meta: true };
    expect(isKeyupUnderMeta(trace({ type: 'keyup', code: 'KeyC', timeStamp: 1, mods: meta }))).toBe(
      true
    );
    expect(
      isKeyupUnderMeta(trace({ type: 'keyup', code: 'KeyC', timeStamp: 1, mods: NO_MODS }))
    ).toBe(false);
    expect(
      isKeyupUnderMeta(trace({ type: 'keyup', code: 'ShiftLeft', timeStamp: 1, mods: meta }))
    ).toBe(false);
    expect(
      isKeyupUnderMeta(
        trace({ type: 'keydown', code: 'KeyC', repeat: false, timeStamp: 1, mods: meta })
      )
    ).toBe(false);
    expect(isKeyupUnderMeta(trace({ type: 'timer', code: 'KeyC', timeStamp: 1 }))).toBe(false);
  });
});
