'use client';

import { type ChangeSet, EditorState } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';
import { Doc, type Op } from '@idem/crdt';
import { useEffect, useRef, useState } from 'react';

/**
 * M4: CodeMirror 6 driving a single local `Doc`. No server yet (that's M6) —
 * every keystroke, paste, and deletion becomes CRDT ops applied to `doc`
 * immediately, logged to the console as the "operation stream" PLAN.md asks
 * for. The mirror line below the editor is a correctness check: it should
 * always equal what's on screen.
 */
export function Editor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mirrorText, setMirrorText] = useState('');
  const [opCount, setOpCount] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const doc = new Doc('local');
    const opLog: Op[] = [];

    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        extensions: [
          basicSetup,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            opLog.push(...applyChangesToDoc(doc, update.changes));
            console.table(opLog.map(describeOp));
            setMirrorText(doc.toString());
            setOpCount(opLog.length);
          }),
        ],
      }),
    });

    return () => view.destroy();
  }, []);

  return (
    <div>
      <div ref={containerRef} />
      <p>
        <strong>doc.toString():</strong>
      </p>
      <pre style={{ whiteSpace: 'pre', margin: 0 }}>{mirrorText}</pre>
      <p>{opCount} operations applied — full stream logged to the console.</p>
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
