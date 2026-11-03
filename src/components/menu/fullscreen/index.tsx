import { useEffect, useState } from 'react';
import { MaximizeIcon, MinimizeIcon } from 'lucide-react';

import { toggleFullscreenWithKeyboardLock } from '@/libs/browser/fullscreen';

export const Fullscreen = () => {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }

    onFullscreenChange();

    document.addEventListener('fullscreenchange', onFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, []);

  function handleFullscreen() {
    toggleFullscreenWithKeyboardLock();
  }

  return (
    <div
      className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded text-neutral-300 hover:bg-neutral-700/70 hover:text-white"
      onClick={handleFullscreen}
    >
      {isFullscreen ? <MinimizeIcon size={18} /> : <MaximizeIcon size={18} />}
    </div>
  );
};
