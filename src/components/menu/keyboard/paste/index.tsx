import { useAtomValue } from 'jotai';
import { ClipboardIcon, Loader2Icon, SettingsIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Kbd } from '@/components/ui/kbd.tsx';
import { keyboardRemapAtom } from '@/jotai/keyboard.ts';
import { pasteRunAtom, pasteSettingsAtom } from '@/jotai/paste.ts';
import { targetOsAtom } from '@/jotai/target.ts';
import { getOperatingSystem } from '@/libs/browser';
import { isRemapActive } from '@/libs/keyboard/remap-config';
import { normalisePasteSettings } from '@/libs/paste/settings';

import { pasteController } from './controller.ts';
import { formatChord } from './decide.ts';

/**
 * Paste row of the keyboard popover (spec §5.4): one click reads the host
 * clipboard and types it; while a run is in progress the row cancels it.
 * The gear opens the settings modal.
 */
export const Paste = () => {
  const { t } = useTranslation();
  const hostOS = getOperatingSystem();
  const run = useAtomValue(pasteRunAtom);
  const rawSettings = useAtomValue(pasteSettingsAtom);
  const remapConfig = useAtomValue(keyboardRemapAtom);
  const targetOs = useAtomValue(targetOsAtom);

  const settings = normalisePasteSettings(rawSettings, hostOS);
  // the hotkey is consumed by the keyboard driver only while the remap is active
  const isHotkeyActive = settings.hotkeyEnabled && isRemapActive(remapConfig, hostOS, targetOs);
  const isRunning = run.status === 'running';

  function handleClick(): void {
    if (isRunning) {
      pasteController.cancel();
      return;
    }
    pasteController.startFromRow();
  }

  return (
    <div
      data-paste-ui=""
      className="flex h-[32px] cursor-pointer items-center justify-between space-x-3 rounded px-3 text-neutral-300 hover:bg-neutral-700/50"
      onClick={handleClick}
    >
      <div className="flex items-center space-x-2">
        {isRunning ? (
          <Loader2Icon size={16} className="animate-spin" />
        ) : (
          <ClipboardIcon size={16} />
        )}
        <span>{isRunning ? t('paste.cancel') : t('paste.title')}</span>
      </div>

      <div className="flex items-center space-x-1">
        {isHotkeyActive && <Kbd>{formatChord(settings.hotkey, hostOS).join('')}</Kbd>}

        <div
          className="flex h-[22px] w-[22px] items-center justify-center rounded text-neutral-400 hover:bg-neutral-600/60 hover:text-white"
          title={t('paste.settings')}
          onClick={(e) => {
            e.stopPropagation();
            pasteController.openSettings();
          }}
        >
          <SettingsIcon size={14} />
        </div>
      </div>
    </div>
  );
};
