import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

import type { PeerRange } from './sync/presence';

/**
 * Remote carets and selections, drawn as CodeMirror decorations (PLAN.md M10).
 *
 * The extension holds no anchors of its own. It is handed already-resolved
 * visible indices by `resolvePeerRanges` and redraws whenever they change —
 * which the editor triggers after *every* document change, local or remote.
 *
 * The field still maps its decorations through incoming changes, even though a
 * rebuild is always coming. That mapping is not the source of truth; it exists
 * so a caret does not visibly jump to a stale offset for the one frame between
 * a keystroke and the rebuild that follows it.
 */

export const setPeerRanges = StateEffect.define<readonly PeerRange[]>();

class CaretWidget extends WidgetType {
  constructor(private readonly peer: PeerRange) {
    super();
  }

  override eq(other: CaretWidget): boolean {
    return (
      other.peer.replica === this.peer.replica &&
      other.peer.name === this.peer.name &&
      other.peer.color === this.peer.color &&
      other.peer.head === this.peer.head
    );
  }

  override toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'cm-idem-peer-caret';
    caret.dataset['testid'] = 'peer-caret';
    caret.dataset['peer'] = this.peer.replica;
    caret.dataset['peerName'] = this.peer.name;
    // The offset the caret was last *resolved* to, not where the DOM happens to
    // sit. Tests assert on this, so it must come from the anchor resolution.
    caret.dataset['offset'] = String(this.peer.head);
    caret.style.borderLeft = `2px solid ${this.peer.color}`;

    const label = document.createElement('span');
    label.className = 'cm-idem-peer-label';
    label.style.background = this.peer.color;
    label.textContent = this.peer.name;
    caret.appendChild(label);
    return caret;
  }

  /** Nothing here is interactive; let every event reach the editor underneath. */
  override ignoreEvent(): boolean {
    return false;
  }
}

function build(ranges: readonly PeerRange[], docLength: number): DecorationSet {
  const decorations = [];
  for (const peer of ranges) {
    // A roster can outrun the document by a frame. Clamping beats throwing:
    // the next rebuild lands with the matching text.
    const head = Math.min(peer.head, docLength);
    const from = Math.min(peer.from, docLength);
    const to = Math.min(peer.to, docLength);
    if (from < to) {
      decorations.push(
        Decoration.mark({
          attributes: { style: `background-color: ${peer.color}33` },
        }).range(from, to),
      );
    }
    decorations.push(
      // `side: -1` puts the caret before text inserted at its own position,
      // which is what the anchor means: the peer's cursor sits to the right of
      // the item it is anchored to and to the left of anything typed after it.
      Decoration.widget({ widget: new CaretWidget(peer), side: -1 }).range(head),
    );
  }
  return Decoration.set(decorations, true);
}

const peerField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPeerRanges)) return build(effect.value, tr.newDoc.length);
    }
    return decorations.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const peerTheme = EditorView.baseTheme({
  // Room above the first line for the name flags, which would otherwise be
  // clipped by the top of the editor exactly when a peer is on line 1.
  '.cm-content': {
    paddingTop: '1.6em',
  },
  '.cm-idem-peer-caret': {
    position: 'relative',
    display: 'inline-block',
    width: 0,
    height: '1.2em',
    verticalAlign: 'text-bottom',
    // Zero-width and absolutely-positioned label: a remote caret must not move
    // the text it sits in, or every peer would see a different line layout.
    pointerEvents: 'none',
  },
  '.cm-idem-peer-label': {
    position: 'absolute',
    bottom: '100%',
    left: '-2px',
    padding: '1px 4px 2px',
    borderRadius: '3px',
    color: '#fff',
    // Absolute, not relative to the editor's monospace size: the flag is a
    // label on the interface, not part of the text being edited.
    font: '500 11px/1.2 ui-sans-serif, system-ui, sans-serif',
    whiteSpace: 'nowrap',
  },
});

export function peerCursors(): Extension {
  return [peerField, peerTheme];
}
