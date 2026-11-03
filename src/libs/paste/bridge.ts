import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import {
  changedFraction,
  SCREEN_STILL_MAX,
  sentinelGone,
  sentinelPresent,
  WINDOW_CHANGE_MIN,
  type Frame,
  type FrameSampler,
  type Sentinel
} from '@/libs/media/frame-probe';
import { getTable } from '@/libs/paste/layouts';
import type { BridgeWindow } from '@/libs/paste/settings';
import { imePreStroke, tableStroke } from '@/libs/paste/text-to-keys';
import type { ImePreKey, KeyStroke, TargetLayout } from '@/libs/paste/types';
import type { ProgramStep, WaitVerdict } from '@/libs/paste/typing-engine';

/**
 * Browser bridge (spec v2 §4, §14): the target can only receive HID key
 * reports, so text without keys travels as an ASCII `data:` URL typed into
 * the target browser's address bar. The page puts the text in a textarea and
 * turns lime when its hash matches (red otherwise) and blue once it handled
 * the copy; the program watches the capture video for that, closes the window
 * and pastes the text into the field that was focused before.
 */

export const BRIDGE_URL_PREFIX = 'data:text/html;charset=utf-8;base64,';
/**
 * Typed before the payload on every run, to prove that address-bar typing
 * reaches a browser with this layout and IME. Case-sensitive on purpose: under
 * Caps Lock the attribute still paints the page red, but `DOCUMENT` is
 * undefined, so the script never turns it magenta.
 */
export const BRIDGE_PROBE_URL =
  "data:text/html,<body bgcolor=red><script>document.bgColor='magenta'</script>";

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
 * legacy colour parsing would read `0f0` as almost black. The copy handler
 * puts exactly the checked value on the clipboard and turns the page blue,
 * which proves that Ctrl+C reached the page (spec v2 §14.4). Trailing spaces
 * pad the UTF-8 length to a multiple of 3, so the base64 has no `=`.
 */
export function buildBridgeHtml(value: string): { html: string; hash: number } {
  const text = value.replace(LONE_SURROGATE, '\ufffd');
  const escaped =
    (text.startsWith('\n') ? '\n' : '') + text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const hash = bridgeHash(text);
  const html =
    `<textarea id=t autofocus>${escaped}</textarea>` +
    `<script>d=document;for(v=t.value,h=i=0;i<v.length;)h=h*31+v.charCodeAt(i++)|0;` +
    `d.bgColor=h==${hash}?'lime':'red';` +
    `oncopy=e=>{e.clipboardData.setData('text',v);e.preventDefault();d.bgColor='blue'}</script>`;
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
}

export const BRIDGE_TIMING = {
  pollMs: 100,
  /** A first readable frame before anything is sent. */
  videoTimeoutMs: 1000,
  /** Two samples this far apart must show a still screen... */
  stillIntervalMs: 300,
  /** ...within this time, or the run stops before the open-window chord. */
  stillTimeoutMs: 2500,
  windowTimeoutMs: 4000,
  windowSettleMs: 600,
  focusSettleMs: 150,
  imeSettleMs: 150,
  probeTimeoutMs: 5000,
  loadTimeoutBaseMs: 5000,
  loadTimeoutPer2kCharsMs: 1000,
  copyTimeoutMs: 1500,
  closeTimeoutMs: 3000,
  closeSettleMs: 300
} as const;

/** Typical durations of the waits, for the ETA only. */
export const BRIDGE_ESTIMATES = {
  /** The video is normally readable at once. */
  videoMs: 0,
  /** One sampling interval when the screen is still. */
  stillMs: 300,
  windowMs: 800,
  probeLoadMs: 700,
  payloadLoadMs: 800,
  copyMs: 250,
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
 * The bridge as a typing-engine program (spec v2 §4.2 as amended by §14).
 * Frames are sampled from the injected sampler inside `wait`/`run` steps; the
 * two baselines live in this closure, so build one program per run:
 * `base1` is the still screen before the window opens (the close check
 * compares with it), `base2` the opened window (the sentinel pages are
 * measured against it). Nothing is sent before the screen was seen to be
 * still, and the probe page runs on every run.
 */
export function buildBridgeProgram(url: string, deps: BridgeDeps): ProgramStep[] {
  const { sampler } = deps;
  const T = BRIDGE_TIMING;
  const E = BRIDGE_ESTIMATES;
  let base1: Frame | null = null; // the still screen before the window opens
  let base2: Frame | null = null; // the opened window: the baseline of every sentinel page
  let previous: Frame | null = null; // the still check's earlier sample

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
  /** The sentinel page painted over the window: ok, the other colour: fail. */
  const page =
    (ok: Sentinel, fail?: Sentinel) =>
    (now: Frame): WaitVerdict => {
      if (sentinelPresent(now, base2, ok)) return 'ok';
      return fail !== undefined && sentinelPresent(now, base2, fail) ? 'fail' : 'pending';
    };
  const closeWindow = (): KeyStroke => chord('KeyW', CTRL);
  const [openCode, openMod] = OPEN_WINDOW[deps.window];

  return [
    { kind: 'phase', phase: 'window' },
    {
      kind: 'wait',
      check: onScreen(() => 'ok'),
      timeoutMs: T.videoTimeoutMs,
      intervalMs: T.pollMs,
      estimateMs: E.videoMs,
      // nothing has been sent yet
      timeoutReason: 'bridge-no-video'
    },
    {
      // scrolling, video or a trackpad's momentum would pass for a new window
      kind: 'wait',
      check: onScreen((now) => {
        const before = previous;
        previous = now;
        if (before === null || changedFraction(before, now) >= SCREEN_STILL_MAX) return 'pending';
        base1 = now;
        return 'ok';
      }),
      timeoutMs: T.stillTimeoutMs,
      intervalMs: T.stillIntervalMs,
      estimateMs: E.stillMs,
      // nothing has been sent yet
      timeoutReason: 'bridge-busy-screen'
    },
    { kind: 'keys', strokes: [chord(openCode, openMod)] },
    {
      kind: 'wait',
      check: onScreen((now) =>
        base1 !== null && changedFraction(base1, now) >= WINDOW_CHANGE_MIN ? 'ok' : 'pending'
      ),
      timeoutMs: T.windowTimeoutMs,
      intervalMs: T.pollMs,
      estimateMs: E.windowMs,
      // only the open-window chord has been sent: nothing to clean up
      timeoutReason: 'bridge-no-window'
    },
    { kind: 'sleep', ms: T.windowSettleMs },
    {
      kind: 'run',
      fn: () => {
        base2 = sampler.sample();
      }
    },
    { kind: 'keys', strokes: focusAddressBar() },

    { kind: 'phase', phase: 'probe' },
    { kind: 'keys', strokes: navigate(BRIDGE_PROBE_URL) },
    {
      kind: 'wait',
      check: onScreen(page('magenta', 'red')),
      timeoutMs: T.probeTimeoutMs,
      intervalMs: T.pollMs,
      estimateMs: E.probeLoadMs,
      // no Ctrl+W on a timeout: whatever has focus now may not be our window
      timeoutReason: 'bridge-probe-failed',
      // red: our probe page loaded but its script did not run (Caps Lock, JavaScript off)
      failReason: 'bridge-probe-red',
      onFail: [closeWindow()]
    },
    { kind: 'keys', strokes: focusAddressBar() },

    { kind: 'phase', phase: 'type' },
    { kind: 'keys', strokes: navigate(url) },
    { kind: 'phase', phase: 'verify' },
    {
      kind: 'wait',
      check: onScreen(page('lime', 'red')),
      timeoutMs: T.loadTimeoutBaseMs + Math.ceil(url.length / 2000) * T.loadTimeoutPer2kCharsMs,
      intervalMs: T.pollMs,
      estimateMs: E.payloadLoadMs,
      timeoutReason: 'bridge-load-failed',
      failReason: 'bridge-verify-failed',
      // the red page is ours, so closing it is safe
      onFail: [closeWindow()]
    },

    { kind: 'phase', phase: 'copy' },
    {
      kind: 'keys',
      // Escape leaves an unedited omnibox for the page, whose textarea has autofocus
      strokes: [chord('Escape'), chord('KeyA', CTRL), chord('KeyC', CTRL)]
    },
    {
      kind: 'wait',
      check: onScreen(page('blue')),
      timeoutMs: T.copyTimeoutMs,
      intervalMs: T.pollMs,
      estimateMs: E.copyMs,
      // the page never saw the copy: the target clipboard may hold something else
      timeoutReason: 'bridge-copy-failed'
    },

    { kind: 'phase', phase: 'close' },
    { kind: 'keys', strokes: [closeWindow()] },
    {
      kind: 'wait',
      // the screen from before the window is back, not merely the page gone
      check: onScreen((now) =>
        base1 !== null &&
        sentinelGone(now, base1, 'blue') &&
        changedFraction(base1, now) < WINDOW_CHANGE_MIN
          ? 'ok'
          : 'pending'
      ),
      timeoutMs: T.closeTimeoutMs,
      intervalMs: T.pollMs,
      estimateMs: E.closeMs,
      timeoutReason: 'bridge-close-failed'
    },
    // the OS reactivates the previous window, which restores its focused field
    { kind: 'sleep', ms: T.closeSettleMs },
    { kind: 'phase', phase: 'paste' },
    { kind: 'keys', strokes: [chord('KeyV', CTRL)] }
  ];
}
