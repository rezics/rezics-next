import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import example from '../src/kernel/recorded/my-realms.json';
import { formatMyRealmsInventory } from '../src/community/my-realms-native';

test('installed native inventory formats only its returned window without inferring entry or actions', async () => {
  for (const count of [0, 1, 10, 20]) {
    const items = Array.from({ length: count }, (_, i) => example.items[i % example.items.length]!);
    const next = 'opaque/sparse?cursor=%25';
    let reads = 0;
    const client = createKernelClient('https://kernel.example', {
      fetch: async () => {
        reads++;
        return Response.json({ items, next });
      },
    });
    const { data } = await client.me.realms.get();
    if (!data) throw new Error('Expected the recorded native inventory');
    expect(formatMyRealmsInventory(data)).toEqual({
      realms: items.map(({ realmId, name }) => ({ realmId, name })),
      next,
    });
    expect(reads).toBe(1);
  }
});
