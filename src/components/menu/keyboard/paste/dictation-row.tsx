import clsx from 'clsx';
import { useAtom } from 'jotai';
import { MicIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { dictationBarAtom } from '@/jotai/paste.ts';
import * as storage from '@/libs/storage';

/** Keyboard-menu row that shows or hides the dictation bar. */
export const DictationRow = () => {
  const { t } = useTranslation();
  const [bar, setBar] = useAtom(dictationBarAtom);

  function toggle(): void {
    const next = { ...bar, open: !bar.open };
    setBar(next);
    storage.setDictationBar(next);
  }

  return (
    <div
      className={clsx(
        'flex h-[32px] cursor-pointer items-center space-x-2 rounded px-3 hover:bg-neutral-700/50',
        bar.open ? 'text-blue-500' : 'text-neutral-300'
      )}
      onClick={toggle}
    >
      <MicIcon size={16} />
      <span>{t('paste.dictationBar')}</span>
    </div>
  );
};
