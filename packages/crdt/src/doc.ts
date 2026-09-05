import { type OpId, compareId, idEqual, idKey } from './id.js';
import { toString as itemsToString } from './index-map.js';

/**
 * One character in the document. Items are never removed from `Doc.items` —
 * deletion only flips `deleted`. Remote operations reference items by
 * identity, so splicing one out would break that reference permanently
 * (CLAUDE.md hard rule 4). `id` is immutable after creation (hard rule 3);
 * `deleted` is the one field allowed to change.
 */
export interface Item {
  readonly id: OpId;
  readonly originLeft: OpId | null;
  readonly content: string;
  deleted: boolean;
}

export interface InsertOp {
  readonly kind: 'insert';
  readonly id: OpId;
  readonly originLeft: OpId | null;
  readonly content: string;
}

export interface DeleteOp {
  readonly kind: 'delete';
  readonly id: OpId;
  readonly target: OpId;
}

export type Op = InsertOp | DeleteOp;

/** Thrown when an operation arrives out of causal order (SPEC §5 assumes this never happens in production). */
export class CausalityError extends Error {
  readonly code = 'causal-delivery-violated';
}

export class Doc {
  readonly replica: string;
  clock = 0;
  readonly items: Item[] = [];
  private readonly applied = new Set<string>();

  constructor(replica: string) {
    this.replica = replica;
  }

  /**
   * Rebuilds a document from a materialized item list — a snapshot (SPEC §9),
   * loaded instead of replaying the log from the beginning. Integration is
   * skipped entirely: the items are already in their converged order, and
   * re-integrating them would be both wasteful and wrong (their origins are
   * relative to a list that already contains them).
   *
   * Two things a snapshot cannot carry, both safe:
   *
   * 1. **Delete-op ids.** An item records *that* it is a tombstone, not the
   *    `OpId` of the operation that made it one, so those ids are missing from
   *    `applied`. A delete already reflected here can therefore be applied a
   *    second time — which is a no-op, because `integrateDelete` only ever
   *    sets `deleted = true` (hard rule 5). Convergence is unaffected.
   *
   * 2. **A delete op's Lamport value.** The clock is seeded from the highest
   *    item id, so a delete that outran every insert leaves the clock low.
   *    Harmless: ids stay globally unique because `replica` is unique per
   *    session, and SPEC §7 states outright that RGA needs causal order, not
   *    Lamport order. A low clock only shifts an arbitrary tiebreak.
   */
  static fromItems(replica: string, items: readonly Item[]): Doc {
    const doc = new Doc(replica);
    for (const item of items) {
      // Copied, not aliased: `deleted` is mutable, and the caller's array is
      // typically a parsed wire message the room still holds a reference to.
      doc.items.push({
        id: item.id,
        originLeft: item.originLeft,
        content: item.content,
        deleted: item.deleted,
      });
      doc.applied.add(idKey(item.id));
      doc.clock = Math.max(doc.clock, item.id.lamport);
    }
    return doc;
  }

  private indexOfItem(id: OpId): number {
    return this.items.findIndex((item) => idEqual(item.id, id));
  }

  /** Item index space, tombstones skipped — what the editor and the user see. */
  visibleItems(): Item[] {
    return this.items.filter((item) => !item.deleted);
  }

  toString(): string {
    return itemsToString(this.items);
  }

  /**
   * SPEC §3 — the correctness core. Do not modify this without adding a
   * property test (CLAUDE.md hard rule 2): a subtly different scan rule
   * still passes hand-written tests and silently breaks convergence under
   * concurrency.
   *
   * The scan starts just right of `op.originLeft` (or at 0 for a document-
   * start insert) and walks right past every item whose id sorts *higher*
   * than `op.id` under `compareId`, stopping — inserting just before — at
   * the first item that sorts lower, or at the end of the run. Every
   * replica that has applied the same set of operations runs this exact
   * deterministic scan over the exact same list, and `compareId` is a total
   * order, so the splice lands in the same place everywhere: that identical
   * placement, with no coordination, is what makes RGA converge. Among
   * concurrent inserts sharing one origin, the higher id always ends up
   * further left — an arbitrary rule, but the same arbitrary rule on every
   * replica, which is all convergence requires (it is also the mechanism
   * behind the backward-interleaving anomaly documented in SPEC §12).
   *
   * Requires causal delivery: `op.originLeft` must already be present in
   * `items`, which means the operation that created it was already applied.
   * SPEC §5 explains how server `seq` ordering guarantees that for free.
   */
  private integrateInsert(op: InsertOp): void {
    let i = op.originLeft === null ? 0 : this.indexOfItem(op.originLeft) + 1;
    if (op.originLeft !== null && i === 0) {
      throw new CausalityError('integrateInsert: originLeft not found — causal delivery violated');
    }
    while (i < this.items.length) {
      const next = this.items[i];
      if (!next || compareId(next.id, op.id) <= 0) break;
      i++;
    }
    this.items.splice(i, 0, {
      id: op.id,
      originLeft: op.originLeft,
      content: op.content,
      deleted: false,
    });
  }

  private integrateDelete(op: DeleteOp): void {
    const idx = this.indexOfItem(op.target);
    const item = idx === -1 ? undefined : this.items[idx];
    if (!item) {
      throw new CausalityError('integrateDelete: target not found — causal delivery violated');
    }
    item.deleted = true; // idempotent: setting true twice is a no-op
  }

  /**
   * Applies a local or remote operation. Returns false without effect if
   * this exact operation id was already applied — duplicate delivery (the
   * reconnect path resends unacknowledged operations) must be a no-op.
   */
  apply(op: Op): boolean {
    const k = idKey(op.id);
    if (this.applied.has(k)) return false;
    this.applied.add(k);
    this.clock = Math.max(this.clock, op.id.lamport);
    if (op.kind === 'insert') this.integrateInsert(op);
    else this.integrateDelete(op);
    return true;
  }

  /** Optimistic local edit: applies immediately, returns the op to broadcast. `visibleIndex` skips tombstones. */
  localInsert(visibleIndex: number, content: string): InsertOp {
    const visible = this.visibleItems();
    if (visibleIndex < 0 || visibleIndex > visible.length) {
      throw new RangeError(
        `localInsert: visibleIndex ${visibleIndex} out of range (length ${visible.length})`,
      );
    }
    // Range-checked above: visibleIndex - 1 is a valid index into `visible` here.
    const originLeft = visibleIndex === 0 ? null : visible[visibleIndex - 1]!.id;
    this.clock += 1;
    const op: InsertOp = {
      kind: 'insert',
      id: { lamport: this.clock, replica: this.replica },
      originLeft,
      content,
    };
    this.applied.add(idKey(op.id));
    this.integrateInsert(op);
    return op;
  }

  localDelete(visibleIndex: number): DeleteOp | null {
    const visible = this.visibleItems();
    if (visible.length === 0) return null;
    const clamped = Math.min(Math.max(visibleIndex, 0), visible.length - 1);
    // Clamped above: guaranteed a valid index into `visible`.
    const target = visible[clamped]!.id;
    this.clock += 1;
    const op: DeleteOp = {
      kind: 'delete',
      id: { lamport: this.clock, replica: this.replica },
      target,
    };
    this.applied.add(idKey(op.id));
    this.integrateDelete(op);
    return op;
  }
}
