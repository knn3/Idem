'use client';

import { Annotation, type ChangeSet, EditorState } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';
import { Doc, type Op } from '@idem/crdt';
import {
  parseServerMessage,
  serializeMessage,
  type ServerMessage,
  type Snapshot,
} from '@idem/protocol';
import { useEffect, useRef, useState } from 'react';

// No doc list until M11 — every tab joins the same fixed room for now. Must
// match DEV_DOC_ID in apps/server/src/dev-seed.ts: op_log.doc_id is a real
// foreign key into `document`, so this has to be a row that actually exists.
const DOC_ID = '00000000-0000-0000-0000-000000000002';
const WS_URL = (process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8787') + '/ws';

/** Marks a CodeMirror transaction as applying a remote op, so the update
 * listener below doesn't turn the server's own broadcast back into local ops. */
const remoteSync = Annotation.define<boolean>();

/**
 * M6: CodeMirror driving a `Doc` that's synced live over WebSocket (M4 was
 * single-client). Local edits become ops, applied immediately and sent to
 * the server; the server's `ops`/`welcome` broadcasts are applied to `doc`
 * and reflected into the editor. `doc.apply` is idempotent (CLAUDE.md hard
 * rule 5), so a client's own op coming back from the server is a no-op —
 * no special-casing needed to avoid an echo loop.
 *
 * M8 adds the catch-up path: `welcome` may carry a snapshot, which the client
 * hydrates from instead of replaying history, and the client tracks the
 * highest `seq` it has applied so a reconnect asks only for what it missed.
 * The offline outbox that makes that reconnect lossless is M9.
 */
export function Editor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mirrorText, setMirrorText] = useState('');
  const [opCount, setOpCount] = useState(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // One replica id for the whole session (SPEC §1). It outlives `doc`, which
    // is replaced wholesale when the server hands us a snapshot.
    const replica = crypto.randomUUID();
    let doc = new Doc(replica);
    const opLog: Op[] = [];
    /** Highest `seq` applied — sent as `sinceSeq` so a reconnect asks only for what it missed. */
    let sinceSeq = 0;
    let helloSentAt = 0;

    function sendOps(ops: Op[]): void {
      if (ops.length === 0 || ws.readyState !== WebSocket.OPEN) return;
      ws.send(serializeMessage({ t: 'ops', ops }));
    }

    /** Pushes `doc`'s text into CodeMirror as a single minimal replacement. */
    function renderDoc(): void {
      const newText = doc.toString();
      const change = diffReplace(view.state.doc.toString(), newText);
      if (!change) return;
      view.dispatch({ changes: change, annotations: [remoteSync.of(true)] });
      setMirrorText(newText);
    }

    function applyRemoteOps(ops: readonly Op[]): void {
      for (const op of ops) doc.apply(op);
      renderDoc();
    }

    /**
     * `welcome` is either snapshot-plus-tail or tail alone (SPEC §6). Hydrating
     * from the snapshot is what keeps opening a long document cheap: the client
     * skips integrating the history and only replays the ops after it.
     */
    function applyWelcome(snapshot: Snapshot | null, ops: readonly Op[], seq: number): void {
      if (snapshot) doc = Doc.fromItems(replica, snapshot.items);
      for (const op of ops) doc.apply(op);
      sinceSeq = seq;
      renderDoc();
      // M8's acceptance criterion is a wall-clock number, so the client
      // reports its own: hello sent → text on screen. See docs/BENCHMARKS.md.
      console.info(
        `[idem] loaded in ${(performance.now() - helloSentAt).toFixed(0)} ms ` +
          `(snapshot ${snapshot ? `${snapshot.items.length} items` : 'none'}, tail ${ops.length} ops, seq ${seq})`,
      );
    }

    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        extensions: [
          basicSetup,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            if (update.transactions.some((tr) => tr.annotation(remoteSync))) return;
            const newOps = applyChangesToDoc(doc, update.changes);
            opLog.push(...newOps);
            console.table(opLog.map(describeOp));
            setMirrorText(doc.toString());
            setOpCount(opLog.length);
            sendOps(newOps);
          }),
        ],
      }),
    });

    const ws = new WebSocket(WS_URL);
    ws.addEventListener('open', () => {
      setConnected(true);
      helloSentAt = performance.now();
      ws.send(serializeMessage({ t: 'hello', docId: DOC_ID, replica, sinceSeq }));
    });
    ws.addEventListener('close', () => setConnected(false));
    ws.addEventListener('message', (event: MessageEvent<string>) => {
      let message: ServerMessage;
      try {
        message = parseServerMessage(event.data);
      } catch (err) {
        console.error('discarding invalid server message', err);
        return;
      }
      if (message.t === 'welcome') {
        applyWelcome(message.snapshot, message.ops, message.seq);
      } else if (message.t === 'ops') {
        applyRemoteOps(message.ops);
        sinceSeq = message.seq;
      } else if (message.t === 'error') {
        console.error(`server rejected a message [${message.code}]: ${message.message}`);
      }
      // 'presence' arrives in M10.
    });

    return () => {
      ws.close();
      view.destroy();
    };
  }, []);

  return (
    <div>
      <div ref={containerRef} />
      <p>
        <strong>doc.toString():</strong> {connected ? '(synced)' : '(offline)'}
      </p>
      <pre style={{ whiteSpace: 'pre', margin: 0 }}>{mirrorText}</pre>
      <p>{opCount} operations applied locally — full stream logged to the console.</p>
    </div>
  );
}

/**
 * Walks a CodeMirror ChangeSet and turns each change into `Doc.localDelete` /
 * `Doc.localInsert` calls in visible-index space. `iterChanges` reports
 * `fromA`/`toA` against the *pre*-change document for every change in the
 * set, so as earlier changes in the same transaction shrink or grow the doc,
 * `delta` keeps later changes' positions aligned with `doc`'s current state.
 */
function applyChangesToDoc(doc: Doc, changes: ChangeSet): Op[] {
  const ops: Op[] = [];
  let delta = 0;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const from = fromA + delta;
    const removeCount = toA - fromA;
    for (let i = 0; i < removeCount; i++) {
      const op = doc.localDelete(from);
      if (op) ops.push(op);
    }
    const text = inserted.toString();
    for (let i = 0; i < text.length; i++) {
      ops.push(doc.localInsert(from + i, text[i]!));
    }
    delta += text.length - removeCount;
  });
  return ops;
}

/** Smallest replacement span covering every difference between two strings, so a
 * remote update moves the local cursor as little as CodeMirror's change-mapping allows. */
function diffReplace(
  oldText: string,
  newText: string,
): { from: number; to: number; insert: string } | null {
  if (oldText === newText) return null;
  const maxCommon = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < maxCommon && oldText[start] === newText[start]) start++;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return { from: start, to: endOld, insert: newText.slice(start, endNew) };
}

function describeOp(op: Op) {
  const id = `${op.id.replica}:${op.id.lamport}`;
  if (op.kind === 'insert') {
    return {
      id,
      kind: op.kind,
      content: op.content,
      originLeft: op.originLeft ? `${op.originLeft.replica}:${op.originLeft.lamport}` : null,
    };
  }
  return { id, kind: op.kind, target: `${op.target.replica}:${op.target.lamport}` };
}
