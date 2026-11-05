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
  ['read unavailable', 503, 200, [identity], undefined],
  ['read denied', 403, 200, [identity], undefined],
] as const)('recipient lookup: %s', async (_name, read, lookup, accounts, expected) => {
  const calls: URL[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      calls.push(new URL(new Request(input, init).url));
      const status = calls.length === 1 ? read : lookup;
      return Response.json(calls.length === 1 ? snapshot : { accounts, next: null }, { status });
    }) as typeof fetch,
  });
  const result = lookupAccessIdentity(client, 'Bearer manager', resourceId, '@aki');
  if (expected === undefined) await expect(result).rejects.toThrow();
  else expect(await result).toEqual(expected);
  expect(calls.map((url) => url.pathname)).toEqual(read === 200 ? ['/v1/grants', '/v1/accounts'] : ['/v1/grants']);
  if (read === 200) expect(calls[1]!.searchParams.toString()).toBe('handle=aki');
});
