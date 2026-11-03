import { Popover } from 'antd';
import clsx from 'clsx';
import { useAtom } from 'jotai';
import { MonitorIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { targetOsAtom } from '@/jotai/target.ts';
import * as storage from '@/libs/storage';
import type { TargetOs } from '@/libs/storage';

export const TargetOsRow = () => {
  const { t } = useTranslation();
  const [targetOs, setTargetOs] = useAtom(targetOsAtom);

  const options: { name: string; value: TargetOs }[] = [
    { name: t('target.windows'), value: 'windows' },
    { name: t('target.linux'), value: 'linux' },
    { name: t('target.macos'), value: 'macos' }
  ];

  function update(os: TargetOs) {
    setTargetOs(os);
    storage.setTargetOs(os);
  }

  const content = (
    <>
      {options.map((option) => (
        <div
          key={option.value}
          className={clsx(
            'my-1 flex cursor-pointer items-center space-x-1 rounded py-1 pl-2 pr-5 hover:bg-neutral-700/50',
            option.value === targetOs ? 'text-blue-500' : 'text-neutral-300'
          )}
          onClick={() => update(option.value)}
        >
          {option.name}
        </div>
      ))}
    </>
  );

  return (
    <Popover content={content} placement="rightTop" arrow={false} align={{ offset: [13, 0] }}>
      <div className="flex h-[32px] cursor-pointer items-center space-x-2 rounded px-3 text-neutral-300 hover:bg-neutral-700/50">
        <MonitorIcon size={16} />
        <span>{t('target.os')}</span>
      </div>
    </Popover>
  );
};
