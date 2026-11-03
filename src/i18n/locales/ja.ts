const ja = {
  translation: {
    serial: {
      notSupported:
        'このブラウザーはシリアル通信に対応していないため、マウスとキーボードを使用できません。デスクトップ版の Chrome をご利用ください。',
      failed: 'シリアルポートに接続できませんでした。もう一度お試しください。'
    },
    camera: {
      tip: 'カメラの許可を待っています...',
      denied: 'カメラの使用が許可されていません',
      authorize:
        'リモートデスクトップにはカメラの許可が必要です。ブラウザーの設定でカメラの使用を許可してください。',
      failed: 'カメラに接続できませんでした。もう一度お試しください。'
    },
    modal: {
      title: 'USB デバイスを選択',
      selectVideo: 'ビデオ入力デバイスを選択してください',
      selectSerial: 'シリアルデバイスを選択'
    },
    menu: {
      serial: 'シリアル',
      keyboard: 'キーボード',
      mouse: 'マウス'
    },
    target: {
      os: '操作先 OS',
      layout: '操作先のキー配列',
      windows: 'Windows',
      linux: 'Linux',
      macos: 'macOS',
      us: 'US (ANSI)',
      jis: '日本語 (JIS)'
    },
    video: {
      resolution: '解像度',
      scale: '表示倍率',
      auto: '自動',
      rotation: '回転',
      customResolution: 'カスタム',
      device: 'デバイス',
      custom: {
        title: 'カスタム解像度',
        width: '幅',
        height: '高さ',
        confirm: 'OK',
        cancel: 'キャンセル'
      }
    },
    audio: {
      tip: 'ヒント',
      permission:
        'USB オーディオデバイスを接続するにはマイクへのアクセス許可が必要です。OS が USB 音声入力をマイクとして扱うため、この許可が必要になります。\n\nこの許可はデバイスの接続にのみ使用され、録音は行いません。',
      viewDoc: 'ドキュメントを見る',
      ok: 'OK'
    },
    keyboard: {
      paste: '貼り付け',
      virtualKeyboard: '仮想キーボード',
      shortcut: {
        title: 'ショートカット',
        custom: 'カスタム',
        capture: 'ここをクリックしてショートカットを記録',
        clear: 'クリア',
        save: '保存',
        captureTips: 'Windows キーなどのシステムキーを記録するには、全画面表示の許可が必要です。',
        enterFullScreen: '全画面表示を切り替えます。'
      },
      remap: {
        title: '⌘ キー変換（Mac）',
        off: 'オフ（⌘ を Win として送信）',
        on: 'オン（⌘ → Ctrl）',
        inactiveMacTarget: '操作先が macOS のため無効です',
        nav: 'Mac 風ナビゲーションも変換（⌘←/→, ⌥←/→, ⌘⇧[ ]）',
        jis: '英数/かな → 無変換/変換（MS-IME で IME オフ/オンを割り当て済みの場合）',
        capsLock: 'Caps Lock の同期を補正',
        help: '送信できるショートカット',
        helpWindow: '通常ウィンドウで動作',
        helpFullscreen: '全画面時のみ動作',
        helpNever: 'その他（⌘Tab, ⌘Space, ⌘Q など）は「ショートカット」から送信してください',
        sideEffects:
          'オン時は ⌘クリック = Ctrl+クリック、⌘+ホイール = Ctrl+ホイール（ズーム）になります',
        enterFullscreen: '全画面にする',
        keyTest: 'キーテスト',
        keyTestHint: 'テスト中はキーは送信されません',
        releaseAll: '全キーを離す',
        recordAsCtrl: '⌘ を Ctrl として記録',
        imeHint: 'ホスト側 IME が変換中です。入力ソースを英数に切り替えてください',
        keyTestEmpty: 'ホストのキーボードでキーを押してください…',
        keyupsUnderMeta: '⌘ 押下中に届いた keyup: {{n}} 回'
      }
    },
    mouse: {
      cursor: {
        title: 'カーソル',
        pointer: 'ポインター',
        grab: '手のひら',
        cell: 'セル',
        hide: '非表示'
      },
      mode: 'マウスモード',
      absolute: '絶対座標モード',
      relative: '相対座標モード',
      direction: 'ホイールの向き',
      scrollUp: '上にスクロール',
      scrollDown: '下にスクロール',
      speed: 'ホイール速度',
      fast: '速い',
      slow: '遅い',
      requestPointer:
        '相対座標モードです。デスクトップをクリックするとマウスポインターを取得します。',
      pointerLockFailed:
        'マウスポインターを取得できませんでした。もう一度画面をクリックしてください。',
      jiggler: {
        title: 'マウスジグラー',
        enable: '有効',
        disable: '無効'
      },
      scrollSensitivity: 'スクロール感度',
      pointerSpeed: 'ポインター速度',
      relativeOnly: '相対座標モードのみ'
    },
    settings: {
      language: '言語',
      document: 'ドキュメント',
      download: 'ダウンロード'
    },
    paste: {
      title: 'クリップボードを入力',
      settings: '貼り付けの設定',
      cancel: 'キャンセル',
      typeText: 'このテキストを入力',
      textPlaceholder: 'ここにテキストを貼り付け（⌘V）',
      speed: '速度',
      speedSafe: '安全',
      speedNormal: '標準',
      newline: '改行',
      newlineEnter: 'Enter',
      newlineShiftEnter: 'Shift+Enter',
      normalize: '記号を正規化（スマートクォート・ダッシュ・NBSP）',
      stripTrailingNewline: '末尾の改行を入力しない',
      imeOff: '先に 無変換 を送って操作先の IME をオフにする',
      hotkey: 'ホスト側ホットキー',
      hotkeyNeedsRemap: '⌘ → Ctrl がオンのとき使えます',
      change: '変更',
      pressHotkey: '新しいキーの組み合わせを押してください（⌘/⌃/⌥ + キー）',
      progress: '{{done}} / {{total}} · 残り約{{eta}}秒',
      skipped: 'ASCII 以外の{{count}}文字をスキップしました',
      skippedList: '入力できない文字: {{chars}}',
      nothingTypeable: '現在の設定で入力できる文字がありません',
      doneCompleted: '完了',
      doneCancelled: 'キャンセルしました',
      doneKey: '停止: ホストでキーが押されました',
      doneMouse: '停止: マウスがクリックされました',
      doneHidden: '停止: タブが非表示になりました',
      doneSerial: '停止: シリアル通信エラー',
      confirmLarge: '{{count}}文字の入力には約{{seconds}}秒かかります。続行しますか？',
      truncated: '{{max}}文字に切り詰めました',
      permDenied:
        'クリップボードへのアクセスがブロックされています。アドレスバーの鍵アイコンから許可するか、テキスト欄に貼り付けてください。',
      noFocus: 'ページをクリックしてからもう一度お試しください。',
      empty: 'クリップボードにテキストがありません。',
      notConnected: 'シリアルが接続されていません',
      capsHint: '操作先で Caps Lock がオンの場合、英字の大小が反転します。'
    },
    debug: {
      hidLog: 'HID ログ',
      copy: 'コピー',
      clear: 'クリア'
    }
  }
};

export default ja;
