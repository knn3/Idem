# Idem — Proposal

**A collaborative text editor built on a CRDT written from scratch, with the merge made visible.**

---

## The name

*Idem* — from **idempotent**, the property that applying an operation twice changes nothing, which is what makes replay and reconnection safe. It is also Latin for *"the same"* — which is exactly what convergence means: every replica, having seen the same set of operations in any order, ends up with the same document.

The name is the thesis.

---

## What it is

A web app where several people edit the same plain-text document at once. Cursors appear where other people are typing. If you lose your connection, you keep editing; when you come back, your edits and theirs merge without a conflict dialog and without a server arbitrating who wins.

The conflict resolution is **not** Yjs, Automerge, or ShareDB. It is a Replicated Growable Array (RGA) implemented in this repo, in a package with no dependencies and no I/O, covered by property-based tests that assert convergence across thousands of randomly permuted operation orderings.

The algorithm is specified exactly in `docs/SPEC.md` §3 and has already been validated: `docs/reference/rga-harness.mjs` is a working implementation that converges across 1,000 randomized multi-replica trials with duplicate delivery. It is the oracle to build against — the design risk is retired before the first line of project code.

The app ships with an **Inspector** panel that shows the machinery: each replica's operation stream, Lamport clocks, which operations are concurrent, and a step-through replay of how a remote insert found its position in the list.

---

## Why this project

### What it proves to a senior engineer

Collaborative editing is a distributed systems problem wearing a text editor costume. Building one from the algorithm up demonstrates:

- **Eventual consistency in practice** — not the phrase, the actual data structure that delivers it
- **Causality and logical time** — Lamport clocks, concurrent vs. causally-ordered operations, why wall clocks are useless here
- **Idempotency and at-least-once delivery** — the reconnect path resends operations it isn't sure landed, and that has to be safe
- **Property-based testing** — the convergence test suite is the strongest single artifact in this repo, and it's the kind of testing most candidates have never written
- **Knowing where your own work is fragile** — RGA has a documented interleaving anomaly. The README names it, shows the failing case, and explains what would fix it. This is the part seniors actually respect.

### What it gives a recruiter

Fifteen seconds, no explanation required: open two windows, disconnect both, type conflicting edits into the same sentence, reconnect, watch them land on an identical document.

That demo works on a phone, in a coffee shop, in front of someone with no technical background.

---

## Scope

### In scope

- Plain-text documents, one document per room
- Real-time sync between any number of clients via WebSocket
- Live remote cursors and selections with names and colors
- Offline editing with a local queue, and safe reconnection
- GitHub sign-in, a document list, shareable document links
- Server-side persistence with an append-only operation log and periodic snapshots
- The Inspector panel
- A property-based convergence test suite and a deterministic network fuzzer

### Explicitly not in scope

These are cut deliberately. Say so in the README — stating what you chose not to build reads as judgment, not as a gap.

- **Rich text** (bold, headings, lists). Rich-text CRDTs are an open research area; formatting spans that survive concurrent edits are much harder than characters. Plain text only.
- **Peer-to-peer sync.** A central server provides causal delivery for free by totally ordering operations. Going P2P would mean implementing causal broadcast, which is a separate project.
- **Undo/redo.** Correct multiplayer undo (undoing *your* last change, not the last change) needs an inverse-operation model this design doesn't have.
- **Access control beyond "has the link".** No roles, no permissions matrix.
- **Garbage collection of tombstones.** Deleted characters stay in memory forever. This is a known limitation with a known fix; document it rather than build it.

---

## Success criteria

The project is done when all of these are true.

1. **The demo works cold.** Two browser windows, both taken offline, conflicting edits typed into the same paragraph, reconnected — identical text in both, every time.
2. **The property suite is green at 1,000 cases.** Random operation sequences, applied in random causally-valid orders across simulated replicas, all converge.
3. **It survives a restart.** Kill the server, bring it back, reload the page, the document is intact.
4. **A new client joins a large document fast.** 10,000 operations, joining client renders in under 500ms via snapshot.
5. **The Inspector explains itself.** Someone who has never heard of a CRDT can watch the step-through and understand why a character landed where it did.
6. **The README carries a bug postmortem.** One real bug from the build, how it was found, what it changed about your mental model.

---

## Architecture at a glance

```
┌──────────────┐   ops over WebSocket    ┌──────────────┐
│  Web client  │ ──────────────────────► │    Server    │
│              │ ◄────────────────────── │              │
│  CodeMirror  │   ops + assigned seq    │  ws + Fastify│
│  view layer  │                         │              │
│      │       │                         │      │       │
│  ┌───▼────┐  │                         │  ┌───▼────┐  │
│  │ @idem/ │  │  same package, both     │  │Postgres│  │
│  │  crdt  │  │  sides                  │  │op_log +│  │
│  └────────┘  │                         │  │snapshot│  │
│  local queue │                         │  └────────┘  │
│  (IndexedDB) │                         │              │
└──────────────┘                         └──────────────┘
```

The server does **not** resolve conflicts. It assigns a sequence number, appends to the log, and rebroadcasts. All merging happens in `@idem/crdt`, identically on every machine. That separation is the point, and it's worth stating in the README: *the server is a relay with a disk, not an authority.*

---

## Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript | One language across client, server, and the CRDT package |
| CRDT | Hand-written RGA | The project. No dependencies, no I/O, pure functions |
| Editor view | CodeMirror 6 | The CRDT is the project; the text-input widget is not. Hand-rolling `contenteditable` costs a week to selection and IME bugs |
| Transport | WebSocket (`ws`) | Persistent bidirectional connection; server assigns global order |
| HTTP/API | Fastify | Auth callback, document list, snapshot fetch |
| Web app | Next.js 15 (App Router) | Most-requested React framework |
| Database | Postgres (Neon) | Append-only log + snapshots; unique constraint enforces idempotency |
| ORM | Drizzle | Schema in TypeScript, SQL stays visible |
| Auth | Auth.js v5, GitHub only | Don't build auth; do understand the session |
| Tests | Vitest + fast-check | Property-based convergence testing is the headline artifact |
| E2E | Playwright | Two browser contexts, real convergence assertion |
| Deploy | Vercel + Fly.io + Neon | Web on Vercel, socket server on Fly (needs a long-lived process) |

---

## The risk, stated plainly

The failure mode for this project is **not finishing**. An unfinished ambitious project is worse than a finished modest one, because a reviewer cannot tell "ran out of time on something hard" from "couldn't do it."

The plan is ordered to defend against exactly this:

- The CRDT core and its tests come **first**, in week one, with no network and no UI. If that works, the project is real.
- **Two tabs syncing live by day 12.** From that point there is always a working demo, and every remaining milestone widens it rather than being required by it.
- Every milestone has an acceptance criterion that is a thing you can *show*, not a thing you can claim.

If week 4 disappears, you still have a working collaborative editor with a tested CRDT. You would only lose the Inspector polish.
