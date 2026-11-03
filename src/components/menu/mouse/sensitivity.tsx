import { ReactElement } from 'react';
import { Popover, Slider } from 'antd';
import { useAtom } from 'jotai';
import { MoveIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { mouseSensitivityAtom } from '@/jotai/mouse.ts';
import { gainToSlider, POINTER_SPEED, sliderToGain } from '@/libs/pointer/scales';
import * as storage from '@/libs/storage';

function formatGain(gain: number): string {
  return `×${gain.toFixed(2)}`;
}

/** "Pointer speed" row (spec §4.3): relative-mode gain, rendered only in relative mode. */
export const Sensitivity = (): ReactElement => {
  const { t } = useTranslation();

  const [sensitivity, setSensitivity] = useAtom(mouseSensitivityAtom);

  function update(value: number): void {
    const gain = sliderToGain(value);
    setSensitivity(gain);
    storage.setMouseSensitivity(gain);
  }

  const content = (
    <div className="flex flex-col items-center space-y-2 px-2 py-3">
      <div className="h-[150px] w-[60px]">
        <Slider
          vertical
          marks={{
            0: <span>{t('mouse.slow')}</span>,
            100: <span>{t('mouse.fast')}</span>
          }}
          range={false}
          included={false}
          step={5}
          value={gainToSlider(sensitivity)}
          onChange={update}
          tooltip={{
            formatter: (value) => formatGain(sliderToGain(value ?? POINTER_SPEED.DEFAULT_SLIDER))
          }}
        />
      </div>
      <span className="select-none text-xs text-neutral-400">{formatGain(sensitivity)}</span>
    </div>
  );

  return (
    <Popover content={content} placement="rightTop" arrow={false} align={{ offset: [13, 0] }}>
      <div className="flex h-[32px] cursor-pointer items-center space-x-2 rounded px-3 text-neutral-300 hover:bg-neutral-700/50">
        <MoveIcon size={16} />
        <span>{t('mouse.pointerSpeed')}</span>
      </div>
    </Popover>
  );
};
