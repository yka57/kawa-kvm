const en = {
  translation: {
    serial: {
      notSupported:
        'Serial not supported. Please use the desktop Chrome browser to enable mouse and keyboard.',
      failed: 'Failed to connect serial. Please try again'
    },
    camera: {
      tip: 'Waiting for authorization...',
      denied: 'Permission Denied',
      authorize:
        'Remote desktop requires camera permission. Please authorize camera in browser settings.',
      failed: 'Failed to connect camera. Please try again.'
    },
    modal: {
      title: 'Select USB Device',
      selectVideo: 'Please select a video input device',
      selectSerial: 'Select serial device'
    },
    menu: {
      serial: 'Serial',
      keyboard: 'Keyboard',
      mouse: 'Mouse'
    },
    target: {
      os: 'Target OS',
      layout: 'Target keyboard layout',
      windows: 'Windows',
      linux: 'Linux',
      macos: 'macOS',
      us: 'US (ANSI)',
      jis: '日本語 (JIS)'
    },
    video: {
      resolution: 'Resolution',
      scale: 'Scale',
      auto: 'Auto',
      rotation: 'Rotation',
      customResolution: 'Custom',
      device: 'Device',
      custom: {
        title: 'Custom Resolution',
        width: 'Width',
        height: 'Height',
        confirm: 'Ok',
        cancel: 'Cancel'
      }
    },
    audio: {
      tip: 'Tip',
      permission:
        'Microphone access is required to connect your USB audio device. The operating system classifies USB inputs as microphones, so this permission is necessary.\n\nThis action is solely for device connectivity and does not enable audio recording.',
      viewDoc: 'View document.',
      ok: 'Ok'
    },
    keyboard: {
      paste: 'Paste',
      virtualKeyboard: 'Keyboard',
      shortcut: {
        title: 'Shortcuts',
        custom: 'Custom',
        capture: 'Click here to capture shortcut',
        clear: 'Clear',
        save: 'Save',
        captureTips:
          'Capturing system-level keys (such as the Windows key) requires full-screen permission.',
        enterFullScreen: 'Toggle full-screen mode.'
      },
      remap: {
        title: '⌘ key mapping (Mac)',
        off: 'Off (send ⌘ as Win)',
        on: 'On (⌘ → Ctrl / Win)',
        split: 'Only listed keys: ⌘ → Ctrl; any other ⌘ is Win (⌘ alone = Win)',
        ctrlKeys: 'Keys sent with Ctrl',
        ctrlKeysHint: 'Letters/digits, e.g. ACFVXZ. Turn off to send every ⌘ as Ctrl',
        inactiveMacTarget: 'Disabled: target OS is macOS',
        nav: 'Also convert Mac navigation (⌘←/→, ⌥←/→, ⌘⇧[ ])',
        jis: '英数/かな → 無変換/変換 (MS-IME with IME-off/on assigned)',
        capsLock: 'Fix Caps Lock sync',
        help: 'Which shortcuts can be sent?',
        helpWindow: 'Work in a normal window',
        helpFullscreen: 'Work only in full screen',
        helpNever: 'Everything else (⌘Tab, ⌘Space, ⌘Q…): use Shortcuts',
        sideEffects:
          'Split off: ⌘-click = Ctrl+click, ⌘+wheel = Ctrl+wheel (zoom). Split on: ⌘ is only sent together with a key (⌘⇧S = Win+Shift+S, …)',
        enterFullscreen: 'Enter full screen',
        keyTest: 'Key test',
        keyTestHint: 'Keys are NOT sent while this is open',
        releaseAll: 'Release all keys',
        recordAsCtrl: 'Record ⌘ as Ctrl',
        imeHint: 'Host IME is composing; switch the host input source to English',
        keyTestEmpty: 'Press keys on the host keyboard…',
        keyupsUnderMeta: 'Key-ups seen while ⌘ held: {{n}}'
      }
    },
    mouse: {
      cursor: {
        title: 'Cursor',
        pointer: 'Pointer',
        grab: 'Grab',
        cell: 'Cell',
        hide: 'Hide'
      },
      mode: 'Mouse mode',
      absolute: 'Absolute mode',
      relative: 'Relative mode',
      direction: 'Wheel direction',
      scrollUp: 'Scroll up',
      scrollDown: 'Scroll down',
      speed: 'Wheel speed',
      fast: 'Fast',
      slow: 'Slow',
      requestPointer: 'Using relative mode. Please click desktop to get mouse pointer.',
      pointerLockFailed: 'Could not capture the mouse pointer. Click the video again.',
      jiggler: {
        title: 'Mouse Jiggler',
        enable: 'Enable',
        disable: 'Disable'
      },
      scrollSensitivity: 'Scroll sensitivity',
      pointerSpeed: 'Pointer speed',
      relativeOnly: 'Relative mode only'
    },
    settings: {
      language: 'Language',
      document: 'Document',
      download: 'Download'
    },
    paste: {
      title: 'Paste host clipboard',
      settings: 'Paste settings',
      cancel: 'Cancel',
      typeText: 'Type this text',
      textPlaceholder: 'Paste text here (⌘V)',
      speed: 'Speed',
      speedSafe: 'Safe',
      speedNormal: 'Normal',
      speedFast: 'Fast',
      newline: 'Newline',
      newlineEnter: 'Enter',
      newlineShiftEnter: 'Shift+Enter',
      unicodeMethod: 'Japanese and other non-ASCII',
      unicodeAuto: 'Auto (Windows: via browser / Linux: Ctrl+Shift+U)',
      unicodeBridge: 'Via the target browser',
      unicodeCtrlShiftU: 'Ctrl+Shift+U (Linux)',
      unicodeSkip: 'Skip (ASCII only)',
      bridgeHint:
        'Opens a temporary window in the target browser, types the text as a URL, copies it and pastes it into the original field. The target clipboard is overwritten.',
      unicodeHint:
        'Types each character with Ctrl+Shift+U (IBus, fcitx5, GTK, Chromium). Switch Mozc to direct input.',
      bridgeWindow: 'Window opened by the bridge',
      bridgeChromium: 'Chrome / Edge private (Ctrl+Shift+N)',
      bridgeFirefox: 'Firefox private (Ctrl+Shift+P)',
      bridgeNewWindow: 'Normal new window (Ctrl+N)',
      bridgeWindowHint:
        'With Firefox choose Firefox private (in Firefox, Ctrl+Shift+N reopens a closed window).',
      imePreKey: 'Turn the target IME off before typing',
      imeAuto: 'Auto (IME-off key on Windows)',
      imeLang2: 'IME-off key (LANG2)',
      imeNonConvert: 'Muhenkan (only if assigned to IME off)',
      imeNone: "Don't send",
      normalize: 'Normalize punctuation (when the text is then all ASCII)',
      stripTrailingNewline: 'Do not type the trailing newline',
      fixCapsLock: 'Turn the target Caps Lock off automatically',
      hotkey: 'Host hotkey',
      hotkeyNeedsRemap: 'Works while ⌘ → Ctrl is on',
      change: 'Change',
      pressHotkey: 'Press the new key combination (⌘/⌃/⌥ + key)',
      progress: '{{done}} / {{total}} · {{eta}} s left',
      phaseWindow: 'Opening a window',
      phaseProbe: 'Opening the check page',
      phaseType: 'Typing the URL',
      phaseVerify: 'Verifying',
      phaseCopy: 'Copying',
      phaseClose: 'Closing the window',
      phasePaste: 'Pasting',
      doNotTouch: "Don't touch anything until it finishes",
      skipped: 'Skipped {{count}} characters that cannot be typed',
      skippedList: 'Not typeable: {{chars}}',
      nothingTypeable: 'Nothing typeable with the current settings',
      doneCompleted: 'Done',
      doneCancelled: 'Cancelled',
      doneKey: 'Stopped: a key was pressed on the host',
      doneMouse: 'Stopped: mouse clicked',
      doneHidden: 'Stopped: tab hidden',
      doneSerial: 'Stopped: serial error',
      doneNoVideo: 'Stopped: no video frame could be read',
      doneBusyScreen:
        'Stopped: the target screen kept changing (wait until scrolling or video stops)',
      doneNoWindow: 'Stopped: no new window appeared (bring the target browser to the front)',
      doneProbeFailed:
        'Stopped: the check page did not appear (check the layout and IME, then close the window)',
      doneProbeRed:
        'Stopped: the check page stayed red (target Caps Lock on, or JavaScript disabled)',
      doneLoadFailed: 'Stopped: the page did not appear (check and close the opened window)',
      doneVerifyFailed: 'Stopped: the text did not match (try the Safe speed or check Caps Lock)',
      doneCopyFailed: 'Stopped: the copy could not be confirmed (close the opened window)',
      doneCloseFailed:
        'Stopped: the temporary window did not close (the text is on the target clipboard)',
      doneCapsLock: 'Stopped: could not turn the target Caps Lock off',
      confirmLarge: '{{count}} characters will take about {{seconds}} s. Continue?',
      bridgeIntroTitle: 'Typing via the target browser',
      bridgeIntro:
        "The text contains non-ASCII characters, so a temporary window opens in the target browser (about {{seconds}} s). Don't touch anything until it finishes. The target clipboard is overwritten. This notice is shown only once.",
      truncated: 'Truncated to {{max}} characters',
      permDenied:
        'Clipboard access is blocked. Allow it from the lock icon in the address bar, or paste into the text box.',
      noFocus: 'Click the page first, then try again.',
      empty: 'The clipboard has no text.',
      notConnected: 'Serial is not connected',
      noVideo: 'The video is not showing, so typing via the browser is unavailable',
      capsHint: 'When the device reports it, the target Caps Lock is turned off before typing.',
      capsOffHint: 'If the target has Caps Lock on, letters are inverted.'
    },
    debug: {
      hidLog: 'HID log',
      copy: 'Copy',
      clear: 'Clear'
    }
  }
};

export default en;
