# Idem

**A collaborative plain-text editor built on a CRDT written from scratch, with the merge made visible.**

Several people edit one document at once. Cursors appear where other people are typing. Lose your connection and you keep editing — when you come back, your edits and theirs merge without a conflict dialog and without a server arbitrating who wins.

The conflict resolution is **not** Yjs, Automerge, or ShareDB. It is a Replicated Growable Array (RGA) implemented in this repo, in a package with no dependencies and no I/O, covered by property-based tests that assert convergence across thousands of randomly permuted operation orderings.

_Idem_ — from **idempotent**, the property that applying an operation twice changes nothing, which is what makes replay and reconnection safe. Also Latin for _"the same"_, which is what convergence means. The name is the thesis.

> **Status:** in progress. Milestones are tracked in [`docs/PLAN.md`](docs/PLAN.md); a demo GIF lands here when M9 does.

---

## How it works

```
┌──────────────┐   ops over WebSocket    ┌──────────────┐
│  Web client  │ ──────────────────────► │    Server    │
│              │ ◄────────────────────── │              │
│  CodeMirror  │   ops + assigned seq    │  ws + Fastify│
│  view layer  │                         │              │
│      │       │                         │      │       │
│  ┌───▼────┐  │  same package, both     │  ┌───▼────┐  │
│  │ @idem/ │  │  sides                  │  │Postgres│  │
│  │  crdt  │  │                         │  │op_log +│  │
│  └────────┘  │                         │  │snapshot│  │
│  local queue │                         │  └────────┘  │
│  (IndexedDB) │                         │              │
└──────────────┘                         └──────────────┘
```

The server **does not resolve conflicts.** It assigns a per-document sequence number, appends to an immutable log, and rebroadcasts. All merging happens in `packages/crdt`, identically on every machine. _The server is a relay with a disk, not an authority._

Causal delivery comes free from that total order: clients apply strictly in `seq` order.

---

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Web on `http://localhost:3000`, socket server on `http://localhost:8787`.

Node 22 (see `.nvmrc`) and pnpm 10.

---

## Commands

```bash
pnpm dev            # web + server together
pnpm dev:web        # Next.js only
pnpm dev:server     # socket server only
pnpm test           # all tests
pnpm test:watch     # watch mode
pnpm test:prop      # property + fuzz suite only (slow)
pnpm typecheck
pnpm lint
pnpm db:push        # push Drizzle schema
pnpm db:studio      # inspect the database
pnpm e2e            # Playwright
```

---

## Layout

```
apps/web           Next.js 15 App Router — editor (CodeMirror 6), doc list, Inspector
apps/server        Fastify + ws — rooms, seq assignment, persistence, broadcast
packages/crdt      The RGA. Zero dependencies, zero I/O, pure functions.
packages/protocol  zod schemas for every wire message; shared by both apps.
docs/SPEC.md       Source of truth for the algorithm
docs/PLAN.md       Milestone order and acceptance criteria
docs/PROPOSAL.md   Scope, success criteria, stack rationale
docs/reference/    A verified JS implementation of the algorithm — the oracle
```

`packages/crdt` has **zero runtime dependencies**, and that is load-bearing rather than tasteful: it is what makes an in-process multi-replica fuzzer possible, and that fuzzer is the main evidence of correctness. ESLint enforces it.

---

## Testing

| Layer                   | What it does                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Unit                    | Hand-built concurrent scenarios for the CRDT                                                                          |
| Property (`fast-check`) | Random operation sequences applied in random causally-valid orders across simulated replicas; assert convergence      |
| Fuzz                    | A seeded `SimNetwork` with delay, reordering, duplication and partitions — deterministic and replayable from the seed |
| E2E (Playwright)        | Two browser contexts, real convergence assertion                                                                      |

Any change to `packages/crdt` must keep `pnpm test:prop` green at 1,000 cases.

---

## Roadmap

|     | Milestone                      | Accepts when                                                                |
| --- | ------------------------------ | --------------------------------------------------------------------------- |
| M0  | Scaffold                       | `pnpm test` and `pnpm build` pass on a clean clone; CI green                |
| M1  | CRDT core                      | Eight concurrent scenarios pass and output matches the reference harness    |
| M2  | Property tests + fuzzer        | 1,000 cases converge across 2–5 replicas; 10,000-op fuzz run byte-identical |
| M3  | Index mapping + cursor anchors | A cursor holds position under remote inserts and anchor deletion            |
| M4  | Editor binding                 | Typing in the browser matches `doc.toString()` exactly                      |
| M5  | Protocol package               | Every message round-trips; malformed input rejected usefully                |
| M6  | WebSocket server               | Two tabs edit one document and stay in sync live                            |
| M7  | Postgres + Drizzle             | Kill the server, restart, reload — document intact                          |
| M8  | Snapshots + catch-up           | 10,000 operations load in a fresh tab under 500 ms                          |
| M9  | Offline queue                  | Two windows offline, conflicting edits, reconnect, identical text           |
| M10 | Presence                       | A remote caret sits correctly while you type before, after and on it        |
| M11 | Auth + documents               | Two GitHub accounts co-edit one document                                    |
| M12 | Inspector                      | Pause sync, conflict, resume, step through the merge decision by decision   |
| M13 | Deploy                         | A stranger opens the link on their phone and types alongside you            |
| M14 | README + write-up              | A newcomer understands what, how and where it's weak in three minutes       |

Full acceptance criteria in [`docs/PLAN.md`](docs/PLAN.md).

---

## Known limitation — RGA interleaving

RGA interleaves **backward** insertion runs: characters repeatedly inserted at the same origin, as when you hold the cursor still and type before the same character. Forward typing does **not** interleave — the run chains through `originLeft` and stays contiguous.

Verified case: from a shared document `X`, replica A inserts `H,E,L,L,O` at index 1 (locally `XOLLEH`) while replica B inserts `W,O,R,L,D` at index 1 (locally `XDLROW`). Both converge to `XDOLLRLOEWH`.

Convergence holds; intention does not. This is documented behavior with a test that demonstrates it. It is **not** to be "fixed" — any scan-rule change that appears to fix it breaks convergence elsewhere. The real fix is a different list CRDT (Fugue, Weidner & Kleppmann 2023) and is out of scope. See `docs/SPEC.md` §12.

---

## Deliberately not built

Stated so it reads as judgment rather than a gap.

- **Rich text.** Formatting spans that survive concurrent edits are an open research area. Plain text only.
- **Peer-to-peer sync.** A central server gives causal delivery for free by totally ordering operations. P2P means implementing causal broadcast — a separate project.
- **Undo/redo.** Correct multiplayer undo (undoing _your_ last change, not the last change) needs an inverse-operation model this design doesn't have.
- **Permissions beyond link access.** No roles, no permissions matrix.
- **Tombstone garbage collection.** Deleted characters stay in memory. Known limitation, known fix, documented instead of built.

---

## License

MIT — see [LICENSE](LICENSE).
