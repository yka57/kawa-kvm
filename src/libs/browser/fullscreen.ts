/**
 * JS fullscreen + Keyboard Lock (spec §3.6). Chrome delivers its reserved
 * shortcuts (⌘W, ⌘T, ⌘⇧[ ]…) to the page only in JS-initiated fullscreen
 * with `navigator.keyboard.lock()`; leaving fullscreen (Esc) unlocks again.
 * Touches `document`/`navigator` only when called, never at import time.
 */
interface KeyboardLockApi {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

function keyboardLockApi(): KeyboardLockApi | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;
}

let unlockOnExitInstalled = false;

function installUnlockOnExit(): void {
  if (unlockOnExitInstalled) return;
  unlockOnExitInstalled = true;

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      keyboardLockApi()?.unlock();
    }
  });
}

export function isFullscreen(): boolean {
  return typeof document !== 'undefined' && !!document.fullscreenElement;
}

/**
 * Enter fullscreen and lock the keyboard, or leave fullscreen and unlock.
 * Same call order as upstream (lock right after requestFullscreen, no await);
 * rejections (permission, no user gesture) are logged, never thrown.
 */
export function toggleFullscreenWithKeyboardLock(): void {
  installUnlockOnExit();

  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((err: unknown) => {
      console.debug('[fullscreen] requestFullscreen failed', err);
    });
    keyboardLockApi()
      ?.lock()
      ?.catch((err: unknown) => {
        console.debug('[fullscreen] keyboard lock failed', err);
      });
  } else {
    document.exitFullscreen().catch((err: unknown) => {
      console.debug('[fullscreen] exitFullscreen failed', err);
    });
    keyboardLockApi()?.unlock();
  }
}
