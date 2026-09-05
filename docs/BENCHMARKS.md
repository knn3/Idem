# Benchmarks

Measured numbers, with the conditions they were measured under. A number
without its conditions is not evidence, so each entry says what machine, what
build, and what was included in the timer.

**Machine for every number below:** Apple M1, macOS 26.5.2, Node v22.22.2,
Postgres 16.15 in Docker on localhost.

---

## M8 · Loading a 10,000-operation document

> **Acceptance criterion (PLAN.md M8):** a document with 10,000 operations
> loads in a fresh tab in under 500 ms.

**Result: 329 ms cold, 58–148 ms warm — in a real browser. Criterion met.**

The document is 10,000 single-character insert operations typed left to right
(126 lines), stored in Postgres, with a snapshot at seq 10,000.

### In the browser — the criterion as written

Chromium, Next.js 15 **dev mode** (unminified, no production build), socket
server and Postgres both on localhost. The timer starts when the client sends
`hello` and stops when the text is on screen, so it covers the server's room
load, the socket round trip, `JSON.parse`, zod validation of all 10,000 items,
`Doc.fromItems`, and the CodeMirror dispatch.

| Load | Time | What the client received |
| --- | --- | --- |
| First — server room also cold | **329 ms** | snapshot 10,000 items, tail 0 |
| Warm | **85 ms** | snapshot 10,000 items, tail 0 |
| Warm | **94 ms** | snapshot 10,000 items, tail 0 |
| Warm | **148 ms** | snapshot 10,000 items, tail 0 |
| Warm, after 3 more ops | **58 ms** | snapshot 10,000 items, tail 3 |

The client prints this itself — open the console on any document and you get
the line, so the number is re-measurable rather than a claim in a file:

```
[idem] loaded in 85 ms (snapshot 10000 items, tail 0 ops, seq 10000)
```

The first load is slower because the server had not yet loaded the room. That
cost is real and belongs in the number: it is what a tab hits after a deploy.

### The baseline it replaces

`apps/server/test/load-benchmark.test.ts` measures the same document twice —
once through the snapshot path, once with snapshots disabled — in-process, so
the two are directly comparable:

| Path | Time | Payload |
| --- | --- | --- |
| Snapshot (`welcome` carries items) | **41 ms** | 1,775 KiB |
| Full replay (`welcome` carries 10,000 ops) | **563 ms** | 1,775 KiB |

Two things worth reading off that table.

**The win is not bandwidth.** Both payloads are 1,775 KiB. A snapshot of a
10,000-character document is about the same size as the 10,000 ops that built
it, because an item and an insert op carry nearly the same fields. What changes
is what the client does with the bytes: hydrating is a linear copy, replaying
is 10,000 integrations, each scanning a list that grows under it — quadratic.

**The baseline is a lower bound, not a fair fight.** It skips the socket
entirely and never pays a cold room load, and it still misses the 500 ms
budget. The real no-snapshot number would be worse. This is the measurement
that says M8 was necessary rather than nice.

### What the snapshot does *not* fix

The server still integrates every operation exactly once, because each snapshot
is materialized from the previous snapshot plus the tail since it. Snapshots do
not remove that O(n²) total — they **amortize** it into 500-op slices paid
during editing, so no single client load ever pays for the whole history.
Reducing the server's total cost needs a different data structure, not a
different snapshot interval, and is out of scope.

### Reproducing it

The in-process numbers run with the normal suite:

```bash
pnpm vitest run --project server test/load-benchmark.test.ts
```

For the browser numbers, seed a 10,000-op document into a scratch database,
start both dev servers, and open the page with the console visible:

```bash
docker run --rm -d --name idem-bench -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=idem -p 5432:5432 postgres:16
```

Then `pnpm db:push`, seed the document by driving a `Room` against
`createPostgresStore` (see the fixture in `load-benchmark.test.ts`), and run
`pnpm dev`.
