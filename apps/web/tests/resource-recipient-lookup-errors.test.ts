import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { lookupAccessIdentity } from '../src/accounts/resource-access/data';
import { snapshot, resourceId } from '../src/stories/pages/accounts-resource-access/fixtures';
const identity = snapshot.identities[1]!;
test.each([
  ['eligible', 200, 200, [identity], identity],
  ['no match', 200, 200, [], null],
  ['ineligible', 200, 200, [{ ...identity, state: 'deleted' }], null],
  ['identity unavailable', 200, 503, [], undefined],
  ['identity transport lost', 200, 0, [], undefined],
  ['management unavailable', 503, 200, [identity], undefined],
  ['management denied', 403, 200, [identity], undefined],
] as const)('%s keeps absence distinct from a retryable read', async (_name, management, lookup, accounts, expected) => {
  const calls: URL[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const url = new URL(new Request(input, init).url);
      calls.push(url);
      const status = calls.length === 1 ? management : lookup;
      if (!status) throw new Error('Transport unavailable');
      return Response.json(calls.length === 1 ? snapshot : { accounts, next: null }, { status });
    }) as typeof fetch,
  });
  const result = lookupAccessIdentity(client, 'Bearer manager', resourceId, '@aki');
  if (expected === undefined) await expect(result).rejects.toThrow();
  else expect(await result).toEqual(expected);
  expect(calls.map((url) => url.pathname)).toEqual(management === 200 ? ['/v1/grants', '/v1/accounts'] : ['/v1/grants']);
  if (management === 200) expect(calls[1]!.searchParams.toString()).toBe('handle=aki');
});
