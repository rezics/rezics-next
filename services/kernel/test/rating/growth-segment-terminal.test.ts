import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readRatingEligibilityJob } from '../../src/rating/eligibility.ts';
import { readRatingSegmentJob } from '../../src/rating/segment-job.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { checkGrowth, measure, seed, type Population } from '../support/growth.ts';
import { id, openTerminalGrowthFixture, type TerminalGrowthFixture } from './support/growth-segment-terminal-fixture.ts';

const scales: [number, number, number] = [256, 1024, 4096];
let fixture: TerminalGrowthFixture;

beforeAll(async () => {
  fixture = await openTerminalGrowthFixture();
}, 300_000);

afterAll(async () => {
  await fixture?.close();
});

function unrelatedVotes(f: TerminalGrowthFixture, namespace: 'segment' | 'eligibility'): Population {
  const voterBase = namespace === 'segment' ? 0x40000000 : 0x41000000;
  const transactionBase = namespace === 'segment' ? 0x50000000 : 0x51000000;
  return {
    name: `unrelated ${namespace} rating voters and votes`,
    hotPartition: f.partition,
    hotShare: 1,
    rows: ({ ordinal }) => {
      const voterId = id(voterBase + ordinal);
      return {
        'access.account': [
          { route: f.route, account_id: voterId, kind: 'actor', state: 'active', transaction_id: voterId },
        ],
        'rating.vote': [
          {
            route: f.route,
            voter_id: voterId,
            question_id: STANDARD_QUESTION_ID,
            target_id: f.targetIds[99],
            units: ordinal % 21,
            revision: 1,
            changed_at: '2026-10-27T10:00:00.000Z',
            transaction_id: id(transactionBase + ordinal),
          },
        ],
      };
    },
  };
}

function retainedCommandHistory(f: TerminalGrowthFixture, namespace: 'segment' | 'eligibility'): Population {
  const historyBase = namespace === 'segment' ? 0x60000000 : 0x61000000;
  const positionBase = namespace === 'segment' ? 1_000_000 : 2_000_000;
  return {
    name: `unrelated retained ${namespace} rating transition and command history`,
    hotPartition: f.partition,
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'core.receipt': [
        {
          partition_no: f.partition,
          principal_id: f.ids.history,
          principal_kind: 'account',
          command_kind: ordinal % 2 ? 'rating.voter-realm.membership' : 'rating.voter-eligibility.event',
          idempotency_key: `retained-terminal-history-${namespace}-${ordinal}`,
          request_digest: Buffer.alloc(32, 0x42),
          epoch: 1,
          position: positionBase + ordinal,
          transaction_id: id(historyBase + ordinal),
          response: { retained: true },
        },
      ],
    }),
  };
}

function assertTerminal(pages: readonly { votes: unknown[]; direction: string }[], direction: 'adding' | 'removing') {
  expect(pages.map(({ votes }) => votes.length)).toEqual([100, 0]);
  expect(pages.map(({ direction: value }) => value)).toEqual([direction, direction]);
}

async function assertAggregateEffects(f: TerminalGrowthFixture, pages: readonly { position: string }[]) {
  for (const page of pages) expect(await f.registeredAggregateEffect(page.position)).toBe(true);
}

async function assertSettled(f: TerminalGrowthFixture, voterId: string, kind: 'realm' | 'eligibility') {
  if (kind === 'realm')
    expect(await readRatingSegmentJob(f.database.admin, { voterId, realmId: f.realmId })).toBeNull();
  else expect(await readRatingEligibilityJob(f.database.admin, { voterId })).toBeNull();
}

function assertBounds(report: Awaited<ReturnType<typeof checkGrowth>>) {
  expect(report.samples.map(({ scale }) => scale)).toEqual(scales);
  expect(report.verdicts.rows.outcome).toBe('compatible');
  expect(report.verdicts.blocks.outcome).toBe('compatible');
  expect(report.verdicts.statements.outcome).toBe('compatible');
  expect(report.samples.every(({ cost }) => cost.statements > 0 && cost.rows > 0)).toBe(true);
}

async function measureRealmAddition(
  f: TerminalGrowthFixture,
  population: Population,
  name: string,
): Promise<Awaited<ReturnType<typeof checkGrowth>>> {
  if ((await f.selectedNeighbourhood(f.ids.segment)).memberships > 0)
    assertTerminal(await f.removeRealmMembership(f.ids.segment), 'removing');
  expect((await f.selectedNeighbourhood(f.ids.segment)).memberships).toBe(0);
  let selectedJoined = false;
  const selected = f.ids.segment;
  const warmup = f.ids.segmentWarmup;
  return checkGrowth(f.database, {
    name,
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (database, scale, previous) =>
      seed({ pool: database.pool, admin: database.admin }, population, { from: previous, to: scale }),
    prepare: async () => {
      if (!selectedJoined) return;
      assertTerminal(await f.removeRealmMembership(selected), 'removing');
      selectedJoined = false;
    },
    warmup: async () => {
      assertTerminal(await f.addRealmMembership(warmup), 'adding');
      assertTerminal(await f.removeRealmMembership(warmup), 'removing');
    },
    operation: async () => {
      const pages = await f.addRealmMembership(selected);
      assertTerminal(pages, 'adding');
      await assertAggregateEffects(f, pages);
      await assertSettled(f, selected, 'realm');
      const neighbourhood = await f.selectedNeighbourhood(selected);
      expect(neighbourhood.memberships).toBe(1);
      const beforeReplay = await f.readAggregate(f.realmId, f.targetIds[0]!);
      expect(beforeReplay).toMatchObject({ count: 3n, sum: 3n, updating: false });
      await f.replayFirstPage(selected, pages[0]!.position, f.realmId, f.targetIds[0]!, beforeReplay);
      expect(await f.checkpoint()).toBeGreaterThanOrEqual(BigInt(pages[1]!.position));
      selectedJoined = true;
      return pages;
    },
    repetitions: 1,
    warmups: 1,
  });
}

async function measureEligibilityRemoval(
  f: TerminalGrowthFixture,
  population: Population,
  name: string,
): Promise<Awaited<ReturnType<typeof checkGrowth>>> {
  const state = await f.database.admin.query<{ state: string }>(
    `SELECT state FROM access.account WHERE route = $1 AND account_id = $2`,
    [f.route, f.ids.eligibility],
  );
  if (state.rows[0]?.state === 'suspended') assertTerminal(await f.reinstate(f.ids.eligibility), 'adding');
  let selectedEligible = true;
  const selected = f.ids.eligibility;
  const warmup = f.ids.eligibilityWarmup;
  return checkGrowth(f.database, {
    name,
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (database, scale, previous) =>
      seed({ pool: database.pool, admin: database.admin }, population, { from: previous, to: scale }),
    prepare: async () => {
      if (selectedEligible) return;
      assertTerminal(await f.reinstate(selected), 'adding');
      selectedEligible = true;
    },
    warmup: async () => {
      assertTerminal(await f.suspend(warmup), 'removing');
      assertTerminal(await f.reinstate(warmup), 'adding');
    },
    operation: async () => {
      const beforeNeighborhood = await f.selectedNeighbourhood(selected);
      expect(beforeNeighborhood.memberships).toBe(1);
      expect(beforeNeighborhood.populations).toEqual([f.globalPopulationId, f.realmId]);
      const pages = await f.suspend(selected);
      assertTerminal(pages, 'removing');
      await assertAggregateEffects(f, pages);
      await assertSettled(f, selected, 'eligibility');
      const afterNeighborhood = await f.selectedNeighbourhood(selected);
      expect(afterNeighborhood.memberships).toBe(1);
      expect(afterNeighborhood.populations).toEqual([f.globalPopulationId, f.realmId]);
      const beforeReplay = await f.readAggregate(f.globalPopulationId, f.targetIds[0]!);
      expect(beforeReplay).toMatchObject({ count: 3n, sum: 3n, updating: false });
      await f.replayFirstPage(selected, pages[0]!.position, f.globalPopulationId, f.targetIds[0]!, beforeReplay);
      expect(await f.checkpoint()).toBeGreaterThanOrEqual(BigInt(pages[1]!.position));
      selectedEligible = false;
      return pages;
    },
    repetitions: 1,
    warmups: 1,
  });
}

test('registered segment and eligibility terminal/replay work stays bounded as unrelated votes and retained history grow', async () => {
  const reports = [
    await measureRealmAddition(fixture, unrelatedVotes(fixture, 'segment'), 'rating segment terminal and replay with unrelated votes'),
    await measureRealmAddition(fixture, retainedCommandHistory(fixture, 'segment'), 'rating segment terminal and replay with retained history'),
    await measureEligibilityRemoval(fixture, unrelatedVotes(fixture, 'eligibility'), 'rating eligibility terminal and replay with unrelated votes'),
    await measureEligibilityRemoval(fixture, retainedCommandHistory(fixture, 'eligibility'), 'rating eligibility terminal and replay with retained history'),
  ];
  reports.forEach(assertBounds);
  console.log(
    'rating-segment-terminal-growth',
    JSON.stringify(
      reports.map((report) => ({
        name: report.name,
        samples: report.samples.map(({ scale, cost }) => ({
          scale,
          rows: cost.rows,
          blocks: cost.blocks,
          statements: cost.statements,
          sharedHit: cost.sharedHit,
          sharedRead: cost.sharedRead,
        })),
      })),
    ),
  );
}, 600_000);

test('an initially empty Realm voter settles with one empty page', async () => {
  const measured = await measure(fixture.database, () => fixture.addRealmMembership(fixture.ids.empty));
  expect(measured.value.map(({ votes }) => votes.length)).toEqual([0]);
  expect(measured.value.map(({ direction }) => direction)).toEqual(['adding']);
  await assertAggregateEffects(fixture, measured.value);
  await assertSettled(fixture, fixture.ids.empty, 'realm');
  expect(measured.cost.rows).toBeGreaterThan(0);
  expect(measured.cost.statements).toBeGreaterThan(0);
  expect(measured.cost.sharedHit + measured.cost.sharedRead).toBeGreaterThan(0);
  expect(await fixture.checkpoint()).toBeGreaterThanOrEqual(BigInt(measured.value[0]!.position));
}, 120_000);
