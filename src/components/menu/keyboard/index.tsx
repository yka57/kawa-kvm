import { useState } from 'react';
import { Divider, Popover } from 'antd';
import { KeyboardIcon } from 'lucide-react';

import { getOperatingSystem } from '@/libs/browser';

import { Paste } from './paste';
import { ReleaseAll } from './release-all.tsx';
import { Remap } from './remap';
import { Shortcuts } from './shortcuts';
import { TargetLayoutRow } from './target-layout.tsx';
import { TargetOsRow } from './target-os.tsx';
import { VirtualKeyboard } from './virtual-keyboard.tsx';

export const Keyboard = () => {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);

  // the ⌘ remap only exists on macOS hosts (spec §3.6)
  const isMacHost = getOperatingSystem() === 'macOS';

  const content = (
    <div className="flex flex-col space-y-0.5">
      <Paste />
      <VirtualKeyboard />
      <Shortcuts />

      <Divider style={{ margin: '5px 0 5px 0' }} />
      <TargetOsRow />
      <TargetLayoutRow />
      {isMacHost && <Remap />}
      <ReleaseAll />
    </div>
  );

  return (
    <Popover
      content={content}
      placement="bottomLeft"
      trigger="click"
      arrow={false}
      open={isPopoverOpen}
      onOpenChange={setIsPopoverOpen}
    >
      <div className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded text-neutral-300 hover:bg-neutral-700/70 hover:text-white">
        <KeyboardIcon size={18} />
      </div>
    </Popover>
  );
};
