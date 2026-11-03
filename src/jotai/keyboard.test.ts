import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';

import type { TraceEntry } from '@/libs/keyboard/driver';
import { DEFAULT_REMAP_CONFIG } from '@/libs/keyboard/remap-config';

import { keyboardRemapAtom, keyboardRemapRawAtom, keyTraceAtom, type KeyTrace } from './keyboard';

describe('keyboardRemapAtom', () => {
  it('starts from the defaults when nothing is stored', () => {
    const store = createStore();
    expect(store.get(keyboardRemapRawAtom)).toBeNull();
    expect(store.get(keyboardRemapAtom)).toEqual(DEFAULT_REMAP_CONFIG);
  });

  it('derives the normalised config from the raw atom (unknown dropped, numbers clamped)', () => {
    const store = createStore();
    store.set(keyboardRemapRawAtom, { enabled: false, tapReleaseMs: 999, junk: 1 });
    expect(store.get(keyboardRemapAtom)).toEqual({
      ...DEFAULT_REMAP_CONFIG,
      enabled: false,
      tapReleaseMs: 200
    });

    store.set(keyboardRemapRawAtom, null);
    expect(store.get(keyboardRemapAtom)).toEqual(DEFAULT_REMAP_CONFIG);
  });

  it('notifies subscribers of the derived atom when the raw atom changes', () => {
    const store = createStore();
    const seen: boolean[] = [];
    const unsubscribe = store.sub(keyboardRemapAtom, () => {
      seen.push(store.get(keyboardRemapAtom).enabled);
    });

    store.set(keyboardRemapRawAtom, { enabled: false });
    store.set(keyboardRemapRawAtom, { enabled: true });
    unsubscribe();

    expect(seen).toEqual([false, true]);
  });
});

describe('keyTraceAtom', () => {
  it('stores the driver trace entries as they are', () => {
    const entry: TraceEntry = {
      seq: 1,
      at: 10,
      ev: {
        type: 'keydown',
        code: 'KeyC',
        key: 'c',
        repeat: false,
        timeStamp: 5,
        mods: { meta: true, ctrl: false, alt: false, shift: false }
      },
      sent: ['+KeyC'],
      report: [1, 0, 6, 0, 0, 0, 0, 0]
    };
    // TraceEntry must stay assignable to KeyTrace (the adapter forwards it unchanged)
    const trace: KeyTrace = entry;

    const store = createStore();
    expect(store.get(keyTraceAtom)).toBeNull();
    store.set(keyTraceAtom, trace);
    expect(store.get(keyTraceAtom)).toBe(entry);
  });
});
