# NanoKVM-USB Browser

This is the NanoKVM-USB browser version project.

Online website: [usbkvm.sipeed.com](https://usbkvm.sipeed.com).
This fork's hosted build: [yka57.github.io/kawa-kvm](https://yka57.github.io/kawa-kvm/)
(see _Run it on the Mac_).

## About this fork (kawa-kvm)

A personal fork of the browser app for a **Mac host** (MacBook trackpad, Japanese, Chrome)
operating a Windows machine through a NanoKVM-USB. It adds three things on top of upstream:

| Feature                                                                                                                                                                                                                                                                                         | Where                                                    | Default                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **⌘ key mapping** — ⌘ + C/V/A/F/X/Z (configurable) is sent as Ctrl, ⌘ + any other key as Win (⌘⇧S = Win+Shift+S), ⌘ alone = Win; split off = every ⌘ is Ctrl; plus Mac navigation rules (⌘←/→ → Home/End, ⌥←/→ → Ctrl+←/→, ⌘⇧[ ] → Ctrl+Shift+Tab / Ctrl+Tab)                                   | Keyboard menu → _⌘ key mapping (Mac)_ (macOS hosts only) | **On** while the host is macOS and the Target OS is not macOS                     |
| **Trackpad / scroll fidelity** — proportional two-finger scrolling with a _Scroll sensitivity_ slider, pointer capture in absolute mode (no stuck buttons), a _Pointer speed_ gain in relative mode, in-flight coalescing of mouse moves                                                        | Mouse menu → _Wheel speed_ / _Pointer speed_             | 100 px per notch, gain ×1.00                                                      |
| **Host clipboard → keystrokes** — one click (or ⌘⇧V) types the Mac clipboard on the target with the US or JIS key table, progress pill, cancel on any host key or click; Japanese and other non-ASCII text goes through the target browser (Windows) or Ctrl+Shift+U (Linux)                    | Keyboard menu → _Paste host clipboard_ (gear = settings) | Normal speed (20 ms / 20 ms), Enter, non-ASCII _Auto_, ⌘⇧V enabled on macOS hosts |
| **Dictation bar** — a host-side text field (macOS dictation or the host IME writes into it) whose text is typed on the target on Enter or after a pause; with the _IME code input_ method (Windows target, Japanese Microsoft IME, nothing to set up) Japanese arrives without opening a window | Keyboard menu → _Dictation bar_                          | Off; auto-send on                                                                 |

Plus the shared _Target OS_ / _Target keyboard layout_ rows, a complete Japanese UI (auto-selected
for Japanese browsers), a _Release all keys_ row and the HID log overlay described below.

The full documentation is in Japanese:

- [docs/README.ja.md](docs/README.ja.md) — every feature and setting with its default and storage key, side effects, known limits.
- [docs/TESTING.ja.md](docs/TESTING.ja.md) — the hardware checklist (about 30 minutes) with result tables for the assumptions the design rests on and the open questions.
- [docs/spec-v1.md](docs/spec-v1.md) — the implementation spec (English). Where it disagrees with the code, the code and this README describe what ships (see _Deviations from the spec_).
- [docs/spec-v2-japanese-paste.md](docs/spec-v2-japanese-paste.md) — spec v2 (English): Japanese and other non-ASCII paste, the IME-off key and the Caps Lock pre-flight. Its §14 (the owner addendum after the review) overrides the earlier sections; spec v1 still applies where it is silent.

## Japanese and other non-ASCII text

Spec: [docs/spec-v2-japanese-paste.md](docs/spec-v2-japanese-paste.md); its §14 (the owner
addendum after the review) overrides the earlier sections. Every stop message, the Linux caveats
and the ETA table are in [docs/README.ja.md](docs/README.ja.md).

Text the target layout can type completely (ASCII, after the optional punctuation folding, which
also removes the invisible U+00AD, U+200B, U+200C, U+200D, U+2060 and U+FEFF) is typed key by key
as before. Otherwise the _Japanese and other non-ASCII_ setting decides for the whole text, and the
text arrives byte-exact (no punctuation folding, no NFC). A single character without a key is
enough: on a Windows target, `Set the oven to 180°C` (or `café`, `• item`, `a → b`, `3 × 4`, or an
invisible character the folding keeps) goes through the browser as a whole. _Skip (ASCII only)_
keeps the v1 behaviour: only those characters are skipped and listed. _Auto_ picks by Target OS:

| Target OS | _Auto_ uses            | What happens                                                                                                            |
| --------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Windows   | Via the target browser | The whole text, ASCII included, goes through a temporary private window in the target browser and is pasted with Ctrl+V |
| Linux     | Ctrl+Shift+U           | Characters with a key are typed directly, every other code point as Ctrl+Shift+U, lowercase hex digits, Space           |
| macOS     | Skip (ASCII only)      | Non-typeable characters are skipped and listed: both methods drive the target with Ctrl chords                          |

Two more methods exist for Windows targets. They are chosen explicitly, never by _Auto_, and type
into whatever field has the focus without opening a window: _IME code input_ (recommended, nothing
to set up on the target; see _IME code input_ below) and _Alt + numpad_ (hex entry: needs the
`EnableHexNumpad` registry value, a new sign-in and NumLock on). Both type characters that have a
key directly and every other code point by its code.

The bridge, step by step (the pill shows each phase and _Don't touch anything until it finishes_;
none of the text is typed before the check page has worked):

1. Wait for a readable video frame (up to 1 s) and a still target screen: two frames 0.3 s apart
   that differ by less than 2 %, within 2.5 s. Otherwise stop before anything is sent, because
   scrolling or video would pass for a new window. Then open a window (Ctrl+Shift+N, Ctrl+Shift+P
   or Ctrl+N, see _Window opened by the bridge_) and wait up to 4 s until a tenth of the captured
   screen has changed; Ctrl+L, then the IME-off key.
2. On every run, type the check page
   `data:text/html,<body bgcolor=red><script>document.bgColor='magenta'</script>` and wait up to
   5 s. Magenta proves that the keys reach a browser address bar with this layout, IME and letter
   case. Under Caps Lock the script fails (`DOCUMENT` is undefined) and the page stays red: Ctrl+W
   (the page is ours), stop. Neither colour: stop without Ctrl+W.
3. Type the text as a `data:text/html;charset=utf-8;base64,…` URL, then Delete and Enter. The page
   puts it in a textarea and turns lime when its hash matches, red otherwise (red: Ctrl+W, stop).
4. Escape, Ctrl+A, Ctrl+C. The page's copy handler puts exactly the checked text on the clipboard
   and turns blue; no blue within 1.5 s: stop without Ctrl+W or Ctrl+V.
5. Ctrl+W, then wait up to 3 s until the screen matches the one from before the window (blue gone,
   less than a tenth changed); only then Ctrl+V into the field that had the focus before.

- **Requirements:** the target focus is in Chrome, Edge or Firefox. The window chord goes to the
  foreground app: Notepad, Windows Terminal and VS Code open a new window on Ctrl+Shift+N, the check
  page URL (and Enter) is typed into it and the run stops at the check page; none of the clipboard
  text is typed there, and that window has to be closed by hand. With Firefox always choose
  _Firefox private (Ctrl+Shift+P)_: Firefox's Ctrl+Shift+N reopens the last closed window, whose tab
  the run would then use and close, ending at the close check instead of pasting. The video is
  showing, the target screen is still when the run starts, and the HDMI capture shows the new
  window. The IME-off key (HID LANG2, 0x91) needs Windows 10 2004+ or Windows 11 with the Japanese
  keyboard layout.
- **Side effects:** a private window flashes (the check page red then magenta, the text page lime
  then blue); the target clipboard (and the Windows clipboard history) holds the text; the target
  IME is left off; _Normal new window (Ctrl+N)_ keeps the URL, and so the text, in the browser
  history. Blue proves that Ctrl+C reached the page, not that the OS accepted the clipboard write.
- The first bridge run shows a one-time explanation with the ETA (`nanokvm-usb-paste-bridge-intro`).
  At Normal speed a run costs about 22 s (screen check, check page and window included) plus 0.16 s
  per Japanese character and 0.05 s per ASCII character: 300 Japanese characters take about 71 s.
- Every paste, whatever the method: Windows targets get the IME-off key before the text (the
  bridge sends it in the new window's address bar), and a target Caps Lock that the device reports
  as on is switched off first (JIS: Shift+CapsLock). Neither is restored. With _Turn the target Caps
  Lock off automatically_ unchecked, the settings warn instead that letters are inverted when the
  target has Caps Lock on (a bridge run then stops at the red check page).
- While a paste runs, mouse moves and wheel reports (trackpad momentum included) are not sent;
  button presses and releases are, and a press stops the run.
- Linux (Ctrl+Shift+U): a cancel from the pill, row or hotkey, or a host key (muted, so it never
  reaches the target), lets the character being entered finish; a click (it reaches the target) or
  hiding the tab stops at once. Press Escape on the target if a half-entered code is left.
- New _Fast_ speed (10 ms hold / 10 ms gap / 60 ms after Enter). The settings are stored as
  version 2; a version 1 `imePreKey: 'none'` becomes `'auto'`.
- _Alt + numpad_ (Windows, hex entry): Alt stays down over keypad + and the UTF-16 code unit in
  hex. It needs the string value `EnableHexNumpad` = `1` under
  `HKEY_CURRENT_USER\Control Panel\Input Method`, a new sign-in, and **NumLock on**: measured under
  the default (new) Microsoft IME, nothing at all is typed while NumLock is off.
- Not done: decimal Alt codes on Windows (measured: the default Microsoft IME keeps only the low
  byte of the value, so Alt+33440 types `á` instead of `あ`; from desk research, not measured,
  because the lab ran no RichEdit application: RichEdit reads the value as Unicode), splitting
  long bridge texts, macOS targets, restoring the IME or Caps Lock state.

### IME code input (Windows targets, no window)

_Japanese and other non-ASCII_ → _IME code input (Windows, no window)_ types through the code input
of the Japanese Microsoft IME. The text goes into whatever field has the focus, no window opens,
the target clipboard is not touched and nothing has to be changed on the target: the recommended
way to type Japanese without a window, for the dictation bar for instance. _Auto_ never picks it,
because it needs the Japanese Microsoft IME as the target's active input method.

- **Sequence:** LANG2 (IME off) first, whatever _Turn the target IME off before typing_ says,
  also for a text the layout can type completely, which is typed key by key as before (this is
  the one method that can leave the IME on). ASCII and line breaks are typed with the IME off
  through the layout table. A stretch of other characters starts with LANG1 (IME on, hiragana
  mode, from every starting mode). Each code point is its code in lower-case hex on the main-row
  digits and the letter keys a–f (exactly four digits up to U+FFFF, exactly six above, never
  five: `3042`, `00e9`, `01f600`), F5 to convert and Ctrl+M to commit, as one unit that a cancel
  does not split. LANG2 ends the stretch. `aあ😀b` is LANG2, a, LANG1, 3 0 4 2 F5 Ctrl+M,
  0 1 f 6 0 0 F5 Ctrl+M, LANG2, b. U+30000–U+3FFFF does not convert and is entered as its two
  UTF-16 surrogates, each with its own F5 and Ctrl+M; a cancel does not split the two either.
- **Tab:** a Tab inside a text that goes by IME code input is entered as a tab character (code
  `0009`, like any other character), not pressed as a key. The Tab key would move the focus out
  of the field, and the F5 of the next character would then reach the application with nothing
  to convert. Measured in both Edge fields, CKEditor 5 and Notepad: the tab character is inserted
  and the focus stays. A text the layout can type completely still presses the Tab key, as with
  every other method: in a web field the focus moves on and the rest of the text is typed there.
- **Commit key:** Ctrl+M, because Enter would be a line break (send, in a chat box) after every
  code if the IME were off after all. Sent with nothing to convert, Ctrl+M did not change the
  field, the focus or the IME state in Edge; whether Edge's own Ctrl+M shortcut (mute tab) fires
  was not checked. During a conversion the page gets the chord only as key events with keyCode
  229: in more than 500 measured runs no Edge field and no CKEditor 5 editor saw a Ctrl+M
  keydown, an Enter that would send, or a plain F5. Microsoft Teams has Ctrl+M as a shortcut (move
  focus to the message pane). Its web client code, read in November 2026, looks shortcuts up by
  keyCode on keydown, so with the default shortcuts it reacts neither to the chord nor to an
  Enter during a conversion; a shortcut the user re-assigned is matched differently and would
  fire. That is a reading of the code, not a measurement of Teams. If the IME is off after all,
  each Ctrl+M moves the focus out of the Teams message box (nothing is sent).
- **Measured** in a virtual machine on Japanese Windows 11 (26H2, build 26300), default (new)
  Microsoft IME, romaji input. With a test sender, in an Edge textarea and an Edge contenteditable
  field: about 26,000 characters, none wrong at 20 ms / 20 ms and at 10 ms / 10 ms; one failure
  class appeared at 5 ms / 5 ms and faster only (a digit swallowed after a line break in a
  contenteditable field). With the keys this app sends, in those two fields and in CKEditor 5
  (39.0.0, 47.6.2, 49.1.0; the editor Teams builds its message box on): at 20 ms / 20 ms no
  character was wrong (15 chat messages and 15 other texts in each of the five fields; 58 of 58
  first pastes after a focus change). With every key at 10 ms / 10 ms, the first paste after the
  field got the focus (a page load, a click into it) lost a digit in about 1 run in 10 (20 of 200;
  the two Edge fields: 0 of 75), because the IME's second conversion after a focus change takes
  23–30 ms instead of about 5. With F5 and Ctrl+M at 40 ms that was gone (196 of 196), but a page
  that needed 30 ms for every input event still fell behind digits 20 ms apart and lost one in
  10 of 84 runs; and with every key 40 ms apart but held for only 10 ms, 2 of 20 first pastes
  after a load of that slow page lost one. At 20 ms / 20 ms that slow page lost nothing (104 of
  104 runs, 20 of them first pastes after a load).
- **Pace:** six strokes per character at 20 ms / 20 ms: about 0.24 s per character (300 Japanese
  characters: about 72 s). A text that needs IME code input is typed at the pace of Normal even
  when the speed is Fast: the whole text, its ASCII and line breaks included, exactly as at Normal
  (see _Measured_). Safe takes about 0.6 s per character. The pace sets how slow a destination may
  be: a page that needed 45 ms or more for every input event lost digits at 20 ms / 20 ms too
  (5 of 46 runs), and none at Safe (30 of 30). A character that arrives as full-width digits and
  letters (`資５９９は` for `資料は`) means the destination is not keeping up: switch to Safe. The
  app also waits an extra 100 ms after the first F5 of every stretch as a margin.
- **Limits:** with the target IME set to kana input (not the default) the code keys type kana and
  every character comes out wrong, silently. Where the IME does not come on (no Japanese IME
  active, an IME-disabled field) the digits arrive as plain text and F5 / Ctrl+M reach the
  application; in Edge such an F5 reloaded the page. Every commit goes into the target IME's input
  history (prediction suggestions).
- **After a stop:** a run that stops in the middle of a text can leave the target IME on. A cancel
  (pill, row, hotkey) or a host key lets the character being entered finish first; when that was
  the last character, only the IME-off key is left, so the run sends it and ends as _Done_. The
  dictation bar then keeps the chunks still queued instead of sending them: it was a stop. A
  click, a hidden tab or a serial error stops at once, in the middle of a character: before trying
  again, press Escape two or three times on the target, even when nothing seems to be left over.
  The digits typed so far stay inside the IME as an unfinished conversion and can come back with
  the next key. Measured without the Escape: they remain in the field, and the first character of
  the next Japanese stretch arrives as its code keys (`お疲３０４え８６解しました` for `お疲了解しました`); with one
  Escape first, the texts typed next arrived exactly.
- **Not measured:** the Microsoft Teams desktop app, Windows 10, a real USB keyboard path (the
  NanoKVM-USB itself). `docs/TESTING.ja.md` has the rows to check them (6-22 to 6-28).
- First trial: Notepad on the target, then the real destination. In Notepad ordinary text and
  single emoji arrived exactly; an F5 with nothing to convert inserts the time and date there (a
  visible sign that the IME did not come on); emoji made of several code points (flags, families,
  skin tones) are broken by Notepad itself. For chat apps where Enter sends (Teams), set _Newline_
  to Shift+Enter.

## Run it on the Mac

**Easiest: open the hosted build.** Every push to `main` is built by GitHub Actions
(`.github/workflows/pages.yml`, `npm run build:pages` = `build` with `--base=/kawa-kvm/`) and
published to

**https://yka57.github.io/kawa-kvm/**

Plug the NanoKVM-USB into the Mac, open that URL in Chrome and allow the camera and the serial
port. Nothing is installed: the page runs inside Chrome and talks to the device over the Mac's
USB; the server only hands out the static files (`https://` is a secure context, so WebSerial
works there). Reload the page to pick up a new deployment.

**Or run it locally.** WebSerial (and the camera) only work in a **secure context**, so run the
dev server on the Mac the NanoKVM-USB is plugged into and open it through `localhost`:

```shell
git clone https://github.com/yka57/kawa-kvm.git   # or rsync the folder to the Mac
cd kawa-kvm
npm install
npm run dev                   # Vite on http://localhost:3001
```

Open **http://localhost:3001** in Chrome (desktop Chrome/Chromium: WebSerial is Chromium-only).
`http://localhost` counts as secure, so the serial and camera permission prompts appear there.

A plain **`http://` LAN origin is NOT a secure context**: opened from another machine as
`http://192.168.x.x:3001` the app shows "Serial not supported" and gets no camera. Serve it over
**HTTPS** or use **localhost** on the machine the device is attached to.
`npm run build && npm run preview` serves the production build on http://localhost:4173.

Requirements: Node 22 (Vite 7 needs ≥ 20.19 / 22.12) and npm. `package-lock.json` is the lock
file used here; upstream's `pnpm-lock.yaml` is kept as is.

## Tests and checks

```shell
npm test            # vitest, node environment, no hardware needed
npm run typecheck   # tsc -b (type-checks the tests too)
npm run lint        # eslint
npm run build       # tsc -b && vite build
```

The unit tests cover the pure modules: the ⌘ remap state machine and driver (byte-identical
upstream traces while the remap is off), the wheel accumulator (regression against upstream's
expression), relative motion and absolute mapping, the move queue, the paste compiler (US table
parity with upstream's `charCodes.ts`, kept verbatim as `src/test/legacy-char-codes.ts`), the paste
planner, the browser bridge (the generated page script against `bridgeHash`, whole runs against a
scripted screen), Ctrl+Shift+U, Alt+numpad and IME code-input entry, the frame probe, the CH9329
frame parser, the serial read loop and the lock-state query, the typing engine, the settings
normalisers (including the v1 → v2 migration), the locale key parity between `en` and `ja`, and the
HID log. The hardware checklist in `docs/TESTING.ja.md` covers what cannot be tested without the
device.

## Debugging: the HID log overlay

Open the app with **`?debug=hid`** (`http://localhost:3001/?debug=hid`), or click _HID log_ at the
bottom of the Key-test modal (Keyboard → ⌘ key mapping → _Which shortcuts can be sent?_). A
monospace panel at the bottom left shows the last 12 reports handed to the device; the buffer
keeps 200 and _Copy_ exports all of them. Example (⌘C with the remap on, then a wheel notch and a
relative move):

```
 +Δt  kind  bytes                    decoded
  +0  kb    01 00 00 00 00 00 00 00  Ctrl
 +12  kb    01 00 06 00 00 00 00 00  Ctrl + C
 +50  kb    01 00 00 00 00 00 00 00  Ctrl
+180  kb    00 00 00 00 00 00 00 00  (none)
  +8  abs   02 00 ff 0f 00 08 ff     x=4095 y=2048 btn=- whl=-1
  +9  rel   01 01 7f 00 00           dx=127 dy=0 btn=L whl=0
```

`kb` is the 8-byte keyboard report, `abs` the absolute mouse payload (x/y 0..4095, little endian),
`rel` the relative mouse payload (signed int8). Δt is the time since the previous report of any
kind. A report whose serial write failed is shown in red. The close button clears the flag
(`nanokvm-usb-debug-hid`); a `?debug=hid` URL shows the panel again on the next load.
Only reports for the target are logged: the device's replies and the paste's GET_INFO
lock-state query are not.

## Behaviour changes versus upstream (for users who touch no setting)

- **macOS hosts: ⌘ + C/V/A/F/X/Z is sent as Ctrl by default, other ⌘ chords as Win** (upstream: ⌘ = Win). Turn it _Off_ in
  Keyboard → ⌘ key mapping to get upstream's keyboard bytes exactly; it is also inactive while the
  Target OS is set to macOS. While it is active and serial is connected, closing or reloading the
  tab asks for confirmation (⌘W / ⌘Q are Chrome-reserved and would end the session silently).
- Scrolling is proportional (pixel accumulator with a first-notch kick) instead of one notch per
  wheel event: a short two-finger nudge is one notch, a flick a short proportional tail.
- Absolute mode uses pointer events with pointer capture: a drag released outside the video
  releases the button; held buttons are released on window blur and when the tab is hidden.
- x = 1.0 maps to 4095 (upstream produced 4096).
- Relative mode: the x2 / devicePixelRatio doubling is gone (a gain slider replaces it), nothing is
  forwarded while the pointer is not locked (the lock-acquiring click no longer clicks on the
  target), flicks keep their full distance (split into several int8 reports) and losing the lock
  releases held buttons.
- Mouse MOVE reports are coalesced while a serial write is in flight (the newest absolute position
  wins, relative deltas are summed). Button, wheel and release reports are never dropped and keep
  their order; keyboard reports are not coalesced.
- The mouse jiggler actually moves the pointer (relative mouse frames; upstream sent them as
  keyboard frames).
- Paste types at 20 ms / 20 ms (upstream: a fixed 50 ms hold, no gap, no way to stop) with a
  progress pill, cancel, and hard stops on any host key, click, hidden tab or serial error. The JIS
  table is used only when the Target layout row says JIS. Text the layout cannot type (Japanese
  etc.) goes through the target browser on Windows targets and Ctrl+Shift+U on Linux targets; on
  macOS targets it is reported as skipped instead of being dropped silently.
- Windows targets get the IME-off key (HID LANG2) before the text of a paste, and a target Caps
  Lock that the device reports as on is switched off first.
- While a paste runs, mouse move and wheel reports are dropped (absolute, relative and touch);
  button presses and releases still go through.
- The serial port is read continuously (upstream left the device's replies unread), also after a
  recoverable read error (break, framing, parity, overrun) when the port offers a new stream.
  With _Turn the target Caps Lock off automatically_ on (the default), a paste first asks the
  CH9329 for the target's lock state with GET_INFO (`57 AB 00 01 00 03`); that command goes to
  the chip, not to the target.
- Japanese-locale browsers get the Japanese UI.

Everything else on the wire is byte-identical to upstream (verified by the parity tests).

### Deviations from `docs/spec-v1.md`

- `DEFAULT_REMAP_CONFIG.enabled` is `true` (spec §3.1/§3.2 say `false`).
- No first-run badge: no `nanokvm-usb-keyboard-remap-seen` key, no blue dot, no `badgeTip` string.
- Mouse move coalescing exists (`src/libs/pointer/move-queue.ts`, moves only, no pacing) although
  spec §7 lists an HID queue as not done.
- `cmdTabSwitch` (⌘⇧[ / ⌘⇧]) matches on the printed character when the event carries one, so it
  also works on a JIS Mac where `[` has the code `BracketRight`.

### Notes on `docs/spec-v2-japanese-paste.md`

- Where the spec is silent: the bridge replaces lone surrogates with U+FFFD before building the
  page (UTF-8 cannot carry them, so the page would always turn red).

## Development

This repository is the browser app itself (upstream keeps it under `browser/`).

```shell
npm install
npm run dev
```

## Deployment

1. Execute `npm run build` to build the project.
2. Execute `npm install -g http-server` to install http-server.
3. Execute `cd dist` to change working directory to `dist/` .
4. Execute `http-server -p 8080 -a localhost` to run the service.
5. Open the Chrome browser and visit `http://localhost:8080`.

### Deploy in Docker (upstream)

```shell
git clone https://github.com/sipeed/NanoKVM-USB.git
cd NanoKVM-USB
docker-compose up -d
```

Then visit `http://localhost:9000` in your browser.
