import { Popover } from 'antd';
import clsx from 'clsx';
import { useAtom } from 'jotai';
import { TypeIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { targetLayoutAtom } from '@/jotai/target.ts';
import * as storage from '@/libs/storage';
import type { TargetLayout } from '@/libs/storage';

export const TargetLayoutRow = () => {
  const { t } = useTranslation();
  const [targetLayout, setTargetLayout] = useAtom(targetLayoutAtom);

  const options: { name: string; value: TargetLayout }[] = [
    { name: t('target.us'), value: 'us' },
    { name: t('target.jis'), value: 'jis' }
  ];

  function update(layout: TargetLayout) {
    setTargetLayout(layout);
    storage.setTargetLayout(layout);
  }

  const content = (
    <>
      {options.map((option) => (
        <div
          key={option.value}
          className={clsx(
            'my-1 flex cursor-pointer items-center space-x-1 rounded py-1 pl-2 pr-5 hover:bg-neutral-700/50',
            option.value === targetLayout ? 'text-blue-500' : 'text-neutral-300'
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
        <TypeIcon size={16} />
        <span>{t('target.layout')}</span>
      </div>
    </Popover>
  );
};
