import type { LayoutTable, TargetLayout } from '@/libs/paste/types';

import { COMMON_TABLE } from './common';
import { JIS_TABLE } from './jis';
import { US_TABLE } from './us';

export const LAYOUT_TABLES: Record<TargetLayout, LayoutTable> = {
  us: US_TABLE,
  jis: JIS_TABLE
};

/** Table for a target layout; unknown values fall back to US. */
export function getTable(layout: TargetLayout): LayoutTable {
  return LAYOUT_TABLES[layout] ?? US_TABLE;
}

export { COMMON_TABLE, JIS_TABLE, US_TABLE };
