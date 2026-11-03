import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Divider, Input, InputRef, Modal } from 'antd';
import { useAtomValue, useSetAtom } from 'jotai';
import { KeyboardIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Kbd, KbdGroup } from '@/components/ui/kbd.tsx';
import { ScrollArea } from '@/components/ui/scroll-area.tsx';
import { isKeyboardEnableAtom, keyboardRemapAtom } from '@/jotai/keyboard.ts';
import { targetOsAtom } from '@/jotai/target.ts';
import { getOperatingSystem } from '@/libs/browser';
import { toggleFullscreenWithKeyboardLock } from '@/libs/browser/fullscreen';
import { isRemapActive } from '@/libs/keyboard/remap-config';

import { toRecordedKey } from './record-key.ts';
import { KeyInfo, Shortcut } from './types.ts';

const MAX_KEYS = 6;

interface RecorderProps {
  shortcuts: Shortcut[];
  addShortcut: (shortcut: Shortcut) => void;
  delShortcut: (index: number) => void;
  setIsRecording: (isRecording: boolean) => void;
}

export const Recorder = ({
  shortcuts,
  addShortcut,
  delShortcut,
  setIsRecording
}: RecorderProps) => {
  const { t } = useTranslation();
  const setIsKeyboardEnable = useSetAtom(isKeyboardEnableAtom);
  const remapConfig = useAtomValue(keyboardRemapAtom);
  const targetOs = useAtomValue(targetOsAtom);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [shortcutLabel, setShortcutLabel] = useState('');
  // "Record ⌘ as Ctrl": offered and pre-checked only while the remap is active
  const [recordAsCtrl, setRecordAsCtrl] = useState(false);

  const inputRef = useRef<InputRef | null>(null);
  const recordedKeysRef = useRef<KeyInfo[]>([]);

  const remapActive = isRemapActive(remapConfig, getOperatingSystem(), targetOs);

  useEffect(() => {
    setIsKeyboardEnable(!isModalOpen);
    setIsRecording(isModalOpen);

    if (!isModalOpen) return;

    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 100);

    return () => {
      clearTimeout(timer);
    };
  }, [isModalOpen]);

  useEffect(() => {
    if (!isFocused) return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();

      const { key, code } = event;
      const keyInfo = toRecordedKey(key, code, recordAsCtrl);

      // dedupe by the stored code (⌘ and ⌃ both record Ctrl while the checkbox is on)
      const isRecorded = recordedKeysRef.current.some((k) => k.code === keyInfo.code);
      if (isRecorded) return;

      if (recordedKeysRef.current.length >= MAX_KEYS) return;

      setShortcutLabel((prev) => (prev ? `${prev} + ${keyInfo.label}` : keyInfo.label));
      recordedKeysRef.current.push(keyInfo);
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isFocused, recordAsCtrl]);

  function openModal() {
    setRecordAsCtrl(remapActive);
    setIsModalOpen(true);
  }

  function saveShortcut() {
    if (recordedKeysRef.current.length > 0) {
      addShortcut({ keys: recordedKeysRef.current });
    }

    clearShortcut();
  }

  function clearShortcut() {
    setShortcutLabel('');
    recordedKeysRef.current = [];
  }

  function closeModal() {
    clearShortcut();
    setIsModalOpen(false);
  }

  return (
    <>
      <div
        className="flex h-[30px] cursor-pointer items-center space-x-1 rounded px-3 text-neutral-300 hover:bg-neutral-700/60"
        onClick={openModal}
      >
        <span>{t('keyboard.shortcut.custom')}</span>
      </div>

      <Modal
        width={500}
        title={t('keyboard.shortcut.title')}
        keyboard={false}
        footer={null}
        open={isModalOpen}
        onCancel={closeModal}
      >
        <div>
          <span className="text-neutral-500">{t('keyboard.shortcut.captureTips')}</span>
          <a className="px-1 text-blue-500/80" onClick={toggleFullscreenWithKeyboardLock}>
            {t('keyboard.shortcut.enterFullScreen')}
          </a>
        </div>

        {remapActive && (
          <div className="pt-3">
            <Checkbox
              checked={recordAsCtrl}
              onChange={(e) => {
                setRecordAsCtrl(e.target.checked);
                clearShortcut();
              }}
            >
              {t('keyboard.remap.recordAsCtrl')}
            </Checkbox>
          </div>
        )}

        <div className="flex items-center space-x-0.5 py-6">
          <Input
            ref={inputRef}
            placeholder={t('keyboard.shortcut.capture')}
            prefix={<KeyboardIcon size={16} className="text-neutral-500" />}
            value={shortcutLabel}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
          />

          <Button onClick={clearShortcut}>{t('keyboard.shortcut.clear')}</Button>
        </div>

        <div className="flex w-full justify-center pb-3">
          <Button type="primary" className="min-w-24" onClick={saveShortcut}>
            {t('keyboard.shortcut.save')}
          </Button>
        </div>

        {shortcuts.length > 0 && (
          <>
            <Divider />

            <ScrollArea className="[&>[data-radix-scroll-area-viewport]]:max-h-[300px]">
              {shortcuts.map((shortcut, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between rounded p-2 hover:bg-neutral-700/50"
                >
                  <div className="flex items-center space-x-1">
                    {shortcut.keys.map((key, index) => (
                      <KbdGroup key={index}>
                        <Kbd>{key.label}</Kbd>
                      </KbdGroup>
                    ))}
                  </div>

                  <div
                    className="flex size-[20px] cursor-pointer items-center justify-center rounded-sm text-neutral-500 hover:text-red-500"
                    onClick={() => delShortcut(index)}
                  >
                    <Trash2Icon size={16} />
                  </div>
                </div>
              ))}
            </ScrollArea>
          </>
        )}
      </Modal>
    </>
  );
};
