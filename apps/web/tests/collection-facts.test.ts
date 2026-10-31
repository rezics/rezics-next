import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadDynamicMembers, loadEditableCollectionPage } from '../src/library/collection-load';
import { loadCollectionPage, type CollectionMember } from '../src/library/reads';
import type { SessionEnv } from '../src/session/client';
import recording from '../src/kernel/recorded/library-collection-members.json';
import definitions from '../src/kernel/recorded/definitions-release.json';
import { parseListPresentation } from '@rezics/ui/cover';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { CollectionReadMembers } = await import('../src/library/collection-page');

const collectionId = '00000000-0000-4000-8000-000000000001';
const stamp = '2026-10-31T00:00:00.000Z';
// Supplied DTO inputs exercise the consumer; they do not stand in for native API evidence.
const bookFacts: NonNullable<CollectionMember['facts']> = {
  'schema:datePublished': [{ kind: 'time', year: 1943 }],
  'schema:author': [{ kind: 'item', id: 'author', labels: { en: 'Supplied author' } }],
};
const filmFacts: NonNullable<CollectionMember['facts']> = {
  'schema:duration': [{ kind: 'quantity', amount: 95, unit: 'min' }],
  'schema:director': [{ kind: 'item', id: 'director', labels: { en: 'Supplied director' } }],
};
const supplied = [
  { ...recording.members[2]!, facts: bookFacts },
  {
    ...recording.members[0]!,
    id: 'film-occurrence',
    subjectId: 'film-original',
    subject: { id: 'film-terminal', type: 'schema:Movie', label: 'Supplied film', types: ['schema:Movie'] },
    facts: filmFacts,
  },
  { ...recording.members[1]!, facts: {} },
  { ...recording.members[3]! },
  { id: 'hidden', subjectId: 'hidden-original', subject: null, note: null, addedAt: stamp, facts: bookFacts },
];
const listPresentations = {
  'schema:Book': parseListPresentation(definitions.release.types['schema:Book'].listPresentation)!,
  'schema:Movie': parseListPresentation(definitions.release.types['schema:Movie'].listPresentation)!,
};

type Call = { path: string; authorization: string | null; query: URLSearchParams };
function source(kind: 'curated' | 'dynamic', status = 200) {
  const calls: Call[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push({ path: url.pathname, authorization: request.headers.get('authorization'), query: url.searchParams });
      if (url.pathname === '/v1/viewerActions')
        return Response.json({ resources: [{ type: 'library.collection', id: collectionId, viewerActions: [] }] });
      if (url.pathname.startsWith('/v1/follows/')) return Response.json({ code: 'not_found' }, { status: 404 });
      if (url.pathname.endsWith('/members')) {
        if (status !== 200) return Response.json({ preparing: true }, { status });
        return Response.json({
          members: supplied.map((member) =>
            kind === 'curated' ? member : { ...member, kind: 'dynamic', privateRule: 'must not reach rows' },
          ),
          next: null,
        });
      }
      return Response.json({
        collection: {
          id: collectionId,
          membershipKind: kind,
          curatorAccountId: 'curator',
          title: 'Supplied facts',
          description: null,
          visibility: 'public',
          revision: 1,
          memberCount: supplied.length,
          createdAt: stamp,
          updatedAt: stamp,
          rule: { private: 'must not reach rows' },
        },
      });
    },
  });
  return { client, calls };
}

function sessionEnv(): Partial<SessionEnv> {
  return {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'collection:read',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'configured',
    SESSIONS: {
      idFromName: () => 'session',
      get: () => ({
        credential: async () => ({ status: 'active', accessToken: 'fixture', subject: 'curator', csrfToken: 'csrf' }),
      }),
    } as SessionEnv['SESSIONS'],
  };
}

test('Collection Book and Film member rows show actual supplied released key facts without inventing missing facts', async () => {
  for (const kind of ['curated', 'dynamic'] as const) {
    for (const viewer of ['anonymous', 'owner-browse', 'owner-editor'] as const) {
      const { client, calls } = source(kind);
      const owner = viewer !== 'anonymous';
      const editor = viewer === 'owner-editor';
      const request = new Request(`https://rezics.test/en/collections/${collectionId}`, {
        ...(owner ? { headers: { cookie: '__Host-rezics_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } } : {}),
      });
      const page = await loadEditableCollectionPage(
        client,
        request,
        owner ? sessionEnv() : {},
        { id: collectionId, ...(editor ? { editor: true } : {}) },
        owner ? 'session' : 'anonymous',
      );
      expect(page.members[0]!.facts).toEqual(bookFacts);
      expect(page.members[1]!.facts).toEqual(filmFacts);
      expect(page.members[2]!.facts).toEqual({});
      expect(Object.hasOwn(page.members[3]!, 'facts')).toBe(false);
      for (const member of page.members) {
        if (!member.subject) expect(Object.hasOwn(member, 'facts')).toBe(false);
        expect(Object.hasOwn(member, 'privateRule')).toBe(false);
        expect(Object.hasOwn(member, 'subjectId')).toBe(kind === 'dynamic' && editor && member.subject !== null);
      }
      expect(Object.hasOwn(page, 'rule')).toBe(false);
      const memberReads = calls.filter((call) => call.path.endsWith('/members'));
      expect(memberReads).toHaveLength(1);
      expect(memberReads[0]!.query.get('view')).toBe('FULL');
      expect(memberReads[0]!.query.get('limit')).toBe('100');
      expect(memberReads[0]!.authorization).toBe(editor ? 'Bearer fixture' : null);
      expect(calls.every((call) => !call.path.startsWith('/v1/subjects'))).toBe(true);

      for (const layout of ['list', 'grid'] as const) {
        const html = renderToStaticMarkup(
          createElement(CollectionReadMembers, { members: page.members, layout, listPresentations, onCopy: () => {} }),
        );
        for (const text of ['Supplied author', '1943', 'Supplied director', '95 min']) expect(html).toContain(text);
        expect(html.indexOf('Supplied author')).toBeLessThan(html.indexOf('1943'));
        expect(html.indexOf('Supplied director')).toBeLessThan(html.indexOf('95 min'));
        expect(html.match(/data-slot="member-list-row-facts"/g)).toHaveLength(2);
        expect(html).toContain(recording.members[2]!.note!);
        expect(html).toContain(`/en/subjects/${supplied[0]!.subject!.id}/`);
        expect(html).not.toContain('film-original');
        expect(html).not.toContain('must not reach rows');
      }
    }
  }
});

test('dynamic refresh and the earlier curated reader retain supplied, empty and absent facts', async () => {
  const dynamic = source('dynamic');
  const page = await loadDynamicMembers(dynamic.client, collectionId);
  expect(page.members.map((member) => member.facts)).toEqual([bookFacts, filmFacts, {}, undefined, undefined]);
  expect(page.members.every((member) => !Object.hasOwn(member, 'subjectId'))).toBe(true);
  expect(dynamic.calls).toHaveLength(1);
  const curated = source('curated');
  const earlier = await loadCollectionPage(
    curated.client,
    new Request('https://rezics.test/en/collections/' + collectionId),
    {},
    { id: collectionId },
  );
  expect(earlier.members.map((member) => member.facts)).toEqual([bookFacts, filmFacts, {}, undefined, undefined]);
  expect(curated.calls).toHaveLength(2);
});

test('facts enrichment never turns preparing or unavailable member reads into completed empty pages', async () => {
  for (const status of [202, 503]) {
    const { client } = source('dynamic', status);
    const page = await loadDynamicMembers(client, collectionId);
    expect(page.preparing).toBe(status === 202);
    expect(page.unavailable).toBe(status === 503);
    expect(page.members).toEqual([]);
  }
});
