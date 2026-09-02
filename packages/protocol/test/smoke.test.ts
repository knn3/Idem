import { describe, expect, it } from 'vitest';

describe('@idem/protocol', () => {
  it('loads', async () => {
    const mod = await import('../src/index.js');
    expect(mod).toBeTypeOf('object');
  });
});
