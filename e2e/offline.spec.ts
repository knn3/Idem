import { expect, test } from '@playwright/test';

import {
  characters,
  clearDocument,
  controlSocket,
  expectDoc,
  expectOffline,
  expectOnline,
  expectQueueDrained,
  focusEditor,
  indicator,
  moveCursorBeforeLastCharacter,
  openEditor,
  readDoc,
  typeText,
} from './helpers';

/**
 * M9's acceptance criterion, run for real: two windows, both offline,
 * conflicting edits typed into the same sentence, reconnected, identical text.
 *
 * This is the headline demo. It is also the only test in the repo that
 * exercises the IndexedDB outbox itself — a browser database can only be
 * tested honestly in a browser.
 *
 * Needs the full stack up (`pnpm dev` with `DATABASE_URL` set); the Playwright
 * config starts it if it is not already running. The recorded video of the
 * first test is the demo GIF in the README — see `docs/DEMO.md`.
 */
const RECORDINGS = 'e2e/recordings';
const VIEWPORT = { width: 900, height: 620 };

const SENTENCE = 'the meeting is at .';
const ALICE_EDIT = 'noon';
const BOB_EDIT = 'four';

test.describe('offline editing', () => {
  test('two windows, both offline, conflicting edits, identical text after reconnect', async ({
    browser,
  }) => {
    const aliceContext = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: RECORDINGS, size: VIEWPORT },
    });
    const bobContext = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: RECORDINGS, size: VIEWPORT },
    });
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    const aliceNetwork = await controlSocket(alice);
    const bobNetwork = await controlSocket(bob);

    try {
      await openEditor(alice);
      await openEditor(bob);
      await clearDocument(alice);
      await expectDoc(bob, '');

      // A shared starting point both windows agree on.
      await typeText(alice, SENTENCE);
      await expectDoc(bob, SENTENCE);
      await expectQueueDrained(alice);

      // Both windows lose the network.
      await aliceNetwork.cut();
      await bobNetwork.cut();
      await expectOffline(alice);
      await expectOffline(bob);

      // Each types a different time into the same gap, before the full stop.
      await moveCursorBeforeLastCharacter(alice);
      await alice.keyboard.type(ALICE_EDIT, { delay: 80 });
      await moveCursorBeforeLastCharacter(bob);
      await bob.keyboard.type(BOB_EDIT, { delay: 80 });

      // Offline, each window shows its own edit and nothing else — and says so.
      await expectDoc(alice, 'the meeting is at noon.');
      await expectDoc(bob, 'the meeting is at four.');
      await expect(indicator(alice)).toHaveAttribute('data-pending', String(ALICE_EDIT.length));
      await expect(indicator(bob)).toHaveAttribute('data-pending', String(BOB_EDIT.length));

      // The network comes back.
      aliceNetwork.restore();
      bobNetwork.restore();
      await expectOnline(alice);
      await expectOnline(bob);
      await expectQueueDrained(alice);
      await expectQueueDrained(bob);

      const merged = await readDoc(alice);
      await expectDoc(bob, merged);

      // Convergence is the guarantee. The exact interleaving of two runs typed
      // at the same position is RGA's business (SPEC §12) — what M9 promises is
      // that going offline loses nothing: every character both people typed is
      // in the result, exactly once.
      expect(characters(merged)).toBe(characters(SENTENCE + ALICE_EDIT + BOB_EDIT));
      expect(merged.startsWith('the meeting is at ')).toBe(true);
      expect(merged.endsWith('.')).toBe(true);

      // And it is durable, not just agreed-upon: a window that reloads reads
      // the merged text back from the server.
      await alice.reload();
      await openEditor(alice);
      await expectDoc(alice, merged);
    } finally {
      // Deterministic names: the demo GIF is built from these two files, and
      // Playwright's own filenames are content-addressed guids.
      const aliceVideo = alice.video();
      const bobVideo = bob.video();
      await aliceContext.close();
      await bobContext.close();
      await aliceVideo?.saveAs(`${RECORDINGS}/alice.webm`);
      await bobVideo?.saveAs(`${RECORDINGS}/bob.webm`);
    }
  });

  test('a reload while offline does not lose queued edits', async ({ browser }) => {
    // The IndexedDB half of the outbox: the operations outlive the page that
    // created them, and the new replica id a reload mints resends them
    // (SPEC §7).
    const context = await browser.newContext({ viewport: VIEWPORT });
    const otherContext = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    const other = await otherContext.newPage();
    const network = await controlSocket(page);

    try {
      await openEditor(page);
      await openEditor(other);
      await clearDocument(page);
      await expectDoc(other, '');
      await expectQueueDrained(page);

      await network.cut();
      await expectOffline(page);
      await typeText(page, 'survives');
      await expect(indicator(page)).toHaveAttribute('data-pending', '8');
      await expectDoc(other, '');

      // Reload with the socket still dead — the page itself still loads, since
      // only the WebSocket is cut. Nothing reached the server, so the queue in
      // IndexedDB is now the only copy of these edits anywhere.
      await page.reload();
      await expect(indicator(page)).toHaveAttribute('data-pending', '8', { timeout: 15_000 });
      await expectOffline(page);
      // The text itself is *not* restored yet — the outbox stores operations,
      // not a document, and a queued operation can only be replayed against the
      // state it was created from. That state arrives with `welcome`.
      await expectDoc(page, '');
      await focusEditor(page);

      network.restore();
      await expectOnline(page);
      await expectQueueDrained(page);
      await expectDoc(page, 'survives');
      await expectDoc(other, 'survives');
    } finally {
      await context.close();
      await otherContext.close();
    }
  });
});
