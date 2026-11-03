import { useEffect, useState } from 'react';
import { Button, Divider, Modal } from 'antd';
import { useSetAtom, useStore } from 'jotai';
import { useTranslation } from 'react-i18next';

import { Kbd } from '@/components/ui/kbd.tsx';
import { isKeyTestOpenAtom, keyTraceAtom, type KeyTrace } from '@/jotai/keyboard.ts';
import { toggleFullscreenWithKeyboardLock } from '@/libs/browser/fullscreen';
import { DEBUG_HID_EVENT } from '@/libs/debug/hid-log';
import * as storage from '@/libs/storage';

import { formatReport, formatTraceEvent, formatTraceSent, isKeyupUnderMeta } from './key-test.ts';

// Chrome hands these to the page in a normal window (preventDefault stops the browser action).
const WINDOW_SHORTCUTS = [
  '⌘C',
  '⌘V',
  '⌘X',
  '⌘A',
  '⌘Z',
  '⌘⇧Z',
  '⌘F',
  '⌘S',
  '⌘R',
  '⌘P',
  '⌘L',
  '⌘D',
  '⌘1…9',
  '⌘+',
  '⌘−',
  '⌘0',
  '⌘←/→',
  '⌘↑/↓',
  '⌥←/→',
  '⌥⌫'
];

// Chrome-reserved: delivered only in JS fullscreen with keyboard lock.
const FULLSCREEN_SHORTCUTS = ['⌘W', '⌘⇧W', '⌘T', '⌘⇧T', '⌘N', '⌘⇧N', '⌘⇧[', '⌘⇧]', '⌘⌥←/→', '⌃Tab'];

const MAX_LINES = 6;

interface RemapHelpProps {
  open: boolean;
  onClose: () => void;
}

const KbdRow = ({ items }: { items: string[] }) => (
  <div className="flex flex-wrap gap-1">
    {items.map((item) => (
      <Kbd key={item}>{item}</Kbd>
    ))}
  </div>
);

/**
 * "Which shortcuts can be sent?" modal with the Key test (spec §3.6). While
 * open the keyboard driver runs in dry-run mode (via isKeyTestOpenAtom): the
 * state machine and traces run, nothing is sent to the target.
 */
export const RemapHelp = ({ open, onClose }: RemapHelpProps) => {
  const { t } = useTranslation();
  const store = useStore();
  const setIsKeyTestOpen = useSetAtom(isKeyTestOpenAtom);

  const [lines, setLines] = useState<KeyTrace[]>([]);
  // keyups of non-modifiers while ⌘ is held (assumption A1 says there are none)
  const [metaKeyups, setMetaKeyups] = useState(0);

  useEffect(() => {
    setIsKeyTestOpen(open);

    return () => {
      setIsKeyTestOpen(false);
    };
  }, [open, setIsKeyTestOpen]);

  useEffect(() => {
    if (!open) return;

    setLines([]);
    setMetaKeyups(0);

    // subscribe directly: only traces produced during this session count
    return store.sub(keyTraceAtom, () => {
      const trace = store.get(keyTraceAtom);
      if (!trace) return;

      setLines((prev) => [trace, ...prev].slice(0, MAX_LINES));
      if (isKeyupUnderMeta(trace)) {
        setMetaKeyups((n) => n + 1);
      }
    });
  }, [open, store]);

  function openHidLog(): void {
    storage.setDebugHid(true);
    window.dispatchEvent(new Event(DEBUG_HID_EVENT));
  }

  return (
    <Modal
      width={620}
      title={t('keyboard.remap.help')}
      keyboard={false}
      footer={null}
      open={open}
      onCancel={onClose}
    >
      <div className="flex flex-col space-y-4 text-neutral-300">
        <div>
          <div className="pb-1 font-medium">{t('keyboard.remap.helpWindow')}</div>
          <KbdRow items={WINDOW_SHORTCUTS} />
        </div>

        <div>
          <div className="flex items-center justify-between pb-1">
            <span className="font-medium">{t('keyboard.remap.helpFullscreen')}</span>
            <Button size="small" onClick={toggleFullscreenWithKeyboardLock}>
              {t('keyboard.remap.enterFullscreen')}
            </Button>
          </div>
          <KbdRow items={FULLSCREEN_SHORTCUTS} />
        </div>

        <div className="text-sm text-neutral-400">{t('keyboard.remap.helpNever')}</div>
        <div className="text-sm text-neutral-400">{t('keyboard.remap.sideEffects')}</div>

        <Divider style={{ margin: '4px 0 4px 0' }} />

        <div>
          <div className="flex items-center justify-between pb-1">
            <span className="font-medium">{t('keyboard.remap.keyTest')}</span>
            <span className="text-xs text-amber-400">{t('keyboard.remap.keyTestHint')}</span>
          </div>

          <div className="min-h-[4rem] rounded bg-neutral-900/60 p-2 font-mono text-xs leading-5">
            {lines.length === 0 ? (
              <div className="text-neutral-500">{t('keyboard.remap.keyTestEmpty')}</div>
            ) : (
              lines.map((line, index) => (
                <div key={line.seq ?? index} className="flex flex-wrap gap-x-2">
                  <span>{formatTraceEvent(line)}</span>
                  <span className="text-neutral-500">→</span>
                  <span className="text-blue-400">{formatTraceSent(line)}</span>
                  <span className="text-neutral-600">{formatReport(line.report)}</span>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-between pt-1 text-xs text-neutral-500">
            <span>{t('keyboard.remap.keyupsUnderMeta', { n: metaKeyups })}</span>
            <a className="text-blue-500/80" onClick={openHidLog}>
              {t('debug.hidLog')}
            </a>
          </div>
        </div>
      </div>
    </Modal>
  );
};
