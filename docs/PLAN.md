# Idem — Build Plan

Fourteen milestones over four weeks at 10–15 hours per week. Each milestone is sized for one Claude Code session and has an acceptance criterion you can **demonstrate**, not merely claim.

**Rules of engagement**

- Do not start a milestone before the previous one's acceptance criterion passes.
- Never end a working session mid-refactor with nothing runnable.
- Commit at every green acceptance criterion, with a message describing behavior, not files.

---

## Week 1 — The algorithm, alone in the dark

No network. No database. No UI until M4. This is the highest-risk work, so it goes first: if the CRDT is correct, the project is real.

### M0 · Scaffold
Monorepo with pnpm workspaces. TypeScript strict mode. Vitest, ESLint, Prettier. GitHub Actions running typecheck, lint, test.

> **Accepts when:** `pnpm test` and `pnpm build` both pass on a clean clone, and CI is green on the first push.

### M1 · CRDT core
`packages/crdt`: `OpId`, `compareId`, Lamport clock rules, `Item`, and a `Doc` class exposing `localInsert`, `localDelete`, `integrate`, `toString`. Follow SPEC §1–§3 exactly.

**There is a working oracle:** `docs/reference/rga-harness.mjs` is a verified, dependency-free JavaScript implementation of this exact algorithm. Run it with `node docs/reference/rga-harness.mjs`. Port it to TypeScript rather than reinventing it, and if your version ever disagrees with it, your version is wrong.

> **Accepts when:** eight hand-written scenarios pass — including two replicas inserting concurrently at the same position, an insert into a region another replica deleted, and two replicas deleting the same character — and your `Doc` produces identical output to the reference harness on the same operation sequences.

### M2 · Property tests and the network fuzzer
`fast-check` generating random operation sequences. A `SimNetwork` harness that runs N in-process replicas over a seeded RNG with configurable delay, reordering, duplication, and partitions — while preserving causal order. The `runTrial` function in the reference harness is a working version of exactly this; port it to Vitest.

Causal order is enforced the way the reference does it: record, for each operation, the set of operations its author had applied at creation time, and refuse delivery until the recipient has applied all of them.

> **Accepts when:** 1,000 generated cases converge across 2–5 replicas with duplicate delivery enabled, and a seeded 10,000-operation fuzz run with partitions ends with all replicas byte-identical. **This suite is the most valuable artifact in the repo.**

### M3 · Index mapping and cursor anchors
`visibleToItemIndex`, `itemToVisibleIndex`, `toString`. Cursors as `OpId` anchors per SPEC §8, with the left-walk fallback when an anchored item is deleted.

> **Accepts when:** tests prove a cursor holds position under remote inserts before it, remote inserts after it, and deletion of its own anchor.

### M4 · Editor binding, single client
CodeMirror 6 in a Next.js page. Editor changes produce operations; operations render back. No server yet — a `console.table` of the operation stream is the output.

> **Accepts when:** you type in the browser and `doc.toString()` matches the editor content exactly, including after paste and multi-character deletion.

**End of week 1:** a tested, correct CRDT driving a real editor on one machine.

---

## Week 2 — Two machines, then durability

### M5 · Protocol package
`packages/protocol`: zod schemas for every message in SPEC §6, with inferred TypeScript types shared by both apps.

> **Accepts when:** every message type round-trips through parse and serialize, and a malformed message is rejected with a useful error.

### M6 · WebSocket server, memory only
`apps/server`: Fastify plus `ws`. Rooms keyed by document id, per-room `seq` counter, broadcast to all peers, deduplication on `(replica, lamport)`.

> **Accepts when:** **two browser tabs edit the same document and both stay in sync live.** This is the day-12 checkpoint. From here you always have a demo.

### M7 · Postgres and Drizzle
Schema from SPEC §9. Every operation appended to `op_log` inside the same transaction that assigns its `seq`.

> **Accepts when:** you kill the server process, restart it, reload the page, and the document is exactly as you left it.

### M8 · Snapshots and catch-up
Snapshot every 500 operations. `hello` with `sinceSeq` returns either snapshot-plus-tail or tail alone.

> **Accepts when:** a document with 10,000 operations loads in a fresh tab in under 500 ms, measured and written down.

**End of week 2:** live multiplayer editing that survives a restart.

---

## Week 3 — The demo that sells it

### M9 · Offline queue
IndexedDB outbox. Operations leave the outbox only on server acknowledgement. Full resend on reconnect. A connection indicator in the UI.

> **Accepts when:** **the headline demo works** — two windows, both offline, conflicting edits typed into the same sentence, reconnected, identical text. Record it.

### M10 · Presence
Ephemeral cursor and selection broadcast. Remote carets rendered as CodeMirror decorations with per-replica names and colors. Peers dropped on disconnect.

> **Accepts when:** a remote caret sits in the correct place while you type before it, after it, and on top of it.

### M11 · Auth and documents
Auth.js v5 with GitHub. Document list, create, rename, delete. Share-by-link.

> **Accepts when:** two different GitHub accounts, in two different browsers, co-edit one document.

**End of week 3:** a product. Everything after this is what makes it memorable.

---

## Week 4 — Make it undeniable

### M12 · The Inspector
Split view beside the editor: each replica's operation stream, Lamport values, version-vector-based concurrency labels (SPEC §7), and a step-through that replays a remote insert showing which items the scan skipped and why it stopped where it did. A "pause sync" toggle so you can manufacture concurrency on demand.

> **Accepts when:** you pause sync, type conflicting text in both windows, resume, and step through the merge decision by decision.

### M13 · Deploy
Web to Vercel, server to Fly.io, database to Neon. Environment variables documented. A public demo document, seeded, that anyone can open without an account.

> **Accepts when:** a stranger opens the link on their phone and can type alongside you.

### M14 · README and the interleaving write-up
Architecture diagram. Three decisions with tradeoffs. The RGA interleaving anomaly per SPEC §12, with the demonstrating test linked. A bug postmortem — one real bug, how you found it, what it changed. A demo GIF above the fold.

> **Accepts when:** someone who has never seen the repo understands what it does, how it works, and where it's weak, in under three minutes.

---

## If you fall behind

Cut in this order. Every cut leaves a working, demonstrable project.

1. **M12 Inspector** — cut to a static operation log with no step-through. Loses impact, keeps the product.
2. **M10 Presence** — cut remote cursors. The core demo does not depend on them.
3. **M11 Auth** — cut to anonymous documents with unguessable URLs. Ship the editor, not the login form.

**Never cut M2.** The property test suite is the reason a senior engineer takes this seriously. If you have to choose between the Inspector and the fuzzer, keep the fuzzer.

---

## Handing this to Claude Code

Put `CLAUDE.md` at the repo root and this file plus `PROPOSAL.md` and `SPEC.md` in `docs/`. Then open one session per milestone — not one session for the whole project. Context stays clean and each session has a single testable goal.

Opening prompt for a fresh repo:

> Read `docs/SPEC.md` and `docs/PLAN.md` in full before writing any code.
>
> Implement **M0** only. Do not start M1.
>
> Set up a pnpm monorepo: `apps/web` (Next.js 15, App Router, TypeScript strict), `apps/server` (Fastify + ws), `packages/crdt` (zero runtime dependencies — this constraint is load-bearing, see SPEC §10), `packages/protocol` (zod). Add Vitest, ESLint, Prettier, and a GitHub Actions workflow running typecheck, lint, and test.
>
> Stop when `pnpm test` and `pnpm build` pass on a clean install. Then show me the tree and wait.

For each subsequent milestone:

> Read `docs/SPEC.md` §<relevant sections> and the M<n> entry in `docs/PLAN.md`.
>
> Implement M<n> only. Write the tests first where the acceptance criterion is testable. Stop when the acceptance criterion passes and tell me how you verified it.

For M1 and M2 specifically, add:

> The integration function in SPEC §3 is the correctness core of this project. Implement it exactly as written. If you believe it is wrong, stop and explain why rather than "improving" it — a subtly different scan rule still passes casual testing and breaks convergence under concurrency.
