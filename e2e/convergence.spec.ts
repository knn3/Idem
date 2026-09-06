import { expect, test } from '@playwright/test';

import {
  characters,
  clearDocument,
  expectDoc,
  expectQueueDrained,
  focusEditor,
  moveCursorBeforeLastCharacter,
  openEditor,
  readDoc,
  typeText,
} from './helpers';

/**
 * Two browser contexts, one document, a real convergence assertion — the M6
 * checkpoint, still guarding the live path now that M9 has rebuilt the client
 * around a queue.
 */
test.describe('two clients', () => {
  test('stay in sync while both are connected', async ({ browser }) => {
    const first = await browser.newContext();
    const second = await browser.newContext();
    const alice = await first.newPage();
    const bob = await second.newPage();

    try {
      await openEditor(alice);
      await openEditor(bob);
      await clearDocument(alice);
      await expectDoc(bob, '');

      await typeText(alice, 'hello');
      await expectDoc(bob, 'hello');

      // Typing at the end of what the other window just wrote — the ordinary
      // case, and the one that would break first if remote operations were
      // being applied at stale indices.
      await focusEditor(bob);
      await bob.keyboard.press('End');
      await bob.keyboard.type(' world', { delay: 60 });
      await expectDoc(alice, 'hello world');

      await expectQueueDrained(alice);
      await expectQueueDrained(bob);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test('converge when both type at the same position at once', async ({ browser }) => {
    const first = await browser.newContext();
    const second = await browser.newContext();
    const alice = await first.newPage();
    const bob = await second.newPage();

    try {
      await openEditor(alice);
      await openEditor(bob);
      await clearDocument(alice);
      await expectDoc(bob, '');

      await typeText(alice, 'AB');
      await expectDoc(bob, 'AB');

      // Both cursors sit between A and B, and both type without waiting for
      // the other — concurrency in the sense the CRDT cares about.
      await moveCursorBeforeLastCharacter(alice);
      await moveCursorBeforeLastCharacter(bob);

      await Promise.all([
        alice.keyboard.type('xxx', { delay: 20 }),
        bob.keyboard.type('yyy', { delay: 20 }),
      ]);

      await expectQueueDrained(alice);
      await expectQueueDrained(bob);

      const merged = await readDoc(alice);
      await expectDoc(bob, merged);
      expect(characters(merged)).toBe(characters('ABxxxyyy'));
      expect(merged.startsWith('A')).toBe(true);
      expect(merged.endsWith('B')).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
