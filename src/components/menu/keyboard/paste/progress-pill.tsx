import { useEffect, useRef, useState } from 'react';
import { Button, message, Modal } from 'antd';
import clsx from 'clsx';
import { useAtomValue, useStore } from 'jotai';
import { Loader2Icon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { isKeyboardEnableAtom, isKeyboardOpenAtom } from '@/jotai/keyboard.ts';
import { pasteRunAtom } from '@/jotai/paste.ts';

import { pasteController, type PasteUi } from './controller.ts';
import {
  countSkipped,
  formatSkippedChars,
  PILL_AUTO_HIDE_MS,
  reasonKey,
  showPill
} from './decide.ts';

/**
 * Progress pill of a paste run (spec §5.4), mounted once in App.tsx. It also
 * hosts the toast/confirm context the controller uses, since it is the one
 * paste component that is always mounted.
 */
export const PasteProgressPill = () => {
  const { t } = useTranslation();
  const store = useStore();
  const run = useAtomValue(pasteRunAtom);
  const isKeyboardOpen = useAtomValue(isKeyboardOpenAtom);
  const [messageApi, messageHolder] = message.useMessage();
  const [modalApi, modalHolder] = Modal.useModal();

  const [visible, setVisible] = useState(false);
  // the visibility rule is evaluated once per run, at its start
  const evaluated = useRef(false);

  // UI bridge for the controller
  useEffect(() => {
    const ui: PasteUi = {
      notify(notice, params) {
        messageApi.open({
          key: `paste-${notice}`,
          type: notice === 'truncated' ? 'info' : 'warning',
          content: t(`paste.${notice}`, params),
          duration: 4
        });
      },
      confirmLarge(count, seconds) {
        // keyboard capture off while the dialog is up (like the shortcut
        // recorder), so Enter/Esc answer the dialog instead of reaching the target
        const wasEnabled = store.get(isKeyboardEnableAtom);
        store.set(isKeyboardEnableAtom, false);
        return new Promise<boolean>((resolve) => {
          modalApi.confirm({
            title: t('paste.title'),
            content: t('paste.confirmLarge', { count, seconds }),
            onOk: () => resolve(true),
            onCancel: () => resolve(false)
          });
        }).finally(() => {
          store.set(isKeyboardEnableAtom, wasEnabled);
        });
      }
    };

    return pasteController.setUi(ui);
  }, [t, messageApi, modalApi, store]);

  const skippedCount = countSkipped(run.skipped);

  useEffect(() => {
    if (run.status === 'idle') {
      evaluated.current = false;
      setVisible(false);
      return;
    }
    if (run.status === 'running') {
      if (!evaluated.current) {
        evaluated.current = true;
        setVisible(showPill(run.etaMs, skippedCount));
      }
      return;
    }
    // done: stays if it was showing, appears for skipped characters or an early stop
    evaluated.current = false;
    setVisible((shown) => shown || showPill(0, skippedCount, run.reason));
  }, [run, skippedCount]);

  // auto-hide after a clean completion
  useEffect(() => {
    if (run.status !== 'done' || run.reason !== 'completed' || skippedCount > 0) return;

    const timer = setTimeout(() => pasteController.dismissResult(), PILL_AUTO_HIDE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [run, skippedCount]);

  const holders = (
    <>
      {messageHolder}
      {modalHolder}
    </>
  );

  if (!visible || run.status === 'idle') {
    return holders;
  }

  const percent = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;
  const skippedChars = run.skipped ? formatSkippedChars(run.skipped) : '';

  return (
    <>
      {holders}

      <div
        data-paste-ui=""
        className={clsx(
          'fixed left-1/2 z-[1001] flex max-w-[min(90vw,640px)] -translate-x-1/2 items-center space-x-3 rounded-lg bg-neutral-800/95 px-4 py-2 text-sm text-neutral-200 shadow-lg',
          // bottom-centre, except under the menu bar while the virtual keyboard
          // drawer (fixed bottom, z-[999]) would be covered by it
          isKeyboardOpen ? 'top-16' : 'bottom-6'
        )}
      >
        {run.status === 'running' ? (
          <>
            <Loader2Icon size={16} className="shrink-0 animate-spin" />
            <span className="whitespace-nowrap">
              {t('paste.progress', {
                done: run.done,
                total: run.total,
                eta: Math.ceil(run.etaMs / 1000)
              })}
            </span>
            <div className="h-1 w-24 shrink-0 overflow-hidden rounded bg-neutral-600">
              <div className="h-full bg-blue-500" style={{ width: `${percent}%` }} />
            </div>
            {skippedCount > 0 && (
              <span className="whitespace-nowrap text-xs text-amber-300">
                {t('paste.skipped', { count: skippedCount })}
              </span>
            )}
            <Button size="small" onClick={() => pasteController.cancel()}>
              {t('paste.cancel')}
            </Button>
          </>
        ) : (
          <>
            <div className="flex min-w-0 flex-col">
              <span>{t(reasonKey(run.reason ?? 'completed'))}</span>
              {skippedCount > 0 && (
                <>
                  <span className="text-xs text-amber-300">
                    {t('paste.skipped', { count: skippedCount })}
                  </span>
                  <span className="break-all text-xs text-neutral-400">
                    {t('paste.skippedList', { chars: skippedChars })}
                  </span>
                </>
              )}
            </div>
            <div
              className="flex h-[20px] w-[20px] shrink-0 cursor-pointer items-center justify-center rounded text-neutral-400 hover:bg-neutral-700 hover:text-white"
              onClick={() => pasteController.dismissResult()}
            >
              <XIcon size={16} />
            </div>
          </>
        )}
      </div>
    </>
  );
};
