import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { boundedRealmMemberPage } from '../src/community/members/source';
import { RealmMembersVisit } from '../src/community/members/visit';
import { requestRealmMemberAddition } from '../src/community/space';

test('the installed unavailable seam grants no enumeration, identity or command', async () => {
  expect(await boundedRealmMemberPage.readPage({ realmId: 'realm', cursor: null })).toEqual({ kind: 'unavailable' });
  expect(
    await boundedRealmMemberPage.readSelected({ realmId: 'realm', accountId: 'a', authority: 'g' }),
  ).toEqual({ kind: 'unavailable' });
  expect(Object.keys(boundedRealmMemberPage).sort()).toEqual(['pageBound', 'readPage', 'readSelected']);
});

test('1/10/20 rows need one page request, no hydration and one explicit selected request', async () => {
  for (const count of [1, 10, 20]) {
    let pages = 0;
    let selections = 0;
    const visit = new RealmMembersVisit('realm', {
      pageBound: 20,
      readPage: async () => {
        pages++;
        return {
          kind: 'ready',
          page: {
            realm: { id: 'realm', label: 'Realm' },
            authority: 'grant',
            next: null,
            rows: Array.from({ length: count }, (_, index) => ({
              kind: 'disclosed',
              identity: { accountId: `${index}`, reference: `${index}`, label: 'Current private fallback' },
              membershipInterval: `interval-${index}`,
              membership: 'pending',
            })),
          },
        };
      },
      readSelected: async (address) => {
        selections++;
        return {
          kind: 'ready',
          ...address,
          identity: { accountId: address.accountId, reference: address.accountId, label: 'Current private fallback' },
          membershipInterval: address.membershipInterval ?? null,
          membership: 'pending',
          advice: { add: 'unavailable', ban: 'available', unban: 'unavailable' },
        };
      },
    });
    const stop = visit.connect();
    await Promise.resolve();
    expect([pages, selections]).toEqual([1, 0]);
    await visit.select(`${count - 1}`);
    expect([pages, selections]).toEqual([1, 1]);
    expect(visit.snapshot().selection?.read).toMatchObject({ membership: 'pending' });
    visit.closeSelection();
    expect([pages, selections]).toEqual([1, 1]);
    stop();
  }
});

test('sparse continuation and explicit failed-page retry preserve opaque cursor bytes', async () => {
  const addresses: unknown[] = [];
  const cursor = ' opaque/+==? &字 ';
  const visit = new RealmMembersVisit('realm', {
    pageBound: 20,
    readPage: async (address) => {
      addresses.push(address);
      return addresses.length === 2
        ? { kind: 'failed' }
        : {
            kind: 'ready',
            page: { realm: { id: 'realm', label: 'Realm' }, authority: 'grant', rows: [], next: cursor },
          };
    },
    readSelected: async () => {
      throw new Error('No hidden selected lookup');
    },
  });
  const stop = visit.connect();
  await Promise.resolve();
  await visit.more();
  expect(visit.snapshot().read.kind).toBe('failed');
  await visit.retryPage();
  expect(addresses).toEqual([
    { realmId: 'realm', cursor: null },
    { realmId: 'realm', cursor },
    { realmId: 'realm', cursor },
  ]);
  stop();
});

test('selected addition uses the native POST owner and treats only proven non-application as rejected', async () => {
  const realmId = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
  const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000301';
  const idempotencyKey = '123e4567-e89b-42d3-a456-426614174000';
  const authorization = 'Bearer current-manager';
  const requests: Request[] = [];
  let outcome: 'accepted' | 'not-applied' | 'erased' | 'lost' = 'accepted';
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(new URL(request.url).pathname).toBe(`/v1/realms/${realmId}/members`);
      expect(request.method).toBe('POST');
      expect(request.headers.get('authorization')).toBe(authorization);
      expect(request.headers.get('idempotency-key')).toBe(JSON.stringify(idempotencyKey));
      expect(await request.json()).toEqual({ accountId });
      if (outcome === 'lost') throw new Error('Response lost after submission');
      if (outcome === 'accepted') return Response.json({ workflowId: 'native-add-workflow' }, { status: 202 });
      const body = {
        type: `https://rezics.com/problems/${outcome === 'erased' ? 'command_result_erased' : 'forbidden'}`,
        title: outcome === 'erased' ? 'Command Result Erased' : 'Forbidden',
        status: outcome === 'erased' ? 410 : 403,
        code: outcome === 'erased' ? 'command_result_erased' : 'forbidden',
        retryable: false,
        effect_status: outcome === 'erased' ? 'unknown' : 'not_applied',
        request_id: 'native-add-request',
      };
      return Response.json(body, { status: body.status });
    },
  });
  const issue = () =>
    requestRealmMemberAddition(
      client,
      new Request('https://site.example.test/action', { method: 'POST', headers: { authorization } }),
      {},
      { realmId, accountId, idempotencyKey },
    );

  expect(await issue()).toEqual({ kind: 'accepted', workflowId: 'native-add-workflow' });
  outcome = 'not-applied';
  expect(await issue()).toEqual({ kind: 'rejected' });
  outcome = 'erased';
  expect(await issue()).toEqual({ kind: 'unknown' });
  outcome = 'lost';
  expect(await issue()).toEqual({ kind: 'unknown' });
  expect(requests).toHaveLength(4);
});
