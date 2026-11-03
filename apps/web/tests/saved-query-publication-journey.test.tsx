import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { publicationExample } from '../src/kernel/fake/collection-publication';
import {
  publishSelectedNative,
  type PublicationInput,
  type PublicationPage,
} from '../src/library/collection-publication';
import { CollectionPublicationPageView } from '../src/library/collection-publication-page';
import {
  admitsSavedQueryPublication,
  publishedMembershipFromDto,
  publishedMembershipFromComplete,
  SavedQueryPublicationAction,
} from '../src/library/saved-query-publication';
import { m } from '../src/paraglide/messages.js';
import { locales } from '../src/paraglide/runtime.js';
import { readFileSync } from 'node:fs';

mock.module('cloudflare:workers', () => ({ env: {} }));

const saved = { id: 'saved-dynamic', curatorAccountId: 'owner', membershipKind: 'dynamic' as const };
const key = '0192f3a0-6c1e-7b2a-9d4e-0000000000aa';
const input: PublicationInput = { collectionId: 'saved-dynamic', revision: 7, subjectIds: [], idempotencyKey: key };

function action(
  collection: Parameters<typeof SavedQueryPublicationAction>[0]['collection'],
  viewerId: string | null,
  allowed = true,
) {
  return renderToStaticMarkup(createElement(SavedQueryPublicationAction, { collection, viewerId, allowed }));
}

test('the owner action opens selected-members publication only for an admitted saved-dynamic curator', () => {
  expect(admitsSavedQueryPublication(saved, 'owner', true)).toBe(true);
  expect(action(saved, 'owner')).toContain('/collections/saved-dynamic/publish');
  expect(action(saved, 'owner')).toContain(m.library_publication_heading());
  expect(action(saved, 'reader')).toBe('');
  expect(action(saved, 'owner', false)).toBe('');
  expect(action({ ...saved, builtinKind: 'everything' }, 'owner')).toBe('');
  expect(action({ ...saved, membershipKind: 'curated' }, 'owner')).toBe('');
});

test('missing published DTO support is unavailable and never a zero-member public set', () => {
  expect(publishedMembershipFromDto({})).toEqual({ state: 'unavailable' });
  expect(publishedMembershipFromDto({ publication: { state: 'complete', generation: 'g', itemCount: 0 } })).toEqual({
    state: 'complete',
    generation: 'g',
    itemCount: 0,
  });
  expect(publishedMembershipFromDto({ publication: { state: 'staging', generation: 'g', itemCount: 0 } })).toEqual({
    state: 'unavailable',
  });
  expect(publishedMembershipFromComplete(null)).toEqual({ state: 'unavailable' });
});

test('the publication page distinguishes current results from unpublished previous membership and inspects revision', () => {
  const submit = async () => ({ ok: false as const, reason: 'unavailable' as const });
  if (publicationExample.source.state !== 'ready') throw new Error('Expected recorded candidates');
  const html = renderToStaticMarkup(createElement(CollectionPublicationPageView, { page: publicationExample, submit }));
  expect(html).toContain(m.library_publication_current());
  expect(html).toContain(m.library_publication_published());
  expect(html).toContain(m.library_publication_published_unavailable());
  expect(html).toContain(m.library_publication_revision({ revision: '7' }));
  expect(html).toContain(m.library_publication_meaning());
  expect(html).not.toContain(m.library_publication_published_generation({ generation: 'g' }));
  expect(html).not.toContain(m.library_publication_complete({ count: '0' }));
  const empty: PublicationPage = {
    ...publicationExample,
    source: { ...publicationExample.source, page: { ...publicationExample.source.page, members: [] } },
  };
  const emptyHtml = renderToStaticMarkup(createElement(CollectionPublicationPageView, { page: empty, submit }));
  expect(emptyHtml).toContain(m.library_publication_confirm_empty());
  expect(emptyHtml).toContain(m.library_publication_published_unavailable());
  for (const state of ['preparing', 'denied', 'unavailable'] as const) {
    const recovered = renderToStaticMarkup(
      createElement(CollectionPublicationPageView, {
        page: { ...publicationExample, source: { state } },
        submit,
      }),
    );
    expect(recovered).toContain(m.library_publication_published_unavailable());
    expect(recovered).not.toContain('type="checkbox"');
    expect(recovered).not.toContain(m.library_publication_count({ count: '0' }));
  }
});

test('generated publishSelected keeps revision, unique IDs, credentials and key', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (url, init) => {
      calls.push(new Request(url, init));
      return Response.json({
        collection: { id: input.collectionId, revision: 8 },
        publication: { generation: 'gen-1', state: 'complete', itemCount: 0 },
      });
    },
  });
  const result = await publishSelectedNative(
    client,
    new Request('https://site.test/_serverFn/publication', {
      method: 'POST',
      headers: { authorization: 'Bearer owner-token' },
    }),
    {},
    input,
  );
  expect(result).toEqual({
    ok: true,
    collection: { id: input.collectionId, revision: 8 },
    publication: { generation: 'gen-1', state: 'complete', itemCount: 0 },
  });
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe('/v1/collections/saved-dynamic:publishSelected');
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer owner-token');
  expect(calls[0]!.headers.get('idempotency-key')).toBe(key);
  expect(await calls[0]!.json()).toEqual({ revision: 7, subjectIds: [] });
});

test('all launch locales name current results, previous membership and recovery', () => {
  const keys = [
    'library_publication_current',
    'library_publication_published',
    'library_publication_published_unavailable',
    'library_publication_meaning',
    'library_publication_revision',
    'library_publication_output_review',
  ];
  for (const locale of locales) {
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8')) as Record<
      string,
      string
    >;
    for (const key of keys) expect(messages[key]?.trim().length).toBeGreaterThan(0);
  }
});
