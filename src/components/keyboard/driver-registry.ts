import type { KeyboardDriver } from '@/libs/keyboard/driver';

/**
 * The physical-keyboard driver currently mounted by `components/keyboard`.
 * Kept outside the component module so non-React code (release-all row,
 * paste controller) can reach it without breaking React fast refresh.
 */
let current: KeyboardDriver | null = null;

/** null while the keyboard capture component is unmounted (keyboard disabled, serial down). */
export function getKeyboardDriver(): KeyboardDriver | null {
  return current;
}

export function setKeyboardDriver(driver: KeyboardDriver | null): void {
  current = driver;
}
