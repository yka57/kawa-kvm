import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from 'antd';
import clsx from 'clsx';
import { XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DEBUG_HID_EVENT,
  formatHex,
  hasDebugHidQuery,
  HID_LOG_CAPACITY,
  hidLog,
  type HidLogEntry
} from '@/libs/debug/hid-log';
import * as storage from '@/libs/storage';

/** Rows shown; the buffer keeps HID_LOG_CAPACITY entries and Copy exports all of them. */
const ROWS = 12;
const COPIED_FEEDBACK_MS = 1500;

const subscribe = (listener: () => void): (() => void) => hidLog.subscribe(listener);
const getVersion = (): number => hidLog.version;

/** Storage flag (set by the Key-test modal link) or `?debug=hid` in the URL. */
function isRequested(): boolean {
  return storage.getDebugHid() || hasDebugHidQuery(window.location.search);
}

/**
 * HID log overlay (spec §6.2): the last reports handed to the device,
 * decoded, with the time since the previous one. Mounted once in App.tsx;
 * shown when the storage flag or `?debug=hid` asks for it, and as soon as
 * the Key-test modal switches the flag on. Closing clears the flag (a
 * `?debug=hid` URL shows it again on the next load).
 */
export const HidLogOverlay = () => {
  const [visible, setVisible] = useState(isRequested);

  useEffect(() => {
    function show(): void {
      setVisible(true);
    }

    window.addEventListener(DEBUG_HID_EVENT, show);

    return () => {
      window.removeEventListener(DEBUG_HID_EVENT, show);
    };
  }, []);

  function close(): void {
    storage.setDebugHid(false);
    setVisible(false);
  }

  if (!visible) return null;

  return <HidLogPanel onClose={close} />;
};

interface PanelProps {
  onClose: () => void;
}

const HidLogPanel = ({ onClose }: PanelProps) => {
  const { t } = useTranslation();
  // re-render on every change of the log; the snapshot is its revision counter
  useSyncExternalStore(subscribe, getVersion);

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  function copy(): void {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;

    clipboard.writeText(hidLog.toText()).then(
      () => setCopied(true),
      (error: unknown) => console.warn('[hid-log] copy failed', error)
    );
  }

  const rows = hidLog.last(ROWS);

  return (
    // data-paste-ui: clicks in here never interrupt a running paste
    <div
      data-paste-ui=""
      className="fixed bottom-2 left-2 z-[1001] w-[min(96vw,640px)] select-text rounded border border-neutral-700 bg-neutral-900/90 font-mono text-[11px] leading-4 text-neutral-200 shadow-lg"
    >
      <div className="flex items-center justify-between border-b border-neutral-700 px-2 py-1">
        <span className="text-neutral-400">
          {t('debug.hidLog')} · {hidLog.size}/{HID_LOG_CAPACITY}
          {hidLog.failures > 0 && <span className="text-red-400"> · !{hidLog.failures}</span>}
        </span>

        <div className="flex items-center space-x-1">
          <Button size="small" onClick={copy}>
            {copied ? '✓' : t('debug.copy')}
          </Button>
          <Button size="small" onClick={() => hidLog.clear()}>
            {t('debug.clear')}
          </Button>
          <div
            className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded text-neutral-400 hover:bg-neutral-700 hover:text-white"
            onClick={onClose}
          >
            <XIcon size={14} />
          </div>
        </div>
      </div>

      <div className="flex h-48 flex-col justify-end overflow-hidden px-2 py-1">
        {rows.map((entry) => (
          <Row key={entry.seq} entry={entry} />
        ))}
      </div>
    </div>
  );
};

/** `+Δt  kind  hex bytes  decoded`; a failed write is red with the error as tooltip. */
const Row = ({ entry }: { entry: HidLogEntry }) => (
  <div
    className={clsx(
      'flex items-baseline space-x-2 whitespace-nowrap',
      entry.error && 'text-red-400'
    )}
    title={entry.error}
  >
    <span className="w-14 shrink-0 text-right text-neutral-500">+{Math.round(entry.dt)}</span>
    <span className="w-7 shrink-0 text-neutral-400">{entry.kind}</span>
    <span className="w-[23ch] shrink-0 text-neutral-300">{formatHex(entry.bytes)}</span>
    <span className="min-w-0 truncate">{entry.decoded}</span>
  </div>
);
