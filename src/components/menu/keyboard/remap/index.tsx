import { useState } from 'react';
import { Checkbox, Divider, Popover } from 'antd';
import clsx from 'clsx';
import { useAtomValue, useSetAtom } from 'jotai';
import { ArrowLeftRightIcon, CircleHelpIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { keyboardRemapAtom, keyboardRemapRawAtom } from '@/jotai/keyboard.ts';
import { targetOsAtom } from '@/jotai/target.ts';
import type { KeyboardRemapConfig } from '@/libs/keyboard/remap-config';
import * as storage from '@/libs/storage';

import { RemapHelp } from './help.tsx';

/** ⌘ key mapping row of the keyboard popover (spec §3.6); rendered on macOS hosts only. */
export const Remap = () => {
  const { t } = useTranslation();
  const config = useAtomValue(keyboardRemapAtom);
  const setRawConfig = useSetAtom(keyboardRemapRawAtom);
  const targetOs = useAtomValue(targetOsAtom);

  const [isHelpOpen, setIsHelpOpen] = useState(false);

  // the remap never applies to a macOS target, whatever the toggle says
  const isMacTarget = targetOs === 'macos';

  function update(patch: Partial<KeyboardRemapConfig>) {
    const next: KeyboardRemapConfig = { ...config, ...patch };
    // the raw atom holds the stored shape (plain record); the derived atom re-normalises it
    setRawConfig({ ...next });
    storage.setKeyboardRemap(next);
  }

  function setEnabled(enabled: boolean) {
    if (isMacTarget) return;
    update({ enabled });
  }

  const options: { name: string; enabled: boolean }[] = [
    { name: t('keyboard.remap.off'), enabled: false },
    { name: t('keyboard.remap.on'), enabled: true }
  ];

  const rules: { key: 'navRules' | 'jisEisuKana' | 'macCapsLockFix'; label: string }[] = [
    { key: 'navRules', label: t('keyboard.remap.nav') },
    { key: 'jisEisuKana', label: t('keyboard.remap.jis') },
    { key: 'macCapsLockFix', label: t('keyboard.remap.capsLock') }
  ];

  const content = (
    <div className="max-w-[360px]">
      {options.map((option) => (
        <div
          key={String(option.enabled)}
          className={clsx(
            'my-1 flex items-center space-x-1 rounded py-1 pl-2 pr-5',
            option.enabled === config.enabled ? 'text-blue-500' : 'text-neutral-300',
            isMacTarget ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-neutral-700/50'
          )}
          onClick={() => setEnabled(option.enabled)}
        >
          {option.name}
        </div>
      ))}

      {isMacTarget && (
        <div className="pb-1 pl-2 text-xs text-neutral-500">
          {t('keyboard.remap.inactiveMacTarget')}
        </div>
      )}

      <Divider style={{ margin: '5px 0 5px 0' }} />

      <div className="flex flex-col space-y-1 px-2 py-1">
        {rules.map((rule) => (
          <Checkbox
            key={rule.key}
            checked={config[rule.key]}
            disabled={!config.enabled || isMacTarget}
            onChange={(e) => update({ [rule.key]: e.target.checked })}
          >
            {rule.label}
          </Checkbox>
        ))}
      </div>

      <Divider style={{ margin: '5px 0 5px 0' }} />

      <div
        className="my-1 flex cursor-pointer items-center space-x-2 rounded py-1 pl-2 pr-5 text-neutral-300 hover:bg-neutral-700/50"
        onClick={() => setIsHelpOpen(true)}
      >
        <CircleHelpIcon size={16} />
        <span>{t('keyboard.remap.help')}</span>
      </div>
    </div>
  );

  return (
    <>
      <Popover content={content} placement="rightTop" arrow={false} align={{ offset: [13, 0] }}>
        <div className="flex h-[32px] cursor-pointer items-center space-x-2 rounded px-3 text-neutral-300 hover:bg-neutral-700/50">
          <ArrowLeftRightIcon size={16} />
          <span>{t('keyboard.remap.title')}</span>
        </div>
      </Popover>

      <RemapHelp open={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
    </>
  );
};
