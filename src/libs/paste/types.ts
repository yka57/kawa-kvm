/**
 * Pure types for the host-clipboard → keystrokes compiler (spec §5.1).
 * No runtime dependencies: safe to import from anywhere, including tests.
 */

/** Keyboard layout the TARGET machine interprets HID usages with. */
export type TargetLayout = 'us' | 'jis';

/** One key chord; `key` is a KeyboardEvent.code name that exists in KeycodeMap. */
export interface KeyCombo {
  key: string;
  shift?: boolean;
}

/** Printable character → chord. Every key is a single character. */
export type LayoutTable = Record<string, KeyCombo>;

/** `unicode`: a Ctrl+Shift+U entry (spec §5); `chord`: a bridge control key such as Ctrl+L (§4.2). */
export type StrokeTag = 'char' | 'enter' | 'tab' | 'ime-pre' | 'unicode' | 'chord';

/** One press/release pair the typing engine executes. */
export interface KeyStroke {
  /** HID modifier bitmap (ModifierBits) held while `key` is down. */
  mod: number;
  /** HID usage of the pressed key (0x04…). */
  key: number;
  /** Index of the originating grapheme in the segmented text; -1 when there is none (ime-pre, bridge keys). */
  src: number;
  tag: StrokeTag;
  /** Extra pause after this stroke's gap, for the target to settle (IME switch, input method, clipboard). */
  afterMs?: number;
  /**
   * Atomic group id: the typing engine defers a cancel until the last stroke
   * of the run of consecutive strokes sharing this id has been released.
   */
  group?: number;
}

export type NewlineMode = 'enter' | 'shift-enter';
/** The RESOLVED IME pre-key the compilers send (settings may also say 'auto', see resolveImePreKey). */
export type ImePreKey = 'none' | 'NonConvert' | 'Lang2';

export interface CompileOptions {
  layout: TargetLayout;
  newline: NewlineMode;
  /** Fold smart quotes / dashes / NBSP / ellipsis to ASCII before compiling. */
  normalizePunct: boolean;
  /** Drop one trailing newline (the usual "copied a whole line" artefact). */
  stripTrailingNewline: boolean;
  /** Stroke sent once before the text (turns the target IME off). */
  imePreKey: ImePreKey;
  /** Hard cap on graphemes; the rest is reported as skipped with reason 'limit'. */
  maxChars: number;
}

export type SkipReason = 'no-key' | 'control' | 'limit';

export interface SkippedChar {
  char: string;
  /** Grapheme index in the normalized text (same index space as KeyStroke.src). */
  index: number;
  reason: SkipReason;
}

export interface CompileStats {
  /** Graphemes after normalisation and trailing-newline stripping; chars === typed + skipped. */
  chars: number;
  /** Graphemes that produced a stroke (the ime-pre stroke is not counted). */
  typed: number;
  /** Entries in `skipped`, every reason included ('limit' too). */
  skipped: number;
  truncated: boolean;
  trailingNewlineStripped: boolean;
}

export interface CompileResult {
  strokes: KeyStroke[];
  skipped: SkippedChar[];
  stats: CompileStats;
}
