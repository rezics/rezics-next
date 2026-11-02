import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  PAGE_GLOBAL_CONTEXT,
  planReads,
  platformRegistry,
  type CompositionDocument,
  type PageRead,
} from '@rezics/composition';
import { readMemberList } from '../src/features/pages/member-list-query';
import { admitMemberPage, admitMemberSection } from '../src/features/pages/member-page-admission';
import recording from '../src/kernel/recorded/library-collection-members.json';

const membersRead = (limit = 2): PageRead => ({
  kind: 'members',
  source: { kind: 'everything' },
  sort: 'id',
  limit,
});
const searchRead = (limit = 2): PageRead => ({
  kind: 'search',
  body: { filter: { type: { in: ['schema:Book'] } }, sort: 'name', limit },
});
const snow = recording.members[0]!;
const genji = recording.members[1]!;
const prince = recording.members[2]!;
const facts = {
  'schema:datePublished': [
    { kind: 'time', year: 1948 },
    { kind: 'time', year: 1956 },
  ],
};

function summary(id: string, label: string) {
  return {
    id,
    type: 'schema:Book',
    types: ['schema:Book'],
    label: { value: label, language: 'en' },
    creativeWork: true,
    cover: null,
  };
}

function hit(id: string, label: string, extra: Record<string, unknown> = {}) {
  return { id, type: 'schema:Book', labels: { en: label }, summary: summary(id, label), ...extra };
}

function membersBody(rows: unknown[], next: string | null = null) {
  return { members: rows, next };
}

test('valid sparse members and search pages keep native order, duplicates and facts', () => {
  const members = membersBody([
    { ...snow, facts },
    { ...genji, facts: { 'schema:datePublished': [{ kind: 'time', year: 1008 }] } },
    snow,
  ]);
  expect(admitMemberPage(membersRead(12), members)).toBe(members);
  expect(facts['schema:datePublished']!.map((fact) => fact.year)).toEqual([1948, 1956]);

  const search = {
    subjects: [hit(snow.subjectId, 'Snow Country', { facts }), hit(genji.subjectId, 'Genji')],
    next: 'opaque',
  };
  expect(admitMemberPage(searchRead(), search)).toBe(search);
});

test('over-limit pages and a malformed later row fail as a whole', () => {
  const read = membersRead();
  const laterSearch = {
    subjects: [hit(snow.subjectId, 'Snow'), hit(genji.subjectId, 'Genji', { id: 'not-a-uuid' })],
    next: null,
  };
  for (const [descriptor, body] of [
    [read, membersBody([snow, genji, prince])],
    [read, membersBody([snow, { subjectId: 'not-a-uuid' }])],
    [read, membersBody([{ ...snow, subject: genji.subject }])],
    [searchRead(), { subjects: [hit(snow.subjectId, 'A'), hit(genji.subjectId, 'B'), hit(prince.subjectId, 'C')], next: null }],
    [searchRead(), laterSearch],
  ] as const) {
    expect(admitMemberPage(descriptor, body)).toBeUndefined();
    expect(admitMemberSection({ ok: true, read: descriptor, body })).toEqual({ ok: false, status: 422 });
  }
});

const document: CompositionDocument = {
  root: { props: {} },
  content: [{ type: 'Members', props: { id: 'members', title: {}, source: { kind: 'everything' }, limit: 2, paged: true } }],
};

async function nativePage(body: Record<string, unknown>, cursor?: string) {
  const continuation = cursor ? { node: 'members', cursor } : undefined;
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) => {
      const plan = planReads(platformRegistry, document, {
        subject: null,
        account: null,
        ...(continuation ? { continuation } : {}),
      });
      expect(await new Request(input, init).json()).toEqual({
        target: { route: '/members' },
        languages: ['en'],
        ...(continuation ? { continuation } : {}),
      });
      return Response.json({
        template: { scope: 'route', key: '/members' },
        document,
        reads: Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body }])),
      });
    },
  });
  return readMemberList(client, {
    target: { route: '/members' },
    locale: 'en',
    node: 'members',
    ...(cursor ? { cursor } : {}),
    expectedReader: null,
    representation: { context: PAGE_GLOBAL_CONTEXT, population: 'global' },
  });
}

test('initial and continuation reads refuse malformed or over-limit pages before a success body', async () => {
  const valid = membersBody([snow], 'opaque:next/==');
  expect(await nativePage(valid)).toMatchObject({ ok: true, body: valid });
  expect(await nativePage(valid, 'opaque:next/==')).toMatchObject({ ok: true, body: valid });
  for (const body of [membersBody([snow, genji, prince]), membersBody([snow, { ...snow, subject: genji.subject }])]) {
    expect(await nativePage(body)).toEqual({ ok: false, status: 422 });
    expect(await nativePage(body, 'opaque:next/==')).toEqual({ ok: false, status: 422 });
  }
});
