import { expect, test } from 'bun:test';
import { clientDeclarations, committedDeclarations } from '../scripts/client.ts';

test('the client package carries the declarations the kernel emits for its HTTP contract', () => {
  const emitted = clientDeclarations();
  expect([...emitted.keys()]).toEqual(expect.arrayContaining(['http/kernel.d.ts', 'http/request.d.ts']));
  if (JSON.stringify([...committedDeclarations()]) !== JSON.stringify([...emitted]))
    throw new Error('packages/client/src/kernel is stale; run `bun run --cwd services/kernel client`');
});
