import { useCallback, useEffect, useRef, useState } from 'react';
import { Checkbox, Input } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import clsx from 'clsx';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { MicIcon, SendIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { serialStateAtom } from '@/jotai/device.ts';
import { isKeyboardEnableAtom, isKeyboardOpenAtom } from '@/jotai/keyboard.ts';
import { dictationBarAtom, pasteRunAtom } from '@/jotai/paste.ts';
import * as storage from '@/libs/storage';

import { pasteController } from './controller.ts';
import { DictationQueue } from './dictation-queue.ts';

/** Dictation keeps revising its last words: send only after this long without a change. */
const AUTO_SEND_IDLE_MS = 1500;

/**
 * Dictation bar: a host-side text field whose content is typed on the target.
 * macOS dictation (or the host IME) writes into it like into any text field;
 * the text leaves on Enter, or by itself after a pause. While it has the
 * focus the physical keyboard is not forwarded to the target.
 */
export const DictationBar = () => {
  const { t } = useTranslation();
  const [bar, setBar] = useAtom(dictationBarAtom);
  const run = useAtomValue(pasteRunAtom);
  const serialState = useAtomValue(serialStateAtom);
  const isKeyboardOpen = useAtomValue(isKeyboardOpenAtom);
  const setIsKeyboardEnable = useSetAtom(isKeyboardEnableAtom);

  const [value, setValue] = useState('');
  const [queued, setQueued] = useState(0);
  const valueRef = useRef('');
  const queueRef = useRef(new DictationQueue());
  const startingRef = useRef(false);
  const composingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextAreaRef | null>(null);

  const isShown = bar.open && serialState === 'connected';

  const write = useCallback((text: string): void => {
    valueRef.current = text;
    setValue(text);
  }, []);

  /** Unsent chunks go back in front of whatever was dictated meanwhile. */
  const restore = useCallback(
    (unsent: string): void => {
      const rest = unsent + queueRef.current.drain();
      setQueued(0);
      if (rest.length > 0) write(rest + valueRef.current);
    },
    [write]
  );

  const pump = useCallback((): void => {
    if (startingRef.current) return;
    const text = queueRef.current.take(pasteController.isBusy());
    if (text === null) return;
    setQueued(queueRef.current.size);
    startingRef.current = true;
    pasteController
      .startFromText(text)
      .then((outcome) => {
        // not started: the controller already said why (not connected, declined…)
        if (outcome !== 'started') restore(text);
      })
      .finally(() => {
        startingRef.current = false;
      });
  }, [restore]);

  const send = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const text = valueRef.current;
    if (text.trim().length === 0) return;
    write('');
    queueRef.current.push(text);
    setQueued(queueRef.current.size);
    pump();
  }, [pump, write]);

  // the next chunk leaves when the run before it completed; any other stop keeps the rest
  useEffect(() => {
    if (run.status !== 'done') return;
    if (run.reason === undefined || run.reason === 'completed') {
      pump();
    } else {
      restore('');
    }
  }, [run, pump, restore]);

  const armAutoSend = useCallback((): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (!bar.autoSend) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!composingRef.current) send();
    }, AUTO_SEND_IDLE_MS);
  }, [bar.autoSend, send]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  // opening the bar puts the cursor in it; hiding it hands the keyboard back
  useEffect(() => {
    if (isShown) {
      inputRef.current?.focus();
    } else {
      setIsKeyboardEnable(true);
    }
  }, [isShown, setIsKeyboardEnable]);

  function update(patch: Partial<storage.DictationBarState>): void {
    const next = { ...bar, ...patch };
    setBar(next);
    storage.setDictationBar(next);
  }

  if (!isShown) return null;

  return (
    <div
      data-paste-ui=""
      className={clsx(
        'fixed left-1/2 z-[1000] flex w-[min(92vw,720px)] -translate-x-1/2 items-end space-x-2 rounded-lg bg-neutral-800/95 px-3 py-2 text-sm text-neutral-200 shadow-lg',
        isKeyboardOpen ? 'top-28' : 'bottom-20'
      )}
    >
      <MicIcon size={18} className="mb-1.5 shrink-0 text-neutral-400" />

      <Input.TextArea
        ref={inputRef}
        autoSize={{ minRows: 1, maxRows: 5 }}
        placeholder={t('paste.dictationPlaceholder')}
        value={value}
        onChange={(e) => {
          write(e.target.value);
          armAutoSend();
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          armAutoSend();
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          } else if (e.key === 'Escape') {
            e.currentTarget.blur();
          }
        }}
        onFocus={() => setIsKeyboardEnable(false)}
        onBlur={() => setIsKeyboardEnable(true)}
      />

      <div className="flex shrink-0 flex-col items-end space-y-1">
        <div className="flex items-center space-x-1">
          {queued > 0 && (
            <span className="whitespace-nowrap text-xs text-neutral-400">
              {t('paste.dictationQueued', { n: queued })}
            </span>
          )}
          <div
            className="flex size-[26px] cursor-pointer items-center justify-center rounded text-neutral-300 hover:bg-neutral-600/60 hover:text-white"
            title={t('paste.dictationSend')}
            onClick={send}
          >
            <SendIcon size={16} />
          </div>
          <div
            className="flex size-[26px] cursor-pointer items-center justify-center rounded text-neutral-400 hover:bg-neutral-600/60 hover:text-white"
            title={t('paste.dictationClose')}
            onClick={() => update({ open: false })}
          >
            <XIcon size={16} />
          </div>
        </div>
        <Checkbox
          className="whitespace-nowrap text-xs"
          checked={bar.autoSend}
          onChange={(e) => update({ autoSend: e.target.checked })}
        >
          {t('paste.dictationAuto')}
        </Checkbox>
      </div>
    </div>
  );
};
