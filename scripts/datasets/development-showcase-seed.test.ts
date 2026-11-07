import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CrossMediaReading } from '../../services/importer/src/cross-media-seed.ts';
import type { CrossMediaSeedCliOptions } from '../../services/importer/src/cross-media-seed.ts';
import { ReviewedCatalogueCommandError } from '../../services/importer/src/http.ts';
import { ShowcaseJournal } from '../../services/importer/src/showcase-publication.ts';
import { runDevelopmentSeed, seedFailureDetail } from './cross-media-seed.ts';
import { cacheDumpAsset } from './fetch-dumps.ts';
import {
  createDevelopmentShowcaseRequest,
  developmentCollectionFailure,
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

async function captureSeedOptions(timestamp?: string): Promise<CrossMediaSeedCliOptions> {
  const tempRoot = join(process.cwd(), '.temp');
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, 'seed-provenance-'));
  const stop = new Error('captured seed options');
  let captured: CrossMediaSeedCliOptions | undefined;
  let thrown: unknown;
  try {
    await runDevelopmentSeed({
      root,
      env: {
        REZICS_DEV_PERSONA_ACCOUNT_KEY: 'persona.key',
        REZICS_DEV_PERSONA_ACCOUNT: owner,
        REZICS_DEV_PERSONA_CLIENT: 'persona-client',
        REZICS_DEV_SHOWCASE_ACCOUNT_KEY: 'showcase.key',
        REZICS_DEV_SHOWCASE_CLIENT: 'showcase-client',
        AUTH_ORIGIN: 'https://auth.seed.test',
      },
      fetchDumps: async () => ({
        cacheRoot: root,
        bangumi: join(root, 'bangumi'),
        vndb: join(root, 'vndb'),
        bangumiArchive: join(root, 'bangumi.zip'),
        vndbArchive: join(root, 'vndb.tar.zst'),
        sourceSnapshots: {
          bangumi: {
            file: 'bangumi.zip',
            url: 'https://archive.seed.test/bangumi.zip',
            sha256: '0'.repeat(64),
            licences: ['CC-BY-SA-3.0'],
          },
          vndb: {
            file: 'vndb.tar.zst',
            url: 'https://archive.seed.test/vndb.tar.zst',
            sha256: '1'.repeat(64),
            ...(timestamp === undefined ? {} : { timestamp }),
            licences: ['ODbL-1.0', 'DbCL-1.0'],
          },
        },
      }),
      createTokenProvider: async () => async () => 'seed-token',
      seedCatalogue: async () => ({ subjects: {}, facts: [] }),
      runSeed: async (_args, options) => {
        captured = options;
        throw stop;
      },
    });
  } catch (error) {
    thrown = error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  expect(thrown).toBe(stop);
  expect(captured).toBeDefined();
  return captured!;
}

test('development seed carries the verified VNDB generation date and omits an unproven date', async () => {
  const pinned = await captureSeedOptions('2026-11-04 08:00:24+00');
  expect(pinned.sourceSnapshotAsOf).toBe('2026-11-04');
  const unpinned = await captureSeedOptions();
  expect(unpinned).not.toHaveProperty('sourceSnapshotAsOf');
});

test('cross-media seed caller prints local dump metadata and preserves reviewed-catalogue attribution', async () => {
  const tempRoot = join(process.cwd(), '.temp');
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, 'seed-diagnostic-'));
  const cause = new Error('Bearer abc123 raw imported record body');
  const fetchImpl = Object.assign(
    async () => {
      throw cause;
    },
    { preconnect() {} },
  );
  const source = 'https://operator:secret@dl.vndb.org/dump/vndb-db.tar.zst?token=private#fragment';
  try {
    const failure = await cacheDumpAsset(
      source,
      join(root, 'downloads', 'vndb-db.tar.zst'),
      '0'.repeat(64),
      { fetchImpl },
    ).catch((error: unknown) => error);
    const detail = seedFailureDetail(failure);
    expect(detail).toContain('operation=dump-download phase=network');
    expect(detail).toContain('target=https://dl.vndb.org/dump/vndb-db.tar.zst');
    expect(detail).not.toContain('operator');
    expect(detail).not.toContain('secret');
    expect(detail).not.toContain('private');
    expect(detail).not.toContain('Bearer abc123');
    expect(detail).not.toContain('raw imported record body');

    const httpFetch = Object.assign(
      async () => new Response('Bearer abc123 raw imported record body', { status: 404 }),
      { preconnect() {} },
    );
    const unavailable = await cacheDumpAsset(
      source,
      join(root, 'downloads', 'unavailable.tar.zst'),
      '0'.repeat(64),
      { fetchImpl: httpFetch },
    ).catch((error: unknown) => error);
    const httpDetail = seedFailureDetail(unavailable);
    expect(httpDetail).toContain('operation=dump-download phase=http');
    expect(httpDetail).toContain('status=404');
    expect(httpDetail).toContain('target=https://dl.vndb.org/dump/vndb-db.tar.zst');
    expect(httpDetail).not.toContain('Bearer abc123');
    expect(httpDetail).not.toContain('raw imported record body');
    expect(httpDetail).not.toContain('token=private');

    const reviewed = new ReviewedCatalogueCommandError('seed-1', 'proposal', {
      status: 403,
      code: 'forbidden',
      operation: 'statement:propose',
    });
    expect(seedFailureDetail(reviewed)).toContain('seed=seed-1 kind=proposal operation=statement:propose');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
  return { request, sent, collections, subjects, result: { readings, workLinks: [], vndbWorkRelations: [] } };
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
    expect(first.status).toBe('current');
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
    expect(developmentCollectionFailure(unavailable.collections)).toEqual({
      state: 'unavailable',
      operation: 'collections.ranked.read-creator',
      code: 'http-503',
    });
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
      result: { readings: [], workLinks: [], vndbWorkRelations: [] },
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
