import { describe, expect, it } from 'vitest';

describe('@idem/crdt', () => {
  it('loads without pulling in any dependency', async () => {
    const mod = await import('../src/index.js');
    expect(mod).toBeTypeOf('object');
  });
});
