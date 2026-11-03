# NanoKVM-USB Browser

This is the NanoKVM-USB browser version project.

Online website: [usbkvm.sipeed.com](https://usbkvm.sipeed.com).
This fork's hosted build: [yka57.github.io/kawa-kvm](https://yka57.github.io/kawa-kvm/)
(see _Run it on the Mac_).

## About this fork (kawa-kvm)

A personal fork of the browser app for a **Mac host** (MacBook trackpad, Japanese, Chrome)
operating a Windows machine through a NanoKVM-USB. It adds three things on top of upstream:

| Feature                                                                                                                                                                                                                                  | Where                                                    | Default                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| **⌘ key mapping** — ⌘ is sent as Ctrl (⌘C/⌘V/⌘F… arrive as Ctrl+C/V/F), plus Mac navigation rules (⌘←/→ → Home/End, ⌥←/→ → Ctrl+←/→, ⌘⇧[ ] → Ctrl+Shift+Tab / Ctrl+Tab)                                                                  | Keyboard menu → _⌘ key mapping (Mac)_ (macOS hosts only) | **On** while the host is macOS and the Target OS is not macOS   |
| **Trackpad / scroll fidelity** — proportional two-finger scrolling with a _Scroll sensitivity_ slider, pointer capture in absolute mode (no stuck buttons), a _Pointer speed_ gain in relative mode, in-flight coalescing of mouse moves | Mouse menu → _Wheel speed_ / _Pointer speed_             | 100 px per notch, gain ×1.00                                    |
| **Host clipboard → keystrokes** — one click (or ⌘⇧V) types the Mac clipboard on the target with the US or JIS key table, progress pill, cancel on any host key or click                                                                  | Keyboard menu → _Paste host clipboard_ (gear = settings) | Normal speed (20 ms / 20 ms), Enter, ⌘⇧V enabled on macOS hosts |

Plus the shared _Target OS_ / _Target keyboard layout_ rows, a complete Japanese UI (auto-selected
for Japanese browsers), a _Release all keys_ row and the HID log overlay described below.

The full documentation is in Japanese:

- [docs/README.ja.md](docs/README.ja.md) — every feature and setting with its default and storage key, side effects, known limits.
- [docs/TESTING.ja.md](docs/TESTING.ja.md) — the hardware checklist (about 15 minutes) with result tables for the assumptions the design rests on and the open questions.
- [docs/spec-v1.md](docs/spec-v1.md) — the implementation spec (English). Where it disagrees with the code, the code and this README describe what ships (see _Deviations from the spec_).

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
parity with upstream's `charCodes.ts`, kept verbatim as `src/test/legacy-char-codes.ts`), the
typing engine, the settings normalisers, the locale key parity between `en` and `ja`, and the HID
log. The hardware checklist in `docs/TESTING.ja.md` covers what cannot be tested without the device.

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

## Behaviour changes versus upstream (for users who touch no setting)

- **macOS hosts: ⌘ is sent as Ctrl by default** (upstream: ⌘ = Win). Turn it _Off_ in
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
  table is used only when the Target layout row says JIS; non-ASCII characters are reported as
  skipped instead of being dropped silently.
- Japanese-locale browsers get the Japanese UI.

Everything else on the wire is byte-identical to upstream (verified by the parity tests).

### Deviations from `docs/spec-v1.md`

- `DEFAULT_REMAP_CONFIG.enabled` is `true` (spec §3.1/§3.2 say `false`).
- No first-run badge: no `nanokvm-usb-keyboard-remap-seen` key, no blue dot, no `badgeTip` string.
- Mouse move coalescing exists (`src/libs/pointer/move-queue.ts`, moves only, no pacing) although
  spec §7 lists an HID queue as not done.
- `cmdTabSwitch` (⌘⇧[ / ⌘⇧]) matches on the printed character when the event carries one, so it
  also works on a JIS Mac where `[` has the code `BracketRight`.

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
