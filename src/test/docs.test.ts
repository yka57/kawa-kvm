import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';

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
});
