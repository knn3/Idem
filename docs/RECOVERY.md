# Recovery

What to do when a document will not load, and why it can happen.

---

## `integrateDelete: target not found — causal delivery violated`

A client threw this while applying `welcome`. It means the stored log is not
replayable: it contains a delete whose target was never inserted, so no replica
can rebuild the document from it.

The op log is append-only and the server assigns `seq`, so a *healthy* log can
never look like this. The way it happens is a lost write.

### How a log gets a hole in it

`Room.applyOps` assigns `seq` synchronously and starts the database append
without waiting for it (SPEC §9 permits the in-memory counter). Before the fix
in this file's companion commit, a failed append was logged and dropped: the
room carried on assigning `seq` and broadcasting. Clients treat a returned `seq`
as the acknowledgement that an operation is durable (SPEC §7), so their outboxes
emptied while nothing reached disk.

Once writes started succeeding again, the log resumed mid-history. Any delete
persisted after the gap could reference an insert that was lost inside it, and
from then on the document was permanently unloadable:

- every new client throws replaying it, and
- `maybeSnapshot` throws too, so snapshots never succeed again and the tail
  grows without bound.

A real database reached exactly this state: 228 operations acknowledged and
lost, a log beginning at `seq` 229 with a delete for an item nothing had
inserted, an empty `snapshot` table, and 901 assigned sequence numbers.

A room now closes itself on the first failed write and refuses further
operations, so a database outage costs at most the one batch already in flight —
which clients resend — instead of corrupting the log permanently.

### Diagnosing

A healthy log starts at `seq` 1 with no interior gaps:

```sql
select min(seq) as lo, max(seq) as hi, count(*) as n from op_log where doc_id = '<doc>';
```

`lo` greater than 1, or `n` smaller than `hi - lo + 1`, means operations are
missing. Check for snapshots too — an empty `snapshot` table on a document with
more than 500 operations means materialization has been failing:

```sql
select doc_id, seq from snapshot order by seq desc limit 5;
```

### Repairing

The lost operations are gone; nothing can reconstruct the characters they
inserted. There is no in-place repair that preserves the document, only choices
about what to keep.

**Back up first, always:**

```bash
pg_dump "$DATABASE_URL" --data-only -t op_log -t snapshot > oplog-backup.sql
```

**Discard the document's history** — appropriate for a demo or scratch document:

```sql
delete from op_log  where doc_id = '<doc>';
delete from snapshot where doc_id = '<doc>';
```

**Keep the readable tail instead**, when the text after the gap is worth saving:
replay the log yourself, skip deletes whose target is absent, materialize the
items, and write them as a fresh snapshot at the current `max(seq)`. Clients
then load from that snapshot and never replay the broken prefix. This preserves
text but silently drops the deletions that could not be applied, so the result
is a document that was never exactly anyone's — decide deliberately, do not
reach for it by default.

---

## The server refuses to start

```
E_MISSING_ENV: DATABASE_URL is not set. Copy .env.example to .env and fill it in.
```

Note that **nothing in this repo loads `.env`** — there is no `dotenv` and no
`--env-file`. `apps/web` picks one up because Next.js reads it, but the socket
server reads the real environment only:

```bash
DATABASE_URL="postgres://user:password@localhost:5432/idem" pnpm dev
```

## The tests pass but the app behaves impossibly

Check which server is actually answering before debugging anything:

```bash
curl -s http://localhost:8787/health
```

If the reported `database` is not the one `DATABASE_URL` names, a server from an
earlier run is holding the port and your changes are not being served:

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN -t | xargs kill
```

The e2e suite checks this before it runs a single test — see
`e2e/server-identity.setup.ts`.
