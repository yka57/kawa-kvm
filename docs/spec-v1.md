# NanoKVM-USB fork — Mac-host UX spec (v1)

Scope: three features for a Mac host operating a (most likely Windows) browser through NanoKVM-USB: (A) ⌘ shortcut remap, (B) trackpad/scroll fidelity, (C) host clipboard → target typing. Everything is opt-in or a pure bug fix; a user who touches no new setting gets upstream behaviour on the wire except the items listed in §8.

## 0. Ground truth

Verified in this repo (2026-11-03):
- Not byte-identical to upstream: `package.json` has `vitest ^3.2.7`, `@vitest/coverage-v8`, scripts `test`/`test:watch`; `vitest.config.ts` (environment `node`, include `src/**/*.test.ts(x)`, tsconfig paths); `src/libs/keyboard/keyboard.test.ts`; `node_modules` installed; `npx vitest run` passes (1 test). No jsdom/happy-dom. Node 22: `Intl.Segmenter` present and segments `"\r\n"` as ONE grapheme; `TextDecoder('shift_jis')` available. TS 5.6 ships `lib.es2022.intl.d.ts`; `tsconfig.app.json` lib is `ES2020` (no `Intl.Segmenter` type yet). `tsc -b` type-checks tests (`include: ["src"]`).
- `src/components/keyboard/index.tsx`: dedupe by `pressedKeys.has(code)` (l.54, `event.repeat` unused); Meta-up sweep releases non-modifiers (l.96-109, all hosts); AltGr hack only when host is Windows (l.27, 58-70, 87-94); IME guard = `isComposing` only (l.47-48); `preventDefault` before anything (l.50); listeners registered in one effect keyed on `[isKeyboardEnabled]`; `normalizeKeyCode` returns `event.code` unchanged. `MetaLeft/MetaRight` → HID 0x08/0x80 (keymap.ts l.14-23) = Win key on the target.
- Upstream history: x2 rule present since the first commit touching `relative.tsx` (8da8aea); DPR term, the Meta sweep and the jiggler regression (`sendKeyboardData([0x01, ...rel])`, 5-byte payload on cmd 0x02) all come from 706b610. Upstream HEAD 1d1dd5e has nothing newer for keyboard/mouse; browser has no `ja.ts`, desktop has one (same GPLv3 project → portable).
- Mouse: `absolute.tsx:76-88` / `relative.tsx:76-88` send exactly one notch per wheel event, `Math.floor(e.deltaY)===0` filter is asymmetric, `scrollIntervalAtom` default 0; `relative.tsx:62-67` drops zero deltas and doubles `|d*DPR|<10` (non-monotonic at DPR 2); buttons/moves/wheel forwarded while pointer is NOT locked; `showMessage()` runs in the render body; `libs/mouse/index.ts:57` clamps to ±127, `:107` yields 4096 at x=1.0; `getCoordinate` ignores rotation (App.tsx applies `rotate()`); absolute listeners live on `#video` only (mouseup off-element → stuck button).
- Four independent `KeyboardReport` writers: Keyboard component, VirtualKeyboard, Shortcut (fresh per click), Paste (raw arrays). Serial: one awaited `writer.write()` per report, FIFO preserved by `WritableStreamDefaultWriter`, no coalescing, RX never drained.
- i18n: `getCurrentLanguage()` picks `navigator.language` when a locale file exists → adding `ja.ts` auto-switches Japanese browsers; it must be complete. `keyboard.paste` is a string in all 10 locales (new paste strings go in a top-level `paste` section). Storage keys in `src/libs/storage/index.ts`; shortcuts key `nanokvm-usb-keyboard-shortcut` holds `{keys:[{code,label}]}[]` with literal `event.code`.
- `menu/recorder` is the screen recorder (name new things `shortcut-recorder`-ish to avoid confusion).

Assumptions (hardware/browser, validated by §6.3; design is harmless if wrong): A1 macOS Chrome delivers no keyup for non-modifier keys while ⌘ is held (modifier keyups do arrive). A2 ⌘C/V/F/… reach the page in a window; ⌘W/T/N/Q/⇧[ ]/⌃Tab only in JS fullscreen (+ keyboard lock); ⌘Tab/⌘Space/screenshots never. A3 macOS fires CapsLock keydown on lock-on and keyup on lock-off. A4 JIS Mac: 英数→`Lang2`, かな→`Lang1`. A5 Chrome movementX is integer, pointer events have fractional clientX, trackpad wheel deltaY is small integers at 60-120 Hz with an un-flagged momentum tail. A6 CH9329 accepts back-to-back frames and multi-notch wheel bytes (shortcut replay already sends back-to-back reports successfully).

## 1. Architecture

```
DOM key events ─► components/keyboard/index.tsx (thin adapter) ─► KeyboardDriver (libs/keyboard/driver.ts: timers, send queue, mute/dry-run)
                                                                    └► translateKeyEvent (libs/keyboard/remap.ts, pure) ─► actions ─► KeyboardReport ─► device.sendKeyboardData
DOM pointer/wheel ─► components/mouse/{absolute,relative}.tsx ─► libs/pointer/{wheel,relative-motion,absolute-map}.ts (pure) ─► libs/mouse (reports) ─► device.sendMouseData
Paste row / ⌘⇧V ─► components/menu/keyboard/paste/controller.ts ─► libs/paste/{text-to-keys,typing-engine}.ts (pure) ─► hidLock ─► device.sendKeyboardData
Shared: jotai/target.ts (targetOs, targetLayout) · storage getters with validated defaults · i18n en+ja · libs/debug/hid-log.ts (ring buffer tapped in Device)
```
Rules: pure modules never touch `window`/`document`/antd at import time (vitest runs in `node`); impure code takes injected `setTimeout/clearTimeout/now/send/EventTarget`. React components only translate DOM events and render. Settings are read through refs inside listeners so listener effects do not re-register (they would run `releaseKeys`).

## 2. Shared foundation

### 2.1 Target settings (`src/jotai/target.ts`, storage)
| key | type | default | used by |
|---|---|---|---|
| `nanokvm-usb-target-os` | `'windows'|'linux'|'macos'` | `'windows'` | A (remap inactive when `macos`), C (help text) |
| `nanokvm-usb-target-layout` | `'us'|'jis'` | `'jis'` if `i18n.language==='ja'` else `'us'` | C (paste table) |
Atoms `targetOsAtom`, `targetLayoutAtom` are initialised at module load from storage (`atom(storage.getTargetOs())`); menus write; features read. UI: two rows in the keyboard popover (`menu/keyboard/target-os.tsx`, `target-layout.tsx`), same look as `menu/mouse/mode.tsx` (right-side Popover, blue = selected).

### 2.2 New storage keys (all additive; getters validate and never throw; existing keys and semantics untouched)
| key | value | default |
|---|---|---|
| `nanokvm-usb-keyboard-remap` | JSON `KeyboardRemapConfig` (§3.2) | defaults = upstream |
| `nanokvm-usb-keyboard-remap-seen` | `'1'` once the remap row was opened (badge) | unset |
| `nanokvm-usb-mouse-scroll-px-per-notch` | number 20..400 | 100 |
| `nanokvm-usb-mouse-sensitivity` | number 0.25..4 (relative-mode gain) | 1 |
| `nanokvm-usb-paste-settings` | JSON `PasteSettings` (§5.5) | defaults |
| `nanokvm-usb-debug-hid` | `'1'` enables the HID log overlay (also `?debug=hid`) | unset |
`nanokvm-usb-mouse-scroll-interval` keeps its key, slider and drop semantics; `nanokvm-usb-keyboard-shortcut` format unchanged.

### 2.3 i18n
`src/i18n/locales/ja.ts` is a COMPLETE file (port desktop `ja.ts`, fill the browser-only keys, use `virtualKeyboard: '仮想キーボード'`, `video.auto: '自動'`, `video.rotation: '回転'`, `serial.*`, `audio.*`, `keyboard.shortcut.captureTips/enterFullScreen`); add `{ key: 'ja', name: '日本語' }` to `languages.ts`. A test flattens `en` and `ja` and asserts identical key sets. All new strings (listed per feature below) are added to `en.ts` and `ja.ts` in the foundation task so feature tasks only consume keys. Other locales fall back to `en`.

New keys (en / ja), grouped:
```
target: { os:'Target OS'/'操作先 OS', layout:'Target keyboard layout'/'操作先のキー配列', windows:'Windows', linux:'Linux', macos:'macOS', us:'US (ANSI)', jis:'日本語 (JIS)' }
keyboard.remap: {
  title:'⌘ key mapping (Mac)'/'⌘ キー変換（Mac）', off:'Off (send ⌘ as Win)'/'オフ（⌘ を Win として送信）', on:'On (⌘ → Ctrl)'/'オン（⌘ → Ctrl）',
  inactiveMacTarget:'Disabled: target OS is macOS'/'操作先が macOS のため無効です',
  nav:'Also convert Mac navigation (⌘←/→, ⌥←/→, ⌘⇧[ ])'/'Mac 風ナビゲーションも変換（⌘←/→, ⌥←/→, ⌘⇧[ ]）',
  jis:'英数/かな → 無変換/変換 (MS-IME with IME-off/on assigned)'/'英数/かな → 無変換/変換（MS-IME で IME オフ/オンを割り当て済みの場合）',
  capsLock:'Fix Caps Lock sync'/'Caps Lock の同期を補正',
  help:'Which shortcuts can be sent?'/'送信できるショートカット', helpWindow:'Work in a normal window'/'通常ウィンドウで動作',
  helpFullscreen:'Work only in full screen'/'全画面時のみ動作', helpNever:'Everything else (⌘Tab, ⌘Space, ⌘Q…): use Shortcuts'/'その他（⌘Tab, ⌘Space, ⌘Q など）は「ショートカット」から送信してください',
  sideEffects:'With ⌘ → Ctrl on: ⌘-click = Ctrl+click, ⌘+wheel = Ctrl+wheel (zoom) on the target'/'オン時は ⌘クリック = Ctrl+クリック、⌘+ホイール = Ctrl+ホイール（ズーム）になります',
  enterFullscreen:'Enter full screen'/'全画面にする', keyTest:'Key test'/'キーテスト',
  keyTestHint:'Keys are NOT sent while this is open'/'テスト中はキーは送信されません',
  releaseAll:'Release all keys'/'全キーを離す', recordAsCtrl:'Record ⌘ as Ctrl'/'⌘ を Ctrl として記録',
  imeHint:'Host IME is composing; switch the host input source to English'/'ホスト側 IME が変換中です。入力ソースを英数に切り替えてください',
  badgeTip:'New: ⌘C/⌘V can be sent as Ctrl+C/Ctrl+V'/'新機能: ⌘C/⌘V を Ctrl+C/Ctrl+V として送れます' }
mouse: { scrollSensitivity:'Scroll sensitivity'/'スクロール感度', pointerSpeed:'Pointer speed'/'ポインター速度', relativeOnly:'Relative mode only'/'相対座標モードのみ' }
paste: { title:'Paste host clipboard'/'クリップボードを入力', settings:'Paste settings'/'貼り付けの設定', cancel:'Cancel'/'キャンセル', typeText:'Type this text'/'このテキストを入力',
  textPlaceholder:'Paste text here (⌘V)'/'ここにテキストを貼り付け（⌘V）', speed:'Speed'/'速度', speedSafe:'Safe'/'安全', speedNormal:'Normal'/'標準',
  newline:'Newline'/'改行', newlineEnter:'Enter', newlineShiftEnter:'Shift+Enter', normalize:'Normalize punctuation (smart quotes, dashes, NBSP)'/'記号を正規化（スマートクォート・ダッシュ・NBSP）',
  stripTrailingNewline:'Do not type the trailing newline'/'末尾の改行を入力しない', imeOff:'Send 無変換 first to turn the target IME off'/'先に 無変換 を送って操作先の IME をオフにする',
  hotkey:'Host hotkey'/'ホスト側ホットキー', hotkeyNeedsRemap:'Works while ⌘ → Ctrl is on'/'⌘ → Ctrl がオンのとき使えます', change:'Change'/'変更',
  progress:'{{done}} / {{total}} · {{eta}} s left'/'{{done}} / {{total}} · 残り約{{eta}}秒', skipped:'{{count}} non-ASCII character(s) skipped'/'ASCII 以外の{{count}}文字をスキップしました',
  skippedList:'Not typeable: {{chars}}'/'入力できない文字: {{chars}}', nothingTypeable:'Nothing typeable with the current settings'/'現在の設定で入力できる文字がありません',
  doneCompleted:'Done'/'完了', doneCancelled:'Cancelled'/'キャンセルしました', doneKey:'Stopped: a key was pressed on the host'/'停止: ホストでキーが押されました',
  doneMouse:'Stopped: mouse clicked'/'停止: マウスがクリックされました', doneHidden:'Stopped: tab hidden'/'停止: タブが非表示になりました', doneSerial:'Stopped: serial error'/'停止: シリアル通信エラー',
  confirmLarge:'{{count}} characters will take about {{seconds}} s. Continue?'/'{{count}}文字の入力には約{{seconds}}秒かかります。続行しますか？', truncated:'Truncated to {{max}} characters'/'{{max}}文字に切り詰めました',
  permDenied:'Clipboard access is blocked. Allow it from the lock icon in the address bar, or paste into the text box.'/'クリップボードへのアクセスがブロックされています。アドレスバーの鍵アイコンから許可するか、テキスト欄に貼り付けてください。',
  noFocus:'Click the page first, then try again.'/'ページをクリックしてからもう一度お試しください。', empty:'The clipboard has no text.'/'クリップボードにテキストがありません。',
  notConnected:'Serial is not connected'/'シリアルが接続されていません', capsHint:'If the target has Caps Lock on, letters will be inverted.'/'操作先で Caps Lock がオンの場合、英字の大小が反転します。' }
debug: { hidLog:'HID log'/'HID ログ', copy:'Copy'/'コピー', clear:'Clear'/'クリア' }
```

## 3. Feature A — ⌘ remap (physical keyboard path)

### 3.1 Behaviour and defaults
- Active iff `hostOS === 'macOS' && cfg.enabled && targetOs !== 'macos'`. Default `enabled: false` (upstream: ⌘ = Win). When active: `MetaLeft→ControlLeft`, `MetaRight→ControlRight`; ⌃ stays Ctrl, ⌥ stays Alt; a lone ⌘ tap becomes a harmless Ctrl tap.
- Tap semantics: a non-modifier pressed while ⌘ is physically down is pressed and auto-released after `tapReleaseMs` (50) — or earlier on real keyup / ⌘-up sweep / release-all. Host autorepeat (`repeat=true`) re-taps once the previous tap finished (`repeatUnderMeta: true`, native Mac feel); `repeat=false` while an entry is released = physical re-press = new tap. Keys pressed without ⌘ keep held semantics (unchanged).
- `navRules` (default on): `cmdArrows` ⌘←/→ → Home/End, ⌘↑/↓ → Ctrl+Home/End (Shift preserved); `optWord` ⌥←/→/⌫/⌦ → Ctrl+←/→/⌫/⌦ (Alt suppressed, masked, see 3.3); `cmdTabSwitch` ⌘⇧[ / ⌘⇧] and ⌘⌥← / ⌘⌥→ → Ctrl+Shift+Tab / Ctrl+Tab.
- `jisEisuKana` (default OFF): `Lang2`→`NonConvert`, `Lang1`→`Convert` (only correct when the target MS-IME has IME-off/on assigned to those keys; default MS-IME template cycles kana modes). Decide with the user after one test (Q1).
- `macCapsLockFix` (default on, effective only when active): on a macOS host both keydown and keyup of `CapsLock` emit a full tap (A3) so host and target lock state stay aligned.
- Off-wire side effects documented in the help modal: ⌘-click → Ctrl+click, ⌘+wheel → Ctrl+wheel on the target; ⌃-click is not a right-click.
- Host shortcut `⌘⇧V` is consumed (not forwarded) when active and the paste hotkey is enabled (§5.4).
- `beforeunload` guard (`e.preventDefault(); e.returnValue = true`) installed only while active and serial is connected (⌘W/⌘Q in a window are Chrome-reserved and would otherwise kill the session silently).

### 3.2 Config (`src/libs/keyboard/remap-config.ts`)
```ts
export interface KeyboardRemapConfig {
  version: 1; enabled: boolean;            // false
  navRules: boolean;                       // true
  jisEisuKana: boolean;                    // false
  macCapsLockFix: boolean;                 // true
  tapReleaseMs: number;                    // 50, clamp 20..200
  minPressMs: number;                      // 30, clamp 0..100 (sweep-path minimum press)
  repeatUnderMeta: boolean;                // true
}
export const DEFAULT_REMAP_CONFIG: KeyboardRemapConfig;
export function normalizeRemapConfig(raw: unknown): KeyboardRemapConfig;   // tolerant: missing→default, unknown dropped, clamps
export interface RemapContext { cfg: KeyboardRemapConfig; active: boolean; hostActions: HostAction[]; }
export interface HostAction { id: 'paste-host-clipboard'; chord: Chord; enabled: boolean }
export interface Chord { code: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }
export function matchChord(ev: { code: string; mods: HostMods; repeat: boolean }, c: Chord): boolean; // exact modifier match, false on repeat
export function mapModifier(code: string, active: boolean): string;        // MetaLeft→ControlLeft, MetaRight→ControlRight when active
export function remapRecordedCode(code: string, active: boolean): { code: string; label: string }; // recorder helper (modifiers only)
export interface RuleOutput { emit: string; mods: Partial<Record<'ctrl'|'alt'|'shift'|'meta', boolean>> }
export function matchRule(ctx: RemapContext, mods: HostMods, code: string): RuleOutput | null;
```
Rule table (exact match on physical meta/alt/ctrl; shift only where given): cmdArrows `{meta}`: ArrowLeft→Home{ctrl:false,meta:false}, ArrowRight→End{…}, ArrowUp→Home{ctrl:true,meta:false}, ArrowDown→End{ctrl:true,meta:false}; optWord `{alt}`: ArrowLeft/ArrowRight/Backspace/Delete→same{ctrl:true,alt:false}; cmdTabSwitch `{meta,shift}`: BracketLeft→Tab{ctrl:true,shift:true,meta:false}, BracketRight→Tab{ctrl:true,shift:false,meta:false}; `{meta,alt}`: ArrowLeft→Tab{ctrl:true,alt:false,shift:true,meta:false}, ArrowRight→Tab{ctrl:true,alt:false,shift:false,meta:false}; jisEisuKana `{}`: Lang2→NonConvert, Lang1→Convert. `matchRule` returns null when `!ctx.active`.

### 3.3 State machine (`src/libs/keyboard/remap.ts`)
```ts
export type HostMods = { meta: boolean; ctrl: boolean; alt: boolean; shift: boolean };
export type HostKeyEvent =
  | { type: 'keydown'; code: string; key?: string; repeat: boolean; timeStamp: number; mods: HostMods }
  | { type: 'keyup'; code: string; timeStamp: number; mods: HostMods }
  | { type: 'timer'; code: string; timeStamp: number }
  | { type: 'release-all' };
export type HidAction =
  | { type: 'press'; code: string } | { type: 'release'; code: string } | { type: 'reset' }
  | { type: 'release-after'; code: string; ms: number } | { type: 'cancel-release'; code: string } | { type: 'cancel-all-timers' }
  | { type: 'host-action'; id: HostAction['id'] } | { type: 'hint'; id: 'ime-composing' }
  | { type: 'trace'; ev: HostKeyEvent; sent: string[] };     // every keydown/keyup/timer produces one trace
type Logical = 'ctrl' | 'alt' | 'shift' | 'meta';
interface KeyEntry { kind: 'mod' | 'key' | 'consumed'; out: string; tap: boolean; released: boolean; pressedAt: number; synthetic?: boolean; override?: RuleOutput['mods'] }
export interface RemapState { hostOS: System; keys: Map<string, KeyEntry>; wireMods: Set<string>; deferred: Set<Logical>; sweepPending: boolean; altGr: { active: boolean; ctrlLeftTimestamp: number } | null }
export function createRemapState(hostOS: System): RemapState;
export function translateKeyEvent(state: RemapState, ev: HostKeyEvent, ctx: RemapContext): HidAction[];  // mutates state in place (owned by the driver)
```
Algorithm (per event; action buckets `rel` → `mid` (reconcile) → `post`):
1. `release-all`: `[cancel-all-timers, reset]`, state := `createRemapState` (AltGr reset too).
2. `keydown`:
   a. `if (st.sweepPending) flushSweep()` (release remaining taps, drop the Meta entry; see 2f).
   b. AltGr (Windows host only, verbatim upstream thresholds): `ControlLeft` stores timestamp; `AltRight` within 10 ms with a ControlLeft entry → finish ControlLeft, `altGr.active=true`.
   c. Host actions: `!ev.repeat && ctx.active` and some enabled `matchChord` → `post.push(host-action)`, `keys.set(code,{kind:'consumed'})`, return (no forwarding; no modifier change). A keydown for an existing `consumed` entry → noop; its keyup deletes the entry silently.
   d. Resync (macOS host only, never while `altGr.active`): for each logical L ≠ logical of `ev.code` when it is a modifier: `ev.mods[L] && noEntryOf(L)` → add `{kind:'mod', out: mapModifier(canonical(L)), synthetic:true}`; `!ev.mods[L] && entriesOf(L)` → (meta: run sweep first) finish them.
   e. Dedupe: entry exists and (`ev.repeat ? !(cfg.repeatUnderMeta && e.tap && e.released) : !e.released`) → noop. Otherwise finish the stale entry.
   f. macOS + `CapsLock` + `macCapsLockFix` + active → `post: press CapsLock, release-after(CapsLock)`; entry `{kind:'key', tap:true}`; done.
   g. Modifier → `keys.set(code,{kind:'mod', out: mapModifier(code, ctx.active)})`; reconcile presses it.
   h. Non-modifier: `mods = physicalMods(st)`; `rule = matchRule(ctx, mods, code)`; `out = rule?.emit ?? code`; unknown HID code → noop. Any other entry with the same `out` → finish it first (collision). `tap = active && mods.meta`. If `rule`: finish pending tap entries first, set `entry.override = rule.mods`. `st.deferred.clear()` (lazy re-press happens now). Entry `{kind:'key', out, tap, pressedAt}`; `post: press out`, `tap → release-after(code, tapReleaseMs)`.
3. `keyup`:
   a. consumed → delete, noop. AltGr active: ControlLeft keyup swallowed; AltRight clears active.
   b. Resync as 2d (with `ev.mods`; the event's own modifier excluded) — retires synthetic entries (e.g. after `keyup MetaRight` with `metaKey=false`).
   c. macOS CapsLock fix → same tap as keydown.
   d. Meta keyup (any host): sweep = finish every `kind:'key'` entry. Exception when active: if some tap entry has `now - pressedAt < cfg.minPressMs`, set `sweepPending=true`, keep the Meta entry and the taps; the pending timer events release the taps and the last one runs `flushSweep` (release remaining, drop Meta entry, reconcile). Any new keydown flushes first (2a).
   e. Own entry → finish (modifier entries: logical removed; if it was suppressed by an override, also drop it from `deferred`).
4. `timer`: entry with `tap && !released` → `rel: release out`, `released=true`, `override=undefined`; if `sweepPending` and no unreleased taps remain → `flushSweep`.
5. `finishEntry(code)`: if `!released` → `release out`; if `tap && !released` → `cancel-release`; delete. When an override that suppressed a physically held modifier ends, that logical is added to `st.deferred` (lazy re-press) instead of being re-pressed immediately.
6. `reconcile`: `desired = { e.out | kind:'mod', !released }` adjusted by overrides of unreleased key entries (`false` removes all codes of that logical, `true` adds canonical code if absent) minus `deferred` logicals; emit presses FIRST, then releases (press-before-release masks a lone Alt/Win tap: `Ctrl↓ Alt↑` instead of `Alt↑ Ctrl↓`), update `wireMods`. Refcounting falls out: physical ⌃ and remapped ⌘ both want `ControlLeft`; it leaves the wire only when both are up.
7. `post.push(trace)` for every keydown/keyup/timer.

Traces to sanity-check (active, defaults): ⌘C → `[01]`,`[01 00 06]`,timer `[01 00 00]`, ⌘↑ `[00]` (exactly one Ctrl+C; today Win+C held). ⌘V held 2 s → tap, then host repeats re-tap every ~90 ms, `[00]` at ⌘-up. ⌥← → `[04]`; ← → `[05]` (press Ctrl), `[01]` (release Alt), `[01 00 50]`, keyup `[01 00 00]`, Alt deferred (not re-pressed), ⌥-up `[00]` → no lone-Alt menu focus. ⌘⇧[ → Ctrl+Shift+Tab; ⌘← → Home with Ctrl released during the tap then re-pressed lazily. Physical ⌃C unchanged. `keydown MetaRight` → exactly `press ControlRight` (resync skips the event's own logical). Preset off → byte-identical to upstream incl. CapsLock.

### 3.4 Driver (`src/libs/keyboard/driver.ts`, impure but DOM-free)
```ts
export interface DriverDeps { send(report: number[]): Promise<void>; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; now(): number; hostOS: System;
  getContext(): RemapContext; onHostAction?(id: HostAction['id']): void; onHint?(id: string): void; onTrace?(t: TraceEntry): void }
export class KeyboardDriver {
  readonly report: KeyboardReport;                 // the single source of what the target sees from this path
  dispatch(ev: HostKeyEvent): void;                // translate → run actions in order; reports computed synchronously, written through one promise chain (ordered)
  releaseAll(): void;                              // dispatch release-all + cancel timers
  setDryRun(on: boolean): void;                    // Key test: state machine + traces run, nothing sent; releaseAll() on toggle
  setMuted(on: boolean): void;                     // hidLock (§5.3): state machine runs (modifiers stay in sync), sends suppressed; on unmute send current report once
  isMuted(): boolean; lastReport(): number[];
}
```
Timers keyed by host code; `timer` events carry `now()`. Error handling: send failures are logged once, never throw into DOM handlers.

### 3.5 Adapter (`src/components/keyboard/index.tsx`)
Keep: listener set, `[isKeyboardEnabled]` effect, `preventDefault/stopPropagation` placement, IME guard (`isComposing` only), `normalizeKeyCode` verbatim. Change: handlers call `driver.dispatch({type, code, key, repeat, timeStamp, mods: {meta:e.metaKey, ctrl:e.ctrlKey, alt:e.altKey, shift:e.shiftKey}})`; `key==='Process'` only triggers a throttled hint (still forwarded). Blur/hidden/disable/unmount → `driver.releaseAll()`. Context comes from refs fed by `keyboardRemapAtom`, `targetOsAtom`, `pasteSettingsAtom` (hotkey) so the effect never re-runs on config change. While `hidLock` is held: driver is muted; a non-modifier keydown calls `hidLock.interrupt()` and is swallowed (modifiers still dispatched so the shadow state stays correct). `onHostAction('paste-host-clipboard')` → `pasteController.startFromHotkey()`. The driver instance is created once per mount (`useRef`), traces go to `keyTraceAtom` unconditionally (only the help modal subscribes).

### 3.6 UI
- `menu/keyboard/index.tsx` order: Paste · Keyboard · Shortcuts · Divider · Target OS · Target layout · ⌘ key mapping (macOS host only, icon `ArrowLeftRightIcon`) · Release all keys. Keyboard menu icon shows a small blue dot on macOS hosts until the remap row is opened once (`nanokvm-usb-keyboard-remap-seen`).
- `menu/keyboard/remap/index.tsx`: rows Off / On (disabled with `inactiveMacTarget` note when targetOs is macOS), Divider, antd `Checkbox` list (nav, jis, capsLock; disabled when off), Divider, help row → `remap/help.tsx`.
- `remap/help.tsx` (antd Modal, `keyboard={false}`, sets `isKeyboardEnableAtom` false like the shortcut recorder? NO — the Key test needs capture, so instead it sets `driver.setDryRun(true)` while open): two lists (window / full screen) + `helpNever` + `sideEffects`, button `enterFullscreen` → `toggleFullscreenWithKeyboardLock()`, Key test line bound to `keyTraceAtom` showing `type · code · key · repeat · ⌘⌃⌥⇧ flags → sent HID codes`, plus a counter 'keyups seen while ⌘ held' (validates A1).
- `src/libs/browser/fullscreen.ts`: `toggleFullscreenWithKeyboardLock()` (requestFullscreen then `navigator.keyboard?.lock()`), `fullscreenchange` listener calls `unlock()` when fullscreen ends (Esc exit); reused by `menu/fullscreen/index.tsx` and `shortcuts/recorder.tsx`.
- `shortcuts/recorder.tsx`: checkbox `recordAsCtrl` (shown and default-checked when remap active) → `remapRecordedCode`; dedupe by mapped code. `shortcuts/index.tsx` default list gains Alt+Tab, Ctrl+Shift+Esc, Win (lone).
- Release all keys row: `driver.releaseAll()` + mouse buttons release (exported `releaseMouseButtons()` from the mouse components via a tiny event bus `libs/mouse/release-bus.ts`).
- `App.tsx`: `beforeunload` effect (active && connected).

## 4. Feature B — pointer / scroll

### 4.1 Pure modules (`src/libs/pointer/`)
```ts
// wheel.ts
export interface WheelSettings { pxPerNotch: number /*100*/; direction: 1 | -1 /*existing, -1 default*/; minIntervalMs: number /*legacy, 0*/ }
export const WHEEL = { GESTURE_GAP_MS: 200, KICK_MIN_PX: 3, REVERSAL_MIN_PX: 2, LINE_PX: 16, PAGE_PX: 800, MAX_NOTCHES: 127 };
export class WheelAccumulator { constructor(s: WheelSettings); update(p: Partial<WheelSettings>): void; feed(e: { deltaX: number; deltaY: number; deltaMode: 0|1|2; t: number }): number /*signed vertical notches to send now*/; reset(): void }
```
`feed`: px = deltaY·[1,16,800][mode]; gap > 200 ms → `acc=0, kick=true, axis=null, lastEmit` untouched; axis lock: first event with max(|dx|,|dy|) ≥ 1 fixes `axis` (horizontal-dominant gesture → return 0 for the whole gesture); reversal: `sign(px) ≠ sign(acc) && |px| ≥ 2` → `acc=0, kick=true`; `acc += px`; `n = trunc(acc/pxPerNotch)`; if `n===0 && kick && |acc| ≥ 3` → `n = sign(acc), acc = 0`; if `n ≠ 0` → `kick=false, acc -= n·pxPerNotch` (unless kicked); legacy rate cap: `minIntervalMs>0 && t-lastEmit < minIntervalMs` → drop (return 0, `acc=0`); else `lastEmit=t`; **return `n * direction`** (regression: deltaY=+100, direction −1 → −1 → wheel byte 0xFF, identical to upstream).
```ts
// relative-motion.ts
export const RELATIVE = { GAIN_MIN: 0.25, GAIN_MAX: 4 };
export class RelativeMotion { constructor(gain = 1); setGain(g: number): void; feed(dx: number, dy: number): { dx: number; dy: number } /*ints; signed remainders carried*/; reset(): void }
export function splitInt8(v: number): number[];   // 300→[127,127,46], -130→[-127,-3], 0→[]
// absolute-map.ts
export function mapClientToVideo(p: {clientX,clientY}, rect: {left,top,width,height}, video: {width,height}|null, rotation: 0|90|180|270): { x: number; y: number };
export function toAbs4095(v: number): number;      // min(4095, floor(clamp01(v)*4096))
```
`mapClientToVideo`: no video → element-relative; displayed aspect swaps for 90/270; letterbox as today; inverse rotation 90:(dy,1−dx) 180:(1−dx,1−dy) 270:(1−dy,dx). `libs/mouse/index.ts`: `MouseAbsoluteRelative.buildReport` uses `toAbs4095`; add `MouseReportRelative.buildReports(dx,dy,wheel): number[][]` using `splitInt8` (one report per chunk, buttons repeated).

### 4.2 Components
`absolute.tsx`: pointer events (`pointerdown/up/move/cancel`, `lostpointercapture`; `pointerType` must be `mouse`|`pen`; touch keeps `touchpad.ts` unchanged in its own effect with the existing deps); `setPointerCapture` on down, release on up; one 'release all held buttons' report on pointercancel/lostpointercapture/window blur/visibility hidden/unmount; `mousedown` listener kept only for `preventDefault`; coordinates via `mapClientToVideo` with `videoRotationAtom`; wheel through `WheelAccumulator` (settings via refs: direction, legacy interval, pxPerNotch); `|notches|>127` → clamp (practically unreachable). `relative.tsx`: `showMessage()` moves into a mount effect; `click` only requests the lock; buttons/moves/wheel forwarded ONLY while locked (constant `FORWARD_WHEN_UNLOCKED=false`); `requestPointerLock()` errors caught (info message, no retry loop); remove x2/DPR rule; `RelativeMotion` with `mouseSensitivityAtom`; split flicks via `buildReports`; `pointerlockchange→unlocked`: release held buttons, reset accumulators. `mouse-jiggler/index.ts`: `device.sendMouseData([0x01, ...report])` for both reports.

### 4.3 Settings UI (`menu/mouse`)
- `speed.tsx` popover: two vertical sliders side by side: existing 'Wheel speed' (made controlled, same mapping) and new 'Scroll sensitivity' (0..100, marks 遅い/速い) ↔ `pxPerNotch = round(400 · 0.1^(v/100))` (v=60 ↔ 100 px default, 100 ↔ 40 px, 0 ↔ 400 px).
- New row `sensitivity.tsx` 'Pointer speed' (icon `MoveIcon`), rendered only when `mouseMode==='relative'`: slider 0..100 ↔ `gain = 0.25 · 16^(v/100)` (50 ↔ 1.0). `initMouse` loads both atoms (`scrollPxPerNotchAtom`, `mouseSensitivityAtom`).

## 5. Feature C — host clipboard → keystrokes (MVP)

### 5.1 Pure compiler (`src/libs/paste/`)
```ts
export type TargetLayout = 'us' | 'jis';
export interface KeyCombo { key: string /*event.code name in KeycodeMap*/; shift?: boolean }
export type LayoutTable = Record<string, KeyCombo>;            // layouts/us.ts, layouts/jis.ts, layouts/index.ts: getTable(layout)
export interface KeyStroke { mod: number; key: number; src: number; tag: 'char'|'enter'|'tab'|'ime-pre' }
export interface CompileOptions { layout: TargetLayout; newline: 'enter'|'shift-enter'; normalizePunct: boolean; stripTrailingNewline: boolean; imePreKey: 'none'|'NonConvert'; maxChars: number /*20000*/ }
export interface CompileResult { strokes: KeyStroke[]; skipped: { char: string; index: number; reason: 'no-key'|'control'|'limit' }[]; stats: { chars: number; typed: number; skipped: number; truncated: boolean; trailingNewlineStripped: boolean } }
export function normalizeText(t: string, o: { punct: boolean }): string;   // ALWAYS: strip BOM, \r\n?→\n, NFC; punct: ‘’‚→' “”„→" –—―→- NBSP→space …→...
export function segmentGraphemes(t: string): string[];                     // Intl.Segmenter('grapheme') if available else Array.from
export function textToKeySequence(text: string, o: CompileOptions): CompileResult;
```
Per grapheme: `\n` → Enter (or Shift+Enter); `\t` → Tab; table hit → stroke; C0/C1 control → skipped `control`; anything else → skipped `no-key` (Japanese text is reported, never silently dropped). Each stroke is executed as press report + release report, so repeated characters need no special case. JIS table (verified against xkb `jp(106)+common` and JetKVM `ja_JP`): `! " # $ % & ' ( )` = Shift+Digit1..9; `-` Minus, `=` Shift+Minus, `^` Equal, `~` Shift+Equal, `\` IntlRo, `_` Shift+IntlRo, `|` Shift+IntlYen, `@` BracketLeft, `` ` `` Shift+BracketLeft, `[` BracketRight, `{` Shift+BracketRight, `;` Semicolon, `+` Shift+Semicolon, `:` Quote, `*` Shift+Quote, `]` Backslash, `}` Shift+Backslash, rest as US; `¥` is non-ASCII (skipped). US table must reproduce `charCodes.ts` exactly (parity test); `charCodes.ts` is deleted once the test passes.

### 5.2 Typing engine (`src/libs/paste/typing-engine.ts`)
```ts
export type SpeedPreset = 'safe' | 'normal';
export const PACING = { safe: { holdMs: 50, gapMs: 50, afterEnterMs: 150 }, normal: { holdMs: 20, gapMs: 20, afterEnterMs: 100 } };
export type StopReason = 'completed'|'cancelled'|'key-interrupt'|'mouse-interrupt'|'tab-hidden'|'serial-error'|'lock-busy';
export interface EngineDeps { send(r: number[]): Promise<void>; lock: HidLock; now(): number; setTimeout; clearTimeout; interruptTarget: EventTarget /*window*/; isInsideOwnUi(target: EventTarget|null): boolean; writeTimeoutMs?: number /*1000*/; watchdogMs?: number /*3000*/ }
export class TypingEngine {
  constructor(deps: EngineDeps);
  get state(): 'idle'|'running'|'stopping';
  run(c: CompileResult, pacing: Pacing): Promise<{ reason: StopReason; typedStrokes: number; totalStrokes: number }>;
  cancel(reason?: StopReason): void;           // releases the lock SYNCHRONOUSLY, aborts the pending sleep; final ZERO stays best-effort
  subscribe(l: (e: { type: 'start'|'progress'|'stop'; done: number; total: number; etaMs: number; reason?: StopReason }) => void): () => void;
}
```
Run: acquire lock (`lock-busy` if held) → install capture listeners on `interruptTarget`: `keydown` (ignore modifiers/CapsLock, `repeat`, and targets inside own UI except Escape), `mousedown`/`touchstart` (ignore inside own UI), `visibilitychange`(hidden)/`pagehide` → cancel with the matching reason → send ZERO → for each stroke: `send(press)`, sleep hold, `send(release=[0…])`, sleep gap(+afterEnter) → FINISH: ZERO (ignore failure), remove listeners, release lock, emit stop. Every `send` is wrapped in `raceWithTimeout(…, writeTimeoutMs)` (timeout ⇒ `serial-error`); a watchdog cancels if no report was sent for `watchdogMs`; whole body in try/finally; subscriber exceptions isolated. Serial disconnect (`SerialPort.handleDisconnect`) calls `typingEngine.cancel('serial-error')`.

### 5.3 HID lock (`src/libs/keyboard/hid-lock.ts`)
`hidLock.acquire('paste')/release/isLocked/onChange/interrupt()`. Cooperation: KeyboardDriver muted while locked (non-modifier keydown → `interrupt()` → engine cancels `key-interrupt`; on unmute the driver sends its current report once, so a chord still physically held after a short run is restored on the target); VirtualKeyboard ignores events and resets its report/modifier state on acquire; Shortcut rows ignore clicks and render `opacity-50 pointer-events-none` (`useHidLocked()` via `useSyncExternalStore`).

### 5.4 Triggers and clipboard
- Paste row stays one click: `navigator.clipboard.readText()` on the click gesture → compile → if `stats.typed===0` show `nothingTypeable` and stop (no lock, no reports) → if graphemes > 2000 confirm with ETA (`strokes × (hold+gap)`) → run. While running the row reads `paste.cancel` and cancels. Errors: `NotAllowedError` with 'focus' → `noFocus`; other `NotAllowedError` → `permDenied` and the settings modal opens on the text box; empty → `empty`; serial not connected → `notConnected`.
- Hotkey `⌘⇧V` (macOS host; chord configurable via the existing shortcut recorder modal reused in read-only 'capture one chord' mode; `hotkeyEnabled` default true) works only while the remap is active (§3.1): the driver consumes the chord (never forwarded, repeats swallowed, no keyup bookkeeping) and calls `pasteController.startFromHotkey()` → same path as the row. Pressing it again during a run cancels. Not active ⇒ ⌘⇧V is forwarded as today.
- `PasteProgressPill` (fixed bottom-center) appears only when ETA > 700 ms, or something was skipped, or the run stopped early; shows progress, `Cancel`, reason, skipped list (unique, max 50); auto-hides 3 s after a clean completion.
- Native `paste` event path, Unicode entry modes, review-before-typing: not in v1 (§7).

### 5.5 Settings (`nanokvm-usb-paste-settings`, `src/libs/paste/settings.ts`, `src/jotai/paste.ts`)
`{ version: 1; speed: 'safe'|'normal' /*normal*/; newline: 'enter'|'shift-enter' /*enter*/; normalizePunct: true; stripTrailingNewline: true; imePreKey: 'none'|'NonConvert' /*none*/; hotkeyEnabled: boolean /*true on macOS hosts*/; hotkey: Chord /*{code:'KeyV',meta:true,shift:true}*/ }` — layout comes from `targetLayoutAtom`. Unknown fields dropped, missing defaulted (forward-migrating, never discarded). UI: gear icon on the Paste row → `paste/settings-modal.tsx` (antd Modal, disables capture like the shortcut recorder): text box + 'Type this text' button (manual fallback), Select speed, Select newline, 3 checkboxes, hotkey line (chord `Kbd`s, enable switch, Change), `capsHint`, link text to the layout row.

## 6. Verification without hardware

### 6.1 Unit tests (vitest, node env; details per task)
Pure modules: remap-config, remap (upstream parity traces, taps, repeat, resync, right-hand modifiers, AltGr, sweep/minPress, rules incl. lone-Alt masking and lazy re-press, collisions, CapsLock, consumed chords, trace), driver with fake timers (tap release timing, cancel on sweep, dry-run sends nothing, mute/unmute resend, ordered sends), wheel (regression against the literal upstream expression, kick gating, axis lock, reversal, gap, legacy drop, deltaMode), relative-motion/splitInt8, absolute-map (letterbox, rotation corners, 4095), layouts (every key in KeycodeMap; US parity with legacy charCodes; all printable ASCII covered for both layouts), normalize/segment (CRLF in both Segmenter and fallback paths, NFC), text-to-keys, typing-engine (fake sink + `new EventTarget()` + fake timers: report sequence for 'aa', cancel, key/mouse/hidden interrupts, write timeout, lock-busy, lock released on every exit), hid-lock, settings normalizers, locale key parity. The baseline `keyboard.test.ts` keeps passing; `KeyboardReport` is unchanged except nothing.

### 6.2 HID log overlay (cheap, kept)
`src/libs/debug/hid-log.ts`: ring buffer (200) of `{t, kind:'kb'|'abs'|'rel', bytes, decoded}` fed by `Device.sendKeyboardData/sendMouseData` (decode: kb → modifier names + key names via reverse `KeycodeMap`; abs → x,y 0..4095, buttons, wheel; rel → dx,dy,wheel,buttons; Δt to previous). `src/components/debug/hid-log.tsx`: fixed bottom-left panel (z-[1001], monospace, 12 rows, Copy/Clear) rendered when `location.search` has `debug=hid` or storage flag set; also opened from the Key test modal.

### 6.3 Manual script on real hardware (user, ~15 min; Japanese copy goes in README)
1. Open with `?debug=hid`. Keyboard → ⌘ key mapping → On. Key test: press ⌘, then C while holding, release: expect `keydown MetaLeft`, `keydown KeyC`, no `keyup KeyC` (A1), `keyup MetaLeft`; press Caps Lock twice: note which events appear (A3); press 英数/かな: expect `Lang2`/`Lang1` (A4); ⌘Tab, ⌘Q, ⌘W in a window and in full screen: note which arrive (A2). Report the four results.
2. Target text editor: ⌘C/⌘V/⌘X/⌘A/⌘Z/⌘F each once → exactly one action; hold ⌘V 2 s → repeated pastes while held, stop on release; ⌘← ⌘→ ⌘⇧← → Home/End/select to line start; ⌥← in a browser → word jump, NOT page back; lone ⌘ tap → no Start menu; ⌘⇧[ ] in full screen → tab switch; fast ⌘C immediately released → copies (minPress).
3. Shortcuts: Alt+Tab default row switches windows; recorder with 'Record ⌘ as Ctrl' records ⌘⇧T as Ctrl+Shift+T.
4. Mouse (absolute): two-finger nudge → exactly one notch; slow 10 cm drag → proportional, stops within a frame of lifting; flick → short proportional tail; reversal mid-gesture → immediate reverse notch; a drag released over the menu bar → button released (HID log shows buttons 0); corners reachable at 4095; rotate 90° → cursor follows.
5. Mouse (relative): click to lock → no click on the target; 1 pt/frame drag → ~1 px/frame, speeding up never slows; fast flick → full distance (HID log shows split reports); Pointer speed slider changes gain; Esc → buttons released.
6. Paste: copy `ascii !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~ ABC xyz 123` on the Mac; JIS selected → identical on a JIS-Windows target; US → identical on a US target; 500-char paragraph at Normal → zero drops; a click on the video mid-paste → stops; text with Japanese → ASCII typed, pill reports skipped count; ⌘⇧V with remap on → types; ⌘W during a paste → 'Leave site?' prompt.

## 7. Deliberately not done (v1)
HID coalescing queue with wire-clock pacing (wire ~27 % utilised at 120 Hz; revisit only if `await write()` latency is measured to grow); ACK/RX reader loop and NumLock/CapsLock LED sync; momentum detector; `unadjustedMovement` raw input; precision key; Shift+wheel horizontal / Ctrl+wheel pinch overlays; carry semantics for the legacy wheel interval; ⌘Tab→Alt+Tab, ⌘Q→Alt+F4, ⌘⇧Z→Ctrl+Y rules; right-⌘-as-Win; separate 'linux' preset; Unicode entry (Alt-codes/CP932/Ctrl+Shift+U/Option-hex); ⌘V-types-host-clipboard with Ctrl+V fallback; native `paste`-event capture; tabbed paste modal; 'fast'/custom pacing; target→host (OCR); leader key.

## 8. Behaviour changes for users who touch nothing
Scroll becomes proportional (px accumulator, kick) instead of one notch per event; relative mode loses the x2/DPR doubling and no longer forwards clicks/moves/wheel while unlocked; flicks keep full distance; x=1.0 maps to 4095; jiggler actually jiggles (relative mouse command); paste types at 20/20 ms with progress/cancel and hard stops, JIS mapping only when the layout row is set to JIS; Japanese-locale browsers switch to the Japanese UI. Everything else on the wire is byte-identical (verified by the parity tests).
## 9. Overrides applied in v1 as shipped (owner addendum, 2026-11-03)

The shipped code deviates from the sections above in four places, decided by the project owner after the spec was frozen. Where this section and an earlier section disagree, this section describes the code.

1. **⌘ remap default ON** (§3.1, §3.2, §8): `DEFAULT_REMAP_CONFIG.enabled = true`. The remap is still active only when `hostOS === 'macOS' && targetOs !== 'macos'`, so non-Mac hosts and macOS targets are unaffected. Rationale: the fork exists for a Mac host driving a Windows/Linux target; an opt-in default would ship the upstream behaviour the fork was made to fix.
2. **No first-run badge** (§2.2, §2.3, §3.6): the `nanokvm-usb-keyboard-remap-seen` key, the `keyboard.remap.badgeTip` string and the blue dot on the keyboard menu icon were dropped. The remap row is simply visible on macOS hosts.
3. **In-flight MOVE coalescing** (§7 listed it as not done): `src/libs/pointer/move-queue.ts` coalesces mouse MOVE reports while a serial write is in flight. Absolute mode keeps only the latest position; relative mode sums the deltas and splits them into int8 chunks at send time. Button, wheel and release reports are never dropped and are sent after any move queued before them. There is no wire-clock pacing. The keyboard path is not queued; the keyboard driver keeps its own ordered promise chain.
4. **cmdTabSwitch matches the printed character** (§3.2 rule table): with `{meta,shift}` held, `event.key` `[` or `{` → Ctrl+Shift+Tab and `]` or `}` → Ctrl+Tab. The `BracketLeft`/`BracketRight` code table is only the fallback for unprintable or absent keys, so JIS keyboards (where `BracketRight` prints `[`) work and `BracketLeft` (`@` on JIS) no longer fires.

Smaller deviations found during implementation are listed in README.md ("Deviations from `docs/spec-v1.md`") and docs/README.ja.md ("仕様書との相違点").
