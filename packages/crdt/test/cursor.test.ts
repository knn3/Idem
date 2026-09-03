import { describe, expect, it } from 'vitest';
import { Doc } from '../src/doc.js';
import { anchorToVisibleIndex, visibleIndexToAnchor } from '../src/cursor.js';

// M3 (IDE-8) acceptance (PLAN.md): a cursor holds position under remote
// inserts before it, remote inserts after it, and deletion of its own
// anchor. "Holds position" means it stays attached to the character it
// anchored to — not that its visible index never changes.
describe('cursor anchors (SPEC §8)', () => {
  it('shifts forward when a remote insert lands before the anchored character', () => {
    const a = new Doc('A');
    const b = new Doc('B');
    ['a', 'b', 'c'].forEach((ch, i) => a.localInsert(i, ch));
    const seedOps = a.items.map((it) => ({
      kind: 'insert' as const,
      id: it.id,
      originLeft: it.originLeft,
      content: it.content,
    }));
    seedOps.forEach((op) => b.apply(op));
    expect(b.toString()).toBe('abc');

    // Cursor anchored right after 'a' (visible index 1).
    const anchor = visibleIndexToAnchor(a.items, 1);
    expect(anchorToVisibleIndex(a.items, anchor)).toBe(1);

    // Remote insert of 'X' at the very start, before the anchored 'a'.
    const remoteX = b.localInsert(0, 'X');
    a.apply(remoteX);
    expect(a.toString()).toBe('Xabc');

    // The anchor still points at 'a', now one visible slot further right.
    expect(anchorToVisibleIndex(a.items, anchor)).toBe(2);
  });

  it('does not move when a remote insert lands after the anchored character', () => {
    const a = new Doc('A');
    const b = new Doc('B');
    ['a', 'b', 'c'].forEach((ch, i) => a.localInsert(i, ch));

    // Cursor anchored right after 'a' (visible index 1).
    const anchor = visibleIndexToAnchor(a.items, 1);
    expect(anchorToVisibleIndex(a.items, anchor)).toBe(1);

    const seedOps = a.items.map((it) => ({
      kind: 'insert' as const,
      id: it.id,
      originLeft: it.originLeft,
      content: it.content,
    }));
    seedOps.forEach((op) => b.apply(op));

    // Remote insert of 'Y' at the end, after the anchored 'a'.
    const remoteY = b.localInsert(3, 'Y');
    a.apply(remoteY);
    expect(a.toString()).toBe('abcY');

    // The anchor's visible index is unchanged — nothing shifted left of it.
    expect(anchorToVisibleIndex(a.items, anchor)).toBe(1);
  });

  it('walks left through tombstones when its own anchor is deleted', () => {
    const a = new Doc('A');
    const b = new Doc('B');
    ['a', 'b', 'c'].forEach((ch, i) => a.localInsert(i, ch));
    const seedOps = a.items.map((it) => ({
      kind: 'insert' as const,
      id: it.id,
      originLeft: it.originLeft,
      content: it.content,
    }));
    seedOps.forEach((op) => b.apply(op));

    // Cursor anchored right after 'b' (visible index 2).
    const anchor = visibleIndexToAnchor(a.items, 2);
    expect(anchorToVisibleIndex(a.items, anchor)).toBe(2);

    // Remote delete of 'b' — the anchored item itself.
    const delB = b.localDelete(1);
    a.apply(delB!);
    expect(a.toString()).toBe('ac');

    // Walks left past the tombstoned 'b' to 'a' — cursor now sits right after 'a'.
    expect(anchorToVisibleIndex(a.items, anchor)).toBe(1);
  });

  it('anchor null means document start and stays at 0 regardless of remote inserts', () => {
    const a = new Doc('A');
    a.localInsert(0, 'z');
    expect(anchorToVisibleIndex(a.items, null)).toBe(0);

    const b = new Doc('B');
    const seedOps = a.items.map((it) => ({
      kind: 'insert' as const,
      id: it.id,
      originLeft: it.originLeft,
      content: it.content,
    }));
    seedOps.forEach((op) => b.apply(op));
    const remote = b.localInsert(0, 'y');
    a.apply(remote);

    expect(anchorToVisibleIndex(a.items, null)).toBe(0);
  });
});
