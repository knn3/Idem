import type { Item } from './doc.js';

/**
 * Two coordinate systems exist and must never be confused (SPEC §4,
 * CLAUDE.md hard rule 6):
 *
 * - Item index — position in `items`, tombstones included. Internal only.
 * - Visible index — position in the rendered text, tombstones skipped. What
 *   the editor and the user see.
 *
 * These are O(n) scans, which is fine under ~50,000 characters (SPEC §4). A
 * rope or order-statistic tree would make them O(log n); that's a stated,
 * measured future optimization, not something to build now.
 */

/** The item index of the `visible`-th visible item, or `items.length` if `visible` is at (or past) the end. */
export function visibleToItemIndex(items: readonly Item[], visible: number): number {
  let seen = 0;
  for (let i = 0; i < items.length; i++) {
    if (!items[i]!.deleted) {
      if (seen === visible) return i;
      seen++;
    }
  }
  return items.length;
}

/** How many visible items precede `itemIdx` — the visible index a visible item at `itemIdx` sits at. */
export function itemToVisibleIndex(items: readonly Item[], itemIdx: number): number {
  let count = 0;
  for (let i = 0; i < itemIdx; i++) {
    if (!items[i]!.deleted) count++;
  }
  return count;
}

export function toString(items: readonly Item[]): string {
  let out = '';
  for (const item of items) if (!item.deleted) out += item.content;
  return out;
}
