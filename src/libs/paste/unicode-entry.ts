import { KeycodeMap, ModifierBits } from '@/libs/keyboard/keymap';
import { getTable } from '@/libs/paste/layouts';
import type { PlanOptions, PreparedText } from '@/libs/paste/plan';
import { controlStroke, imePreStroke, tableStroke } from '@/libs/paste/text-to-keys';
import type { CompileResult, KeyStroke } from '@/libs/paste/types';

/**
 * Ctrl+Shift+U code point entry for Linux targets (spec v2 §5, pure): IBus,
 * fcitx5, GTK and Chromium read the hex digits after the trigger and commit
 * on Space (Enter could submit a form). One code point per sequence.
 */

/** After the trigger's release. */
export const UNICODE_TRIGGER_SETTLE_MS = 80;
/** After the first trigger of a run: IBus loads its data lazily. */
export const UNICODE_FIRST_TRIGGER_SETTLE_MS = 400;
/** After the committing Space. */
export const UNICODE_COMMIT_SETTLE_MS = 80;

const TRIGGER_MOD = ModifierBits.LeftCtrl | ModifierBits.LeftShift;

/** Main-row key of a lowercase hex digit; never the keypad, whose digits depend on NumLock. */
function hexDigitKey(digit: string): number {
  return digit >= 'a' ? KeycodeMap[`Key${digit.toUpperCase()}`] : KeycodeMap[`Digit${digit}`];
}

/**
 * Ctrl+Shift+U, the code point in lowercase hex (at least four digits),
 * Space; one atomic group so a cancel never leaves the target mid-entry.
 */
export function codePointStrokes(
  cp: number,
  src: number,
  group: number,
  first: boolean
): KeyStroke[] {
  const strokes: KeyStroke[] = [
    {
      mod: TRIGGER_MOD,
      key: KeycodeMap.KeyU,
      src,
      tag: 'unicode',
      afterMs: first ? UNICODE_FIRST_TRIGGER_SETTLE_MS : UNICODE_TRIGGER_SETTLE_MS,
      group
    }
  ];
  for (const digit of cp.toString(16).padStart(4, '0')) {
    strokes.push({ mod: 0, key: hexDigitKey(digit), src, tag: 'unicode', group });
  }
  strokes.push({
    mod: 0,
    key: KeycodeMap.Space,
    src,
    tag: 'unicode',
    afterMs: UNICODE_COMMIT_SETTLE_MS,
    group
  });
  return strokes;
}

/** After Alt goes up: the target commits the character. */
export const ALT_HEX_COMMIT_SETTLE_MS = 30;

/**
 * Keypad key of a decimal digit, letter key of a–f. The target's NumLock has
 * to be on: measured with EnableHexNumpad = "1" under the default (new)
 * Microsoft IME, nothing at all is typed while NumLock is off. Only the
 * previous-generation IME reads the keypad whatever NumLock says.
 */
function altHexDigitKey(digit: string): number {
  return digit >= 'a' ? KeycodeMap[`Key${digit.toUpperCase()}`] : KeycodeMap[`Numpad${digit}`];
}

/**
 * Windows hex-numpad entry (needs HKCU\Control Panel\Input Method
 * EnableHexNumpad = "1" on the target, and NumLock on): Alt stays down over
 * keypad +, the UTF-16 code unit in hex, and goes up with the last digit. One
 * atomic group.
 */
export function altHexUnitStrokes(unit: number, src: number, group: number): KeyStroke[] {
  const alt = ModifierBits.LeftAlt;
  const keys = [KeycodeMap.NumpadAdd, ...[...unit.toString(16)].map(altHexDigitKey)];
  return keys.map((key, i) => {
    const last = i === keys.length - 1;
    const stroke: KeyStroke = { mod: alt, key, src, tag: 'unicode', group };
    if (last) stroke.afterMs = ALT_HEX_COMMIT_SETTLE_MS;
    else stroke.hold = alt;
    return stroke;
  });
}

/** One Alt entry per UTF-16 code unit (a surrogate pair is two entries). */
export function altHexStrokes(cp: number, src: number, group: number): KeyStroke[] {
  const text = String.fromCodePoint(cp);
  const strokes: KeyStroke[] = [];
  for (let i = 0; i < text.length; i++) {
    strokes.push(...altHexUnitStrokes(text.charCodeAt(i), src, group));
  }
  return strokes;
}

/**
 * Microsoft IME code input for Windows targets ('ime-code', pure). With the
 * Japanese IME on, a code point typed as hex digits and converted with F5
 * becomes that character, and a commit key finishes it. The text goes into
 * whatever field has the focus: no helper window, nothing to change on the
 * target.
 *
 * Measured on Japanese Windows 11 (26H2, build 26300) with the default (new)
 * Microsoft IME and romaji input. With the lab's own sender, in an Edge
 * textarea and an Edge contenteditable field: about 26,000 characters, none
 * wrong at 20 ms / 20 ms and at 10 ms / 10 ms. With the strokes of this
 * compiler, in those two fields, in CKEditor 5 (39.0.0, 47.6.2, 49.1.0) and in
 * Notepad: no digit lost at 20 ms / 20 ms; with the code-input keys at
 * 10 ms / 10 ms CKEditor lost one in about one of ten first pastes after a
 * focus change and, under a page slow to handle its input events, in mid-text,
 * which is why the app types this method no faster than 'normal' (planPacing
 * in plan.ts). The previous-generation IME behaves like the new one in the
 * two Edge fields at those paces but ignores F5 at 5 ms / 5 ms and faster, so
 * this method must never be paced below 10 ms / 10 ms (the fastest preset of
 * PACING).
 *
 * What the stroke list guarantees:
 * - LANG2 (IME off) first. LANG1 (IME on in hiragana mode, from every starting
 *   mode) before a stretch of code units, LANG2 before the next direct key and
 *   at the end: ASCII and line breaks are typed with the IME off.
 * - No Tab key. Tab moves the focus out of a field, and the F5 of the next
 *   unit would then reach the application with no composition. A tab in the
 *   text is entered as the code unit 0009 like any other unit: measured in
 *   both Edge fields, that inserts a tab character and the focus stays.
 * - Every F5 directly follows its digits and is directly followed by the
 *   commit. Without a composition F5 reloads a browser page, and digits typed
 *   while the candidate list is open pick candidates instead of starting the
 *   next code. LANG2, Shift+Enter or the next code are not commits.
 * - Every key of a stretch (LANG1, the digits, F5, the commit) takes at least
 *   IME_CODE_MIN_STROKE_MS from its press to the next press, whatever pacing
 *   the engine is given.
 * - The commit is IME_CODE_COMMIT, not Enter.
 * - One atomic group per code point: a deferred stop (Cancel, a host key)
 *   waits for the commit of the code point being entered, for both commits
 *   when it is a plane-3 code point entered as two surrogates.
 *
 * Limits: with the target IME set to kana input the code keys type kana and
 * every character comes out wrong, silently. Where the IME does not come on
 * (no Japanese IME active, an IME-disabled field) the digits arrive as plain
 * text and F5 / the commit chord reach the application. Every commit goes
 * into the target's IME input history. Not measured: the Microsoft Teams
 * desktop app, Windows 10, a real USB keyboard path.
 */

/**
 * The chord that commits a converted code, modifier and key in one press
 * report: Ctrl+M. Not Enter: both commit and leave the IME on, but should the
 * IME be off after all, Enter is a line break (= send, in a chat box) after
 * every code. Sent without a composition in Edge (IME off, and IME on with
 * nothing typed), Ctrl+M did not change the field, the focus or the IME
 * state; whether Edge's own Ctrl+M shortcut (mute tab) fires was not checked.
 * During a composition the page gets this chord as keydowns with keyCode 229
 * only (measured in the Edge fields and CKEditor 5: no keydown with keyCode
 * 77 in any run). Microsoft Teams binds Ctrl+M (move focus to the message
 * pane); its client code, read in 2026-11, looks hotkeys up by keyCode on
 * keydown, so the chord is not seen while composing. That is a reading of the
 * code with default shortcuts, not a measurement of Teams. Defined in this
 * one place.
 */
export const IME_CODE_COMMIT: Readonly<Pick<KeyStroke, 'mod' | 'key'>> = {
  mod: ModifierBits.LeftCtrl,
  key: KeycodeMap.KeyM
};

/**
 * Extra pause after the first F5 of each stretch (the first conversion after
 * a LANG1). The failure it is for appeared at 5 ms / 5 ms and faster only: in
 * a contenteditable field, with a line break before the stretch, the first
 * digit after the first commit was swallowed in 9 of 400 stretches (that
 * character then arrived as three raw keys); with 100 ms here, in 0 of 240
 * (an earlier run at that pace, multi-line chat messages, still had 2 of
 * 1,100 characters wrong with the pause). There it did not fail at
 * 10 ms / 10 ms or slower without the pause: it is kept as a margin. It does
 * not cover the second conversion after a focus change: the pace of 'normal'
 * does (planPacing in plan.ts).
 */
export const IME_CODE_FIRST_F5_SETTLE_MS = 100;

/**
 * Least time from the press of every key of a code-input stretch (LANG1, each
 * digit, F5, the commit) to the next press, whatever pacing the engine is
 * given: the 40 ms that 20 ms / 20 ms ('normal') takes for a stroke.
 *
 * A guard at the level of the strokes. The app does not type this method
 * faster than 'normal' in the first place (planPacing in plan.ts, which lists
 * the measurements), and at 'normal' and slower the floor changes nothing.
 * It would not be enough by itself: keys 40 ms apart but held for only 10 ms
 * still lost a digit on a destination slow to handle its input.
 */
export const IME_CODE_MIN_STROKE_MS = 40;

/** Plane 3: code input converts neither its five-digit nor its six-digit form. */
const PLANE_3_FIRST = 0x30000;
const PLANE_3_LAST = 0x3ffff;

/**
 * The code-input units of a code point, each as lower-case hex digits:
 * - up to U+FFFF exactly four digits, zero padded (3042, 00e9, ff01): shorter
 *   and longer forms do not convert;
 * - above, exactly six digits, zero padded (01f600, 020bb7, 10ffff). Never
 *   five: five decimal digits can be read as a JIS X 0213 code (21516 gave
 *   another kanji);
 * - U+30000..U+3FFFF: its two UTF-16 surrogates as two four-digit units, each
 *   with its own F5 and commit (that produced the character).
 */
export function imeCodeDigits(cp: number): string[] {
  if (cp >= PLANE_3_FIRST && cp <= PLANE_3_LAST) {
    const pair = String.fromCodePoint(cp);
    return [pair.charCodeAt(0), pair.charCodeAt(1)].map((unit) => unit.toString(16));
  }
  return [cp.toString(16).padStart(cp > 0xffff ? 6 : 4, '0')];
}

/**
 * One code-input unit: the digits on the main-row digit keys and the letter
 * keys a–f (no Shift), F5 (converts: the Unicode reading is the first
 * candidate) and IME_CODE_COMMIT as one press report (commits, the IME stays
 * on). Every stroke takes at least IME_CODE_MIN_STROKE_MS before the next
 * press. `group` is the
 * atomic group of the unit's code point: a deferred stop (Cancel, a host key)
 * takes effect after the commit of the group's last unit, never between the
 * strokes of a unit and never between the two surrogates of a plane-3 code
 * point. A click, a hidden tab or a serial error is not deferred: those can
 * still leave the target mid-entry. Measured: the digits typed so far then
 * stay as an open composition, which the LANG2 and LANG1 of the next paste
 * neither commit nor cancel. Text typed next joins it: the stray digits stay
 * in the field and the first character of the next stretch arrives as its
 * raw keys (a real click into the field committed the digits instead). The
 * keys that end a composition (Enter, the commit chord, Escape) reach the
 * application as plain keys when there is none, so none is sent blindly and
 * this stays with the user: one Escape on the target before the next paste
 * (measured: both pastes that followed were exact).
 */
export function imeCodeUnitStrokes(
  digits: string,
  src: number,
  group: number,
  firstOfStretch: boolean
): KeyStroke[] {
  const strokes: KeyStroke[] = [];
  // the IME and the destination need this long per key, whatever the speed preset
  const minMs = IME_CODE_MIN_STROKE_MS;
  for (const digit of digits) {
    strokes.push({ mod: 0, key: hexDigitKey(digit), src, tag: 'unicode', group, minMs });
  }
  const convert: KeyStroke = { mod: 0, key: KeycodeMap.F5, src, tag: 'unicode', group, minMs };
  if (firstOfStretch) convert.afterMs = IME_CODE_FIRST_F5_SETTLE_MS;
  strokes.push(convert, { ...IME_CODE_COMMIT, src, tag: 'unicode', group, minMs });
  return strokes;
}

/**
 * IME on (LANG1) or off (LANG2) around a stretch of code units; neither needed
 * a settle time. LANG1 starts the stretch and carries the floor of its other
 * keys; LANG2 does not, like the direct keys that follow it.
 */
function imeSwitchStroke(key: 'Lang1' | 'Lang2'): KeyStroke {
  const stroke: KeyStroke = { mod: 0, key: KeycodeMap[key], src: -1, tag: 'ime-pre' };
  if (key === 'Lang1') stroke.minMs = IME_CODE_MIN_STROKE_MS;
  return stroke;
}

/**
 * Optional IME pre-key, then per grapheme: "\n" → Enter (newline mode),
 * "\t" → Tab, a layout-table hit → its direct stroke, anything else → one
 * group per code point: Ctrl+Shift+U, or Alt+numpad hex for 'alt-hex'.
 * 'ime-code' always starts with LANG2 whatever the pre-key setting says (it
 * needs deterministic IME keys), never presses Tab ("\t" is the code unit
 * 0009) and enters every code point without a direct stroke as its
 * code-input units between LANG1 and LANG2, one group per code point (both
 * surrogate units of a plane-3 code point share theirs). `typed` counts
 * graphemes.
 */
export function compileUnicode(prepared: PreparedText, o: PlanOptions): CompileResult {
  const table = getTable(o.layout);
  const imeCode = o.method === 'ime-code';
  const strokes: KeyStroke[] = [];
  const pre = imePreStroke(imeCode ? 'Lang2' : o.imePreKey);
  if (pre) strokes.push(pre);

  // src indexes the segmented text like `skipped` does: skip the indices of removed graphemes
  const removed = new Set(prepared.skipped.map((entry) => entry.index));
  let src = 0;
  let group = 0;
  // 'ime-code' only: a LANG1 was sent and no LANG2 since
  let imeOn = false;
  for (const grapheme of prepared.graphemes) {
    while (removed.has(src)) src++;
    // 'ime-code': the Tab key would take the focus away from the field the next F5 needs
    const stroke =
      imeCode && grapheme === '\t'
        ? null
        : (controlStroke(grapheme, o.newline, src) ?? tableStroke(table, grapheme, src));
    if (stroke) {
      if (imeOn) strokes.push(imeSwitchStroke('Lang2'));
      imeOn = false;
      strokes.push(stroke);
    } else if (imeCode) {
      for (const ch of grapheme) {
        for (const digits of imeCodeDigits(ch.codePointAt(0) ?? 0)) {
          if (!imeOn) strokes.push(imeSwitchStroke('Lang1'));
          strokes.push(...imeCodeUnitStrokes(digits, src, group, !imeOn));
          imeOn = true;
        }
        group++;
      }
    } else {
      for (const ch of grapheme) {
        const cp = ch.codePointAt(0) ?? 0;
        strokes.push(
          ...(o.method === 'alt-hex'
            ? altHexStrokes(cp, src, group)
            : codePointStrokes(cp, src, group, group === 0))
        );
        group++;
      }
    }
    src++;
  }
  if (imeOn) strokes.push(imeSwitchStroke('Lang2'));

  return { strokes, skipped: prepared.skipped, stats: prepared.stats };
}
