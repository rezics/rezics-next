import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { listHostedCataloguesForSubject } from '../../src/content/hosted-catalogue-subject.ts';
import type { HostedDependencies } from '../../src/content/hosted-chapters-model.ts';
import { hostedSubjectCursorBinding } from '../../src/content/hosted-catalogue-subject-cursor.ts';
import {
  hostedSubjectPageLimit,
  isCurrentPublicCatalogueCandidate,
} from '../../src/content/hosted-catalogue-subject-model.ts';
import { hostedReadingPositionIsBounded, hostedReadingSelectionShape } from '../../src/content/hosted-reading-shape.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import type { Actor } from '../../src/request/access.ts';

const pageSql = readFileSync(new URL('../../src/content/hosted-catalogue-subject-page.sql', import.meta.url), 'utf8');
const subjectId = '00000000-0000-7000-8000-000000000001';

setDefaultTimeout(180_000);
let fixture: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  fixture = await hostedChaptersFixture();
});
afterAll(async () => {
  await fixture?.close();
});

async function publishedCatalogue(subject: string) {
  const subjectPartition = partitionOf(routeOf(subject)!);
  const thread = await fixture.threadOutsidePartition(subjectPartition);
  const revised = await fixture.native.revise(thread.firstPost, { subjectIds: [subject] });
  expect(revised.status, JSON.stringify(revised.value)).toBe(200);
  await fixture.projectSubjectThread(thread.id);

  const occurrenceId = fixture.newOccurrenceIdFor(thread.firstPost.id);
  const created = await fixture.native.call('POST', '/v1/hostedCatalogues', {
    postId: thread.firstPost.id,
    threadId: thread.id,
    placements: [{ occurrenceId, parentId: null, position: 0, title: 'Contents', kind: 'part' }],
  });
  expect(created.status, JSON.stringify(created.value)).toBe(201);
  const published = await fixture.native.call('POST', `/v1/hostedCatalogues/${thread.firstPost.id}:publish`, {
    expectedRevisionId: created.value.revisionId,
    expectedPublicationId: null,
    occurrenceIds: [occurrenceId],
  });
  expect(published.status, JSON.stringify(published.value)).toBe(200);
  return {
    catalogueId: thread.firstPost.id,
    threadId: thread.id,
    structureRevisionId: created.value.revisionId as string,
    publicationId: published.value.revisionId as string,
  };
}

function readDependencies(pool: Pool = fixture.native.pool): HostedDependencies {
  return {
    pool,
    access: fixture.native.system.access,
    tokens: fixture.native.system.tokenKeys,
    clock: () => new Date(),
  };
}

function bumpAfterExactPublicationRead(pool: Pool, catalogueId: string, partition: number): Pool {
  let bumped = false;
  return new Proxy(pool, {
    get(target, property) {
      if (property !== 'connect') {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async () => {
        const client = await target.connect();
        const query = client.query;
        client.query = ((...args: unknown[]) => {
          const statement = args[0] as string | { text?: string; values?: readonly unknown[] };
          const sql = typeof statement === 'string' ? statement : (statement.text ?? '');
          const values = Array.isArray(args[1])
            ? (args[1] as readonly unknown[])
            : typeof statement === 'string'
              ? []
              : (statement.values ?? []);
          return Promise.resolve(Reflect.apply(query, client, args)).then(async (result) => {
            if (!bumped && sql.includes('content.hosted_structure_revision') && values.includes(catalogueId)) {
              bumped = true;
              await pool.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [partition]);
            }
            return result;
          });
        }) as typeof client.query;
        return client;
      };
    },
  });
}

test('current public candidates require a publication pointer', () => {
  expect(
    isCurrentPublicCatalogueCandidate({
      route: 1,
      catalogue_id: subjectId,
      thread_id: subjectId,
      publication_id: subjectId,
    }),
  ).toBe(true);
  expect(
    isCurrentPublicCatalogueCandidate({
      route: 1,
      catalogue_id: subjectId,
      thread_id: subjectId,
      publication_id: '',
    }),
  ).toBe(false);
});

test('subject catalogue pages stay inside the hosted twenty-item bound', () => {
  expect(hostedSubjectPageLimit(undefined)).toBe(20);
  expect(hostedSubjectPageLimit(1)).toBe(1);
  expect(hostedSubjectPageLimit(20)).toBe(20);
  expect(hostedSubjectPageLimit(0)).toBe(-1);
  expect(hostedSubjectPageLimit(21)).toBe(-1);
});

test('subject discovery SQL seeks indexed threads and same-route post subject ids', () => {
  expect(pageSql).toContain('content.subject_thread');
  expect(pageSql).toContain('hosted_catalogue');
  expect(pageSql).toContain('= ANY (r.subject_ids)');
  expect(pageSql).toContain('hosted_placement');
  expect(pageSql).toContain("p.visibility = 'published'");
});

test('continuations bind the subject, limit and viewer without catalogue bytes', () => {
  const actor: Actor = {
    kind: 'account',
    accountId: subjectId,
    clientId: 'reader',
    requestedBy: null,
    authnEpoch: 1,
    scopes: ['post:read'],
  };
  const binding = hostedSubjectCursorBinding(subjectId, { actor, deadline: Date.now() + 1000 }, 20);
  expect(binding.operation).toBe('content.hosted-catalogue.for-subject');
  expect(binding.parameters).toMatchObject({ subjectId, limit: 20 });
  expect(JSON.stringify(binding)).not.toContain('canonicalBytes');
});

test('hosted reading selections keep digest and bounded document position', () => {
  const digest = 'a'.repeat(64);
  expect(
    hostedReadingSelectionShape({
      catalogueId: subjectId,
      publicationRevisionId: subjectId,
      occurrenceId: subjectId,
      targetRevisionId: subjectId,
      targetSha256: digest,
      documentPosition: { blockId: 'block-1', offset: 12 },
    }),
  ).toBe(true);
  expect(hostedReadingPositionIsBounded(null)).toBe(true);
  expect(hostedReadingPositionIsBounded({ blockId: 'x'.repeat(129), offset: 0 })).toBe(false);
  expect(hostedReadingPositionIsBounded({ blockId: 'ok', offset: -1 })).toBe(false);
  expect(
    hostedReadingSelectionShape({
      catalogueId: subjectId,
      publicationRevisionId: subjectId,
      occurrenceId: subjectId,
      targetRevisionId: subjectId,
      targetSha256: 'not-a-digest',
      documentPosition: null,
    }),
  ).toBe(false);
});

test('for-subject discovers a public catalogue when Subject and catalogue epochs differ', async () => {
  const excludedPartition = partitionOf(routeOf(fixture.catalogueId)!);
  const subject = await fixture.subjectOutsidePartition(excludedPartition);
  const catalogue = await publishedCatalogue(subject);
  const subjectPartition = partitionOf(routeOf(subject)!);
  const cataloguePartition = partitionOf(routeOf(catalogue.catalogueId)!);
  const states = await fixture.native.pool.query<{ partition_no: number; epoch: number }>(
    'SELECT partition_no,epoch FROM core.partition WHERE partition_no=ANY($1::integer[])',
    [[subjectPartition, cataloguePartition]],
  );
  const originalSubjectEpoch = states.rows.find((row) => row.partition_no === subjectPartition)!.epoch;
  const catalogueEpoch = states.rows.find((row) => row.partition_no === cataloguePartition)!.epoch;
  const subjectEpoch = Math.max(originalSubjectEpoch, catalogueEpoch) + 1;
  try {
    await fixture.native.pool.query('UPDATE core.partition SET epoch=$2 WHERE partition_no=$1', [
      subjectPartition,
      subjectEpoch,
    ]);
    const page = await fixture.native.call('GET', `/v1/subjects/${subject}/hostedCatalogues`, undefined, {
      anonymous: true,
    });
    expect(page.status, JSON.stringify(page.value)).toBe(200);
    expect(page.value.items).toContainEqual({
      catalogueId: catalogue.catalogueId,
      revisionId: catalogue.publicationId,
      kind: 'publication',
      sourceRevisionId: catalogue.structureRevisionId,
      threadId: catalogue.threadId,
    });
  } finally {
    await fixture.native.pool.query('UPDATE core.partition SET epoch=$2 WHERE partition_no=$1', [
      subjectPartition,
      originalSubjectEpoch,
    ]);
  }
});

test('a catalogue epoch change suppresses its stale item while raw cursor progress reaches the next catalogue', async () => {
  const subject = await fixture.subjectOutsidePartition(partitionOf(routeOf(fixture.catalogueId)!));
  const first = await publishedCatalogue(subject);
  const second = await publishedCatalogue(subject);
  const candidates = [first, second].sort((left, right) => left.catalogueId.localeCompare(right.catalogueId));
  const subjectPartition = partitionOf(routeOf(subject)!);
  const cataloguePartitions = [...new Set(candidates.map((candidate) => partitionOf(routeOf(candidate.catalogueId)!)))];
  const states = await fixture.native.pool.query<{ partition_no: number; epoch: number }>(
    'SELECT partition_no,epoch FROM core.partition WHERE partition_no=ANY($1::integer[])',
    [[subjectPartition, ...cataloguePartitions]],
  );
  const originalEpochs = new Map(states.rows.map((row) => [row.partition_no, row.epoch]));
  const originalSubjectEpoch = originalEpochs.get(subjectPartition)!;
  const catalogueEpoch = Math.max(...cataloguePartitions.map((partition) => originalEpochs.get(partition)!));
  const selectedSubjectEpoch = Math.max(originalSubjectEpoch, catalogueEpoch) + 2;
  const context = { actor: fixture.native.author.actor, deadline: Date.now() + 60_000 };
  const target = candidates[0]!;
  const targetPartition = partitionOf(routeOf(target.catalogueId)!);
  try {
    await fixture.native.pool.query('UPDATE core.partition SET epoch=$2 WHERE partition_no=$1', [
      subjectPartition,
      selectedSubjectEpoch,
    ]);
    const firstPage = await listHostedCataloguesForSubject(
      readDependencies(bumpAfterExactPublicationRead(fixture.native.pool, target.catalogueId, targetPartition)),
      subject,
      { limit: 1 },
      context,
    );
    expect(firstPage.value.items).toEqual([]);
    expect(firstPage.value.nextCursor).toEqual(expect.any(String));

    const secondPage = await listHostedCataloguesForSubject(
      readDependencies(),
      subject,
      { limit: 1, cursor: firstPage.value.nextCursor! },
      context,
    );
    expect(secondPage.value.items.map((item) => item.catalogueId)).toEqual([candidates[1]!.catalogueId]);
    expect(secondPage.value.nextCursor).toBeNull();
  } finally {
    for (const [partition, epoch] of originalEpochs)
      await fixture.native.pool.query('UPDATE core.partition SET epoch=$2 WHERE partition_no=$1', [partition, epoch]);
  }
});

test('withdrawing the current TOC removes its catalogue from Subject discovery', async () => {
  const subject = await fixture.subjectOutsidePartition(partitionOf(routeOf(fixture.catalogueId)!));
  const catalogue = await publishedCatalogue(subject);
  const visible = await fixture.native.call('GET', `/v1/subjects/${subject}/hostedCatalogues`, undefined, {
    anonymous: true,
  });
  expect(visible.value.items.map((item: { catalogueId: string }) => item.catalogueId)).toContain(catalogue.catalogueId);

  const withdrawn = await fixture.native.call('POST', `/v1/hostedCatalogues/${catalogue.catalogueId}:publish`, {
    expectedRevisionId: catalogue.structureRevisionId,
    expectedPublicationId: catalogue.publicationId,
    occurrenceIds: [],
  });
  expect(withdrawn.status, JSON.stringify(withdrawn.value)).toBe(200);
  const current = await fixture.native.call('GET', `/v1/subjects/${subject}/hostedCatalogues`, undefined, {
    anonymous: true,
  });
  expect(current.status).toBe(200);
  expect(current.value.items).toEqual([]);
});
