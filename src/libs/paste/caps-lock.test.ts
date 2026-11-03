import { describe, expect, it } from 'vitest';

import type { LockState } from '@/libs/device';
import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';

import {
  buildCapsLockPreflight,
  CAPS_LOCK_ESTIMATE_MS,
  CAPS_LOCK_TIMEOUT_MS,
  capsLockToggle
} from './caps-lock';
import type { WaitStep } from './typing-engine';

const state = (caps: boolean): LockState => ({ num: true, caps, scroll: false, version: 0x38 });

describe('Caps Lock pre-flight', () => {
  it('toggles with Shift+CapsLock on JIS (a bare 0x39 is 英数 there) and a bare CapsLock on US', () => {
    expect(capsLockToggle('jis')).toEqual({
      mod: ModifierBits.LeftShift,
      key: 0x39,
      src: -1,
      tag: 'chord'
    });
    expect(capsLockToggle('us')).toEqual({
      mod: 0,
      key: KeycodeMap.CapsLock,
      src: -1,
      tag: 'chord'
    });
  });

  it('is the toggle, then a wait for the device to report Caps Lock off', async () => {
    let answer: LockState | null = state(true);
    const [keys, wait] = buildCapsLockPreflight('jis', () => Promise.resolve(answer));
    expect(keys).toEqual({ kind: 'keys', strokes: [capsLockToggle('jis')] });
    expect(wait).toMatchObject({
      kind: 'wait',
      timeoutMs: CAPS_LOCK_TIMEOUT_MS,
      estimateMs: CAPS_LOCK_ESTIMATE_MS,
      timeoutReason: 'caps-lock'
    });
    expect(CAPS_LOCK_TIMEOUT_MS).toBe(1000);

    const check = () => (wait as WaitStep).check();
    await expect(check()).resolves.toBe('pending');
    answer = null; // no answer from the device
    await expect(check()).resolves.toBe('pending');
    answer = state(false);
    await expect(check()).resolves.toBe('ok');
  });
});
