import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';

import { KeycodeMap } from '@/libs/keyboard/keymap';
import { planPacing, planPaste } from '@/libs/paste/plan';
import { PASTE_HARD_LIMIT } from '@/libs/paste/text-to-keys';
import { estimateProgramMs, PACING, type SpeedPreset } from '@/libs/paste/typing-engine';
import { IME_CODE_COMMIT, IME_CODE_MIN_STROKE_MS } from '@/libs/paste/unicode-entry';

import readmeJa from '../../docs/README.ja.md?raw';
import testingJa from '../../docs/TESTING.ja.md?raw';
import readme from '../../README.md?raw';

/**
 * Guards for the fork's Markdown docs (README.md, docs/README.ja.md,
 * docs/TESTING.ja.md). docs/spec-v1.md is deliberately not covered.
 *
 * - `npm run format` (prettier --write .) must be a no-op on them.
 * - Every GFM table row has the header's cell count. GFM splits a cell at
 *   every unescaped `|`, even inside a code span, so a `|` in a cell must be
 *   written `\|` or the row renders broken on GitHub.
 * - The hardware checklist keeps the acceptance items that only it covers.
 */

const ROOT = decodeURIComponent(new URL('../../', import.meta.url).pathname);

const docs: [path: string, text: string][] = [
  ['README.md', readme],
  ['docs/README.ja.md', readmeJa],
  ['docs/TESTING.ja.md', testingJa]
];

/** Lines of each table (consecutive `|` lines outside fenced code blocks). */
function tables(text: string): string[][] {
  const result: string[][] = [];
  let current: string[] | null = null;
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    if (!fenced && line.startsWith('|')) {
      if (!current) result.push((current = []));
      current.push(line);
    } else {
      current = null;
    }
  }
  return result;
}

/** Cell count as GFM sees it: split at unescaped pipes, drop the outer two. */
function cellCount(row: string): number {
  return row.split(/(?<!\\)\|/).length - 2;
}

describe('fork docs', () => {
  it.each(docs)('%s is prettier-formatted', async (path, text) => {
    const file = ROOT + path;
    const config = await prettier.resolveConfig(file, { editorconfig: true });
    expect(config, 'prettier config resolved').not.toBeNull();
    expect(await prettier.check(text, { ...config, filepath: file })).toBe(true);
  });

  it.each(docs)('%s: every table row has the header cell count', (path, text) => {
    const found = tables(text);
    expect(found.length, path).toBeGreaterThan(0);
    for (const table of found) {
      const header = table[0];
      const width = cellCount(header);
      expect(width, header).toBeGreaterThan(1);
      for (const row of table) {
        expect(row.startsWith('| ') && row.endsWith(' |'), row).toBe(true);
        expect(cellCount(row), row).toBe(width);
      }
    }
  });

  it('TESTING.ja.md keeps the hardware-only acceptance items', () => {
    // §2: remap Off re-run must match upstream's Win+C bytes (T4 acceptance 1)
    expect(testingJa).toContain('08 00 06');
    // §4: jiggler frames in the HID log (T6 acceptance 4)
    expect(testingJa).toContain('dx=10 dy=10');
    expect(testingJa).toContain('dx=-10 dy=-10');
    // assumptions table and the open questions (T9)
    for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) {
      expect(testingJa).toMatch(new RegExp(`^\\| ${id}\\s+\\|`, 'm'));
    }
    for (const q of ['Q1', 'Q2', 'Q3']) {
      expect(testingJa).toContain(`**${q}.`);
    }
  });

  /** A press as the HID log of TESTING.ja.md shows it: `00 00 3e…` (modifier, reserved, usage). */
  const logged = (key: number, mod = 0): string => {
    const hex = (byte: number) => byte.toString(16).padStart(2, '0');
    return `\`${hex(mod)} 00 ${hex(key)}…\``;
  };

  it('TESTING.ja.md keeps the hardware rows of IME code input', () => {
    // §6: the first trial with its HID log, then the real target, the stops and the tab
    for (const id of ['6-22', '6-23', '6-24', '6-25', '6-26', '6-27', '6-28']) {
      expect(testingJa).toMatch(new RegExp(`^\\| ${id}\\s+\\|`, 'm'));
    }
    // LANG1, F5 and the commit chord the compiler sends (modifier and key in one report)
    expect(testingJa).toContain(logged(KeycodeMap.Lang1));
    expect(testingJa).toContain(logged(KeycodeMap.F5));
    expect(testingJa).toContain(logged(IME_CODE_COMMIT.key, IME_CODE_COMMIT.mod));
    // §7: the assumption that only the real hardware can confirm
    expect(testingJa).toMatch(/^\| A11\s+\|.*6-22〜6-28/m);
  });

  it('TESTING.ja.md: the stop and tab rows of IME code input say what to do and what must not appear', () => {
    const row = (id: string) => testingJa.split('\n').find((line) => line.startsWith(`| ${id} `));
    // 6-26: Esc on the target before the retry, whether or not something is visibly left over
    expect(row('6-26')).toMatch(
      /何も残っていないように見えても、やり直す前に操作先で Esc を 2〜3 回押す/
    );
    // 6-28: the tab arrives as the code 0009 and the focus stays; no Tab key in the HID log
    expect(row('6-28')).toMatch(/タブ文字が入り、フォーカスは入力欄に残ったまま/);
    expect(row('6-28')).toContain(`Tab キー（${logged(KeycodeMap.Tab)}）は出ず`);
    const code0009 = ['Digit0', 'Digit0', 'Digit0', 'Digit9'].map((code) =>
      logged(KeycodeMap[code])
    );
    expect(row('6-28')).toContain(`${code0009.join(' ')}（0 0 0 9）`);
  });

  it('the READMEs name what IME code input was not measured on, and NumLock for Alt + numpad', () => {
    expect(readme).toContain(
      '**Not measured:** the Microsoft Teams desktop app, Windows 10, a real USB keyboard path'
    );
    expect(readmeJa).toContain(
      '測定していないもの: Microsoft Teams のデスクトップアプリ、Windows 10、実機の USB キーボードの経路'
    );
    expect(readme).toContain('**NumLock on**');
    expect(readmeJa).toContain('操作先の NumLock はオンにしておいてください');
  });

  it('the READMEs keep the limits of IME code input and the recovery after a stop', () => {
    // one line of text: the English README is hard-wrapped
    const en = readme.replace(/\s+/g, ' ');
    // kana input, an IME that does not come on, the input history
    expect(en).toContain('the code keys type kana and every character comes out wrong, silently');
    expect(readmeJa).toContain('かな入力の IME では、エラーなしですべて違う文字になります');
    expect(en).toMatch(/the digits arrive as plain text and F5 \/ \S+ reach the application/);
    expect(readmeJa).toMatch(/数字がそのまま入り、F5 と \S+ がアプリに届きます/);
    expect(en).toContain("Every commit goes into the target IME's input history");
    expect(readmeJa).toContain('確定した文字は、1 文字ずつ操作先の IME の入力履歴に入り');
    // a stop in the middle of a text leaves the IME on; one during the last character does not
    expect(en).toContain('a run that stops in the middle of a text can leave the target IME on');
    expect(readmeJa).toContain('途中で止めると、操作先の IME がオンのまま残ることがあります');
    expect(en).toContain('only the IME-off key is left, so the run sends it and ends as _Done_');
    expect(readmeJa).toContain('それも送って「完了」になります');
    // after a click, a hidden tab or a serial error: Esc first, even with nothing visible
    expect(en).toMatch(
      /A click, a hidden tab or a serial error stops at once[^.]*: before trying again, press Escape two or three times on the target, even when nothing seems to be left over\./
    );
    expect(readmeJa).toMatch(
      /クリック、タブの非表示、シリアルエラーでは、文字の途中でもすぐ止まります。このときは、何も残っていないように見えても、やり直す前に操作先で Esc を 2〜3 回押してください。/
    );
    // a Tab in a text that goes by code input is a tab character, not the key
    expect(en).toContain('is entered as a tab character (code `0009`');
    expect(en).toContain('not pressed as a key');
    expect(readmeJa).toContain('タブは、Tab キーを押さずに、タブ文字として入力します');
    // the commit chord without a composition: what was measured in Edge, and what was not
    expect(en).toMatch(/did not change the field, the focus or the IME state in Edge/);
    expect(en).toMatch(/whether Edge's own \S+ shortcut \([^)]+\) fires was not checked/);
    expect(readmeJa).toMatch(/入力欄の内容もフォーカスも IME の状態も変えませんでした/);
    expect(readmeJa).toMatch(
      /Edge 自身の \S+ のショートカット（[^）]+）が働くかどうかは確認していません/
    );
    expect(en).not.toMatch(/changed nothing in Edge/);
    expect(readmeJa).not.toMatch(/Edge では何も変えませんでした/);
    // Teams binds the commit chord: what is said about it is a reading of its code, no more
    expect(en).toContain('That is a reading of the code, not a measurement of Teams.');
    expect(readmeJa).toContain('これはコードを読んだ結果で、Teams で測定したものではありません。');
  });

  it('the READMEs quote the pace IME code input is sent at, and what was measured about it', () => {
    const en = readme.replace(/\s+/g, ' ');
    // 300 Japanese characters in one stretch, as the app would type them
    const plan = planPaste('あ'.repeat(300), {
      layout: 'jis',
      newline: 'enter',
      normalizePunct: true,
      stripTrailingNewline: true,
      imePreKey: 'Lang2',
      method: 'ime-code',
      maxChars: PASTE_HARD_LIMIT
    });
    if (plan.kind !== 'unicode') throw new Error(plan.kind);
    // at the pace the app types the plan at: Fast is typed as Normal
    const steps = [{ kind: 'keys' as const, strokes: plan.compiled.strokes }];
    const seconds = (speed: SpeedPreset) =>
      Math.round(estimateProgramMs(steps, planPacing(plan, speed)) / 1000);
    expect(planPacing(plan, 'fast')).toBe(PACING.normal);
    expect([seconds('safe'), seconds('normal'), seconds('fast')]).toEqual([181, 72, 72]);
    expect(en).toContain(`(300 Japanese characters: about ${seconds('normal')} s)`);
    expect(en).toContain(
      'A text that needs IME code input is typed at the pace of Normal even when the speed is Fast'
    );
    expect(readmeJa).toMatch(
      /^\| IME コード入力、日本語 300 文字 \| 約 3 分\s+\| 約 1 分 12 秒\s+\| 約 1 分 12 秒\s+\|$/m
    );
    expect(readmeJa).toContain('標準でも高速でも約 0.24 秒');
    expect(readmeJa).toContain(
      'IME コード入力で打つテキストは、「高速」を選んでも「標準」の速さ（押下 20 ms / 間隔 20 ms）で打ちます'
    );
    // the stroke floor behind it: no key of a stretch faster than a stroke at Normal
    expect(IME_CODE_MIN_STROKE_MS).toBe(PACING.normal.holdMs + PACING.normal.gapMs);

    // why: with every key at 10 ms / 10 ms a digit was lost after a focus change (measured)
    expect(en).toContain(
      'With every key at 10 ms / 10 ms, the first paste after the field got the focus (a page load, a click into it) lost a digit in about 1 run in 10'
    );
    expect(readmeJa).toContain(
      'すべてのキーを 10 ms / 10 ms で打つと、入力欄にフォーカスが移った直後（ページを開いた直後や、欄をクリックした直後）の最初の入力で、3 文字目の最初の数字が抜けることがありました'
    );
    // ...and with only F5 and the commit slowed down, a page slow to handle its input lost digits
    expect(en).toContain('still fell behind digits 20 ms apart and lost one in 10 of 84 runs');
    expect(readmeJa).toContain(
      '20 ms おきに届く数字に処理が追いつかず、84 回のうち 10 回で数字が 1 つ抜けました'
    );
    // ...and keys 40 ms apart were not enough while they were held for 10 ms only
    expect(en).toContain('with every key 40 ms apart but held for only 10 ms');
    expect(readmeJa).toContain('キーを押している時間が 10 ms のままだと');
    // what to do when the destination is slower still
    expect(en).toContain('means the destination is not keeping up: switch to Safe');
    expect(readmeJa).toContain(
      '操作先の処理がキーに追いついていません。速度を「安全」にしてください'
    );
    // neither README may call 10 ms / 10 ms throughout error-free again, and no pace or number
    // is left open
    expect(readmeJa).not.toContain('誤りなく測定できた一番速い設定');
    expect(en).not.toContain('not measured yet as a whole');
    expect(readmeJa).not.toContain('まだ通しでは測定していません');
    expect(readme + readmeJa + testingJa).not.toContain('@@');

    // the hardware row for the speeds tests the case that failed: the first paste after a click
    const row = testingJa.split('\n').find((line) => line.startsWith('| 6-25 '));
    expect(row).toContain('入力欄の外をクリックしてから欄をクリックし直した直後に貼り付ける');
    expect(row).toContain('標準でも高速でも約 1 分 10 秒');
  });

  it('README.md says which Alt code facts were measured and which come from desk research', () => {
    const en = readme.replace(/\s+/g, ' ');
    expect(en).toContain(
      'from desk research, not measured, because the lab ran no RichEdit application: RichEdit reads the value as Unicode'
    );
  });
});
