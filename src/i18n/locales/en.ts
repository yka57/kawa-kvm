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
        on: 'On (⌘ → Ctrl)',
        inactiveMacTarget: 'Disabled: target OS is macOS',
        nav: 'Also convert Mac navigation (⌘←/→, ⌥←/→, ⌘⇧[ ])',
        jis: '英数/かな → 無変換/変換 (MS-IME with IME-off/on assigned)',
        capsLock: 'Fix Caps Lock sync',
        help: 'Which shortcuts can be sent?',
        helpWindow: 'Work in a normal window',
        helpFullscreen: 'Work only in full screen',
        helpNever: 'Everything else (⌘Tab, ⌘Space, ⌘Q…): use Shortcuts',
        sideEffects:
          'With ⌘ → Ctrl on: ⌘-click = Ctrl+click, ⌘+wheel = Ctrl+wheel (zoom) on the target',
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
      newline: 'Newline',
      newlineEnter: 'Enter',
      newlineShiftEnter: 'Shift+Enter',
      normalize: 'Normalize punctuation (smart quotes, dashes, NBSP)',
      stripTrailingNewline: 'Do not type the trailing newline',
      imeOff: 'Send 無変換 first to turn the target IME off',
      hotkey: 'Host hotkey',
      hotkeyNeedsRemap: 'Works while ⌘ → Ctrl is on',
      change: 'Change',
      pressHotkey: 'Press the new key combination (⌘/⌃/⌥ + key)',
      progress: '{{done}} / {{total}} · {{eta}} s left',
      skipped: '{{count}} non-ASCII character(s) skipped',
      skippedList: 'Not typeable: {{chars}}',
      nothingTypeable: 'Nothing typeable with the current settings',
      doneCompleted: 'Done',
      doneCancelled: 'Cancelled',
      doneKey: 'Stopped: a key was pressed on the host',
      doneMouse: 'Stopped: mouse clicked',
      doneHidden: 'Stopped: tab hidden',
      doneSerial: 'Stopped: serial error',
      confirmLarge: '{{count}} characters will take about {{seconds}} s. Continue?',
      truncated: 'Truncated to {{max}} characters',
      permDenied:
        'Clipboard access is blocked. Allow it from the lock icon in the address bar, or paste into the text box.',
      noFocus: 'Click the page first, then try again.',
      empty: 'The clipboard has no text.',
      notConnected: 'Serial is not connected',
      capsHint: 'If the target has Caps Lock on, letters will be inverted.'
    },
    debug: {
      hidLog: 'HID log',
      copy: 'Copy',
      clear: 'Clear'
    }
  }
};

export default en;
