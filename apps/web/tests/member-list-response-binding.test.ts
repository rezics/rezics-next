import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT, planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { readMemberList, type MemberPageTarget } from '../src/features/pages/member-list-query';

const subject = '00000000-0000-8000-8000-000000000001';
const foreign = '00000000-0000-8000-8000-000000000002';
const document: CompositionDocument = {
  root: { props: {} },
  content: [
    { type: 'AccountIdentity', props: { id: 'identity' } },
    { type: 'Members', props: { id: 'other', title: {}, source: { kind: 'everything' }, limit: 12, paged: true } },
    {
      type: 'Members',
      props: {
        id: 'members',
        title: {},
        source: { kind: 'collection', id: subject },
        filter: 'type = Book',
        limit: 24,
        paged: true,
      },
    },
  ],
};
const continuation = { node: 'members', cursor: 'opaque:next/==' };
const body = { members: [{ id: subject }], next: 'opaque:after/==' };
async function read(target: MemberPageTarget, changes: Record<string, unknown> = {}, status = 200) {
  const { identity, ...nativeChanges } = changes;
  const page = {
    subject: 'route' in target ? undefined : subject,
    account: 'account' in target ? 'native-account-id' : undefined,
    template: 'route' in target ? { scope: 'route', key: target.route } : { scope: 'type', key: 'schema:Person' },
    document,
    reads: {},
    ...nativeChanges,
  };
  const plan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: page.subject ?? null,
    account: page.account ? { id: page.account, handle: 'reader' } : null,
    continuation,
  });
  page.reads = Object.fromEntries(
    Object.entries(plan.reads).map(([key, descriptor]) => [
      key,
      {
        status: 200,
        body:
          descriptor.kind === 'account' ? (identity ?? { accounts: [{ id: page.account, handle: 'reader' }] }) : body,
      },
    ]),
  );
  let calls = 0;
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls++;
      expect(request.redirect).toBe('manual');
      expect(await request.json()).toEqual({ target, languages: ['en'], continuation });
      expect(request.headers.get('authorization')).toBe('Bearer prepared');
      return Response.json(page, { status, headers: { location: '/v1/pages:read?target=canonical' } });
    },
  });
  const result = await readMemberList(
    client,
    {
      target,
      locale: 'en',
      ...continuation,
      expectedReader: 'reader',
      representation: { context: PAGE_GLOBAL_CONTEXT, population: 'global' },
    },
    'Bearer prepared',
  );
  expect(calls).toBe(1);
  return result;
}

test('native subject, account and route continuations retain the selected source, predicate and bounded page', async () => {
  for (const target of [{ subject }, { account: 'reader' }, { account: 'READER' }, { route: '/members' }]) {
    expect(await read(target)).toEqual({
      ok: true,
      body,
      read: {
        kind: 'members',
        source: { kind: 'collection', id: subject },
        filter: 'type = Book',
        sort: 'id',
        limit: 12,
        cursor: continuation.cursor,
      },
    });
  }
  expect((await read({ route: '/unconfigured' }, { template: { scope: 'generic', key: null } })).ok).toBe(true);
  // The DTO does not echo a handle or a generic route key; native resolution remains authoritative without them.
  expect(
    (await read({ account: 'reader' }, { document: { ...document, content: document.content.slice(1) } })).ok,
  ).toBe(true);
});

test('same-Context foreign identities cannot expose the selected rows or continuation', async () => {
  for (const [target, changes] of [
    [{ subject }, { subject: foreign }],
    [{ subject }, { subject: undefined }],
    [{ subject }, { account: 'foreign-account' }],
    [{ account: 'reader' }, { account: undefined }],
    [{ account: 'reader' }, { identity: { accounts: [{ id: 'foreign-account', handle: 'reader' }] } }],
    [{ account: 'reader' }, { identity: { accounts: [{ id: 'native-account-id', handle: 'foreign' }] } }],
    [
      { account: 'reader' },
      { identity: { accounts: [{ id: 'native-account-id', handle: 'reader', movedTo: 'current' }] } },
    ],
    [{ route: '/members' }, { template: { scope: 'route', key: '/foreign' } }],
    [{ route: '/members' }, { subject }],
    [{ route: '/members' }, { template: { scope: 'type', key: 'schema:Person' } }],
    [{ subject }, { context: { id: foreign, population: { kind: 'global' } } }],
    [
      { subject },
      { context: { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'realm', id: foreign, title: 'Same title' } } },
    ],
  ] as [MemberPageTarget, Record<string, unknown>][])
    expect(await read(target, changes)).toEqual({ ok: false, status: 409 });
});

test('native redirect and refusal statuses stay with route handling without following or projecting a page', async () => {
  for (const status of [308, 400, 403, 404, 503])
    expect(await read({ subject }, {}, status)).toEqual({ ok: false, status });
});
