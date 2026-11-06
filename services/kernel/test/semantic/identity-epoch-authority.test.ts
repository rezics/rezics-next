import { expect, test } from 'bun:test';
import type { CommandAuthorization } from '../../src/command/command.ts';
import { commandAuthorityAt } from '../../src/semantic/identity-adapters/identity-epoch-contract.ts';

const authorization = { action: 'subject:merge' } as CommandAuthorization;
const other = { action: 'subject:read' } as CommandAuthorization;

test('commandAuthorityAt asks authorizationFor for the named partition', async () => {
  const seen: number[] = [];
  const result = await commandAuthorityAt(
    {
      authorization,
      authorizationFor: async (partition) => {
        seen.push(partition);
        return other;
      },
      basis: { actorAccountId: 'account', clientId: 'client', requestedBy: 'actor' },
      deadline: 9,
    },
    17,
  );
  expect(seen).toEqual([17]);
  expect(result).toEqual({
    partition: 17,
    basis: { actorAccountId: 'account', clientId: 'client', requestedBy: 'actor' },
    deadline: 9,
    authorization: other,
  });
});

test('commandAuthorityAt keeps a single authorization when authorizationFor is absent', async () => {
  expect(await commandAuthorityAt({ authorization }, 4)).toEqual({ partition: 4, authorization });
});
