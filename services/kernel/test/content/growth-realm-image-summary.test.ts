import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import realmHead from '../../src/community/realm-read.sql';
import spaceHead from '../../src/community/space-read.sql';
import mediaRead from '../../src/content/realm-media-read.sql';
import partitionAnchor from '../../src/partition/read.sql';
import { assertGrowthAccessPaths, checkGrowth, seed } from '../support/growth.ts';
import { observeSql, type SqlExecution } from './support/sql-observer.ts';
import {
  realmImageSummaryFixture,
  type RealmImageSummaryFixture,
} from './support/growth-realm-image-summary-fixture.ts';

setDefaultTimeout(600_000);
const scales = [256, 1024, 4096] as const;
const none = { state: 'none', value: null } as const;
const unavailable = { state: 'unavailable', value: null } as const;
let fixture: RealmImageSummaryFixture;
beforeAll(async () => {
  fixture = await realmImageSummaryFixture();
}, 360_000);
afterAll(async () => {
  await fixture?.close();
});

function assertAvailable(result: Awaited<ReturnType<RealmImageSummaryFixture['read']>>) {
  for (const [slot, id] of [
    ['avatar', fixture.selected.avatarMediaId],
    ['banner', fixture.selected.bannerMediaId],
  ] as const) {
    const optional = result[slot];
    expect(optional.state).toBe('available');
    if (optional.state !== 'available') throw new Error(`${slot}: expected available, reached ${optional.state}`);
    const actual = fixture.facts.filter((row) => row.media_id === id);
    expect(actual.length).toBeGreaterThan(0);
    expect(actual.length).toBeLessThanOrEqual(12);
    const largest = actual.reduce((a, b) => (b.width > a.width ? b : a));
    const metadata = fixture.metadata.find((row) => row.media_id === id)!;
    expect(optional.value).toEqual({
      id,
      containerId: fixture.realmId,
      digest: largest.sha256,
      width: largest.width,
      height: largest.height,
      variants: actual.map(({ format, width, height }) => ({ format, width, height })),
      placeholder:
        metadata.thumbhash && metadata.color ? { thumbhash: metadata.thumbhash, color: metadata.color } : null,
      focalPoint: null,
      credit: null,
    });
    const serialized = JSON.stringify(optional.value);
    expect(serialized).not.toMatch(/original|sourceUrl|source_url|uploader|account|"key"|https?:/i);
    expect(serialized).not.toContain(fixture.native.alice.accountId);
    expect(serialized).not.toContain(fixture.sha256);
  }
}

function assertBindings(records: readonly SqlExecution[]) {
  const media = records.filter((row) => row.statement === mediaRead.sql);
  expect(media).toHaveLength(4); // Two source and two final exact media probes.
  for (const id of [fixture.selected.avatarMediaId, fixture.selected.bannerMediaId])
    expect(media.filter((row) => row.parameters.includes(id))).toHaveLength(2);
  for (const row of media) expect(row.parameters).toContain(fixture.route);
  const realms = records.filter((row) => row.statement === realmHead.sql);
  const hosts = records.filter((row) => row.statement === spaceHead.sql);
  expect(realms.length).toBeGreaterThanOrEqual(3);
  expect(hosts.length).toBeGreaterThanOrEqual(2);
  for (const row of realms) expect(row.parameters).toContain(fixture.realmId);
  for (const row of hosts) expect(row.parameters).toContain(fixture.spaceId);
  expect(records.lastIndexOf(realms.at(-1)!)).toBeGreaterThan(records.indexOf(media[1]!));
  expect(records.lastIndexOf(hosts.at(-1)!)).toBeGreaterThan(records.indexOf(media[1]!));
}

test('native two-slot Realm summaries keep fixed indexed work on independent population and retained-history axes', async () => {
  // The second sweep holds the first axis at 4096; selected keys, bytes and variants never change.
  for (const axis of ['population', 'history'] as const) {
    const population = fixture.population(axis);
    const report = await checkGrowth(fixture.db, {
      name: `Native Realm image summary ${axis}`,
      scales,
      repetitions: 3,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      async grow(database, scale, previous) {
        await seed(database, population, { from: previous, to: scale });
      },
      async operation() {
        const trace = observeSql(fixture.db.pool);
        try {
          assertAvailable(await fixture.read());
          assertBindings(trace.records);
          const start = trace.records.length;
          expect(await fixture.read({ realmId: fixture.realmId, avatarMediaId: null, bannerMediaId: null })).toEqual({
            avatar: none,
            banner: none,
          });
          expect(trace.records.length).toBe(start); // Unset slots do not discover replacement images.
          expect(await fixture.read(fixture.selected, fixture.anonymous)).toEqual({ avatar: none, banner: none });
          // Alice remains the exact uploader and a Realm manager, with current realm:read removed.
          expect(await fixture.read(fixture.selected, fixture.owner)).toEqual({ avatar: none, banner: none });
          expect(await fixture.read(fixture.erased)).toEqual({ avatar: none, banner: none });
          // Wrong-purpose slots cannot be treated as interchangeable images.
          expect(
            await fixture.read({
              realmId: fixture.realmId,
              avatarMediaId: fixture.selected.bannerMediaId,
              bannerMediaId: fixture.selected.avatarMediaId,
            }),
          ).toEqual({ avatar: none, banner: none });
          // A closed native pg pool fails at checkout. This is not an Access stub or a returned empty map.
          expect(await fixture.read(fixture.selected, fixture.reader, fixture.failedPool)).toEqual({
            avatar: unavailable,
            banner: unavailable,
          });
          expect(
            await fixture.read({ ...fixture.selected, bannerMediaId: null }, fixture.reader, fixture.failedPool),
          ).toEqual({ avatar: unavailable, banner: none });
          assertAvailable(await fixture.read());
        } finally {
          await trace.close();
        }
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([...scales]);
    // Keep real controls/catalog work and every refusal in the inclusive observation.
    for (const metric of ['controlStatements', 'catalogStatements'] as const)
      expect(new Set(report.samples.map(({ cost }) => cost[metric])).size).toBe(1);
    const relations = [
      'community.realm',
      'community.realm_revision',
      'community.space',
      'community.space_revision',
      'access.resource_grant',
      'content.media',
      'content.media_variant',
    ];
    for (const relation of relations) {
      const rows = report.samples.map(({ cost }) => cost.relations[relation]?.rows);
      expect(rows.every((value) => typeof value === 'number')).toBe(true);
      expect(new Set(rows).size).toBe(1);
      const pages = report.samples.at(-1)?.relationSizes[relation]?.relpages;
      if (typeof pages !== 'number') throw new Error(`Missing grown page count for ${relation}`);
      expect(pages).toBeGreaterThan(8);
    }
    assertGrowthAccessPaths(`Native Realm image summary ${axis}`, report.samples, relations);
    // Runner-owned structured profiles retain statements, rows, buffer hits/reads and refusals.
    // No source/audit artifact or promotion claim is generated by this test.
  }
}, 600_000);

async function atFinalAnchor(statement: string, mutate: () => Promise<void>) {
  const trace = observeSql(fixture.db.pool);
  let pending: ReturnType<typeof fixture.read> | undefined;
  let release: (() => void) | undefined;
  try {
    assertAvailable(await fixture.read());
    const records = [...trace.records];
    const last = records.findLastIndex((row) => row.statement === statement);
    expect(last).toBeGreaterThan(0);
    const anchor = records.findLastIndex((row, index) => index < last && row.statement === partitionAnchor.sql);
    expect(anchor).toBeGreaterThanOrEqual(0);
    const occurrence = records.slice(0, anchor + 1).filter((row) => row.statement === partitionAnchor.sql).length;
    // Hold before the final snapshot's first anchor, before it mints authoritative read time.
    const barrier = trace.hold({ statement: partitionAnchor.sql, occurrence }, 'before');
    release = barrier.release;
    pending = fixture.read();
    const reached = await Promise.race([
      barrier.entered,
      pending.then(() => {
        throw new Error('Summary completed without reaching its final native anchor');
      }),
    ]);
    expect(reached.parameters).toEqual(records[anchor]!.parameters);
    await mutate();
    release();
    expect(await pending).toEqual({ avatar: none, banner: none });
  } finally {
    release?.();
    if (pending) await pending.catch(() => undefined);
    await trace.close();
  }
}

test('final native Realm and independent active Space anchors reject changes committed after source images', async () => {
  const { native, realmId, spaceId } = fixture;
  await atFinalAnchor(realmHead.sql, async () => {
    const current = await native.call('GET', `/v1/realms/${realmId}`, { kernel: native.mutationKernel });
    await native.checked('PATCH', `/v1/realms/${realmId}`, { summary: 'Changed after the image source anchor' }, 200, {
      kernel: native.mutationKernel,
      headers: { 'if-match': JSON.stringify(current.value.realm.headRevisionId) },
    });
  });
  // Current read loss is independent of the Realm/media head signatures.
  try {
    await atFinalAnchor(realmHead.sql, async () => {
      await native.revoke(realmId, native.bob.accountId, ['realm:read']);
    });
  } finally {
    await native.grant(native.bob.accountId, realmId, ['realm:read']);
  }
  await atFinalAnchor(spaceHead.sql, async () => {
    const current = await native.call('GET', `/v1/spaces/${spaceId}`, { kernel: native.mutationKernel });
    expect(current.response.status).toBe(200);
    const lifecycle = await native.call('GET', `/v1/spaces/${spaceId}/lifecycle`, { kernel: native.mutationKernel });
    expect(lifecycle.response.status).toBe(200);
    await native.checked(
      'POST',
      `/v1/spaces/${spaceId}/removal`,
      {
        expectedVersion: lifecycle.value.container.version,
        reason: 'Independent host removal',
      },
      200,
      { kernel: native.mutationKernel, headers: { 'if-match': JSON.stringify(current.value.space.headRevisionId) } },
    );
  });
  expect(await fixture.read()).toEqual({ avatar: none, banner: none });
}, 600_000);
