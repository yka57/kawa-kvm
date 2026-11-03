import type { LockState } from '@/libs/device';
import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import type { KeyStroke, TargetLayout } from '@/libs/paste/types';
import type { ProgramStep } from '@/libs/paste/typing-engine';

/**
 * Caps Lock pre-flight (spec v2 §8.3, pure): with the target's Caps Lock on,
 * every letter arrives with the wrong case and a bridge URL fails its check.
 * The controller prepends this program when the device reports Caps Lock on;
 * the state is not restored afterwards.
 */

/** Stop with 'caps-lock' when the device still reports Caps Lock on after this long. */
export const CAPS_LOCK_TIMEOUT_MS = 1000;
/**
 * For the ETA only: the target sets its LED right after the toggle and the
 * next GET_INFO reply shows it, so the first poll or the one after succeeds.
 */
export const CAPS_LOCK_ESTIMATE_MS = 100;

/** JIS targets read a bare 0x39 as 英数: Caps Lock is Shift+英数 there. */
export function capsLockToggle(layout: TargetLayout): KeyStroke {
  return {
    mod: layout === 'jis' ? ModifierBits.LeftShift : 0,
    key: KeycodeMap.CapsLock,
    src: -1,
    tag: 'chord'
  };
}

/**
 * One toggle, then a wait until the device reports Caps Lock off. An
 * unanswered query (null) keeps the wait pending, so it ends in the timeout.
 */
export function buildCapsLockPreflight(
  layout: TargetLayout,
  getLockState: () => Promise<LockState | null>
): ProgramStep[] {
  return [
    { kind: 'keys', strokes: [capsLockToggle(layout)] },
    {
      kind: 'wait',
      check: async () => ((await getLockState())?.caps === false ? 'ok' : 'pending'),
      timeoutMs: CAPS_LOCK_TIMEOUT_MS,
      estimateMs: CAPS_LOCK_ESTIMATE_MS,
      timeoutReason: 'caps-lock'
    }
  ];
}
