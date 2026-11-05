import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planCrossMediaSeed,
  seedCrossMedia,
  crossMediaAliases,
  type CrossMediaSeedResult,
} from '../../../importer/src/cross-media-seed.ts';
import {
  ShowcaseJournal,
  captureShowcaseCommands,
  publishShowcase,
} from '../../../importer/src/showcase-publication.ts';
import { createPublicBulkClient, GLOBAL_CONTEXT } from '../../../importer/src/public-bulk-client.ts';
import {
  createDevelopmentShowcaseRequest,
  seedDevelopmentShowcase,
} from '../../../../scripts/datasets/development-showcase.ts';
import {
  createCollectionPresentationFixture,
  type CollectionPresentationFixture,
} from '../library/support/collection-presentation-fixture.ts';
import { openApiObserver } from './api-observer.ts';

let f: CollectionPresentationFixture;
let directory: string;
let result: CrossMediaSeedResult;
const selection = { bangumi: [100], vndb: ['v410'] };
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'showcase-persona-native-'));
  f = await createCollectionPresentationFixture();
  const journal = new ShowcaseJournal(join(directory, 'source.sqlite'));
  try {
    const plan = await planCrossMediaSeed(
      {
        async *rows(provider, table) {
          if (provider === 'bangumi' && table === 'subject') yield { id: 100, type: 2, name: 'STEINS;GATE' };
          if (provider !== 'vndb') return;
          if (table === 'vn') yield { id: 'v410', olang: 'ja', alias: null };
          if (table === 'vn_titles') yield { id: 'v410', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null };
          if (table === 'entry_meta') yield { id: 'v410', revision: '7', lastmod: '2026-10-25' };
          if (table === 'vn_extlinks') yield { id: 'v410', link: 1 };
          if (table === 'extlinks') yield { id: 1, site: 'website', value: 'https://bgm.tv/subject/100' };
        },
      },
      { selection },
    );
    result = await seedCrossMedia(
      plan,
      join(directory, 'import.sqlite'),
      captureShowcaseCommands(f.runtime.importTransport, journal),
      { origin: f.runtime.origin },
      { mediaDeadlineMs: 0 },
    );
    const observer = await openApiObserver(f.runtime);
    expect(
      (
        await observer.http('/v1/grants', {
          resource: { route: 0, id: GLOBAL_CONTEXT },
          subject: { kind: 'account', id: f.runtime.identity.bulk.accountId },
          actions: ['context:accept', 'context:adopt'],
          valid: '(,)',
        })
      ).status,
    ).toBe(201);
    const publicClient = createPublicBulkClient({
      origin: f.runtime.origin,
      fetch: async (input, init) => f.runtime.replay(new Request(input, init)),
    });
    const publication = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review: f.runtime.importTransport,
      publicClient,
    });
    expect(publication.status).toBe('published');
  } finally {
    journal.close();
  }
}, 180000);
afterAll(async () => {
  await f?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  await f.refresh();
}, 120000);

test('native persona Collections contain the actual admitted works and disclose current ownership and kinds independently', async () => {
  const journal = new ShowcaseJournal(join(directory, 'persona.sqlite'));
  try {
    const request = createDevelopmentShowcaseRequest({
      origin: f.runtime.origin,
      token: async () => f.owner.bearer,
      fetch: async (input, init) => f.runtime.replay(new Request(input, init)),
    });
    const first = await seedDevelopmentShowcase({ journal, request, result, selection, accountId: f.owner.accountId });
    expect(first.collections.map((row) => row.status)).toEqual(['current', 'current', 'current']);
    const ids = new Set(result.readings.map((row) => row.subject.subject!.id));
    expect(ids.size).toBe(2);
    for (const row of first.collections) {
      expect(row.id).toBeString();
      const read = await f.send(f.owner.bearer, 'GET', `/v1/collections/${row.id}`);
      expect(read.status).toBe(200);
      expect((await read.json()).collection).toMatchObject({
        id: row.id,
        curatorAccountId: f.owner.accountId,
        presentationKind: row.kind,
        presentationKindSource: row.kind === null ? 'mixed' : 'owner',
      });
      const page = await f.send(null, 'GET', `/v1/collections/${row.id}/members?limit=100`);
      expect(page.status).toBe(200);
      expect((await page.json()).members.map((member: { subjectId: string }) => member.subjectId)).toEqual(
        row.sources.map((source) => source.subjectId),
      );
      expect(row.sources.every((source) => ids.has(source.subjectId))).toBe(true);
    }
    expect(first.collections[2]!.kind).toBeNull();
    expect(first.workLinks).toEqual(result.workLinks);
    expect(first.edition.status).toBe('producer-unavailable');
    expect(first.offer.status).toBe('awaiting-content-edition');
    const reopened = await seedDevelopmentShowcase({
      journal,
      request,
      result,
      selection,
      accountId: f.owner.accountId,
    });
    expect(reopened.collections).toEqual(first.collections);
  } finally {
    journal.close();
  }
}, 180000);

test('exact reopen resolves a committed response loss and retains one native permanent refusal without duplicate creates', async () => {
  const path = join(directory, 'unknown.sqlite');
  let journal = new ShowcaseJournal(path);
  const readOnly = await f.credential('ordinary', ['subject:read', 'collection:read', 'collection:update']);
  const sends: { key: string; body: string; returnedId: string }[] = [];
  let interrupt = true;
  const request = createDevelopmentShowcaseRequest({
    origin: f.runtime.origin,
    token: async () => f.owner.bearer,
    fetch: async (input, init) => {
      const sent = new Request(input, init);
      const body = sent.method === 'POST' ? await sent.clone().text() : '';
      if (interrupt && body.includes('Showcase grid')) sent.headers.set('authorization', `Bearer ${readOnly.bearer}`);
      const response = await f.runtime.replay(sent);
      if (body.includes('Showcase ranked')) {
        const value = await response.clone().json();
        sends.push({ key: sent.headers.get('idempotency-key')!, body, returnedId: value.collection.id });
        if (interrupt) throw new DOMException('Committed response lost at HTTP boundary', 'TimeoutError');
      }
      return response;
    },
  });
  try {
    const first = await seedDevelopmentShowcase({ journal, request, result, selection, accountId: f.owner.accountId });
    expect(first.collections.map((row) => row.status)).toEqual(['unknown-delivery', 'refused', 'current']);
    journal.close();
    journal = new ShowcaseJournal(path);
    interrupt = false;
    const reopened = await seedDevelopmentShowcase({
      journal,
      request,
      result,
      selection,
      accountId: f.owner.accountId,
    });
    expect(reopened.collections.map((row) => row.status)).toEqual(['current', 'refused', 'current']);
    expect(new Set(sends.map((row) => row.key)).size).toBe(1);
    expect(new Set(sends.map((row) => row.body)).size).toBe(1);
    expect(new Set(sends.map((row) => row.returnedId)).size).toBe(1);
    expect(reopened.collections[0]!.id).toBe(sends[0]!.returnedId);
    const listing = await f.send(
      f.owner.bearer,
      'GET',
      `/v1/collections?curatorAccountId=${f.owner.accountId}&limit=100`,
    );
    expect(listing.status).toBe(200);
    expect(
      (await listing.json()).collections.filter((row: { id: string }) => row.id === sends[0]!.returnedId),
    ).toHaveLength(1);
  } finally {
    journal.close();
  }
}, 180000);
