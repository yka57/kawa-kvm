import { ReactElement } from 'react';
import { Popover, Slider } from 'antd';
import { useAtom } from 'jotai';
import { GaugeIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { scrollIntervalAtom, scrollPxPerNotchAtom } from '@/jotai/mouse.ts';
import {
  intervalToWheelSpeed,
  pxPerNotchToSlider,
  SCROLL_SENSITIVITY,
  sliderToPxPerNotch,
  wheelSpeedToInterval
} from '@/libs/pointer/scales';
import * as storage from '@/libs/storage';

/**
 * Wheel settings (spec §4.3): the legacy "Wheel speed" rate cap (controlled
 * now, same mapping) next to the new "Scroll sensitivity" (host px per notch).
 */
export const Speed = (): ReactElement => {
  const { t } = useTranslation();

  const [scrollInterval, setScrollInterval] = useAtom(scrollIntervalAtom);
  const [scrollPxPerNotch, setScrollPxPerNotch] = useAtom(scrollPxPerNotchAtom);

  function updateSpeed(speed: number): void {
    const interval = wheelSpeedToInterval(speed);
    setScrollInterval(interval);
    storage.setMouseScrollInterval(interval);
  }

  function updateSensitivity(value: number): void {
    const pxPerNotch = sliderToPxPerNotch(value);
    setScrollPxPerNotch(pxPerNotch);
    storage.setScrollPxPerNotch(pxPerNotch);
  }

  const marks = {
    0: <span>{t('mouse.slow')}</span>,
    100: <span>{t('mouse.fast')}</span>
  };

  const content = (
    <div className="flex space-x-5 px-2 py-3">
      <div className="flex flex-col items-center space-y-2">
        <span className="select-none whitespace-nowrap text-xs text-neutral-400">
          {t('mouse.speed')}
        </span>
        <div className="h-[150px] w-[60px]">
          <Slider
            vertical
            marks={marks}
            range={false}
            included={false}
            step={10}
            value={intervalToWheelSpeed(scrollInterval)}
            onChange={updateSpeed}
          />
        </div>
      </div>

      <div className="flex flex-col items-center space-y-2">
        <span className="select-none whitespace-nowrap text-xs text-neutral-400">
          {t('mouse.scrollSensitivity')}
        </span>
        <div className="h-[150px] w-[60px]">
          <Slider
            vertical
            marks={marks}
            range={false}
            included={false}
            step={5}
            value={pxPerNotchToSlider(scrollPxPerNotch)}
            onChange={updateSensitivity}
            tooltip={{
              formatter: (value) =>
                `${sliderToPxPerNotch(value ?? SCROLL_SENSITIVITY.DEFAULT_SLIDER)} px`
            }}
          />
        </div>
      </div>
    </div>
  );

  return (
    <Popover content={content} placement="rightTop" arrow={false} align={{ offset: [13, 0] }}>
      <div className="flex h-[32px] cursor-pointer items-center space-x-2 rounded px-3 text-neutral-300 hover:bg-neutral-700/50">
        <GaugeIcon size={16} />
        <span>{t('mouse.speed')}</span>
      </div>
    </Popover>
  );
};
