import { useSyncExternalStore } from 'react';

import { hidLock } from '@/libs/keyboard/hid-lock';

function subscribe(onStoreChange: () => void): () => void {
  return hidLock.onChange(() => onStoreChange());
}

function getSnapshot(): boolean {
  return hidLock.isLocked();
}

/** True while the paste engine owns the HID keyboard wire (spec §5.3). */
export function useHidLocked(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
