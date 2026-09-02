/**
 * OpId identifies one operation. Lamport value first, replica id as a
 * deterministic tiebreak — see SPEC §1.
 */
export interface OpId {
  readonly lamport: number;
  readonly replica: string;
}

/**
 * Total order over OpId, identical on every replica. Lamport first, replica
 * string as tiebreak — the tiebreak is arbitrary but deterministic, which is
 * exactly what lets concurrent inserts converge (SPEC §1).
 */
export function compareId(a: OpId, b: OpId): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  return a.replica < b.replica ? -1 : a.replica > b.replica ? 1 : 0;
}

export function idEqual(a: OpId | null, b: OpId | null): boolean {
  if (a === null || b === null) return a === b;
  return a.lamport === b.lamport && a.replica === b.replica;
}

/** Dedup key for the applied-operations set. */
export function idKey(id: OpId): string {
  return `${id.replica}:${id.lamport}`;
}
