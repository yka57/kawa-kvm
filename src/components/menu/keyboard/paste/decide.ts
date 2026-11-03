import { formatKeyDisplay } from '@/components/menu/keyboard/shortcuts/record-key.ts';
import type { System } from '@/libs/browser';
import { isModifier } from '@/libs/keyboard/keymap.ts';
import type { PasteHotkey } from '@/libs/paste/settings';
import { PASTE_SOFT_LIMIT } from '@/libs/paste/text-to-keys';
import type { CompileResult, SkippedChar } from '@/libs/paste/types';
import type { Pacing, StopReason } from '@/libs/paste/typing-engine';

/**
 * Pure decision helpers of the paste controller and the progress pill
 * (spec §5.4). No React, antd, jotai or DOM: unit-tested in node.
 */

export type StartDecision = 'run' | 'confirm' | 'nothing' | 'notConnected';

/**
 * Whether a compiled clipboard runs, needs a confirmation first (soft limit)
 * or is refused. `serialState` is the value of serialStateAtom.
 */
export function decideStart(result: CompileResult, serialState: string): StartDecision {
  if (serialState !== 'connected') return 'notConnected';
  if (result.stats.typed === 0) return 'nothing';
  if (result.stats.chars > PASTE_SOFT_LIMIT) return 'confirm';
  return 'run';
}

/** Wall-clock estimate of a run: the engine's per-stroke pacing, summed. */
export function estimateRunMs(result: CompileResult, pacing: Pacing): number {
  let total = 0;
  for (const stroke of result.strokes) {
    total += pacing.holdMs + pacing.gapMs + (stroke.tag === 'enter' ? pacing.afterEnterMs : 0);
  }
  return total;
}

export type ClipboardFailure = 'noFocus' | 'permDenied' | 'empty';

/**
 * Classifies a `navigator.clipboard.readText()` rejection (spec §5.4).
 * Anything unexpected (no Clipboard API, insecure context) counts as blocked
 * access, which routes the user to the manual text box.
 */
export function classifyClipboardError(error: unknown): ClipboardFailure {
  const record =
    typeof error === 'object' && error !== null
      ? (error as { name?: unknown; message?: unknown })
      : {};
  const name = typeof record.name === 'string' ? record.name : '';
  const message = typeof record.message === 'string' ? record.message : '';
  if (name === 'NotAllowedError') {
    return /focus/i.test(message) ? 'noFocus' : 'permDenied';
  }
  if (name === 'NotFoundError' || name === 'DataError') return 'empty';
  return 'permDenied';
}

export interface SkippedSummary {
  char: string;
  count: number;
}

/**
 * Unique untypeable characters in first-occurrence order with their counts.
 * The truncated tail (reason 'limit') is a length problem, not a character
 * problem, and is reported separately.
 */
export function summarizeSkipped(skipped: readonly SkippedChar[]): SkippedSummary[] {
  const counts = new Map<string, number>();
  for (const entry of skipped) {
    if (entry.reason === 'limit') continue;
    counts.set(entry.char, (counts.get(entry.char) ?? 0) + 1);
  }
  return Array.from(counts, ([char, count]) => ({ char, count }));
}

export function countSkipped(summary: readonly SkippedSummary[] | undefined): number {
  if (!summary) return 0;
  return summary.reduce((sum, entry) => sum + entry.count, 0);
}

export const MAX_SKIPPED_SHOWN = 50;

// control, format and separator characters have no visible glyph
const INVISIBLE = /^[\p{Cc}\p{Cf}\p{Z}]/u;

/** Display token of one character; invisible ones are shown as U+XXXX. */
export function displayChar(char: string): string {
  if (!INVISIBLE.test(char)) return char;
  const codePoint = char.codePointAt(0) ?? 0;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Space-separated list of at most `max` unique characters, with an ellipsis when cut. */
export function formatSkippedChars(
  summary: readonly SkippedSummary[],
  max: number = MAX_SKIPPED_SHOWN
): string {
  const shown = summary.slice(0, max).map((entry) => displayChar(entry.char));
  if (summary.length > max) shown.push('…');
  return shown.join(' ');
}

/** Runs shorter than this are not worth a pill (spec §5.4). */
export const PILL_ETA_THRESHOLD_MS = 700;
/** A clean completion hides the pill after this delay. */
export const PILL_AUTO_HIDE_MS = 3000;

/**
 * Pill visibility rule: a noticeable ETA, skipped characters or an early
 * stop. `etaMs` is the estimate at the moment of the decision (the start of
 * the run), `reason` is only known once the run stopped.
 */
export function showPill(etaMs: number, skipped: number, reason?: StopReason): boolean {
  if (skipped > 0) return true;
  if (reason !== undefined && reason !== 'completed') return true;
  return etaMs > PILL_ETA_THRESHOLD_MS;
}

const REASON_KEYS: Record<StopReason, string> = {
  completed: 'doneCompleted',
  cancelled: 'doneCancelled',
  'key-interrupt': 'doneKey',
  'mouse-interrupt': 'doneMouse',
  'tab-hidden': 'doneHidden',
  'serial-error': 'doneSerial',
  // never shown: a busy lock means another run is in progress (no state written)
  'lock-busy': 'doneCancelled'
};

/** i18n key of the stop reason line. */
export function reasonKey(reason: StopReason): string {
  return `paste.${REASON_KEYS[reason]}`;
}

const MAC_MODIFIER_LABELS = { meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' } as const;
const PC_MODIFIER_LABELS = { meta: 'Win', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' } as const;
const MODIFIER_ORDER = ['meta', 'ctrl', 'alt', 'shift'] as const;

/** Kbd labels of a chord, modifiers first: ⌘⌃⌥⇧ on macOS, Win/Ctrl/Alt/Shift elsewhere. */
export function formatChord(chord: PasteHotkey, hostOS: System): string[] {
  const labels = hostOS === 'macOS' ? MAC_MODIFIER_LABELS : PC_MODIFIER_LABELS;
  const out: string[] = [];
  for (const flag of MODIFIER_ORDER) {
    if (chord[flag]) out.push(labels[flag]);
  }
  out.push(formatKeyDisplay(chord.code, chord.code));
  return out;
}

export interface ChordKeyEvent {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The chord a keydown defines during hotkey capture. Null for a bare
 * modifier, an empty code, or a key without ⌘/⌃/⌥ (⇧ alone would hijack
 * ordinary typing on the target).
 */
export function chordFromKeyEvent(event: ChordKeyEvent): PasteHotkey | null {
  if (!event.code || isModifier(event.code)) return null;
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return null;
  const chord: PasteHotkey = { code: event.code };
  if (event.metaKey) chord.meta = true;
  if (event.ctrlKey) chord.ctrl = true;
  if (event.altKey) chord.alt = true;
  if (event.shiftKey) chord.shift = true;
  return chord;
}
