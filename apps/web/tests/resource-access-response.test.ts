import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadAccess, writeAccess, type Change } from '../src/accounts/resource-access/data';
import { snapshot, resourceId, readerId } from '../src/stories/pages/accounts-resource-access/fixtures';

const command: Change = {
  resourceId,
  kind: 'direct',
  operation: 'create',
  subject: { kind: 'account', id: readerId },
  actions: ['collection:read'],
  role: null,
  valid: '[,)',
  key: crypto.randomUUID(),
};
const grant = { resource: snapshot.resource, subject: command.subject, actions: command.actions, valid: command.valid };

test('a 2xx response only confirms the exact native grant acknowledgement', async () => {
  for (const [body, status] of [
    [{ grant }, 'saved'],
    [{ grant: { ...grant, actions: [...grant.actions].reverse() } }, 'saved'],
    [{}, 'uncertain'],
    [{ grant: { ...grant, subject: { kind: 'active_accounts' } } }, 'uncertain'],
    [{ grant: { ...grant, resource: { ...grant.resource, id: readerId } } }, 'uncertain'],
    [{ grant: { ...grant, valid: '[2026-01-01,)' } }, 'uncertain'],
    [{ grant: { ...grant, actions: ['collection:update'] } }, 'uncertain'],
  ] as const) {
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (url, init) => {
        return new Request(url, init).method === 'GET' ? Response.json(snapshot) : Response.json(body);
      }) as typeof fetch,
    });
    expect(await writeAccess(client, 'Bearer actual', command)).toEqual({ status });
  }
});

test('public problem code and URI forms distinguish preparation from an unavailable dependency', async () => {
  for (const [body, status] of [
    [{ code: 'preparing' }, 'preparing'],
    [{ type: 'https://rezics.com/problems/preparing' }, 'preparing'],
    [{ type: 'https://rezics.com/problems/dependency_unavailable' }, 'unavailable'],
    [{}, 'unavailable'],
  ] as const) {
    const client = createKernelClient('https://kernel.test', {
      fetch: (async () => Response.json(body, { status: 503 })) as typeof fetch,
    });
    expect(await loadAccess(client, 'Bearer actual', resourceId)).toEqual({ status });
  }
});
