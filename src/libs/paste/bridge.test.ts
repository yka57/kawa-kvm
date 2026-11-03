import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HidLock } from '@/libs/keyboard/hid-lock';
import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import {
  sentinelFraction,
  sentinelGone,
  type Frame,
  type FrameSampler
} from '@/libs/media/frame-probe';
import { FakeClock, FakeSink, flushMicrotasks } from '@/test/fakes';

import {
  BRIDGE_ESTIMATES,
  BRIDGE_PROBE_URL,
  BRIDGE_TIMING,
  BRIDGE_URL_PREFIX,
  bridgeHash,
  buildBridgeHtml,
  buildBridgeProgram,
  buildBridgeUrl,
  utf8Base64,
  type BridgeDeps
} from './bridge';
import { getTable } from './layouts';
import type { TargetLayout } from './types';
import {
  estimateProgramMs,
  TypingEngine,
  type EngineEvent,
  type Pacing,
  type ProgramStep,
  type WaitStep
} from './typing-engine';

// Node's Buffer as the reference codec (the app's tsconfig carries no Node types)
const { Buffer } = globalThis as unknown as {
  Buffer: {
    from(input: string, encoding?: 'utf8' | 'base64'): { toString(encoding: string): string };
  };
};

const CTRL = ModifierBits.LeftCtrl;
const SHIFT = ModifierBits.LeftShift;
const LAYOUTS: TargetLayout[] = ['us', 'jis'];

const SAMPLES = [
  '',
  'hello',
  'こんにちは、世界！',
  '𠮷野家の\u{20bb7}',
  '\u{1f468}\u200d\u{1f469}\u200d\u{1f467} family',
  'a</textarea><script>alert(1)</script>',
  'x</TEXTAREA >y',
  '&amp; &lt; &#x41; &copy &',
  '\nleading newline',
  '\n\ntwo leading newlines',
  'trailing newline\n',
  'tabs\tand\nlines\n\n',
  'e\u0301 \ufa10 \ufeff',
  'あ'.repeat(5000)
];

interface CopyEvent {
  clipboardData: { setData(type: string, data: string): void };
  preventDefault(): void;
}

/** The text between `<script>` and `</script>`. */
function scriptOf(html: string): string {
  return html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
}

/**
 * What the target browser does with a bridge URL: base64 → UTF-8 → HTML.
 * The textarea's RCDATA ends at the first `</textarea>`, `&amp;`/`&lt;` are
 * decoded and the newline right after the start tag is dropped; then the
 * page script runs against stubs of `t` and `document`. `oncopy` is the copy
 * handler the script installed on the window.
 */
function openPage(url: string, tamper?: (value: string) => string) {
  expect(url.startsWith(BRIDGE_URL_PREFIX)).toBe(true);
  const html = Buffer.from(url.slice(BRIDGE_URL_PREFIX.length), 'base64').toString('utf8');
  const open = '<textarea id=t autofocus>';
  expect(html.startsWith(open)).toBe(true);
  const raw = html.slice(open.length, html.indexOf('</textarea>'));
  let value = raw.replace(/&(amp|lt);/g, (_, name: string) => (name === 'amp' ? '&' : '<'));
  if (value.startsWith('\n')) value = value.slice(1);
  if (tamper) value = tamper(value);

  const document: { bgColor?: string } = {};
  // d, v, h, i and oncopy are the script's implicit globals: parameters keep them out of globalThis
  const run = new Function(
    't',
    'document',
    'd',
    'v',
    'h',
    'i',
    'oncopy',
    `${scriptOf(html)}\nreturn oncopy`
  );
  const oncopy = run({ value }, document) as ((event: CopyEvent) => void) | undefined;
  return { html, value, bgColor: document.bgColor, document, oncopy };
}

/** The probe page as the browser renders it: the body's colour attribute, then its script. */
function openProbe(url: string): { color: string; error?: unknown } {
  const comma = url.indexOf(',');
  expect(url.slice(0, comma).toLowerCase()).toBe('data:text/html');
  const html = url.slice(comma + 1);
  const attribute = /<body bgcolor=([a-z]+)>/i.exec(html);
  expect(attribute).not.toBeNull();
  const document = { bgColor: attribute![1] };
  // tag names are case-insensitive: the script runs whatever the case of its tags
  const script = scriptOf(html.replace(/<(\/?)script>/gi, '<$1script>'));
  try {
    new Function('document', script)(document);
  } catch (error) {
    // colour keywords are case-insensitive; the script, unlike the markup, is not
    return { color: document.bgColor.toLowerCase(), error };
  }
  return { color: document.bgColor.toLowerCase() };
}

/** What Caps Lock does to typed letters. */
function swapCase(text: string): string {
  return text.replace(/[a-z]/gi, (c) =>
    c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()
  );
}

describe('bridge payload', () => {
  it('bridgeHash is the 32-bit 31-polynomial over UTF-16 units', () => {
    expect(bridgeHash('')).toBe(0);
    expect(bridgeHash('a')).toBe(97);
    expect(bridgeHash('ab')).toBe(97 * 31 + 98);
    expect(bridgeHash('hello')).toBe(99162322); // Java "hello".hashCode()
    expect(bridgeHash('\u{20bb7}')).toBe(0xd842 * 31 + 0xdfb7);
    const long = bridgeHash('あ'.repeat(5000));
    expect(Number.isInteger(long) && long >= -(2 ** 31) && long < 2 ** 31).toBe(true);
  });

  it.each(SAMPLES.map((text) => [JSON.stringify(text.slice(0, 40)), text]))(
    'the page script agrees with bridgeHash and the textarea round-trips: %s',
    (_, text) => {
      const page = openPage(buildBridgeUrl(text));
      expect(page.value).toBe(text);
      expect(page.bgColor).toBe('lime');
      expect(buildBridgeHtml(text).hash).toBe(bridgeHash(text));
      expect(openPage(buildBridgeUrl(text), (v) => `${v}x`).bgColor).toBe('red');
    }
  );

  it.each(SAMPLES.slice(0, -1).map((text) => [JSON.stringify(text.slice(0, 40)), text]))(
    'the copy handler copies exactly the checked value and turns the page blue: %s',
    (_, text) => {
      const page = openPage(buildBridgeUrl(text));
      expect(page.bgColor).toBe('lime');
      const setData = vi.fn();
      const preventDefault = vi.fn();
      page.oncopy!({ clipboardData: { setData }, preventDefault });
      expect(setData).toHaveBeenCalledWith('text', text);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(page.document.bgColor).toBe('blue');
    }
  );

  it('the probe page turns magenta only when typed in the right case (Caps Lock leaves it red)', () => {
    expect(openProbe(BRIDGE_PROBE_URL)).toEqual({ color: 'magenta' });
    const capsLock = openProbe(swapCase(BRIDGE_PROBE_URL));
    expect(capsLock.color).toBe('red');
    expect(capsLock.error).toBeInstanceOf(ReferenceError); // DOCUMENT is not defined
  });

  it('a lone surrogate travels as U+FFFD and the hashes still agree', () => {
    for (const text of ['lone \ud800 high', '\udc00 low first', 'end\ud83d']) {
      const page = openPage(buildBridgeUrl(text));
      expect(page.value).toBe(text.replace(/[\ud800-\udfff]/g, '\ufffd'));
      expect(page.bgColor).toBe('lime');
    }
  });

  it('escapes & and < so neither a reference nor </textarea> can end the text early', () => {
    const { html } = buildBridgeHtml('a<b&c</textarea>d');
    expect(html).toContain(
      '<textarea id=t autofocus>a&lt;b&amp;c&lt;/textarea>d</textarea><script>'
    );
    expect(html.match(/<\/textarea>/g)).toHaveLength(1);
  });

  it('doubles a leading newline, which the parser drops after <textarea>', () => {
    expect(
      buildBridgeHtml('\nx').html.startsWith('<textarea id=t autofocus>\n\nx</textarea>')
    ).toBe(true);
    expect(buildBridgeHtml('x\n').html.startsWith('<textarea id=t autofocus>x\n</textarea>')).toBe(
      true
    );
  });

  it('is exactly the specified page, padded with spaces to a multiple of 3 UTF-8 bytes', () => {
    const { html, hash } = buildBridgeHtml('hi');
    expect(html.trimEnd()).toBe(
      `<textarea id=t autofocus>hi</textarea><script>d=document;for(v=t.value,h=i=0;i<v.length;)h=h*31+v.charCodeAt(i++)|0;d.bgColor=h==${hash}?'lime':'red';oncopy=e=>{e.clipboardData.setData('text',v);e.preventDefault();d.bgColor='blue'}</script>`
    );
    expect(BRIDGE_PROBE_URL).toBe(
      "data:text/html,<body bgcolor=red><script>document.bgColor='magenta'</script>"
    );
    for (const text of SAMPLES) {
      const page = buildBridgeHtml(text).html;
      const padding = page.length - page.trimEnd().length;
      expect(padding).toBeLessThanOrEqual(2);
      expect(new TextEncoder().encode(page).length % 3).toBe(0);
    }
  });

  it('utf8Base64 equals Buffer.from(s).toString("base64")', () => {
    for (const text of [...SAMPLES, 'a', 'ab', 'abc', 'abcd', 'é', '€', '\u{1f600}']) {
      expect(utf8Base64(text)).toBe(Buffer.from(text).toString('base64'));
    }
  });

  it('builds URLs without padding whose every character has a key on US and JIS', () => {
    for (const text of SAMPLES) {
      const url = buildBridgeUrl(text);
      expect(url.slice(BRIDGE_URL_PREFIX.length)).toMatch(/^[A-Za-z0-9+/]*$/);
      for (const layout of LAYOUTS) {
        const table = getTable(layout);
        for (const char of url + BRIDGE_PROBE_URL) {
          expect(table[char], `${layout} ${JSON.stringify(char)}`).toBeDefined();
        }
      }
    }
  });
});

const sampler: FrameSampler = { sample: () => null, available: () => true };

function deps(over: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    sampler,
    layout: 'us',
    imeOff: 'Lang2',
    window: 'chromium-private',
    ...over
  };
}

const outline = (steps: ProgramStep[]) =>
  steps.map((step) => (step.kind === 'phase' ? `phase:${step.phase}` : step.kind));
const waits = (steps: ProgramStep[]) =>
  steps.filter((step): step is WaitStep => step.kind === 'wait');
const keySteps = (steps: ProgramStep[]) =>
  steps.flatMap((step) => (step.kind === 'keys' ? [step.strokes] : []));

const CTRL_W = { mod: CTRL, key: KeycodeMap.KeyW, src: -1, tag: 'chord' };

describe('buildBridgeProgram', () => {
  it('has the specified structure: still screen first, the probe on every run', () => {
    expect(outline(buildBridgeProgram(buildBridgeUrl('あ'), deps()))).toEqual([
      'phase:window',
      'wait', // a readable frame
      'wait', // a still screen (base1)
      'keys', // open the window
      'wait', // the window appeared
      'sleep',
      'run', // base2
      'keys', // Ctrl+L, IME off
      'phase:probe',
      'keys',
      'wait',
      'keys', // Ctrl+L, IME off
      'phase:type',
      'keys',
      'phase:verify',
      'wait',
      'phase:copy',
      'keys',
      'wait', // the page saw the copy
      'phase:close',
      'keys',
      'wait', // the screen before the window is back
      'sleep',
      'phase:paste',
      'keys'
    ]);
  });

  it('opens the configured window with one chord report', () => {
    const open = (window: BridgeDeps['window']) =>
      keySteps(buildBridgeProgram(buildBridgeUrl('あ'), deps({ window })))[0];
    expect(open('chromium-private')).toEqual([
      { mod: CTRL | SHIFT, key: KeycodeMap.KeyN, src: -1, tag: 'chord' }
    ]);
    expect(open('firefox-private')).toEqual([
      { mod: CTRL | SHIFT, key: KeycodeMap.KeyP, src: -1, tag: 'chord' }
    ]);
    expect(open('new-window')).toEqual([
      { mod: CTRL, key: KeycodeMap.KeyN, src: -1, tag: 'chord' }
    ]);
  });

  it('focuses the address bar, then sends the resolved IME-off key with its settle time', () => {
    const focus = (imeOff: BridgeDeps['imeOff']) =>
      keySteps(buildBridgeProgram(buildBridgeUrl('あ'), deps({ imeOff })))[1];
    const ctrlL = { mod: CTRL, key: KeycodeMap.KeyL, src: -1, tag: 'chord', afterMs: 150 };
    const ime = (key: number) => ({ mod: 0, key, src: -1, tag: 'ime-pre', afterMs: 150 });
    expect(focus('Lang2')).toEqual([ctrlL, ime(0x91)]);
    expect(focus('NonConvert')).toEqual([ctrlL, ime(0x8b)]);
    expect(focus('none')).toEqual([ctrlL]);
    expect(BRIDGE_TIMING.focusSettleMs).toBe(150);
    expect(BRIDGE_TIMING.imeSettleMs).toBe(150);
  });

  it('waits with the specified timeouts, intervals, reasons and estimates', () => {
    const shortUrl = buildBridgeUrl('あ');
    const [video, still, windowWait, probe, verify, copy, close] = waits(
      buildBridgeProgram(shortUrl, deps())
    );
    expect(video).toMatchObject({
      timeoutMs: 1000,
      intervalMs: 100,
      estimateMs: BRIDGE_ESTIMATES.videoMs,
      timeoutReason: 'bridge-no-video'
    });
    expect(still).toMatchObject({
      timeoutMs: 2500,
      intervalMs: 300,
      estimateMs: BRIDGE_ESTIMATES.stillMs,
      timeoutReason: 'bridge-busy-screen'
    });
    expect(windowWait).toMatchObject({
      timeoutMs: 4000,
      intervalMs: 100,
      estimateMs: BRIDGE_ESTIMATES.windowMs,
      timeoutReason: 'bridge-no-window'
    });
    expect(probe).toMatchObject({
      timeoutMs: 5000,
      estimateMs: BRIDGE_ESTIMATES.probeLoadMs,
      timeoutReason: 'bridge-probe-failed',
      failReason: 'bridge-probe-red',
      onFail: [CTRL_W]
    });
    expect(verify).toMatchObject({
      timeoutMs: 5000 + 1000,
      estimateMs: BRIDGE_ESTIMATES.payloadLoadMs,
      timeoutReason: 'bridge-load-failed',
      failReason: 'bridge-verify-failed',
      onFail: [CTRL_W]
    });
    expect(copy).toMatchObject({
      timeoutMs: 1500,
      estimateMs: BRIDGE_ESTIMATES.copyMs,
      timeoutReason: 'bridge-copy-failed'
    });
    expect(close).toMatchObject({
      timeoutMs: 3000,
      estimateMs: BRIDGE_ESTIMATES.closeMs,
      timeoutReason: 'bridge-close-failed'
    });
    // only the red pages are ours to close; a copy or close failure never sends more keys
    for (const wait of [video, still, windowWait, copy, close]) {
      expect(wait.onFail).toBeUndefined();
      expect(wait.failReason).toBeUndefined();
    }

    // about 9 KB of UTF-8 → a URL of 12 001–14 000 characters: 7 × 1 s on top of the base
    const longUrl = buildBridgeUrl('あ'.repeat(3000));
    expect(Math.ceil(longUrl.length / 2000)).toBe(7);
    expect(waits(buildBridgeProgram(longUrl, deps()))[4].timeoutMs).toBe(5000 + 7 * 1000);
  });

  it('types the URLs with the layout table, then Delete and Enter', () => {
    const url = buildBridgeUrl('あ');
    for (const layout of LAYOUTS) {
      const [, , probe, , type] = keySteps(buildBridgeProgram(url, deps({ layout })));
      const table = getTable(layout);
      const typed = (strokes: typeof probe, text: string) => {
        expect(strokes).toHaveLength(text.length + 2);
        Array.from(text).forEach((char, i) => {
          const combo = table[char];
          expect(strokes[i]).toEqual({
            mod: combo.shift ? SHIFT : 0,
            key: KeycodeMap[combo.key],
            src: -1,
            tag: 'char'
          });
        });
        expect(strokes.slice(-2).map((s) => s.key)).toEqual([KeycodeMap.Delete, KeycodeMap.Enter]);
      };
      typed(probe, BRIDGE_PROBE_URL);
      typed(type, url);
    }
    // ':' sits on different keys
    const usColon = keySteps(buildBridgeProgram(url, deps({ layout: 'us' })))[2][4];
    const jisColon = keySteps(buildBridgeProgram(url, deps({ layout: 'jis' })))[2][4];
    expect(usColon).toMatchObject({ mod: SHIFT, key: KeycodeMap.Semicolon });
    expect(jisColon).toMatchObject({ mod: 0, key: KeycodeMap.Quote });
  });

  it('copies with Escape, Ctrl+A, Ctrl+C, closes with Ctrl+W, pastes with Ctrl+V', () => {
    const strokes = keySteps(buildBridgeProgram(buildBridgeUrl('あ'), deps()));
    expect(strokes.slice(-3)).toEqual([
      [
        { mod: 0, key: KeycodeMap.Escape, src: -1, tag: 'chord' },
        { mod: CTRL, key: KeycodeMap.KeyA, src: -1, tag: 'chord' },
        // no settle time: the copy wait watches for the page's blue instead
        { mod: CTRL, key: KeycodeMap.KeyC, src: -1, tag: 'chord' }
      ],
      [CTRL_W],
      [{ mod: CTRL, key: KeycodeMap.KeyV, src: -1, tag: 'chord' }]
    ]);
    // no report ever carries a modifier without a key
    expect(strokes.flat().every((s) => s.key !== 0)).toBe(true);
  });

  it('estimates the run from its strokes, sleeps and wait estimates', () => {
    const still: Pacing = { holdMs: 0, gapMs: 0, afterEnterMs: 0 };
    // settles: Ctrl+L and IME off twice; sleeps 600 + 300; waits: video 0, still 300,
    // window 800, probe 700, payload 800, copy 250, close 500
    expect(estimateProgramMs(buildBridgeProgram(buildBridgeUrl('あ'), deps()), still)).toBe(
      4 * 150 + 900 + 0 + 300 + 800 + 700 + 800 + 250 + 500
    );
  });

  it('refuses a URL character without a key (programming error)', () => {
    expect(() => buildBridgeProgram('data:あ', deps())).toThrow('without a key');
  });
});

// ---------------------------------------------------------------------------
// Scripted runs: a fake target screen reacts to the keys the engine sends.
// ---------------------------------------------------------------------------

type Screen = 'desktop' | 'window' | 'magenta' | 'lime' | 'red' | 'blue';
type Rgb = [number, number, number];

/** A 96×54 frame: the top `chrome` rows `top` (window frame and address bar), the rest `color`. */
function screen(color: Rgb, chrome = 0, top: Rgb = [40, 40, 40]): Frame {
  const w = 96;
  const h = 54;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = i < chrome * w ? top : color;
    data.set([r, g, b, 255], i * 4);
  }
  return { w, h, data };
}

/** A busy screen (video, scrolling): pseudo-random grey levels, another picture per seed. */
function noise(seed: number): Frame {
  const frame = screen([0, 0, 0]);
  let state = (seed * 2654435761) >>> 0;
  for (let i = 0; i < frame.w * frame.h; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    const v = (state >>> 16) & 255;
    frame.data.set([v, v, v, 255], i * 4);
  }
  return frame;
}

const SCREENS: Record<Screen, Frame> = {
  desktop: screen([200, 200, 200]),
  window: screen([40, 40, 40]),
  magenta: screen([235, 16, 235], 8),
  lime: screen([16, 235, 16], 8),
  red: screen([235, 16, 16], 8),
  blue: screen([16, 16, 235], 8)
};

interface TargetScript {
  opensWindow: boolean;
  /** What the window shows after each Enter (the probe page first); unchanged when absent. */
  pages: Screen[];
  /** Ctrl+C reaches the lime page, whose copy handler turns it blue. */
  copies: boolean;
  closesWindow: boolean;
  /** The user's screen before the window opens and after it closes (default: a grey desktop). */
  desktop?: Frame;
  /** What Ctrl+W reveals instead of the desktop. */
  afterClose?: Frame;
  /** What the capture shows before the open-window chord, by time (default: the desktop). */
  before?: (ms: number) => Frame | null;
}

const WORKS: TargetScript = {
  opensWindow: true,
  pages: ['magenta', 'lime'],
  copies: true,
  closesWindow: true
};
const QUICK: Pacing = { holdMs: 1, gapMs: 1, afterEnterMs: 0 };

/** Press reports as tokens: typed characters joined, other keys by name (^ Ctrl, + Shift). */
function describeKeys(reports: number[][], layout: TargetLayout): string[] {
  const chars = new Map<string, string>();
  for (const [char, combo] of Object.entries(getTable(layout))) {
    chars.set(`${combo.shift ? SHIFT : 0}:${KeycodeMap[combo.key]}`, char);
  }
  const names = new Map(Object.entries(KeycodeMap).map(([name, code]) => [code, name]));
  const tokens: string[] = [];
  let text = '';
  for (const [mod, , key] of reports) {
    if (key === 0) continue;
    const char = chars.get(`${mod}:${key}`);
    if (char !== undefined) {
      text += char;
      continue;
    }
    if (text) tokens.push(text);
    text = '';
    const name = (names.get(key) ?? String(key)).replace(/^Key/, '');
    tokens.push((mod & CTRL ? '^' : '') + (mod & SHIFT ? '+' : '') + name);
  }
  if (text) tokens.push(text);
  return tokens;
}

async function runBridge(
  script: TargetScript,
  over: Partial<BridgeDeps> = {},
  text = 'こんにちは'
) {
  const clock = new FakeClock();
  const sink = new FakeSink();
  const desktop = script.desktop ?? SCREENS.desktop;
  let shown = desktop;
  let page: Screen | null = null;
  let opened = false;
  let enters = 0;
  const pressedAt: number[] = [];
  const engine = new TypingEngine({
    send: (report) => {
      const [mod, , key] = report;
      if (key !== 0) pressedAt.push(clock.now());
      if (mod === (CTRL | SHIFT) && key === KeycodeMap.KeyN) {
        opened = true;
        if (script.opensWindow) shown = SCREENS.window;
      }
      if (mod === 0 && key === KeycodeMap.Enter) {
        const next = script.pages[enters++];
        if (next !== undefined) {
          page = next;
          shown = SCREENS[next];
        }
      }
      if (mod === CTRL && key === KeycodeMap.KeyC && script.copies && page === 'lime') {
        page = 'blue';
        shown = SCREENS.blue;
      }
      if (mod === CTRL && key === KeycodeMap.KeyW && script.closesWindow) {
        page = null;
        shown = script.afterClose ?? desktop;
      }
      return sink.send(report);
    },
    lock: new HidLock(),
    clock,
    interruptTarget: new EventTarget(),
    isInsideOwnUi: () => false
  });
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  const url = buildBridgeUrl(text);
  const layout = over.layout ?? 'us';
  const program = buildBridgeProgram(url, {
    ...deps(over),
    sampler: {
      sample: () => (opened || !script.before ? shown : script.before(clock.now())),
      available: () => true
    }
  });

  const promise = engine.runProgram(program, QUICK);
  await flushMicrotasks();
  await clock.advanceAsync(20_000);
  const result = await promise;
  const phases = events.flatMap((e) => (e.phase && e.type === 'progress' ? [e.phase] : []));
  return {
    result,
    url,
    keys: describeKeys(sink.reports, layout),
    reports: sink.reports,
    pressedAt,
    phases: phases.filter((phase, i) => phase !== phases[i - 1]),
    shown: () => shown
  };
}

describe('bridge runs against a scripted target screen', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lime, blue, then gone: probes, types, verifies, copies, closes and pastes with Ctrl+V last', async () => {
    const run = await runBridge(WORKS);
    expect(run.result.reason).toBe('completed');
    expect(run.keys).toEqual([
      '^+N',
      '^L',
      'Lang2',
      BRIDGE_PROBE_URL,
      'Delete',
      'Enter',
      '^L',
      'Lang2',
      run.url,
      'Delete',
      'Enter',
      'Escape',
      '^A',
      '^C',
      '^W',
      '^V'
    ]);
    expect(run.phases).toEqual(['window', 'probe', 'type', 'verify', 'copy', 'close', 'paste']);
    expect(run.result.typedStrokes).toBe(run.result.totalStrokes);
    // the still-screen check took two samples 300 ms apart before the chord
    expect(run.pressedAt[0]).toBe(300);
  });

  it('types JIS strokes on a JIS target', async () => {
    const run = await runBridge(WORKS, { layout: 'jis', imeOff: 'NonConvert' });
    expect(run.result.reason).toBe('completed');
    expect(run.keys.slice(0, 4)).toEqual(['^+N', '^L', 'NonConvert', BRIDGE_PROBE_URL]);
    expect(run.keys).toContain(run.url);
  });

  it('no readable frame: bridge-no-video before any key', async () => {
    const run = await runBridge({ ...WORKS, before: () => null });
    expect(run.result).toMatchObject({ reason: 'bridge-no-video', typedStrokes: 0 });
    expect(run.keys).toEqual([]);
    expect(run.reports.every((report) => report.every((byte) => byte === 0))).toBe(true);
  });

  it('a screen that keeps changing (video, scrolling): bridge-busy-screen before any key', async () => {
    const run = await runBridge({ ...WORKS, before: (ms) => noise(Math.floor(ms / 33)) });
    expect(run.result).toMatchObject({ reason: 'bridge-busy-screen', typedStrokes: 0 });
    expect(run.keys).toEqual([]);
    expect(run.reports.every((report) => report.every((byte) => byte === 0))).toBe(true);
  });

  it('a screen that settles: the chord follows two still samples, then the run completes', async () => {
    // scrolling until 1 s; the samples at 1200 and 1500 ms are the first still pair
    const run = await runBridge({
      ...WORKS,
      before: (ms) => (ms < 1000 ? noise(Math.floor(ms / 33)) : SCREENS.desktop)
    });
    expect(run.result.reason).toBe('completed');
    expect(run.pressedAt[0]).toBe(1500);
    expect(run.keys[0]).toBe('^+N');
  });

  it('a frame unreadable at first: the chord waits for a readable one, then the run completes', async () => {
    let samples = 0;
    const run = await runBridge({
      ...WORKS,
      before: () => (samples++ === 0 ? null : SCREENS.desktop)
    });
    expect(run.result.reason).toBe('completed');
    // a readable frame at 100 ms, the still pair at 100 and 400 ms
    expect(run.pressedAt[0]).toBe(400);
  });

  it('scrolling that settles before a chord that opens nothing: only the chord is sent', async () => {
    const run = await runBridge({
      ...WORKS,
      opensWindow: false,
      before: (ms) => (ms < 1000 ? noise(Math.floor(ms / 33)) : SCREENS.desktop)
    });
    expect(run.result.reason).toBe('bridge-no-window');
    expect(run.keys).toEqual(['^+N']);
  });

  it('no window: stops with bridge-no-window before any URL is typed', async () => {
    const run = await runBridge({ ...WORKS, opensWindow: false });
    expect(run.result.reason).toBe('bridge-no-window');
    expect(run.keys).toEqual(['^+N']);
  });

  it('probe fails: no payload typed and no Ctrl+W', async () => {
    const run = await runBridge({ ...WORKS, pages: [] });
    expect(run.result.reason).toBe('bridge-probe-failed');
    expect(run.keys).toEqual(['^+N', '^L', 'Lang2', BRIDGE_PROBE_URL, 'Delete', 'Enter']);
  });

  it('the probe page stays red (Caps Lock, JavaScript off): Ctrl+W closes it, no payload', async () => {
    const run = await runBridge({ ...WORKS, pages: ['red'] });
    expect(run.result.reason).toBe('bridge-probe-red');
    expect(run.keys).toEqual(['^+N', '^L', 'Lang2', BRIDGE_PROBE_URL, 'Delete', 'Enter', '^W']);
    expect(run.shown()).toBe(SCREENS.desktop);
  });

  it('red page: closes it with Ctrl+W, then stops with bridge-verify-failed', async () => {
    const run = await runBridge({ ...WORKS, pages: ['magenta', 'red'] });
    expect(run.result.reason).toBe('bridge-verify-failed');
    expect(run.keys.slice(-4)).toEqual([run.url, 'Delete', 'Enter', '^W']);
    expect(run.shown()).toBe(SCREENS.desktop);
  });

  it('a page that never loads: bridge-load-failed, nothing closed', async () => {
    const run = await runBridge({ ...WORKS, pages: ['magenta'] });
    expect(run.result.reason).toBe('bridge-load-failed');
    expect(run.keys.slice(-3)).toEqual([run.url, 'Delete', 'Enter']);
  });

  it('the copy is not confirmed (the page stays lime): no Ctrl+W, no Ctrl+V', async () => {
    const run = await runBridge({ ...WORKS, copies: false });
    expect(run.result.reason).toBe('bridge-copy-failed');
    expect(run.keys.slice(-3)).toEqual(['Escape', '^A', '^C']);
    expect(run.keys).not.toContain('^W');
    expect(run.keys).not.toContain('^V');
  });

  it('a window that does not close: bridge-close-failed, no Ctrl+V', async () => {
    const run = await runBridge({ ...WORKS, closesWindow: false });
    expect(run.result.reason).toBe('bridge-close-failed');
    expect(run.keys.slice(-2)).toEqual(['^C', '^W']);
  });

  it('Ctrl+W reveals another screen (the next tab of a restored window): bridge-close-failed, no Ctrl+V', async () => {
    const run = await runBridge({ ...WORKS, afterClose: screen([250, 250, 250], 8, [60, 60, 60]) });
    expect(run.result.reason).toBe('bridge-close-failed');
    expect(run.keys.slice(-2)).toEqual(['^C', '^W']);
    expect(run.keys).not.toContain('^V');
  });

  it('a desktop with lime and blue banners that the window hides still completes', async () => {
    // 3 of 54 rows each (5.6 %): LINE green classifies as lime, a dark blue banner as blue
    const desktop = screen([200, 200, 200], 3, [6, 199, 85]);
    for (let i = 3 * 96; i < 6 * 96; i++) desktop.data.set([20, 30, 200, 255], i * 4);
    expect(sentinelFraction(desktop, 'lime')).toBeCloseTo(3 / 54);
    expect(sentinelFraction(desktop, 'blue')).toBeCloseTo(3 / 54);
    // measured against the opened window, the banner would never count as gone
    expect(sentinelGone(desktop, SCREENS.window, 'blue')).toBe(false);

    const run = await runBridge({ ...WORKS, desktop });
    expect(run.result.reason).toBe('completed');
    expect(run.keys[run.keys.length - 1]).toBe('^V');
  });
});
