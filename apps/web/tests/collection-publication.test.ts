import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  publicationCandidates,
  publicationInput,
  publicationResponse,
  publicationSource,
  publishSelectedRecord,
  selectedPublicationAdapter,
  collectionPublicationQuery,
  type PublicationInput,
  type PublicationPage,
} from '../src/library/collection-publication';
import { CollectionPublicationPageView } from '../src/library/collection-publication-page';
import { PublicationLink } from '../src/library/collection-publication-link';
import { loadDynamicMembers, loadEditableCollectionPage } from '../src/library/collection-load';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';
import { publicationExample } from '../src/kernel/fake/collection-publication';
import { isSignedInPath } from '../src/session/guard';
import { m } from '../src/paraglide/messages.js';

const key = '0192f3a0-6c1e-7b2a-9d4e-0000000000aa';
const input: PublicationInput = { collectionId: 'saved-dynamic', revision: 7, subjectIds: [], idempotencyKey: key };
const write = () =>
  new Request('https://site.test/_serverFn/publication', {
    method: 'POST',
    headers: { authorization: 'Bearer owner-token' },
  });

test('explicit empty and nonempty requests retain native revision and unique IDs, with a hard 100 selection limit', () => {
  expect(publicationInput(input)).toEqual(input);
  expect(publicationInput({ ...input, subjectIds: ['canonical-a'] }).subjectIds).toEqual(['canonical-a']);
  expect(
    publicationInput({ ...input, subjectIds: Array.from({ length: 100 }, (_, n) => `subject-${n}`) }).subjectIds,
  ).toHaveLength(100);
  for (const patch of [
    { revision: 0 },
    { revision: 1.5 },
    { collectionId: '../private' },
    { idempotencyKey: 'new' },
    { subjectIds: ['a', 'a'] },
    { subjectIds: [''] },
    { subjectIds: Array.from({ length: 101 }, (_, n) => `${n}`) },
  ])
    expect(() => publicationInput({ ...input, ...patch })).toThrow();
});

test('the current dynamic reader preserves header revision and original IDs; selection uses only disclosed canonical summaries from this page', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/members'))
        return Response.json({
          members: [
            { kind: 'dynamic', subjectId: 'alias-a', subject: { id: 'canonical-a', type: 'schema:Book', label: 'A' } },
            {
              kind: 'dynamic',
              subjectId: 'original-a',
              subject: { id: 'canonical-a', type: 'schema:Book', label: 'A' },
            },
            { kind: 'dynamic', subjectId: 'private-b', subject: null },
          ],
          next: 'hidden-page',
        });
      if (path === '/v1/collections/saved-dynamic')
        return Response.json({
          collection: {
            id: input.collectionId,
            curatorAccountId: 'owner',
            revision: 7,
            membershipKind: 'dynamic',
            title: 'Owner selection',
            visibility: 'private',
            description: null,
          },
        });
      if (path === '/v1/viewerActions') return Response.json({ resources: [] });
      return Response.json({ code: 'not_found' }, { status: 404 });
    },
  });
  const sessionEnv: Partial<SessionEnv> = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'publication-test',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => ({
          status: 'active',
          subject: 'owner',
          csrfToken: 'A'.repeat(22),
          accessToken: 'owner-token',
        }),
      }),
    } as unknown as DurableObjectNamespace<SessionStore>,
  };
  const page = await loadEditableCollectionPage(
    client,
    new Request('https://site.test', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    }),
    sessionEnv,
    { id: input.collectionId, editor: true },
  );
  const source = publicationSource(page, 'owner');
  expect(source.state).toBe('ready');
  if (source.state !== 'ready') throw new Error('Expected consumer source context');
  expect(source.revision).toBe(7);
  expect(source.page.members.map((member) => member.subjectId)).toEqual(['alias-a', 'original-a', undefined]);
  expect(JSON.stringify(source.page)).not.toContain('private-b');
  expect(publicationCandidates(source.page).map((member) => member.subject?.id)).toEqual(['canonical-a']);
  expect(source.page.next).toBe('hidden-page');
  expect(requests.filter((request) => request.url.includes('/members'))).toHaveLength(1);
  expect(requests.some((request) => request.url.includes('hidden-page'))).toBe(false);
  expect(requests.some((request) => request.url.includes('/subjects/'))).toBe(false);
  expect(requests.every((request) => !new URL(request.url).search.includes('owner-token'))).toBe(true);
  expect(publicationSource({ ...source.page, builtinKind: 'everything' }, 'owner').state).toBe('unsupported');
  expect(publicationSource(source.page, 'someone-else').state).toBe('denied');
  expect(publicationSource({ ...source.page, unavailable: true, members: [] }, 'owner').state).toBe('unavailable');
  expect(publicationSource({ ...source.page, preparing: true, members: [] }, 'owner').state).toBe('preparing');
  const { revision: _revision, ...withoutRevision } = source.page;
  expect(publicationSource(withoutRevision, 'owner').state).toBe('unavailable');
  const ordinary = await loadDynamicMembers(client, input.collectionId);
  expect(ordinary.members.every((member) => member.subjectId === undefined && member.facts === undefined)).toBe(true);
  expect(JSON.stringify(ordinary)).not.toContain('private-b');
  expect(JSON.stringify(ordinary)).not.toContain('alias-a');
});

test('one guarded POST uses the exact selected native route and payload; unknown retries preserve the request and key', async () => {
  const calls: Request[] = [];
  const adapter = selectedPublicationAdapter('https://kernel.test', async (url, init) => {
    calls.push(new Request(url, init));
    if (calls.length === 1) throw new Error('Connection lost after dispatch');
    return Response.json({ code: 'source_unavailable' }, { status: 503 });
  });
  const selected = { ...input, subjectIds: ['canonical-a'] };
  expect(await publishSelectedRecord(adapter, write(), {}, selected)).toEqual({ ok: false, reason: 'unknown' });
  expect(await publishSelectedRecord(adapter, write(), {}, selected)).toEqual({ ok: false, reason: 'unavailable' });
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/v1/collections/saved-dynamic:publishSelected');
    expect(new URL(call.url).search).toBe('');
    expect(call.headers.get('authorization')).toBe('Bearer owner-token');
    expect(call.headers.get('idempotency-key')).toBe(key);
    expect(await call.json()).toEqual({ revision: 7, subjectIds: ['canonical-a'] });
  }
  let dispatched = false;
  const never = async () => {
    dispatched = true;
    return { status: 200, body: {} };
  };
  const refused = await publishSelectedRecord(
    never,
    new Request('https://site.test', {
      method: 'POST',
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}`, origin: 'https://foreign.test' },
    }),
    {},
    input,
  );
  expect(refused).toEqual({ ok: false, reason: 'denied' });
  expect(dispatched).toBe(false);
  expect(
    await selectedPublicationAdapter(undefined, async () => {
      throw new Error('Must not dispatch');
    })(input, 'Bearer owner-token'),
  ).toEqual({ status: 503, body: null });
});

test('only the exact native complete response establishes publication; pending, denied, stale, malformed and sparse outcomes do not', () => {
  const complete = {
    collection: { id: input.collectionId, revision: 8 },
    publication: { generation: '42', state: 'complete', itemCount: 0 },
  };
  expect(publicationResponse(200, complete, input)).toEqual({ ok: true, ...complete });
  const selected = { ...input, subjectIds: ['canonical-a'] };
  expect(
    publicationResponse(200, { ...complete, publication: { ...complete.publication, itemCount: 1 } }, selected).ok,
  ).toBe(true);
  for (const body of [
    {},
    { collection: complete.collection },
    { ...complete, publication: { ...complete.publication, state: 'pending' } },
    { ...complete, publication: { ...complete.publication, itemCount: 1 } },
    { ...complete, collection: { ...complete.collection, id: 'other-destination' } },
    { ...complete, publication: { ...complete.publication, generation: '' } },
  ])
    expect(publicationResponse(200, body, input)).toEqual({ ok: false, reason: 'unknown' });
  for (const [status, reason] of [
    [403, 'denied'],
    [409, 'stale'],
    [503, 'unavailable'],
    [404, 'unavailable'],
    [202, 'unknown'],
  ] as const)
    expect(publicationResponse(status, {}, input)).toEqual({ ok: false, reason });
});

test('empty intent is explicit and unavailable sources never render a zero selection, checkboxes or a successful publication', () => {
  const submit = async () => ({ ok: false as const, reason: 'unavailable' as const });
  const empty: PublicationPage = {
    ...publicationExample,
    source:
      publicationExample.source.state === 'ready'
        ? { ...publicationExample.source, page: { ...publicationExample.source.page, members: [] } }
        : publicationExample.source,
  };
  const html = renderToStaticMarkup(createElement(CollectionPublicationPageView, { page: empty, submit }));
  expect(html).toContain(m.library_publication_confirm_empty());
  expect(html).toContain(m.library_publication_no_disclosed());
  expect(html).toContain('disabled=""');
  for (const state of ['unavailable', 'denied', 'preparing', 'unsupported'] as const) {
    const unavailable = renderToStaticMarkup(
      createElement(CollectionPublicationPageView, {
        page: { ...empty, source: { state } },
        submit,
      }),
    );
    expect(unavailable).not.toContain('type="checkbox"');
    expect(unavailable).not.toContain(m.library_publication_count({ count: '0' }));
    expect(unavailable).not.toContain(m.library_publication_complete({ count: '0' }));
    expect(unavailable).toContain(m.library_publication_previous());
  }
});

test('owner-menu link and personal query preserve route and identity boundaries without authority or background retries', () => {
  const html = renderToStaticMarkup(
    createElement(PublicationLink, { target: { id: input.collectionId, membershipKind: 'dynamic' } }),
  );
  expect(html).toContain(`/collections/${input.collectionId}/publish`);
  expect(isSignedInPath('/fr/collections/saved-dynamic/publish')).toBe(true);
  const address = { id: input.collectionId };
  const alice = collectionPublicationQuery({ subject: 'alice', csrfToken: 'a' }, address);
  const bob = collectionPublicationQuery({ subject: 'bob', csrfToken: 'b' }, address);
  expect(alice.queryKey).not.toEqual(bob.queryKey);
  expect(alice.gcTime).toBe(0);
  expect(alice.retry).toBe(false);
  expect(alice.refetchOnWindowFocus).toBe(false);
});
