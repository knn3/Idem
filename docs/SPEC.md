# Idem — Technical Specification

This document is the source of truth for the algorithm and the protocol. If code and this document disagree, one of them is a bug — decide which and fix it.

---

## 1. Core model

The document is an **ordered list of items**. Each item holds one character. Items are never removed; deletion marks a tombstone. Tombstones must persist because remote operations refer to positions by item identity, and a removed item would break that reference.

```ts
interface OpId {
  lamport: number   // Lamport logical clock value
  replica: string   // unique per client session (uuid v4)
}

interface Item {
  id: OpId
  originLeft: OpId | null   // the item this was inserted immediately after; null = document start
  content: string           // exactly one character in v1
  deleted: boolean
}
```

### Identifier ordering

A total order over `OpId` is required, and it must be identical on every replica.

```ts
function compareId(a: OpId, b: OpId): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  return a.replica < b.replica ? -1 : a.replica > b.replica ? 1 : 0
}
```

Lamport first, replica string as tiebreak. The tiebreak is arbitrary but must be deterministic — that arbitrariness is precisely what makes concurrent inserts converge.

### Lamport clock rules

Each replica keeps `clock: number`, starting at 0.

- **Before creating a local operation:** `clock += 1`, and the new operation's id is `{ lamport: clock, replica: myReplicaId }`.
- **On receiving a remote operation:** `clock = Math.max(clock, remote.id.lamport)`.

This guarantees that if operation A causally precedes B, then `A.lamport < B.lamport`. The converse does not hold — a lower Lamport value does not prove causal precedence — which is exactly why concurrency detection needs more than a comparison (see §7).

---

## 2. Operations

```ts
type Op =
  | { kind: 'insert'; id: OpId; originLeft: OpId | null; content: string }
  | { kind: 'delete'; id: OpId; target: OpId }
```

A delete carries its own `id` — used for the log, deduplication, and clock advancement — but its *effect* depends only on `target`. Applying the same delete twice is a no-op. Applying two different deletes to the same target is also a no-op the second time. **This is where the project gets its name.**

---

## 3. Integration — the heart of the algorithm

This is the only genuinely subtle function in the codebase. Get it right, test it hard, do not refactor it casually.

### Remote insert

```ts
function integrateInsert(items: Item[], op: InsertOp): void {
  // 1. Find where scanning starts: just right of the origin.
  let i = op.originLeft === null
    ? 0
    : indexOfItem(items, op.originLeft) + 1

  // 2. Scan right past every item whose id is GREATER than ours.
  //    Stop at the first item with a smaller id — we go before it.
  while (i < items.length && compareId(items[i].id, op.id) > 0) {
    i++
  }

  // 3. Insert.
  items.splice(i, 0, {
    id: op.id,
    originLeft: op.originLeft,
    content: op.content,
    deleted: false,
  })
}
```

**Why this converges.** Two replicas that have applied the same set of operations run the same scan from the same origin over the same list, and `compareId` is a total order. The result is byte-identical. Among concurrent inserts sharing an origin, the higher id ends up further left — arbitrary, but the same arbitrary choice everywhere.

**This requires causal delivery.** `indexOfItem(op.originLeft)` must find the origin, so the operation that created it must already have been applied. §5 explains how the server guarantees this for free.

### Remote delete

```ts
function integrateDelete(items: Item[], op: DeleteOp): void {
  const item = findItem(items, op.target)
  if (!item) throw new Error('causal delivery violated: delete before insert')
  item.deleted = true   // idempotent
}
```

### Local operations

A local edit produces an operation, applies it to the local state immediately (optimistic — the user must never wait for a round trip), and queues it for send.

```ts
function localInsert(doc: Doc, visibleIndex: number, ch: string): InsertOp {
  const originLeft = visibleIndex === 0
    ? null
    : visibleItemAt(doc.items, visibleIndex - 1).id
  doc.clock += 1
  const op: InsertOp = {
    kind: 'insert',
    id: { lamport: doc.clock, replica: doc.replica },
    originLeft,
    content: ch,
  }
  integrateInsert(doc.items, op)
  return op
}
```

Note `originLeft` is derived from the item at `visibleIndex - 1` — **visible** index, skipping tombstones. Getting this mapping wrong is the most likely source of early bugs.

---

## 4. Index mapping

Two coordinate systems exist and must never be confused:

- **Item index** — position in `items`, including tombstones. Internal only.
- **Visible index** — position in the rendered text, tombstones skipped. What CodeMirror and the user see.

```ts
function visibleToItemIndex(items: Item[], visible: number): number
function itemToVisibleIndex(items: Item[], itemIdx: number): number
function toString(items: Item[]): string   // concat of non-deleted content
```

**Performance note, and what to say about it.** These are O(n) scans. For documents under roughly 50,000 characters that is fine, and v1 should not optimize it. The correct fix is a rope or an order-statistic tree giving O(log n) index lookup. Do not build it — measure it, note the threshold in the README, and describe the fix. A stated, measured limitation reads far better than a premature optimization.

---

## 5. Causal delivery via server ordering

The server assigns every operation a monotonically increasing `seq` per document, appends it to the log, and rebroadcasts in `seq` order. Clients apply in `seq` order.

This gives causal delivery without implementing causal broadcast: a client only ever references items it has already seen, those items reached it through the server at a lower `seq`, and every other client also receives that lower `seq` first.

**A client's own operations are applied locally before they have a `seq`.** When they come back from the server, the client must recognize and skip them. Deduplicate on `(replica, lamport)`.

This is the single most important simplifying decision in the design, and it should be stated out loud in the README: *going peer-to-peer would require implementing causal broadcast, which is a separate project. A star topology buys causal delivery for the price of a sequence number.*

---

## 6. Wire protocol

JSON over WebSocket. Every message is validated with zod at the boundary, on both ends.

### Client → server

```ts
{ t: 'hello',    docId: string, replica: string, sinceSeq: number }
{ t: 'ops',      ops: Op[] }
{ t: 'presence', anchor: OpId | null, focus: OpId | null }
```

### Server → client

```ts
{ t: 'welcome',  snapshot: Snapshot | null, ops: Op[], seq: number }
{ t: 'ops',      ops: Op[], seq: number }      // seq = highest seq in this batch
{ t: 'presence', peers: Peer[] }
{ t: 'error',    code: string, message: string }
```

```ts
interface Snapshot { seq: number; items: Item[] }
interface Peer { replica: string; name: string; color: string; anchor: OpId | null; focus: OpId | null }
```

### Connect / reconnect sequence

1. Client sends `hello` with `sinceSeq` — the highest `seq` it has applied (0 on first connect).
2. Server responds with `welcome`:
   - If `sinceSeq` is 0 or older than the latest snapshot: send the snapshot plus every operation after it.
   - Otherwise: send only operations with `seq > sinceSeq`.
3. Client flushes its offline queue as an `ops` message.
4. Server deduplicates, assigns `seq` to genuinely new operations, persists, rebroadcasts to all clients including the sender.

---

## 7. Offline and reconnection

The client keeps an **outbox** of operations created but not yet acknowledged, persisted in IndexedDB so a page reload doesn't lose them.

- An operation leaves the outbox when the client sees it come back from the server with a `seq`.
- On reconnect, the whole outbox is resent. Resending is safe — operations are idempotent, and the server's unique index on `(doc_id, replica, lamport)` rejects duplicates silently.

**Ordering after reconnect does not matter.** A returning client's operations may carry lower Lamport values than operations already applied by others. RGA does not require operations to arrive in Lamport order — only in causal order, which §5 guarantees. Concurrent operations may interleave in any order and still converge.

### Concurrency detection for the Inspector

Lamport values alone cannot prove two operations were concurrent. To label concurrency honestly in the Inspector, attach a **version vector** to each operation in the log: a map of `replica → highest lamport seen from that replica` at creation time.

Operation A causally precedes B if `A.replica`'s entry in B's vector is at least `A.lamport`. If neither precedes the other, they are concurrent.

Version vectors are needed **only** for the Inspector's labeling. Do not let them creep into the merge path — the merge does not need them, and adding them there would be a real design error.

---

## 8. Cursors

**Never store a cursor as a number.** A remote insert before your cursor shifts a numeric position and the cursor visibly jumps — the classic bug in naive implementations.

Store a cursor as an **anchor**: the `OpId` of the item immediately to its left (`null` = document start). To render, convert the anchor to a visible index at paint time. If the anchored item has been deleted by someone else, walk left through tombstones to the nearest visible item.

A selection is two anchors. Presence data is **ephemeral** — broadcast, never written to Postgres, dropped when the socket closes.

---

## 9. Persistence

```sql
-- Append-only operation log. Never UPDATE, never DELETE.
CREATE TABLE op_log (
  doc_id     uuid    NOT NULL REFERENCES document(id),
  seq        bigint  NOT NULL,
  replica    text    NOT NULL,
  lamport    integer NOT NULL,
  op         jsonb   NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, seq),
  UNIQUE (doc_id, replica, lamport)     -- makes duplicate delivery impossible
);

CREATE TABLE snapshot (
  doc_id     uuid NOT NULL REFERENCES document(id),
  seq        bigint NOT NULL,
  items      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, seq)
);

CREATE TABLE document (
  id       uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app_user(id),
  title    text NOT NULL,
  slug     text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id        uuid PRIMARY KEY,
  github_id text NOT NULL UNIQUE,
  name      text NOT NULL,
  avatar_url text
);
```

`seq` is assigned by the server per document, not by a global sequence. Take it from `max(seq) + 1` inside the same transaction as the insert, or keep an in-memory counter per loaded room with the unique constraint as the backstop.

**Snapshots** are written every 500 operations. A snapshot is the materialized `items` array — tombstones included, because they are still referenced. Keep the two most recent snapshots and delete older ones; keep the log forever (it is the audit trail and it powers the Inspector).

---

## 10. Package layout

```
idem/
├── apps/
│   ├── web/                 Next.js 15 app — editor, doc list, Inspector
│   └── server/              Fastify + ws — rooms, persistence, broadcast
├── packages/
│   ├── crdt/                THE PROJECT. Zero dependencies. Zero I/O.
│   │   ├── src/id.ts        OpId, compareId, Lamport clock
│   │   ├── src/doc.ts       Doc class, local ops, integration
│   │   ├── src/index-map.ts visible ↔ item index
│   │   └── test/            unit + property + fuzz
│   └── protocol/            zod schemas for every wire message
└── docs/
```

### The rule that protects the project

`packages/crdt` must import nothing. No React, no database, no WebSocket, no logger, no date library. It is pure functions over plain data.

This is not stylistic. It is what makes the property tests possible: the fuzzer spins up ten simulated replicas in one process, feeds them permuted operation streams, and compares results. That is only cheap because the package has no I/O.

---

## 11. Invariants

Every one of these should exist as an assertion in the test suite.

1. **Convergence.** Any two replicas having applied the same set of operations produce identical `toString()` output.
2. **Idempotency.** Applying any operation twice yields the same state as applying it once.
3. **Commutativity of concurrent operations.** Two concurrent operations applied in either order yield the same state.
4. **Causal readiness.** Integration never runs against a missing `originLeft` or a missing delete `target`.
5. **Tombstone permanence.** `items.length` never decreases.
6. **Identity immutability.** An `Item.id` is never reassigned after creation.
7. **Intention preservation for cursors.** A remote edit entirely to the left of a cursor shifts its visible index; a remote edit entirely to the right does not.

---

## 12. Known limitation — state this, don't hide it

RGA exhibits an **interleaving anomaly on backward insertions**. This has been verified empirically against the exact algorithm in §3 — see `docs/reference/rga-harness.mjs`, which reproduces it.

Be precise about when it happens, because the commonly repeated version of this claim is wrong:

- **Forward runs do not interleave.** When a user types normally, the cursor advances, so each character's `originLeft` is the character they just typed. The run forms a chain and stays contiguous through a merge. Alice typing `HELLO` while Bob concurrently types `WORLD` converges to `XHELLOWORLD` or `XWORLDHELLO` — never a mixture.
- **Backward runs do interleave.** When characters are repeatedly inserted at the *same* origin — the user holds the cursor still and types before the same character, e.g. pressing Home and typing — every character in the run shares one `originLeft`. Two such concurrent runs interleave character by character.

### Verified reproduction

Shared starting document `X`. Both replicas insert five characters, each at visible index 1, so every insert has `originLeft = X`.

```
Replica A inserts H, E, L, L, O  → locally reads  XOLLEH
Replica B inserts W, O, R, L, D  → locally reads  XDLROW
After merge, both converge to:   XDOLLRLOEWH
```

Convergence holds — the two replicas agree exactly. Intention does not: neither user's run survived intact.

Write this as a test named something like `documents_rga_backward_interleaving` and assert the exact merged string. It is documenting known behavior, not a failure. **Do not "fix" it** — any change to the scan rule that appears to fix it will break convergence somewhere else.

The genuine fix is a different list CRDT. Fugue (Weidner & Kleppmann, 2023, *"The Art of the Fugue: Minimizing Interleaving in Collaborative Text Editing"*) is designed for maximal non-interleaving and is the right pointer to cite. RGA was chosen here for implementability within the schedule.

**Do not skip this section.** A candidate who can state the weakness in their own data structure, with a reproduction, is in a different category from one who cannot.
