import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Divider, Input, Modal, Select, Switch } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import clsx from 'clsx';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { KeyboardIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Kbd, KbdGroup } from '@/components/ui/kbd.tsx';
import { isKeyboardEnableAtom, keyboardRemapAtom } from '@/jotai/keyboard.ts';
import { pasteSettingsAtom } from '@/jotai/paste.ts';
import { targetLayoutAtom, targetOsAtom } from '@/jotai/target.ts';
import { getOperatingSystem } from '@/libs/browser';
import { isRemapActive } from '@/libs/keyboard/remap-config';
import { normalisePasteSettings, type PasteSettings } from '@/libs/paste/settings';
import type { NewlineMode } from '@/libs/paste/types';
import type { SpeedPreset } from '@/libs/paste/typing-engine';
import * as storage from '@/libs/storage';
import type { TargetLayout } from '@/libs/storage';

import { pasteController, pasteSettingsModalAtom } from './controller.ts';
import { chordFromKeyEvent, formatChord } from './decide.ts';

/**
 * Paste settings modal (spec §5.5), mounted once in App.tsx and opened from
 * the gear of the Paste row or by the controller when clipboard access is
 * blocked. Keyboard capture is off while it is open, like the shortcut
 * recorder, so typing in the text box never reaches the target.
 */
export const PasteSettingsModal = () => {
  const { t } = useTranslation();
  const hostOS = getOperatingSystem();

  const modalState = useAtomValue(pasteSettingsModalAtom);
  const setIsKeyboardEnable = useSetAtom(isKeyboardEnableAtom);
  const [rawSettings, setRawSettings] = useAtom(pasteSettingsAtom);
  const [targetLayout, setTargetLayout] = useAtom(targetLayoutAtom);
  const remapConfig = useAtomValue(keyboardRemapAtom);
  const targetOs = useAtomValue(targetOsAtom);

  const [text, setText] = useState('');
  const [isCapturing, setIsCapturing] = useState(false);
  const textRef = useRef<TextAreaRef>(null);

  const settings = useMemo(
    () => normalisePasteSettings(rawSettings, hostOS),
    [rawSettings, hostOS]
  );
  const remapActive = isRemapActive(remapConfig, hostOS, targetOs);
  const isOpen = modalState.open;

  const update = useCallback(
    (patch: Partial<PasteSettings>) => {
      const next: PasteSettings = { ...settings, ...patch };
      // the raw atom holds the stored shape; normalisePasteSettings re-validates it
      setRawSettings({ ...next });
      storage.setPasteSettings(next);
    },
    [settings, setRawSettings]
  );

  useEffect(() => {
    setIsKeyboardEnable(!isOpen);
    if (!isOpen) return;

    setText('');
    setIsCapturing(false);

    const timer = setTimeout(() => {
      textRef.current?.focus();
    }, 100);

    return () => {
      clearTimeout(timer);
    };
  }, [isOpen, setIsKeyboardEnable]);

  // Hotkey capture: the first keydown with ⌘/⌃/⌥ and a non-modifier key is the new chord.
  useEffect(() => {
    if (!isCapturing) return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === 'Escape') {
        setIsCapturing(false);
        return;
      }

      const chord = chordFromKeyEvent(event);
      if (!chord) return;

      update({ hotkey: chord });
      setIsCapturing(false);
    };

    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isCapturing, update]);

  function close(): void {
    setIsCapturing(false);
    pasteController.closeSettings();
  }

  async function typeText(): Promise<void> {
    const outcome = await pasteController.startFromText(text);
    if (outcome === 'started') close();
  }

  function updateLayout(layout: TargetLayout): void {
    setTargetLayout(layout);
    storage.setTargetLayout(layout);
  }

  const layoutOptions: { value: TargetLayout; label: string }[] = [
    { value: 'us', label: t('target.us') },
    { value: 'jis', label: t('target.jis') }
  ];
  const speedOptions: { value: SpeedPreset; label: string }[] = [
    { value: 'safe', label: t('paste.speedSafe') },
    { value: 'normal', label: t('paste.speedNormal') }
  ];
  const newlineOptions: { value: NewlineMode; label: string }[] = [
    { value: 'enter', label: t('paste.newlineEnter') },
    { value: 'shift-enter', label: t('paste.newlineShiftEnter') }
  ];

  return (
    <Modal
      width={520}
      title={t('paste.settings')}
      keyboard={false}
      footer={null}
      open={isOpen}
      onCancel={close}
    >
      <div data-paste-ui="" className="flex flex-col space-y-4 pt-2">
        {modalState.permDenied && <Alert type="warning" showIcon message={t('paste.permDenied')} />}

        {/* manual fallback */}
        <div className="flex flex-col space-y-2">
          <Input.TextArea
            ref={textRef}
            rows={4}
            placeholder={t('paste.textPlaceholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex justify-end">
            <Button type="primary" disabled={text.length === 0} onClick={typeText}>
              {t('paste.typeText')}
            </Button>
          </div>
        </div>

        <Divider style={{ margin: 0 }} />

        <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3">
          <span className="text-neutral-400">{t('target.layout')}</span>
          <Select
            size="small"
            className="w-44"
            value={targetLayout}
            options={layoutOptions}
            onChange={updateLayout}
          />

          <span className="text-neutral-400">{t('paste.speed')}</span>
          <Select
            size="small"
            className="w-44"
            value={settings.speed}
            options={speedOptions}
            onChange={(speed) => update({ speed })}
          />

          <span className="text-neutral-400">{t('paste.newline')}</span>
          <Select
            size="small"
            className="w-44"
            value={settings.newline}
            options={newlineOptions}
            onChange={(newline) => update({ newline })}
          />
        </div>

        <div className="flex flex-col space-y-1">
          <Checkbox
            checked={settings.normalizePunct}
            onChange={(e) => update({ normalizePunct: e.target.checked })}
          >
            {t('paste.normalize')}
          </Checkbox>
          <Checkbox
            checked={settings.stripTrailingNewline}
            onChange={(e) => update({ stripTrailingNewline: e.target.checked })}
          >
            {t('paste.stripTrailingNewline')}
          </Checkbox>
          <Checkbox
            checked={settings.imePreKey === 'NonConvert'}
            onChange={(e) => update({ imePreKey: e.target.checked ? 'NonConvert' : 'none' })}
          >
            {t('paste.imeOff')}
          </Checkbox>
        </div>

        <Divider style={{ margin: 0 }} />

        {/* hotkey: consumed by the keyboard driver only while ⌘ → Ctrl is active */}
        <div className={clsx('flex flex-col space-y-1', !remapActive && 'opacity-50')}>
          <div className="flex items-center space-x-3">
            <span className="text-neutral-400">{t('paste.hotkey')}</span>

            {isCapturing ? (
              <Input
                size="small"
                className="w-60"
                readOnly
                autoFocus
                placeholder={t('paste.pressHotkey')}
                prefix={<KeyboardIcon size={14} className="text-neutral-500" />}
                onBlur={() => setIsCapturing(false)}
              />
            ) : (
              <KbdGroup>
                {formatChord(settings.hotkey, hostOS).map((label, index) => (
                  <Kbd key={index}>{label}</Kbd>
                ))}
              </KbdGroup>
            )}

            <Switch
              size="small"
              checked={settings.hotkeyEnabled}
              disabled={!remapActive}
              onChange={(checked) => update({ hotkeyEnabled: checked })}
            />
            <Button
              size="small"
              disabled={!remapActive}
              // keep the capture input focused: its blur would end the capture
              // just before this click toggled it back on
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setIsCapturing((capturing) => !capturing)}
            >
              {t(isCapturing ? 'paste.cancel' : 'paste.change')}
            </Button>
          </div>

          {!remapActive && (
            <span className="text-xs text-neutral-500">{t('paste.hotkeyNeedsRemap')}</span>
          )}
        </div>

        <span className="text-xs text-neutral-500">{t('paste.capsHint')}</span>
      </div>
    </Modal>
  );
};
