import { atom } from 'jotai';

import * as storage from '@/libs/storage';
import type { TargetLayout, TargetOs } from '@/libs/storage';

export type { TargetLayout, TargetOs };

// Initialised from storage at module load (spec §2.1): the keyboard menu rows
// write these, features (remap, paste) read them.

// OS of the machine behind the KVM; the ⌘ remap is inactive when it is macOS.
export const targetOsAtom = atom<TargetOs>(storage.getTargetOs());

// Keyboard layout the target interprets HID usages with (paste table).
export const targetLayoutAtom = atom<TargetLayout>(storage.getTargetLayout());
