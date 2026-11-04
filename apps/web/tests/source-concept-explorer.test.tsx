import { expect, mock, test } from 'bun:test';
import type { KernelClient, SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  conceptTypeAdmitted,
  readSourceConcept,
  validConceptCursor,
} from '../src/features/catalogue/source-concept-explorer';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';

mock.module('cloudflare:workers', () => ({ env: {} }));

const concept = '00000000-0000-4000-8000-00000000c001';
const schemeA = '00000000-0000-4000-8000-00000000c002';
const schemeB = '00000000-0000-4000-8000-00000000c003';
const broader = '00000000-0000-4000-8000-00000000c004';

function item(mode: 'ok' | 'unreadable' | 'retired'): SubjectRead {
  return {
    subject: {
      id: concept,
      type: 'skos:Concept',
      revision: 1,
      release:
        mode === 'retired'
          ? 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          : 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      context: '00000000-0000-4000-8000-000000000001',
      labels: { en: 'Protagonist', ja: '主人公' },
      descriptions: { en: 'Lead role' },
      aliases: { en: ['Hero', 'Protagonist'], ja: ['主人公'] },
      statements: {
        'skos:inScheme': [
          {
            id: '00000000-0000-4000-8000-00000000e021',
            rank: 'normal',
            property: { id: 'skos:inScheme', data_type: 'wikibase-item' },
            value: { type: 'value', content: schemeA },
            qualifiers: [],
            references: [],
          },
          {
            id: '00000000-0000-4000-8000-00000000e022',
            rank: 'normal',
            property: { id: 'skos:inScheme', data_type: 'wikibase-item' },
            value: { type: 'value', content: schemeB },
            qualifiers: [],
            references: [],
          },
        ],
        'skos:broader': [
          {
            id: '00000000-0000-4000-8000-00000000e023',
            rank: 'normal',
            property: { id: 'skos:broader', data_type: 'wikibase-item' },
            value: { type: 'value', content: broader },
            qualifiers: [],
            references: [],
          },
        ],
        'schema:sameAs': [
          {
            id: '00000000-0000-4000-8000-00000000e024',
            rank: 'normal',
            property: { id: 'schema:sameAs', data_type: 'url' },
            value: { type: 'value', content: 'https://vndb.org/i1' },
            qualifiers: [],
            references: [],
          },
        ],
      },
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    related: {
      [schemeA]: { type: 'skos:ConceptScheme', labels: { en: 'VNDB traits' } },
      [schemeB]: { type: 'skos:ConceptScheme', labels: { en: 'Bangumi tags' } },
      [broader]: { type: 'skos:Concept', labels: { en: 'Role' } },
    },
    summary: null,
  };
}

function client(mode: 'ok' | 'unreadable' | 'retired', linksStatus = 200) {
  return {
    subjects: ({ id }: { id: string }) => ({
      get: async () => (mode === 'unreadable' ? { status: 404 } : { status: 200, data: item(mode) }),
      links: {
        get: async ({ query }: { query: { cursor?: string } }) =>
          linksStatus === 200
            ? {
                status: 200,
                data: {
                  links: [
                    {
                      subject: '00000000-0000-4000-8000-00000000c005',
                      statement: '00000000-0000-4000-8000-00000000e025',
                      summary: {
                        id: '00000000-0000-4000-8000-00000000c005',
                        type: 'skos:Concept',
                        label: { value: 'Heroine', language: 'en' },
                      },
                      related: {},
                    },
                  ],
                  next: query.cursor ? null : 'concept-next',
                  freshness: { caught_up: true },
                },
              }
            : { status: linksStatus, data: { code: 'dependency_unavailable' } },
      },
    }),
  } as unknown as KernelClient;
}

test('source concept explorer covers two schemes, duplicate labels, unknown roles, continuation and retired meaning', async () => {
  expect(conceptTypeAdmitted(bundledRelease, 'skos:Concept')).toBe(true);
  const read = await readSourceConcept(client('ok'), 'Bearer reader', bundledRelease, concept, 'en', {
    role: 'vndb:unknown',
  });
  if (!read.ok) throw new Error('expected concept');
  expect(read.schemes.map((scheme) => scheme.label).sort()).toEqual(['Bangumi tags', 'VNDB traits']);
  expect(read.aliases.filter((alias) => alias.text === 'Protagonist').length).toBe(1);
  expect(read.requestedRole).toBe('vndb:unknown');
  expect(read.codes.some((code) => code.property === 'role')).toBe(false);
  expect(read.public.subject.id).toBe(concept);
  expect(read.broader.rows.some((row) => row.direction === 'broader' && row.id === broader)).toBe(true);
  expect(read.codes.some((code) => code.property === 'schema:sameAs')).toBe(false);
  expect(read.narrower.next).toBe('concept-next');
  const continued = await readSourceConcept(client('ok'), 'Bearer reader', bundledRelease, concept, 'en', {
    cursor: 'concept-next',
  });
  expect(continued.ok && continued.narrower.next).toBeNull();
  const failed = await readSourceConcept(client('ok', 503), 'Bearer reader', bundledRelease, concept, 'en', {
    cursor: 'concept-next',
  });
  expect(failed.ok && failed.narrower).toMatchObject({ state: 'unavailable', cursor: 'concept-next', next: null });
  const unsupportedRelease = {
    ...bundledRelease,
    properties: {
      ...bundledRelease.properties,
      'skos:broader': { ...bundledRelease.properties['skos:broader'], relation: undefined },
    },
  };
  const unsupported = await readSourceConcept(client('ok'), 'Bearer reader', unsupportedRelease, concept, 'en', {});
  expect(unsupported.ok && unsupported.narrower.state).toBe('unsupported');
  const retired = await readSourceConcept(
    client('retired'),
    'Bearer reader',
    { ...bundledRelease, digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    concept,
    'en',
    {},
  );
  expect(retired.ok && retired.retired).toBe(true);
  expect(await readSourceConcept(client('unreadable'), 'Bearer reader', bundledRelease, concept, 'en', {})).toEqual({
    ok: false,
    reason: 'unavailable',
  });
  const unknown = await readSourceConcept(client('ok'), 'Bearer reader', bundledRelease, concept, 'en', {});
  expect(unknown.ok && conceptTypeAdmitted(bundledRelease, 'schema:Book')).toBe(false);
  expect(catalogueEntries.concepts({ id: concept, label: 'Protagonist', locale: 'en' }).href).toContain('/concepts');
});

test('native inverse stays bounded, distinguishes exact empty and readiness, and keeps advice independent', async () => {
  const subject = item('retired');
  subject.subject.statements['source:original'] = [
    {
      id: broader,
      rank: 'normal',
      property: { id: 'source:original', data_type: 'external-id' },
      value: { type: 'value', content: '未知/المصدر/00-A' },
      qualifiers: [],
      references: [],
    },
  ];
  subject.related[schemeB] = { labels: {} };
  delete subject.related[broader];
  Object.assign(subject, {
    viewerActions: { state: 'available', actions: [{ action: 'statement:propose', operations: ['subject.propose'] }] },
  });
  let calls = 0;
  let response: { status: number; data: unknown } = {
    status: 200,
    data: {
      links: [],
      next: null,
      count: { value: 0, exact: true },
      freshness: { caught_up: true },
    },
  };
  const native = {
    subjects: () => ({
      get: async () => ({ status: 200, data: subject, headers: { 'rezics-session-token': 'source-receipt' } }),
      links: {
        get: async (request: unknown) => {
          calls++;
          expect(request).toEqual({
            query: { property: 'skos:broader', language: 'ja', limit: 20, cursor: 'original' },
            headers: { authorization: 'Bearer reader', 'rezics-session-token': 'source-receipt' },
          });
          return response;
        },
      },
    }),
  } as unknown as KernelClient;
  const read = () =>
    readSourceConcept(
      native,
      'Bearer reader',
      {
        ...bundledRelease,
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      concept,
      'ja',
      { role: '未知/المصدر/00-A', cursor: 'original', session: 'previous' },
    );
  const exact = await read();
  expect(exact).toMatchObject({
    ok: true,
    retired: true,
    requestedRole: '未知/المصدر/00-A',
    narrower: { state: 'available', exactEmpty: true },
    broader: { rows: [], withheld: 1 },
    viewerActions: { state: 'available' },
  });
  if (!exact.ok) throw Error('Expected source');
  expect(exact.codes).toEqual([
    {
      property: 'source:original',
      label: 'source:original',
      labelLang: null,
      value: '未知/المصدر/00-A',
      unknown: true,
    },
  ]);
  expect(exact.schemes.find((row) => row.id === schemeB)?.readable).toBe(true);
  response = {
    status: 200,
    data: { links: [], next: 'continue', freshness: { caught_up: false }, count: { value: 0, exact: true } },
  };
  expect(await read()).toMatchObject({ narrower: { state: 'lagging', exactEmpty: false, next: 'continue' } });
  response = { status: 200, data: { links: [], next: 'continue', freshness: { caught_up: true } } };
  expect(await read()).toMatchObject({ narrower: { state: 'available', exactEmpty: false } });
  for (const [code, state] of [
    ['semantic_not_ready', 'preparing'],
    ['dependency_unavailable', 'unavailable'],
  ]) {
    response = { status: 503, data: { code } };
    expect(await read()).toMatchObject({
      narrower: { state, rows: [], next: null, exactEmpty: false },
      viewerActions: exact.viewerActions,
      codes: exact.codes,
    });
  }
  response = { status: 403, data: {} };
  expect(await read()).toEqual({ ok: false, reason: 'denied' });
  expect(calls).toBe(6);
  expect(validConceptCursor('界'.repeat(1365))).toBe(true);
  expect(validConceptCursor('界'.repeat(1366))).toBe(false);
  const before = calls;
  expect(
    (
      await readSourceConcept(native, undefined, bundledRelease, concept, 'en', {
        cursor: '界'.repeat(1366),
      })
    ).ok,
  ).toBe(false);
  expect(calls).toBe(before);
});
