import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { RankingGenerations } from '../src/modules/recommendation/ranking.ts';
import { RecommendationUnavailable } from '../src/modules/recommendation/derived-generation.ts';
import { discoveryRankingHealth, readDiscoveryRankingHealth }
  from '../src/modules/discovery/public-ranking.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const target = native();
const receipt = { action: 'rating.observation.set', outcome: 'succeeded', target, realm: native(),
  ratingSlot: `urn:rezics:rating-slot:${'a'.repeat(64)}`, ratingObservation: native(),
  admissionId: randomUUID(), requestDigest: 'a'.repeat(64), authorityEpoch: '1',
  ratingAvailability: 'available', ratingValue: 8 };

function builder(receipts: Record<string, unknown>[], resolve: (targets: readonly string[]) => Promise<string[]>) {
  const failures: string[] = [];
  const client = { release: () => {}, query: async (sql: string) => {
    if (sql.includes('recovery_fence')) return { rows: [{ open: true }], rowCount: 1 };
    if (sql.includes('UPDATE access.derived_generation_input')) return { rows: [{ complete: true }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const access = { connect: async () => client, query: async () => ({ rows: [{ population: 'public',
    partition_count: 1, data_epoch: 'epoch', checkpoint: '0', target: '1', zero_snapshot: '17' }] }) } as unknown as Pool;
  const relay = { query: async (sql: string) => ({ rows: sql.includes('delivered_batch')
    ? [{ sequence: '1', event_count: receipts.length }]
    : receipts.map((item, ordinal) => ({ sequence: '1', event_id: `event-${ordinal}`,
      envelope: { type: 'com.rezics.rating.observation-changed.v1', data: { ordinal, receipt: item } } })) }) } as unknown as Pool;
  const rankings = new RankingGenerations({ access, relay, dataEpoch: 'epoch', cursorKey: new Uint8Array(32),
    canReadWork: async () => true, zeroCandidates: async (after, snapshot, limit, targets) => {
      expect(after).toBeNull(); expect(snapshot).toBe('17'); expect(limit).toBe(targets!.length);
      return resolve(targets!);
    } });
  rankings.fail = async (_generation, _lease, reason) => { failures.push(reason); };
  return { rankings, failures };
}

test('target receipt validation rejects malformed identities, conflicting forms and malformed values before kind exclusion', async () => {
  for (const malformed of [
    { target: null }, { target: 'not-an-iri' }, { work: native() }, { main: native() },
    { ratingSlot: 'bad-slot' }, { ratingValue: 11 }, { ratingValue: 0 }, { ratingValue: 2.5 },
    { ratingAvailability: 'withdrawn' }, { requestDigest: 'bad-digest' }, { admissionId: 'bad-id' },
    { target: undefined, work: undefined },
  ]) {
    let probes = 0;
    const { rankings, failures } = builder([{ ...receipt, ...malformed }], async () => { probes++; return []; });
    expect(await rankings.runBatch('generation', '1')).toMatchObject({ failed: 'source-invalid', checkpoint: '0' });
    expect(failures).toEqual(['source-invalid at 1']); expect(probes).toBe(0);
  }
});

test('non-Work targets share one deduplicated pinned population query and advance the checkpoint', async () => {
  let probes = 0;
  const { rankings, failures } = builder([receipt, { ...receipt, ratingAvailability: 'withdrawn', ratingValue: undefined }],
    async targets => { probes++; expect(targets).toEqual([target]); return []; });
  expect(await rankings.runBatch('generation', '1')).toEqual({ relayBatches: 1, signals: 0, checkpoint: '1', snapshotComplete: true });
  expect(probes).toBe(1); expect(failures).toEqual([]);
});

test('a target kind source outage retries with the original cause instead of dropping the receipt', async () => {
  const cause = new Error('graph unavailable');
  const { rankings, failures } = builder([receipt], async () => { throw cause; });
  await expect(rankings.runBatch('generation', '1')).rejects.toBeInstanceOf(RecommendationUnavailable);
  await expect(rankings.runBatch('generation', '1')).rejects.toMatchObject({ cause });
  expect(failures).toEqual([]);
});

test('readiness surfaces failed bootstrap and stale rebuilds while a diagnostic outage preserves serving availability', async () => {
  const position = { dataEpoch: 'epoch', sequence: '2' }, generation = randomUUID();
  const failure = { generation: randomUUID(), reason: 'source-invalid at 2' };
  const recommendations = { publicRankingStatus: async () => null as { generation: string; dataEpoch: string; sequence: string } | null,
    publicRankingBuildFailure: async () => failure };
  const session = { position, deps: { recommendations } } as unknown as WorkReadSession;
  const bootstrap = await readDiscoveryRankingHealth(session);
  expect(Value.Check(discoveryRankingHealth, bootstrap)).toBe(true);
  expect(bootstrap).toMatchObject({ status: 'unavailable', generation: null, buildFailure: failure });
  recommendations.publicRankingStatus = async () => ({ generation, dataEpoch: 'epoch', sequence: '1' });
  expect(await readDiscoveryRankingHealth(session)).toMatchObject({ status: 'ready', sequenceLag: '1', buildFailure: failure });
  recommendations.publicRankingBuildFailure = async () => { throw new Error('diagnostic unavailable'); };
  expect(await readDiscoveryRankingHealth(session)).toMatchObject({ status: 'ready', buildFailure: null });
});


test('public build diagnostics retain the last failure during the single pending retry and clear after a ready replacement', async () => {
  const failed = { generation: randomUUID(), state: 'failed', reason: 'source-invalid at 42' };
  let recent = [failed];
  let probes = 0;
  const client = { release: () => {}, query: async (sql: string, values?: unknown[]) => {
    if (sql.includes('recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('failure_reason')) {
      probes++;
      expect(sql).toContain('ORDER BY created_at DESC,id');
      expect(values?.[1]).toBe(2);
      return { rows: recent };
    }
    return { rows: [] };
  } };
  const rankings = new RankingGenerations({ access: { connect: async () => client } as unknown as Pool,
    relay: {} as Pool, dataEpoch: 'epoch', cursorKey: new Uint8Array(32), canReadWork: async () => true });
  expect(await rankings.publicRankingBuildFailure()).toEqual({ generation: failed.generation, reason: failed.reason });
  recent = [{ generation: randomUUID(), state: 'building', reason: '' }, failed];
  expect(await rankings.publicRankingBuildFailure()).toEqual({ generation: failed.generation, reason: failed.reason });
  recent[0]!.state = 'ready';
  expect(await rankings.publicRankingBuildFailure()).toBeNull();
  expect(probes).toBe(3);
});
