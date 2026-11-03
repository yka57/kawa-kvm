import type { Shortcut } from './types.ts';

/**
 * Read-only default shortcuts of the Shortcuts popover (spec §3.6). Same
 * `{ keys: [{ code, label }] }` shape as the stored custom shortcuts; the
 * first two are upstream's, the rest cover what macOS never lets the page
 * capture (app switching, task manager, the Start menu).
 */
export const DEFAULT_SHORTCUTS: readonly Shortcut[] = [
  {
    keys: [
      { code: 'MetaLeft', label: 'Win' },
      { code: 'Tab', label: 'Tab' }
    ]
  },
  {
    keys: [
      { code: 'ControlLeft', label: 'Ctrl' },
      { code: 'AltLeft', label: 'Alt' },
      { code: 'Delete', label: '⌫' }
    ]
  },
  {
    keys: [
      { code: 'AltLeft', label: 'Alt' },
      { code: 'Tab', label: 'Tab' }
    ]
  },
  {
    keys: [
      { code: 'ControlLeft', label: 'Ctrl' },
      { code: 'ShiftLeft', label: 'Shift' },
      { code: 'Escape', label: 'Esc' }
    ]
  },
  {
    keys: [{ code: 'MetaLeft', label: 'Win' }]
  }
];
