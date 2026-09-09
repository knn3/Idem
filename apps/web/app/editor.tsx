'use client';

import { Annotation, type ChangeSet, EditorState } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';
import { visibleIndexToAnchor, type CursorAnchor, type Doc, type Op } from '@idem/crdt';
import type { Peer } from '@idem/protocol';
import { useEffect, useRef, useState } from 'react';

import { peerCursors, setPeerRanges } from './peer-cursors';
import { createOutbox } from './sync/outbox';
import { resolvePeerRanges } from './sync/presence';
import { SyncClient, type SyncState } from './sync/sync-client';

// No doc list until M11 — every tab joins the same fixed room for now. Must
// match DEV_DOC_ID in apps/server/src/dev-seed.ts: op_log.doc_id is a real
// foreign key into `document`, so this has to be a row that actually exists.
const DOC_ID = '00000000-0000-0000-0000-000000000002';
const WS_URL = (process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8787') + '/ws';

/** Marks a CodeMirror transaction as applying a remote op, so the update
 * listener below doesn't turn the server's own broadcast back into local ops. */
const remoteSync = Annotation.define<boolean>();

/**
 * CodeMirror bound to a `Doc` that a `SyncClient` keeps in step with the
 * server. This component owns the editor and nothing else: local edits become
 * operations, which are applied immediately and handed to the client; whatever
 * the client applies to the document is rendered back.
 *
 * M9 makes that binding survive a dead network. Operations go into a persisted
 * outbox and leave it only on acknowledgement, so typing while offline is
 * ordinary typing — the text is in the document the moment it is typed, and
 * the queue drains on reconnect. See `sync/sync-client.ts`.
 *
 * M10 adds presence. Remote carets are decorations resolved from `OpId`
 * anchors against the current document, recomputed after every change rather
 * than transformed — see `sync/presence.ts` and `peer-cursors.ts`.
 */
export function Editor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mirrorText, setMirrorText] = useState('');
  const [opCount, setOpCount] = useState(0);
  const [sync, setSync] = useState<SyncState>({ status: 'connecting', pending: 0 });
  const [peerCount, setPeerCount] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // One replica id per session (SPEC §1). A reload mints a new one — which is
    // why the outbox is keyed by document, not by replica: operations queued
    // under the old id are still operations the server has never seen.
    const replica = crypto.randomUUID();
    const opLog: Op[] = [];
    let client: SyncClient | null = null;
    let disposed = false;
    let peers: readonly Peer[] = [];

    /**
     * Re-resolves every peer anchor against the current document and hands the
     * result to the decoration field.
     *
     * Called after *every* change, local or remote, rather than relying on
     * CodeMirror to map the old positions forward. Anchors are the truth
     * (SPEC §8); recomputing from them is what makes a remote caret sit
     * correctly whether you type before it, after it, or on top of it.
     */
    function refreshPeers(): void {
      if (disposed || !client) return;
      view.dispatch({
        effects: setPeerRanges.of(resolvePeerRanges(client.doc.items, peers, replica)),
      });
    }

    /** Sends this replica's cursor as two anchors — never as offsets. */
    function sendPresence(): void {
      if (!client) return;
      const items = client.doc.items;
      const range = view.state.selection.main;
      let anchor: CursorAnchor;
      let focus: CursorAnchor;
      try {
        anchor = visibleIndexToAnchor(items, range.anchor);
        focus = visibleIndexToAnchor(items, range.head);
      } catch {
        // The selection is briefly ahead of the document — a remote change is
        // mid-flight. The next event resends it.
        return;
      }
      client.setPresence(anchor, focus);
    }

    /** Pushes the document's text into CodeMirror as a single minimal replacement. */
    function renderDoc(doc: Doc): void {
      const newText = doc.toString();
      const change = diffReplace(view.state.doc.toString(), newText);
      if (!change) return;
      view.dispatch({ changes: change, annotations: [remoteSync.of(true)] });
      setMirrorText(newText);
    }

    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        extensions: [
          basicSetup,
          peerCursors(),
          EditorView.updateListener.of((update) => {
            if (!client) return;
            const local =
              update.docChanged && !update.transactions.some((tr) => tr.annotation(remoteSync));
            if (local) {
              const newOps = applyChangesToDoc(client.doc, update.changes);
              opLog.push(...newOps);
              console.table(opLog.map(describeOp));
              setMirrorText(client.doc.toString());
              setOpCount(opLog.length);
              client.push(newOps);
            }
            if (!update.docChanged && !update.selectionSet) return;
            // Deferred: dispatching from inside an update listener is not
            // allowed, and both of these dispatch or send.
            queueMicrotask(() => {
              if (disposed) return;
              sendPresence();
              refreshPeers();
            });
          }),
        ],
      }),
    });

    const retryNow = () => client?.retryNow();

    void (async () => {
      const outbox = await createOutbox(DOC_ID);
      if (disposed) return;
      client = new SyncClient({
        url: WS_URL,
        docId: DOC_ID,
        replica,
        outbox,
        onChange: () => {
          // Read the getter every time: a snapshot replaces the document.
          if (client) renderDoc(client.doc);
          refreshPeers();
          // A remote change can move this replica's own cursor, which makes its
          // anchors different from the ones the peers were last told about.
          sendPresence();
        },
        onState: setSync,
        onPeers: (next) => {
          peers = next;
          setPeerCount(next.length);
          refreshPeers();
        },
      });
      // The browser knows the network is back before a backoff timer does.
      window.addEventListener('online', retryNow);
      await client.start();
    })();

    return () => {
      disposed = true;
      window.removeEventListener('online', retryNow);
      client?.destroy();
      view.destroy();
    };
  }, []);

  return (
    <div>
      <ConnectionIndicator state={sync} />
      <div ref={containerRef} />
      <p>
        <strong>doc.toString():</strong>
      </p>
      <pre data-testid="doc-text" style={{ whiteSpace: 'pre', margin: 0 }}>
        {mirrorText}
      </pre>
      <p data-testid="peer-count" data-peers={peerCount}>
        {opCount} operations applied locally — full stream logged to the console.
        {peerCount > 0 && ` ${peerCount} other ${peerCount === 1 ? 'person' : 'people'} here.`}
      </p>
    </div>
  );
}

const STATUS_LABEL: Record<SyncState['status'], string> = {
  online: 'Online',
  connecting: 'Connecting…',
  offline: 'Offline',
  error: 'Stopped',
};

const STATUS_COLOR: Record<SyncState['status'], string> = {
  online: '#12805c',
  connecting: '#9a6700',
  offline: '#b42318',
  error: '#b42318',
};

/**
 * The connection indicator. It reports the queue depth as well as the status,
 * because "offline" alone does not answer the question the user actually has
 * while the network is down: *is my typing safe?*
 */
function ConnectionIndicator({ state }: { state: SyncState }) {
  const color = STATUS_COLOR[state.status];
  // The queue depth is the reassurance while offline; when something has gone
  // permanently wrong the message replaces it, because "3 edits queued" answers
  // the wrong question if the document will never load.
  return (
    <p
      data-testid="connection-indicator"
      data-status={state.status}
      data-pending={state.pending}
      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 0 0.5rem' }}
    >
      <span
        aria-hidden
        style={{
          width: '0.6rem',
          height: '0.6rem',
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
        }}
      />
      <strong style={{ color }}>{STATUS_LABEL[state.status]}</strong>
      <span>
        {state.error ??
          (state.pending === 0
            ? 'all edits acknowledged'
            : `${state.pending} edit${state.pending === 1 ? '' : 's'} queued`)}
      </span>
    </p>
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
