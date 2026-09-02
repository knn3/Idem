import { test } from '@playwright/test';

// Two browser contexts, one document, a real convergence assertion.
// Filled in once live sync lands in M6 (IDE-11); the offline variant follows in
// M9 (IDE-14).
test.describe('two clients', () => {
  test.skip('converge on identical text after concurrent edits', async () => {});
});
