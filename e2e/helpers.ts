import { expect, type Locator, type Page, type WebSocketRoute } from '@playwright/test';

/**
 * Shared steps for the browser tests. Every assertion here reads
 * `doc.toString()` — the CRDT's own text, mirrored into the page — rather than
 * CodeMirror's buffer, because the CRDT is the thing under test and the editor
 * is only how a person reaches it.
 */

/** The mirrored `doc.toString()` for this page. */
export function docText(page: Page): Locator {
  return page.getByTestId('doc-text');
}

export function indicator(page: Page): Locator {
  return page.getByTestId('connection-indicator');
}

export async function openEditor(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.cm-content').waitFor();
  await expectOnline(page);
}

export async function expectOnline(page: Page): Promise<void> {
  await expect(indicator(page)).toHaveAttribute('data-status', 'online', { timeout: 15_000 });
}

export async function expectOffline(page: Page): Promise<void> {
  await expect(indicator(page)).toHaveAttribute('data-status', 'offline', { timeout: 15_000 });
}

/** Waits for every locally-created operation to be acknowledged by the server. */
export async function expectQueueDrained(page: Page): Promise<void> {
  await expect(indicator(page)).toHaveAttribute('data-pending', '0', { timeout: 15_000 });
}

export async function readDoc(page: Page): Promise<string> {
  return (await docText(page).textContent()) ?? '';
}

export async function expectDoc(page: Page, text: string): Promise<void> {
  await expect.poll(() => readDoc(page), { timeout: 15_000 }).toBe(text);
}

export async function focusEditor(page: Page): Promise<void> {
  await page.locator('.cm-content').click();
}

/** Types at the current cursor, one character at a time, as a person would. */
export async function typeText(page: Page, text: string): Promise<void> {
  await focusEditor(page);
  await page.keyboard.type(text, { delay: 60 });
}

/** Moves the cursor to just before the last character of the document. */
export async function moveCursorBeforeLastCharacter(page: Page): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
}

/**
 * Empties the document so a run starts from a known state.
 *
 * The room is persistent and shared — there is no document list until M11 — so
 * without this a second run would be asserting against the first run's text.
 * Tombstones mean this grows the log rather than shrinking it, which is the
 * correct behaviour and costs nothing at demo scale.
 */
export async function clearDocument(page: Page): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expectDoc(page, '');
}

/** Sorted characters — the multiset that convergence must preserve exactly. */
export function characters(text: string): string {
  return [...text].sort().join('');
}

/**
 * A cut cable for one page.
 *
 * `BrowserContext.setOffline` is the obvious tool and the wrong one: it does
 * not tear down a WebSocket that is already open, so a client with a live
 * socket never notices. Proxying the socket instead gives the test the thing
 * it actually needs — a connection it can drop on command, and refuse to let
 * back up until it says so.
 */
export interface SocketControl {
  /** Drops the live socket and refuses new ones, exactly as a dead network does. */
  cut(): Promise<void>;
  /** Lets the client's next reconnect attempt through. */
  restore(): void;
}

export async function controlSocket(page: Page): Promise<SocketControl> {
  const live: WebSocketRoute[] = [];
  let allowed = true;

  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (!allowed) {
      ws.close();
      return;
    }
    // No message handlers: with a server connection open, Playwright forwards
    // traffic in both directions untouched. The proxy exists to be closable,
    // not to interfere.
    ws.connectToServer();
    live.push(ws);
  });

  return {
    async cut() {
      allowed = false;
      await Promise.all(live.splice(0).map((ws) => ws.close()));
    },
    restore() {
      allowed = true;
    },
  };
}

/** Remote carets drawn in this page — one per connected peer. */
export function peerCarets(page: Page): Locator {
  return page.locator('[data-testid="peer-caret"]');
}

/**
 * Waits until this page draws exactly one remote caret, at `offset`.
 *
 * Polls rather than asserts once: the offset settles after two round trips —
 * the local recompute from anchors, then the peer's own presence message — and
 * the settled value is the one the criterion is about.
 */
export async function expectPeerCaretAt(page: Page, offset: number): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await peerCarets(page).evaluateAll((els) =>
            els.map((el) => el.getAttribute('data-offset')),
          )
        ).join(),
      { timeout: 15_000 },
    )
    .toBe(String(offset));
}

/** Places the local cursor at a visible offset, counting from the start of the document. */
export async function placeCursor(page: Page, offset: number): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < offset; i++) await page.keyboard.press('ArrowRight');
}
