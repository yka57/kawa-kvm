import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import {
  changedFraction,
  sentinelGone,
  sentinelPresent,
  WINDOW_CHANGE_MIN,
  type Frame,
  type FrameSampler
} from '@/libs/media/frame-probe';
import { getTable } from '@/libs/paste/layouts';
import type { BridgeWindow } from '@/libs/paste/settings';
import { imePreStroke, tableStroke } from '@/libs/paste/text-to-keys';
import type { ImePreKey, KeyStroke, TargetLayout } from '@/libs/paste/types';
import type { ProgramStep, WaitVerdict } from '@/libs/paste/typing-engine';

/**
 * Browser bridge (spec v2 §4): the target can only receive HID key reports,
 * so text without keys travels as an ASCII `data:` URL typed into the target
 * browser's address bar. The page puts the text in a textarea and turns lime
 * when its hash matches (red otherwise); the program watches the capture
 * video for that, copies the text, closes the window and pastes it into the
 * field that was focused before.
 */

export const BRIDGE_URL_PREFIX = 'data:text/html;charset=utf-8;base64,';
/** Typed first to prove that address-bar typing works with this layout and IME. */
export const BRIDGE_PROBE_URL = 'data:text/html,<body bgcolor=magenta>';

/** Java's String.hashCode over UTF-16 units: what the page script computes. */
export function bridgeHash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return h;
}

/** A lone surrogate cannot travel in UTF-8: the page decodes it as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * The bridge page for `value` (prepared text: LF only, no controls but tab
 * and newline). `&` and `<` are escaped so neither a character reference nor
 * `</textarea>` ends the RCDATA early; a leading newline is doubled because
 * the parser drops the first one after `<textarea>`. Colours are names:
 * legacy colour parsing would read `0f0` as almost black. Trailing spaces
 * pad the UTF-8 length to a multiple of 3, so the base64 has no `=`.
 */
export function buildBridgeHtml(value: string): { html: string; hash: number } {
  const text = value.replace(LONE_SURROGATE, '\ufffd');
  const escaped =
    (text.startsWith('\n') ? '\n' : '') + text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const hash = bridgeHash(text);
  const html =
    `<textarea id=t autofocus>${escaped}</textarea>` +
    `<script>for(v=t.value,h=i=0;i<v.length;)h=h*31+v.charCodeAt(i++)|0;` +
    `document.bgColor=h==${hash}?'lime':'red'</script>`;
  const padding = (3 - (new TextEncoder().encode(html).length % 3)) % 3;
  return { html: html + ' '.repeat(padding), hash };
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 of the UTF-8 bytes, without line breaks (also correct for lengths not padded to 3). */
export function utf8Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const rest = bytes.length - i;
    const n =
      (bytes[i] << 16) | ((rest > 1 ? bytes[i + 1] : 0) << 8) | (rest > 2 ? bytes[i + 2] : 0);
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63];
    out += rest > 1 ? BASE64[(n >> 6) & 63] : '=';
    out += rest > 2 ? BASE64[n & 63] : '=';
  }
  return out;
}

export function buildBridgeUrl(value: string): string {
  return BRIDGE_URL_PREFIX + utf8Base64(buildBridgeHtml(value).html);
}

export interface BridgeDeps {
  sampler: FrameSampler;
  layout: TargetLayout;
  /** Resolved; 'none' sends nothing. */
  imeOff: ImePreKey;
  window: BridgeWindow;
  /** Type the probe page first (the controller skips it once a probe succeeded, §9.3). */
  probe: boolean;
  /** The probe page appeared: the controller caches the success. */
  onProbeOk(): void;
}

export const BRIDGE_TIMING = {
  pollMs: 100,
  windowTimeoutMs: 4000,
  windowSettleMs: 600,
  focusSettleMs: 150,
  imeSettleMs: 150,
  probeTimeoutMs: 5000,
  loadTimeoutBaseMs: 5000,
  loadTimeoutPer2kCharsMs: 1000,
  copySettleMs: 250,
  closeTimeoutMs: 3000,
  closeSettleMs: 300
} as const;

/** Typical durations of the waits, for the ETA only. */
export const BRIDGE_ESTIMATES = {
  windowMs: 800,
  probeLoadMs: 700,
  payloadLoadMs: 800,
  closeMs: 500
} as const;

const CTRL = ModifierBits.LeftCtrl;
const SHIFT = ModifierBits.LeftShift;

/** One report with modifier + key, then the all-zero release (never a modifier-only report). */
function chord(code: string, mod = 0, afterMs?: number): KeyStroke {
  const stroke: KeyStroke = { mod, key: KeycodeMap[code], src: -1, tag: 'chord' };
  if (afterMs !== undefined) stroke.afterMs = afterMs;
  return stroke;
}

const OPEN_WINDOW: Record<BridgeWindow, [code: string, mod: number]> = {
  'chromium-private': ['KeyN', CTRL | SHIFT],
  'firefox-private': ['KeyP', CTRL | SHIFT],
  'new-window': ['KeyN', CTRL]
};

/** Every character of a URL we build has a key in both layouts; a miss is a programming error. */
function urlStrokes(url: string, layout: TargetLayout): KeyStroke[] {
  const table = getTable(layout);
  return Array.from(url, (char) => {
    const stroke = tableStroke(table, char, -1);
    if (stroke === null)
      throw new Error(`bridge URL character without a key: ${JSON.stringify(char)}`);
    return stroke;
  });
}

/**
 * The bridge as a typing-engine program (spec v2 §4.2). Frames are sampled
 * from the injected sampler inside `run`/`wait` steps; the two baselines live
 * in this closure, so build one program per run.
 */
export function buildBridgeProgram(url: string, deps: BridgeDeps): ProgramStep[] {
  const { sampler } = deps;
  const T = BRIDGE_TIMING;
  let screenBefore: Frame | null = null; // before the window opens
  let newWindow: Frame | null = null; // the opened window: the baseline of every sentinel

  const imeOff = imePreStroke(deps.imeOff, T.imeSettleMs);
  // Ctrl+L also works when Edge's new-tab page routes typing to its own search box
  const focusAddressBar = (): KeyStroke[] => [
    chord('KeyL', CTRL, T.focusSettleMs),
    ...(imeOff ? [imeOff] : [])
  ];
  // Delete drops an inline autocompletion behind the cursor before Enter
  const navigate = (target: string): KeyStroke[] => [
    ...urlStrokes(target, deps.layout),
    chord('Delete'),
    chord('Enter')
  ];
  const onScreen = (verdict: (now: Frame) => WaitVerdict) => (): WaitVerdict => {
    const now = sampler.sample();
    return now === null ? 'pending' : verdict(now);
  };
  const [openCode, openMod] = OPEN_WINDOW[deps.window];

  const steps: ProgramStep[] = [
    { kind: 'phase', phase: 'window' },
    {
      kind: 'run',
      fn: () => {
        screenBefore = sampler.sample();
      }
    },
    { kind: 'keys', strokes: [chord(openCode, openMod)] },
    {
      kind: 'wait',
      check: onScreen((now) =>
        screenBefore !== null && changedFraction(screenBefore, now) >= WINDOW_CHANGE_MIN
          ? 'ok'
          : 'pending'
      ),
      timeoutMs: T.windowTimeoutMs,
      intervalMs: T.pollMs,
      estimateMs: BRIDGE_ESTIMATES.windowMs,
      // only the open-window chord has been sent: nothing to clean up
      timeoutReason: 'bridge-no-window'
    },
    { kind: 'sleep', ms: T.windowSettleMs },
    {
      kind: 'run',
      fn: () => {
        newWindow = sampler.sample();
      }
    },
    { kind: 'keys', strokes: focusAddressBar() }
  ];

  if (deps.probe) {
    steps.push(
      { kind: 'phase', phase: 'probe' },
      { kind: 'keys', strokes: navigate(BRIDGE_PROBE_URL) },
      {
        kind: 'wait',
        check: onScreen((now) => (sentinelPresent(now, newWindow, 'magenta') ? 'ok' : 'pending')),
        timeoutMs: T.probeTimeoutMs,
        intervalMs: T.pollMs,
        estimateMs: BRIDGE_ESTIMATES.probeLoadMs,
        // no Ctrl+W: whatever has focus now may not be our window
        timeoutReason: 'bridge-probe-failed'
      },
      { kind: 'run', fn: () => deps.onProbeOk() },
      { kind: 'keys', strokes: focusAddressBar() }
    );
  }

  steps.push(
    { kind: 'phase', phase: 'type' },
    { kind: 'keys', strokes: navigate(url) },
    { kind: 'phase', phase: 'verify' },
    {
      kind: 'wait',
      check: onScreen((now) => {
        if (sentinelPresent(now, newWindow, 'lime')) return 'ok';
        return sentinelPresent(now, newWindow, 'red') ? 'fail' : 'pending';
      }),
      timeoutMs: T.loadTimeoutBaseMs + Math.ceil(url.length / 2000) * T.loadTimeoutPer2kCharsMs,
      intervalMs: T.pollMs,
      estimateMs: BRIDGE_ESTIMATES.payloadLoadMs,
      timeoutReason: 'bridge-load-failed',
      failReason: 'bridge-verify-failed',
      // the red page is ours, so closing it is safe
      onFail: [chord('KeyW', CTRL)]
    },
    { kind: 'phase', phase: 'copy' },
    {
      kind: 'keys',
      // Escape leaves an unedited omnibox for the page, whose textarea has autofocus
      strokes: [chord('Escape'), chord('KeyA', CTRL), chord('KeyC', CTRL, T.copySettleMs)]
    },
    { kind: 'phase', phase: 'close' },
    { kind: 'keys', strokes: [chord('KeyW', CTRL)] },
    {
      kind: 'wait',
      check: onScreen((now) => (sentinelGone(now, newWindow, 'lime') ? 'ok' : 'pending')),
      timeoutMs: T.closeTimeoutMs,
      intervalMs: T.pollMs,
      estimateMs: BRIDGE_ESTIMATES.closeMs,
      timeoutReason: 'bridge-close-failed'
    },
    // the OS reactivates the previous window, which restores its focused field
    { kind: 'sleep', ms: T.closeSettleMs },
    { kind: 'phase', phase: 'paste' },
    { kind: 'keys', strokes: [chord('KeyV', CTRL)] }
  );
  return steps;
}
