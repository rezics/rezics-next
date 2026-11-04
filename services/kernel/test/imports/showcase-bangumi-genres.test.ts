import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchStatement } from '@rezics/definitions/bulk';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import { emptyCrossMediaPlan, crossMediaAliases, seedCrossMedia } from '../../../importer/src/cross-media-seed.ts';
import { seedReviewedCatalogue, type ReviewedCataloguePort } from '../../../importer/src/reviewed-catalogue.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createReleasedDiscoveryFixture, type ReleasedDiscoveryFixture } from '../support/released-discovery.ts';

const payload = {
  id: 884,
  type: 2,
  name: 'CHAOS;HEAD',
  name_cn: '混沌头',
  meta_tags: ['科幻', '后宫', 'TV', '日本', '游戏改'],
};

let fixture: ReleasedDiscoveryFixture;
let database: GrowthDatabase;
let directory: string;
let statePath: string;
let cataloguePort: ReviewedCataloguePort;
let journal: ShowcaseJournal;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'showcase-bangumi-genre-native-'));
  statePath = join(directory, 'state.sqlite');
  fixture = await createReleasedDiscoveryFixture({
    version: 1,
    kernelPool: async (url) => {
      database = await openGrowthDatabase(url);
      return database.pool;
    },
  });
  cataloguePort = await fixture.reviewedCatalogueOperator('alice');
  journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
}, 180_000);

afterAll(async () => {
  journal?.close();
  await database?.admin.end();
  await fixture?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

function planFor(record: typeof payload) {
  const plan = emptyCrossMediaPlan();
  plan.records.bangumi.push({ source: 'bangumi', key: String(record.id), revision: null, payload: record });
  plan.members.push({
    source: 'bangumi',
    key: String(record.id),
    kind: 'work',
    membership: 'family',
    franchise: 'steins-gate',
  });
  return plan;
}

function publicReader() {
  return createPublicBulkClient({
    origin: 'https://reviewed.discovery.test',
    fetch: (async (input) => {
      const url = new URL(String(input));
      const response = await fixture.request('anonymous', 'GET', url.pathname + url.search);
      return Response.json(response.body, { status: response.status });
    }) as typeof fetch,
  });
}

test('default seed publishes the reviewed source Concept publicly and retracts only its source keyword after tag removal and reopen', async () => {
  const reviewed = await seedReviewedCatalogue({ path: statePath, port: cataloguePort });
  const sourceConcept = reviewed.subjects['source-harem']!;
  const canonicalConcept = reviewed.subjects['canonical-harem']!;
  const publicClient = publicReader();
  const run = async (record: typeof payload) => {
    const plan = planFor(record);
    const result = await seedCrossMedia(
      plan,
      statePath,
      captureShowcaseCommands(cataloguePort, journal),
      { origin: 'https://reviewed.discovery.test' },
      { providers: ['bangumi'], bangumiGenrePort: cataloguePort },
    );
    const publication = await publishShowcase({
      plan,
      result,
      aliases: crossMediaAliases,
      journal,
      review: cataloguePort,
      publicClient,
    });
    return { result, publication };
  };

  const first = await run(payload);
  expect(first.publication.status).toBe('published');
  const workId = first.result.readings[0]!.subject.subject!.id!;
  const firstKeyword = first.publication.manifest.records
    .flatMap((record) => record.assertions)
    .find((assertion) => assertion.property === 'schema:keywords')!;
  expect(firstKeyword.statement.value).toEqual({ type: 'value', content: sourceConcept });
  expect(firstKeyword.statement.value).not.toEqual({ type: 'value', content: canonicalConcept });
  expect(firstKeyword.statement.qualifiers).toEqual([
    { property: { id: 'rezics:spoilerLevel' }, value: { type: 'value', content: { amount: '0', unit: '1' } } },
  ]);
  const publicSubject = (await publicClient.readSubject(workId)).subject as {
    statements: Record<string, BatchStatement[]>;
  };
  expect(publicSubject.statements['schema:keywords']?.map((statement) => statement.value.content)).toContain(
    sourceConcept,
  );

  journal.close();
  journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const removed = await run({ ...payload, meta_tags: [] });
  expect(removed.result.bangumiGenrePublication!.candidateIds).toEqual([]);
  expect(
    removed.publication.manifest.records
      .flatMap((record) => record.assertions)
      .some(
        (assertion) =>
          assertion.property === 'schema:keywords' &&
          assertion.statement.value.type === 'value' &&
          assertion.statement.value.content === sourceConcept,
      ),
  ).toBe(false);
  const after = (await publicClient.readSubject(workId)).subject as { statements: Record<string, BatchStatement[]> };
  expect(after.statements['schema:keywords']?.map((statement) => statement.value.content) ?? []).not.toContain(
    sourceConcept,
  );
  expect(after.statements['schema:name']?.length).toBeGreaterThan(0);
  expect(removed.result.runs.bangumi?.status).toBe('committed');
});
