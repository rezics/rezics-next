import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CrossMediaReading } from '../../services/importer/src/cross-media-seed.ts';
import { ShowcaseJournal } from '../../services/importer/src/showcase-publication.ts';
import {
  createDevelopmentShowcaseRequest,
  seedDevelopmentShowcase,
  type ShowcaseRequest,
} from './development-showcase.ts';

const owner = crypto.randomUUID();
const selection = { vndb: ['v2002'], bangumi: [10380, 84148] };
const roots = [
  { source: 'vndb' as const, externalId: 'v2002', type: 'rezics:VisualNovel', property: 'wdt:P3180' },
  { source: 'bangumi' as const, externalId: '10380', type: 'rezics:TVAnime', property: 'wdt:P5732' },
  { source: 'bangumi' as const, externalId: '84148', type: 'schema:Book', property: 'wdt:P5732' },
];
function fixture() {
  const subjects = roots.map((root) => ({
    id: crypto.randomUUID(),
    type: root.type,
    statements: { [root.property]: [{ value: { type: 'value', content: root.externalId } }] },
  }));
  const readings = roots.map((root, index): CrossMediaReading => ({
    source: root.source,
    externalId: root.externalId,
    selection: 'selected',
    route: `/subjects/${subjects[index]!.id}/same-title`,
    subject: { subject: subjects[index] } as CrossMediaReading['subject'],
  }));
  const collections = new Map<
    string,
    {
      id: string;
      curatorAccountId: string;
      presentationKind: string | null;
      presentationKindSource: string;
      visibility: string;
      memberCount: number;
    }
  >();
  const members = new Map<string, { id: string; subjectId: string }[]>();
  const receipts = new Map<string, unknown>();
  const sent: Parameters<ShowcaseRequest>[0][] = [];
  const request: ShowcaseRequest = async (input) => {
    const path = input.path.split('?')[0]!;
    if (input.body !== undefined) {
      sent.push(structuredClone(input));
      if (receipts.has(input.key!)) return Response.json(receipts.get(input.key!));
      if (path === '/v1/collections') {
        const body = input.body as { presentationKind: string | null; visibility: string };
        const id = crypto.randomUUID();
        const collection = {
          id,
          curatorAccountId: owner,
          ...body,
          memberCount: 0,
          presentationKindSource: body.presentationKind === null ? 'mixed' : 'owner',
        };
        collections.set(id, collection);
        members.set(id, []);
        receipts.set(input.key!, { collection });
      } else {
        const id = path.split('/')[3]!;
        const member = { id: crypto.randomUUID(), subjectId: (input.body as { subjectId: string }).subjectId };
        members.get(id)!.push(member);
        collections.get(id)!.memberCount++;
        receipts.set(input.key!, { member });
      }
      return Response.json(receipts.get(input.key!), { status: 201 });
    }
    if (path.startsWith('/v1/subjects/'))
      return Response.json({ subject: subjects.find((row) => path.endsWith(row.id)) });
    const id = path.split('/')[3]!;
    return Response.json(
      path.endsWith('/members') ? { members: members.get(id), next: null } : { collection: collections.get(id) },
    );
  };
  return { request, sent, collections, subjects, result: { readings, workLinks: [] } };
}

test('composes exact source roots and current native kinds; reopening reuses Collections and occurrences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'persona-seed-'));
  const path = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(path);
  const f = fixture();
  try {
    const first = await seedDevelopmentShowcase({ ...f, journal, accountId: owner, selection });
    expect(first.collections.map((row) => [row.view, row.status, row.kind])).toEqual([
      ['ranked', 'current', 'rezics:VisualNovel'],
      ['grid', 'current', null],
      ['mixed', 'current', null],
    ]);
    expect(first.collections[2]!.sources.map((row) => row.subjectId)).toEqual(f.subjects.map((row) => row.id));
    expect(first.edition.status).toBe('producer-unavailable');
    expect(first.offer.status).toBe('awaiting-content-edition');
    journal.close();
    journal = new ShowcaseJournal(path);
    const writes = f.sent.length;
    const reopened = await seedDevelopmentShowcase({ ...f, journal, accountId: owner, selection });
    expect(reopened).toEqual(first);
    expect(f.sent.length).toBe(writes);
    expect(f.collections.size).toBe(3);
    let creatorReads = 0;
    const unavailable = await seedDevelopmentShowcase({
      ...f,
      journal,
      accountId: owner,
      selection,
      request: async (input) => {
        if (input.audience === 'creator') {
          creatorReads++;
          return Response.json({}, { status: 503 });
        }
        return f.request(input);
      },
    });
    expect(creatorReads).toBe(6);
    expect(unavailable.collections.every((row) => row.status === 'unavailable')).toBe(true);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unknown delivery replays exact pending bytes/key; permanent refusal stays terminal and missing source stays distinct', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'persona-reopen-'));
  const path = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(path);
  const f = fixture();
  let lost = false;
  try {
    const first = await seedDevelopmentShowcase({
      ...f,
      journal,
      accountId: owner,
      selection,
      request: async (input) => {
        if (input.body && (input.body as { title?: string }).title === 'Showcase grid')
          return Response.json({ retryable: false, effect_status: 'not_applied' }, { status: 422 });
        const response = await f.request(input);
        if (!lost && input.body) {
          lost = true;
          throw new DOMException('Response lost after commit', 'TimeoutError');
        }
        return response;
      },
    });
    expect(first.collections.map((row) => row.status)).toEqual(['unknown-delivery', 'refused', 'current']);
    const pending = journal.action(`persona:${owner}:ranked`)!;
    journal.close();
    journal = new ShowcaseJournal(path);
    const reopened = await seedDevelopmentShowcase({ ...f, journal, accountId: owner, selection });
    expect(reopened.collections.map((row) => row.status)).toEqual(['current', 'refused', 'current']);
    expect(f.sent[0]).toEqual(f.sent.find((row, index) => index > 0 && row.key === f.sent[0]!.key));
    expect(journal.action(`persona:${owner}:ranked`)!.idempotency_key).toBe(pending.idempotency_key);
    expect(f.collections.size).toBe(2);
    const missing = await seedDevelopmentShowcase({
      ...f,
      journal,
      accountId: owner,
      selection,
      result: { readings: [], workLinks: [] },
    });
    expect(missing.sources.every((row) => row.status === 'missing-source')).toBe(true);
    const wrongIdentity = await seedDevelopmentShowcase({
      ...f,
      journal,
      accountId: owner,
      selection,
      request: async (input) =>
        input.path.startsWith('/v1/subjects/')
          ? Response.json({ subject: { ...f.subjects[0], id: crypto.randomUUID() } })
          : f.request(input),
    });
    expect(wrongIdentity.sources.every((row) => row.status === 'missing-source')).toBe(true);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('production HTTP adapter separates current creator credentials from anonymous disclosure and seals write keys', async () => {
  const observed: Request[] = [];
  let credentials = 0;
  const request = createDevelopmentShowcaseRequest({
    origin: 'http://127.0.0.1:4100',
    token: async () => `creator-${++credentials}`,
    fetch: async (input) => {
      observed.push(new Request(input));
      return Response.json({});
    },
  });
  await request({ path: '/v1/collections', audience: 'creator', body: { title: 'Selected' }, key: 'sealed-key' });
  await request({ path: '/v1/collections', audience: 'public' });
  await request({ path: '/v1/collections', audience: 'creator' });
  expect(observed.map((row) => row.headers.get('authorization'))).toEqual([
    'Bearer creator-1',
    null,
    'Bearer creator-2',
  ]);
  expect(observed[0]!.headers.get('idempotency-key')).toBe('"sealed-key"');
  expect(await observed[0]!.json()).toEqual({ title: 'Selected' });
});
