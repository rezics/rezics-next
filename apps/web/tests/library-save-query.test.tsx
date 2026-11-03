import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { parseFilter } from '@rezics/filter';
import { createSavedQueryHandoffStore } from '../src/library/save-query';
import { admitSavedQuerySelection } from '../src/library/saved-query-editor/selection';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { submitCollectionRule } = await import('../src/library/collection-rule-actions');

const filter = parseFilter({
  and: [
    { owner: { presence: true } },
    {
      and: [
        { type: { in: ['schema:Book'] } },
        { statement: { property: 'schema:keywords', in: ['space opera'] } },
      ],
    },
  ],
});
const key = '10000000-0000-4000-8000-000000000001';
const credential = async () => ({
  status: 'active' as const,
  subject: 'owner',
  accessToken: 'owner-token',
  csrfToken: 'a'.repeat(22),
});
const sessionEnv = {
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'saved-query-test',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: { idFromName: (id: string) => id, get: () => ({ credential, credentialIfFresh: credential }) },
} as unknown as Partial<import('../src/session/client').SessionEnv>;
const request = () => new Request('https://web.test/action', { method: 'POST', headers: { authorization: 'Bearer current-viewer' } });

test('the current representable filter reaches one private id-ordered create action unchanged', async () => {
  const selection = admitSavedQuerySelection({
    document: { statement: { property: 'schema:keywords', in: ['space opera'] } },
    type: 'schema:Book',
    search: '?l.schema%3Akeywords=localized+label&cursor=next',
  });
  expect(selection).toEqual({ state: 'admitted', filter, sort: 'id' });
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
    },
  });

  await submitCollectionRule(client, request(), sessionEnv, {
    title: 'Space opera',
    description: '',
    filter: selection.state === 'admitted' ? selection.filter : filter,
    sort: selection.state === 'admitted' ? selection.sort : 'id',
    idempotencyKey: key,
  });

  expect(calls).toHaveLength(1);
  expect(await calls[0]!.json()).toEqual({
    membershipKind: 'dynamic',
    title: 'Space opera',
    description: '',
    visibility: 'private',
    rule: { filter, sort: 'id' },
  });
});

test('unsupported selections stay unsaved and a replacement viewer cannot consume the handoff', () => {
  const store = createSavedQueryHandoffStore();
  const unsupported = admitSavedQuerySelection({ document: filter, type: 'schema:Book', search: '?q=space+opera' });
  expect(unsupported.state).toBe('invalid');
  if (unsupported.state === 'admitted') store.write({ viewerId: 'owner', ...unsupported });
  expect(store.take('replacement-viewer')).toBeNull();
  expect(store.take('owner')).toBeNull();

  expect(store.write({ viewerId: 'owner', filter, sort: 'id' })).toBe(true);
  expect(store.take('owner')).toEqual({ viewerId: 'owner', filter, sort: 'id' });
  expect(store.take('owner')).toBeNull();
});
