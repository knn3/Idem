import { type OpId, idEqual } from './id.js';
import type { Item } from './doc.js';
import { itemToVisibleIndex, visibleToItemIndex } from './index-map.js';

/**
 * A cursor is never a number (SPEC §8, CLAUDE.md hard rule 7): a numeric
 * position jumps when a remote edit lands before it. Instead it's an anchor —
 * the `OpId` of the item immediately to its left, or `null` at document
 * start. Converting anchor to visible index happens at paint time.
 */
export type CursorAnchor = OpId | null;

export interface Selection {
  readonly anchor: CursorAnchor;
  readonly focus: CursorAnchor;
}

/**
 * Converts a cursor anchor to a visible index for rendering. If the anchored
 * item has since been deleted, walks left through tombstones to the nearest
 * still-visible item (SPEC §8) rather than jumping to a stale offset.
 */
export function anchorToVisibleIndex(items: readonly Item[], anchor: CursorAnchor): number {
  if (anchor === null) return 0;

  let idx = items.findIndex((item) => idEqual(item.id, anchor));
  if (idx === -1) {
    throw new RangeError('anchorToVisibleIndex: anchor not found — causal delivery violated');
  }

  while (idx >= 0 && items[idx]!.deleted) idx--;
  if (idx < 0) return 0; // everything left of the anchor was deleted too — cursor sits at document start

  return itemToVisibleIndex(items, idx) + 1;
}

/** The anchor for a cursor sitting at `visibleIndex` — the id of the visible item immediately to its left. */
export function visibleIndexToAnchor(items: readonly Item[], visibleIndex: number): CursorAnchor {
  if (visibleIndex === 0) return null;
  const itemIdx = visibleToItemIndex(items, visibleIndex - 1);
  const item = items[itemIdx];
  if (!item) {
    throw new RangeError(`visibleIndexToAnchor: visibleIndex ${visibleIndex} out of range`);
  }
  return item.id;
}
