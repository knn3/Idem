import { anchorToVisibleIndex, type Item } from '@idem/crdt';
import type { Peer } from '@idem/protocol';

/**
 * Turning a peer roster into screen positions (SPEC §8, M10).
 *
 * This is the whole of the presence logic, and it is deliberately pure: no
 * CodeMirror, no React, no DOM. Peers arrive carrying `OpId` anchors, never
 * numbers (CLAUDE.md hard rule 7), and those anchors are resolved against the
 * *current* document every time something is painted. That is what makes a
 * remote caret hold its place when you type in front of it — nothing is
 * transformed, the position is simply recomputed from an identity that did not
 * change.
 */

/** A peer's cursor in visible-index space — the same coordinates the editor uses. */
export interface PeerRange {
  readonly replica: string;
  readonly name: string;
  readonly color: string;
  /** Where the caret is drawn: the moving end of the selection. */
  readonly head: number;
  /** Selected span, `from === to` for a collapsed cursor. */
  readonly from: number;
  readonly to: number;
}

/**
 * Resolves every peer except `selfReplica` against `items`.
 *
 * A peer whose anchor names an item this replica has not seen is skipped
 * rather than thrown on. Presence is ephemeral and best-effort: the roster and
 * the operation stream are separate messages, so a momentarily stale peer is an
 * expected state, not a broken invariant. It corrects itself on that peer's
 * next cursor move.
 */
export function resolvePeerRanges(
  items: readonly Item[],
  peers: readonly Peer[],
  selfReplica: string,
): PeerRange[] {
  const ranges: PeerRange[] = [];
  for (const peer of peers) {
    if (peer.replica === selfReplica) continue;
    let head: number;
    let tail: number;
    try {
      head = anchorToVisibleIndex(items, peer.focus);
      tail = anchorToVisibleIndex(items, peer.anchor);
    } catch {
      continue;
    }
    ranges.push({
      replica: peer.replica,
      name: peer.name,
      color: peer.color,
      head,
      from: Math.min(head, tail),
      to: Math.max(head, tail),
    });
  }
  return ranges;
}
