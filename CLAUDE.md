# Idem

A collaborative plain-text editor built on a hand-written RGA CRDT. Several clients edit one document at once; edits merge without a server arbitrating, including after a client has been offline.

**Read `docs/SPEC.md` before touching `packages/crdt`.** It is the source of truth for the algorithm. `docs/PLAN.md` holds the milestone order and acceptance criteria.

---

## Architecture

```
apps/web         Next.js 15 App Router — editor (CodeMirror 6), doc list, Inspector
apps/server      Fastify + ws — rooms, seq assignment, persistence, broadcast
packages/crdt    The RGA. Zero dependencies, zero I/O, pure functions.
packages/protocol  zod schemas for every wire message; shared by both apps.
```

The server **does not resolve conflicts**. It assigns a per-document sequence number, appends to an immutable log, and rebroadcasts. All merging happens in `packages/crdt`, identically on every machine.

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

## Hard rules

These are not style preferences. Breaking any of them breaks correctness.

1. **`packages/crdt` imports nothing.** No React, no database client, no WebSocket, no logger, no date library. Adding a dependency here makes the in-process multi-replica fuzzer impossible, and that fuzzer is the project's main evidence of correctness.

2. **Never modify `integrateInsert` without adding a property test.** The scan rule in SPEC §3 is exact. A subtly different rule passes hand-written tests and silently breaks convergence under concurrency. If it looks wrong to you, stop and explain rather than changing it.

3. **`Item.id` is immutable after creation.** Nothing reassigns it, ever.

4. **Deletes are tombstones.** Items are never spliced out of the list. Remote operations reference items by identity; removing one breaks that reference permanently.

5. **Every operation is idempotent.** Applying the same operation twice must be a no-op. The reconnect path resends operations it isn't sure landed, and that has to be safe.

6. **Two index spaces, never confused.** *Item index* includes tombstones and is internal. *Visible index* skips them and is what the editor and the user see. Any function taking an index must say which in its name or its type.

7. **Cursors are `OpId` anchors, never numbers.** A stored numeric cursor jumps when a remote edit lands before it.

8. **Causal delivery is assumed and provided by server `seq` ordering.** Clients apply strictly in `seq` order. Do not add out-of-order application; it would require causal broadcast, which is out of scope.

9. **Validate at every boundary with zod.** Every WebSocket message, both directions. No `any`, no unchecked casts across the wire.

---

## Conventions

- TypeScript strict. No `any`. No non-null assertions except where an invariant is asserted on the line above.
- Named exports only, no default exports.
- Tests live beside the code in `test/` within each package.
- Errors carry a code and a message that says what to do about it.
- Comments explain *why*, never *what*. The integration function is the exception — annotate it heavily, it is genuinely subtle.

---

## Testing expectations

- **Unit** — hand-built concurrent scenarios for the CRDT.
- **Property (`fast-check`)** — random operation sequences applied in random causally-valid orders across simulated replicas; assert convergence.
- **Fuzz** — a seeded `SimNetwork` with delay, reordering, duplication, and partitions. Deterministic and replayable from the seed.
- **E2E (Playwright)** — two browser contexts, real convergence assertion.

Any change to `packages/crdt` must keep `pnpm test:prop` green at 1,000 cases.

---

## Known limitation

RGA interleaves **backward** insertion runs — characters repeatedly inserted at the same origin, as when a user holds the cursor still and types before the same character. Forward typing does **not** interleave: the run chains through `originLeft` and stays contiguous.

Verified case: from a shared document `X`, replica A inserts `H,E,L,L,O` at index 1 (locally `XOLLEH`) while replica B inserts `W,O,R,L,D` at index 1 (locally `XDLROW`). Both converge to `XDOLLRLOEWH`.

Convergence holds; intention does not. This is documented behavior covered by a test marked as such. **Do not "fix" it** — any scan-rule change that appears to fix it breaks convergence elsewhere. The real fix is a different list CRDT (Fugue, Weidner & Kleppmann 2023) and is out of scope. See SPEC §12 and `docs/reference/rga-harness.mjs`.

---

## Out of scope

Rich text · peer-to-peer sync · undo/redo · permissions beyond link access · tombstone garbage collection.

If a task seems to require one of these, stop and ask rather than expanding the scope.
