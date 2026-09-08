import { expect, test } from '@playwright/test';

import {
  clearDocument,
  expectDoc,
  expectPeerCaretAt,
  openEditor,
  peerCarets,
  placeCursor,
  typeText,
} from './helpers';

/**
 * M10's acceptance criterion in a real browser: *a remote caret sits in the
 * correct place while you type before it, after it, and on top of it.*
 *
 * Every assertion reads `data-offset` — the offset the caret was last resolved
 * to from the peer's `OpId` anchors — rather than a pixel position, because
 * the anchor resolution is the thing under test and pixels are how it happens
 * to be drawn. The unit coverage is `apps/web/test/presence.test.ts`; this is
 * the proof that the whole path, wire included, agrees with it.
 */
test.describe('remote carets', () => {
  test('hold their place while the other window types around them', async ({ browser }) => {
    const first = await browser.newContext();
    const second = await browser.newContext();
    const alice = await first.newPage();
    const bob = await second.newPage();

    try {
      await openEditor(alice);
      await openEditor(bob);
      await clearDocument(alice);
      await expectDoc(bob, '');

      await typeText(alice, 'HELLO');
      await expectDoc(bob, 'HELLO');

      // Bob parks between the two Ls; Alice sees his caret there.
      await placeCursor(bob, 3);
      await expectPeerCaretAt(alice, 3);

      // Typing *before* it. A numeric cursor would have stayed at 3 and the
      // caret would visibly drift a character left of where Bob is.
      await placeCursor(alice, 0);
      await alice.keyboard.type('X');
      await expectDoc(bob, 'XHELLO');
      await expectPeerCaretAt(alice, 4);

      // Typing *after* it changes nothing.
      await placeCursor(alice, 6);
      await alice.keyboard.type('!');
      await expectDoc(bob, 'XHELLO!');
      await expectPeerCaretAt(alice, 4);

      // Typing *on top of* it. The character lands to the right of the item
      // Bob is anchored to, so his caret does not move: it now sits in front of
      // what Alice just typed, which is still where Bob's own cursor is. Both
      // windows agree, and neither had to transform a number to get there.
      await placeCursor(alice, 4);
      await alice.keyboard.type('Z');
      await expectDoc(bob, 'XHELZLO!');
      await expectPeerCaretAt(alice, 4);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test('carry a name and a colour, and disappear when the peer leaves', async ({ browser }) => {
    const first = await browser.newContext();
    const second = await browser.newContext();
    const alice = await first.newPage();
    const bob = await second.newPage();

    try {
      await openEditor(alice);
      await openEditor(bob);
      await clearDocument(alice);
      await typeText(alice, 'HELLO');
      await expectDoc(bob, 'HELLO');

      await placeCursor(bob, 2);
      await expectPeerCaretAt(alice, 2);

      const caret = peerCarets(alice).first();
      await expect(caret).toHaveAttribute('data-peer-name', /\w+/);
      await expect(caret.locator('.cm-idem-peer-label')).toHaveCSS(
        'background-color',
        /rgb\(\d+, \d+, \d+\)/,
      );

      // Peers are dropped on disconnect (PLAN.md M10) — presence is ephemeral,
      // so a caret must not outlive the socket that was moving it.
      await second.close();
      await expect(peerCarets(alice)).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await first.close();
      await second.close().catch(() => {});
    }
  });
});
