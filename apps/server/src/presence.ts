/**
 * Peer identity for presence (SPEC §6, §8).
 *
 * A client's `presence` message carries only anchors — it never names or
 * colors itself — so the server hands out both. Until M11 there is no account
 * to take a name from, so a peer gets one from a fixed palette.
 *
 * Assignment is *per room*, not a bare hash of the replica id: a hash alone
 * would eventually give two people in the same document the same color, which
 * is the one thing presence must never do. The hash picks the preferred slot,
 * so a given replica lands on the same identity every time the room is empty
 * enough to grant it, and probing from there guarantees distinctness while any
 * free slot remains.
 */

export interface PeerIdentity {
  readonly name: string;
  readonly color: string;
}

/**
 * Hues chosen to stay distinguishable from each other and from black text on a
 * white page — a caret is a two-pixel line, so low-contrast colors read as
 * "nothing is there".
 */
const PALETTE: readonly PeerIdentity[] = [
  { name: 'Otter', color: '#d2431a' },
  { name: 'Heron', color: '#1a6fd2' },
  { name: 'Marten', color: '#12805c' },
  { name: 'Kestrel', color: '#9a3fd0' },
  { name: 'Vireo', color: '#b8860b' },
  { name: 'Lynx', color: '#c0197a' },
  { name: 'Shrike', color: '#0f7d8c' },
  { name: 'Badger', color: '#6b4bd8' },
];

export const PALETTE_SIZE = PALETTE.length;

/** FNV-1a, 32-bit. Any stable string hash would do; this one is four lines and has no dependencies. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The identity for `replica`, avoiding every name in `taken`.
 *
 * Past `PALETTE_SIZE` peers in one room the palette is exhausted and identities
 * start repeating — the preferred slot is returned unconditionally. That is the
 * honest failure mode: presence degrades into ambiguity rather than throwing a
 * live document's connection away.
 */
export function pickIdentity(replica: string, taken: ReadonlySet<string>): PeerIdentity {
  const start = hash(replica) % PALETTE_SIZE;
  for (let step = 0; step < PALETTE_SIZE; step++) {
    // Non-null: the index is `% PALETTE_SIZE` of a non-negative number.
    const candidate = PALETTE[(start + step) % PALETTE_SIZE]!;
    if (!taken.has(candidate.name)) return candidate;
  }
  return PALETTE[start]!;
}
