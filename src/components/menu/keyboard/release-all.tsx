import { HandIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getKeyboardDriver } from '@/components/keyboard/driver-registry';
import { device } from '@/libs/device';
import { emitMouseRelease } from '@/libs/mouse/release-bus';

const EMPTY_REPORT = [0, 0, 0, 0, 0, 0, 0, 0];

/** "Release all keys" row (spec §3.6): keyboard driver reset plus mouse buttons up. */
export const ReleaseAll = () => {
  const { t } = useTranslation();

  function releaseAll(): void {
    const driver = getKeyboardDriver();
    if (driver) {
      driver.releaseAll();
    } else {
      // capture is unmounted (keyboard disabled): send the all-zero report directly
      device.sendKeyboardData(EMPTY_REPORT).catch((err: unknown) => {
        console.error('[keyboard] release all failed', err);
      });
    }

    emitMouseRelease();
  }

  return (
    <div
      className="flex h-[32px] cursor-pointer items-center space-x-2 rounded px-3 text-neutral-300 hover:bg-neutral-700/50"
      onClick={releaseAll}
    >
      <HandIcon size={16} />
      <span>{t('keyboard.remap.releaseAll')}</span>
    </div>
  );
};
