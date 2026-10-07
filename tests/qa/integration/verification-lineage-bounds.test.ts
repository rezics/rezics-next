import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { migrationVersion, schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { LINEAGE_BUDGET, LINEAGE_EDGE_BUDGET, analyzeClaimSupport,
  type Availability } from '../../../services/main/src/modules/verification/analysis.ts';
import { VerificationMissing, VerificationStale, VerificationStore, nativeId, uuidOf,
  type AnalysisSnapshot, type WalkAuthority } from '../../../services/main/src/modules/verification/store.ts';

let pool: Pool;

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL) {
    throw new Error('Run through the isolated integration tier');
  }
  pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 6 });
  await migrateContent(pool);
});

afterAll(async () => { await pool?.end(); });

async function observations(count: number, principal = randomUUID(), database = pool) {
  const record = randomUUID();
  const ids = Array.from({ length: count }, () => randomUUID());
  await database.query(`INSERT INTO source.record (id, provider, namespace, external_id)
    VALUES ($1, 'fixture', 'verification-walk', $2)`, [record, record]);
  await database.query(`INSERT INTO source.observation (id, record_id, principal_id, media_type,
    retention, coverage, rights_evidence)
    SELECT id, $2::uuid, $3::uuid, 'application/json', 'not-retained', '{}', '{}'
    FROM unnest($1::uuid[]) AS id`, [ids, record, principal]);
  return { principal, ids };
}

// Observe the owner adapter's indexed, single-candidate journal reads, including
// empty seeks and snapshot holes, rather than deriving work from a global sequence.
function measuredStore() {
  const queries: string[] = [];
  const measured = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql: string, values?: unknown[]) => {
          queries.push(sql);
          return client.query(sql, values);
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
  return { store: new VerificationStore(measured), queries };
}

function boundedFreshness(queries: string[]) {
  const seeks = queries.filter(sql => /FROM verification\.invalidation i/.test(sql));
  expect(seeks.length).toBeLessThanOrEqual(LINEAGE_EDGE_BUDGET + 4);
  for (const sql of seeks) {
    expect(sql).toMatch(/LIMIT 1/);
    expect(sql).toMatch(/stream_principal|local_sequence/);
  }
  return seeks.length;
}

function walkWithoutFreshness(walk: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(walk).filter(([key]) => !key.startsWith('freshness_')
    && key !== 'validated_sequence' && key !== 'version'));
}

function authority(principal: string): WalkAuthority {
  return { principal, actingSubject: nativeId(principal), scope: 'urn:rezics:verification:walk-fixture',
    authorityEpoch: randomUUID(), requestDigest: randomUUID() };
}

async function evidence(store: VerificationStore, principal: string, roots: string[]) {
  const claim = nativeId(randomUUID());
  const recorded = await store.recordEvidence(principal, randomUUID(), claim, {
    claimRevision: nativeId(randomUUID()), expectedHead: null,
    items: roots.map((observation, ordinal) => ({ observation, stance: ordinal === 0 ? 'supports' : 'uncertain',
      availability: 'available', selector: {} })),
  });
  return { claim, revision: uuidOf(recorded.evidence.revision)! };
}

async function edge(store: VerificationStore, principal: string, observation: string,
  target: { observation?: string; origin?: string }, relation = 'copy-of') {
  const result = await store.recordLineage(principal, randomUUID(), observation, {
    relation, target, basis: 'declared-by-source', method: null,
  });
  return uuidOf(result.edge)!;
}

async function origin(store: VerificationStore, principal: string) {
  const result = await store.recordOrigin(principal, randomUUID(), {
    kind: 'publication', locator: `urn:rezics:publication:${randomUUID()}`,
  });
  return uuidOf(result.origin)!;
}

function analyze(snapshot: AnalysisSnapshot) {
  return analyzeClaimSupport({
    claim: { referent: 'urn:rezics:walk:subject', context: 'urn:rezics:walk:context',
      predicate: 'urn:rezics:walk:predicate', editionScope: null, validFrom: null, validUntil: null },
    evaluationContext: 'urn:rezics:walk:context',
    items: snapshot.revision.items.map(item => ({ ordinal: item.ordinal, stance: item.stance,
      availability: item.currentAvailability as Availability, observation: item.observation ?? null,
      contentRevision: item.contentRevision ?? null, graphReference: item.graphReference ?? null })),
    links: snapshot.links, truncated: snapshot.truncated, lineageProof: snapshot.lineageProof,
    recordOf: snapshot.recordOf, observedAt: snapshot.observedAt, referencedClaims: new Map(), reliability: [],
  });
}

function bounded(snapshot: AnalysisSnapshot) {
  expect(snapshot.work.expansions).toBeGreaterThanOrEqual(0);
  expect(snapshot.work.expansions).toBeLessThanOrEqual(40);
  expect(snapshot.work.links).toBeGreaterThanOrEqual(0);
  expect(snapshot.work.links).toBeLessThanOrEqual(160);
  expect(snapshot.truncated).toBe(!snapshot.complete);
  if (!snapshot.complete) {
    expect(snapshot.continuation).not.toBeNull();
    expect(snapshot.lineageProof).toEqual({ dependence: 'over-budget', independentOrigins: null, origins: [] });
    expect(analyze(snapshot)).toMatchObject({ support: 'abstained', coverage: 'incomplete',
      dependence: 'over-budget', independentOrigins: null, origins: [] });
  } else expect(snapshot.continuation).toBeNull();
}

function replayed(actual: AnalysisSnapshot, original: AnalysisSnapshot) {
  const { stepReplayed: actualReplay, ...actualResult } = actual;
  const { stepReplayed: originalReplay, ...originalResult } = original;
  expect(actualReplay).toBe(true);
  expect(originalReplay).toBe(false);
  expect(actualResult).toEqual(originalResult);
}

async function walkState(walk: string) {
  return (await pool.query(`SELECT to_jsonb(w) AS walk,
    (SELECT jsonb_agg(to_jsonb(n) ORDER BY n.root_ordinal, n.observation_id)
      FROM verification.lineage_walk_node n WHERE n.walk_id = w.id) AS nodes,
    (SELECT jsonb_agg(o.origin_id ORDER BY o.origin_id)
      FROM verification.lineage_walk_origin o WHERE o.walk_id = w.id) AS origins,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.version)
      FROM verification.lineage_walk_step s WHERE s.walk_id = w.id) AS steps
    FROM verification.lineage_walk w WHERE w.id = $1`, [walk])).rows[0];
}

async function finish(store: VerificationStore, claim: string, revision: string,
  caller: WalkAuthority, first: AnalysisSnapshot) {
  let current = first;
  const sum = { ...first.work };
  bounded(current);
  for (let step = 0; !current.complete && step < 20; step++) {
    current = await store.analysisSnapshot(claim, revision, caller, current.continuation!);
    bounded(current);
    sum.expansions += current.work.expansions;
    sum.links += current.work.links;
    expect(current.totalWork).toEqual(sum);
  }
  expect(current.complete).toBe(true);
  const durable = await pool.query<{ nodes: number; expansions: number; links: number }>(`
    SELECT (SELECT count(*)::int FROM verification.lineage_walk_node WHERE walk_id = w.id) AS nodes,
      w.expansions::int AS expansions, w.edges::int AS links
    FROM verification.lineage_walk w WHERE w.id = $1`, [current.walk]);
  expect(durable.rows[0]).toEqual({ nodes: sum.expansions, ...sum });
  return current;
}

async function chain(length: number, cycle = false, extraRoot = false) {
  const fixture = await observations(length + Number(extraRoot));
  const store = new VerificationStore(pool);
  const edges: string[] = [];
  for (let index = 0; index < length - 1; index++) {
    edges.push(await edge(store, fixture.principal, fixture.ids[index]!, { observation: fixture.ids[index + 1]! }));
  }
  const publication = cycle ? null : await origin(store, fixture.principal);
  edges.push(await edge(store, fixture.principal, fixture.ids[length - 1]!,
    cycle ? { observation: fixture.ids[0]! } : { origin: publication! },
    cycle ? 'copy-of' : 'publishes-origin'));
  const manifest = await evidence(store, fixture.principal,
    extraRoot ? [fixture.ids[0]!, fixture.ids[length]!] : [fixture.ids[0]!]);
  return { ...fixture, ...manifest, store, edges, publication, caller: authority(fixture.principal) };
}

test('lineage fan-out counts retracted candidates, survives unrelated growth, and durably replays concurrent resumes', async () => {
  const fixture = await observations(1);
  const root = fixture.ids[0]!;
  const store = new VerificationStore(pool);
  const candidateCount = 205;
  const retractedCount = 31;
  for (let index = 0; index < candidateCount; index++) {
    const publication = await origin(store, fixture.principal);
    const recorded = await edge(store, fixture.principal, root, { origin: publication }, 'publishes-origin');
    if (index < retractedCount) {
      await store.retractLineage(fixture.principal, randomUUID(), recorded, 'Publication attribution withdrawn');
    }
  }
  const manifest = await evidence(store, fixture.principal, [root]);
  const caller = authority(fixture.principal);
  const startKey = randomUUID();
  const first = await store.analysisSnapshot(manifest.claim, manifest.revision, caller, undefined, startKey);
  bounded(first);
  expect(first.stepReplayed).toBe(false);
  expect(first.complete).toBe(false);
  expect(first.work).toEqual({ expansions: 1, links: LINEAGE_EDGE_BUDGET });
  expect(first.totalWork).toEqual(first.work);

  // Neither population growth nor other observations' heads change this walk's basis.
  const unrelated = await observations(1_000, fixture.principal);
  const unrelatedOrigin = await origin(store, fixture.principal);
  for (const observation of unrelated.ids.slice(0, 45)) {
    await edge(store, fixture.principal, observation, { origin: unrelatedOrigin }, 'publishes-origin');
  }
  await store.recordObservationDisposition(fixture.principal, randomUUID(), unrelated.ids[0]!, {
    expectedHead: null, state: 'withdrawn', reason: 'Unrelated source withdrawn',
  });
  replayed(await new VerificationStore(pool).analysisSnapshot(manifest.claim, manifest.revision,
    caller, undefined, startKey), first);

  const plan = await pool.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
    SELECT e.id, EXISTS (SELECT 1 FROM verification.lineage_retraction r WHERE r.edge_id = e.id) AS retracted
    FROM verification.lineage_edge e WHERE e.observation_id = $1 AND e.relation = 'publishes-origin'
      AND e.id > '00000000-0000-0000-0000-000000000000'::uuid ORDER BY e.id LIMIT 1`, [root]);
  expect(JSON.stringify(plan.rows[0]!['QUERY PLAN'])).toMatch(/lineage_(publication|edge)_seek/);
  await expect(store.analysisSnapshot(manifest.claim, manifest.revision, caller, first.continuation!, startKey, true))
    .rejects.toBeInstanceOf(VerificationStale);

  // Failing the final step receipt must roll back frontier, counters and discovered origins together.
  const beforeFailure = await walkState(first.walk);
  const failureHook = `lineage_walk_failure_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE FUNCTION verification.${failureHook}() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected lineage step failure'; END $$`);
  try {
    await pool.query(`CREATE TRIGGER ${failureHook} BEFORE INSERT ON verification.lineage_walk_step
      FOR EACH ROW WHEN (NEW.walk_id = '${first.walk}'::uuid)
      EXECUTE FUNCTION verification.${failureHook}()`);
    try {
      await expect(store.analysisSnapshot(manifest.claim, manifest.revision, caller, first.continuation!))
        .rejects.toThrow('injected lineage step failure');
      expect(await walkState(first.walk)).toEqual(beforeFailure);
    } finally {
      await pool.query(`DROP TRIGGER ${failureHook} ON verification.lineage_walk_step`);
    }
  } finally {
    await pool.query(`DROP FUNCTION verification.${failureHook}()`);
  }

  // A fresh adapter and simultaneous clients share the committed input step.
  const token = first.continuation!;
  const results = await Promise.all([
    new VerificationStore(pool).analysisSnapshot(manifest.claim, manifest.revision, caller, token),
    new VerificationStore(pool).analysisSnapshot(manifest.claim, manifest.revision, caller, token),
  ]);
  const resumed = results.find(result => !result.stepReplayed)!;
  const concurrent = results.find(result => result.stepReplayed)!;
  expect(resumed).toBeDefined();
  expect(concurrent).toBeDefined();
  replayed(concurrent, resumed);
  replayed(await new VerificationStore(pool).analysisSnapshot(manifest.claim, manifest.revision, caller, token), resumed);
  const beforeRead = await walkState(resumed.walk);
  const readOnly = await store.analysisSnapshot(manifest.claim, manifest.revision, caller, undefined, startKey, true);
  replayed(readOnly, resumed);
  const afterRead = await walkState(resumed.walk);
  expect(afterRead.nodes).toEqual(beforeRead.nodes);
  expect(afterRead.origins).toEqual(beforeRead.origins);
  expect(afterRead.steps).toEqual(beforeRead.steps);
  expect(walkWithoutFreshness(afterRead.walk)).toEqual(walkWithoutFreshness(beforeRead.walk));
  bounded(resumed);
  expect(resumed.work).toEqual({ expansions: 0, links: candidateCount - LINEAGE_EDGE_BUDGET });
  expect(resumed.complete).toBe(true);
  expect(resumed.totalWork).toEqual({ expansions: 1, links: candidateCount });
  expect(resumed.lineageProof.dependence).toBe('established');
  expect(resumed.lineageProof.independentOrigins).toBe(candidateCount - retractedCount);
  expect(resumed.lineageProof.origins).toHaveLength(32);
  expect(analyze(resumed)).toMatchObject({ support: 'supported', coverage: 'complete',
    dependence: 'established', independentOrigins: candidateCount - retractedCount });
  const durable = await pool.query<{ steps: number; nodes: number; origins: number; links: number }>(`
    SELECT (SELECT count(*)::int FROM verification.lineage_walk_step WHERE walk_id = w.id) AS steps,
      (SELECT count(*)::int FROM verification.lineage_walk_node WHERE walk_id = w.id) AS nodes,
      (SELECT count(*)::int FROM verification.lineage_walk_origin WHERE walk_id = w.id) AS origins,
      w.edges::int AS links FROM verification.lineage_walk w WHERE w.id = $1`, [resumed.walk]);
  expect(durable.rows[0]).toEqual({ steps: 2, nodes: 1, origins: candidateCount - retractedCount, links: candidateCount });
}, 90_000);

test('a lineage chain longer than sixty observations completes across bounded steps', async () => {
  const fixture = await chain(73);
  const first = await fixture.store.analysisSnapshot(fixture.claim, fixture.revision, fixture.caller);
  expect(first.complete).toBe(false);
  expect(first.work.expansions).toBe(LINEAGE_BUDGET);
  const complete = await finish(new VerificationStore(pool), fixture.claim, fixture.revision, fixture.caller, first);
  expect(complete.totalWork).toEqual({ expansions: 73, links: 73 });
  expect(complete.lineageProof).toEqual({ dependence: 'established', independentOrigins: 1,
    origins: [`origin:${fixture.publication}`] });

  // One durable walk dependency covers more lineage/disposition heads than the summary manifest ceiling.
  const context = `urn:rezics:walk-summary:${randomUUID()}`;
  const analysis = analyze(complete);
  const activated = await fixture.store.activateSummary({
    target: fixture.claim, context, claim: fixture.claim, claimRevision: complete.revision.claimRevision,
    adoptedRevision: null, assessment: nativeId(randomUUID()), policyRevision: 'urn:rezics:walk-summary-policy:v1',
    support: analysis.support, review: 'unreviewed', coverage: analysis.coverage, dependence: analysis.dependence,
    reasons: analysis.reasons, dependencies: [{ owner: 'content', kind: 'lineage-walk',
      reference: complete.walk, expectedHead: complete.walk }], ownerPositions: {},
    operationKey: randomUUID(), expectedActive: null, observedDemand: null, openChallenges: 0, resolvedChallenges: 0,
  });
  expect(activated.status).toBe('activated');
  const current = await fixture.store.readSummary(fixture.claim, context);
  expect(current?.dependencies).toEqual([{ owner: 'content', kind: 'lineage-walk',
    reference: complete.walk, expectedHead: complete.walk, currentHead: complete.walk }]);
  expect(current?.pendingWork).toBe(false);
  await fixture.store.retractLineage(fixture.principal, randomUUID(), fixture.edges.at(-1)!, 'Original attribution withdrawn');
  const stale = await fixture.store.readSummary(fixture.claim, context);
  expect(stale?.dependencies[0]).toMatchObject({ expectedHead: complete.walk, currentHead: null });
  expect(stale?.pendingWork).toBe(true);
  let demand = await fixture.store.reassessmentDemand(fixture.claim, context);
  for (let batch = 0; !demand && batch < 100; batch++) {
    const page = await fixture.store.processInvalidations('verification-walk-summary', { pageSize: 200, maxPages: 20 });
    demand = await fixture.store.reassessmentDemand(fixture.claim, context);
    if (page.pages === 0) break;
  }
  expect(demand).not.toBeNull();
  expect((await fixture.store.readSummary(fixture.claim, context))?.pendingWork).toBe(true);
}, 90_000);

test('lineage and derivation inputs share a DAG and suppress dependent observations own publication origins', async () => {
  const fixture = await observations(4);
  const [root, first, second, shared] = fixture.ids as [string, string, string, string];
  const store = new VerificationStore(pool);
  const publication = await origin(store, fixture.principal);
  await edge(store, fixture.principal, shared, { origin: publication }, 'publishes-origin');
  await edge(store, fixture.principal, root, { observation: first });
  await edge(store, fixture.principal, first, { observation: shared });
  await edge(store, fixture.principal, second, { observation: shared });
  for (const dependent of [root, first, second]) {
    await edge(store, fixture.principal, dependent, { origin: await origin(store, fixture.principal) }, 'publishes-origin');
  }
  await store.recordDerivation(fixture.principal, randomUUID(), root, {
    kind: 'tool-extraction', method: 'urn:rezics:walk:fixture-extraction', model: null,
    toolVersion: '1', profileRevision: null, limitations: 'Fixture extraction retains shared provenance',
    inputs: [{ observation: first }, { observation: second }],
  });
  const manifest = await evidence(store, fixture.principal, [root]);
  const caller = authority(fixture.principal);
  const firstStep = await store.analysisSnapshot(manifest.claim, manifest.revision, caller);
  const complete = await finish(store, manifest.claim, manifest.revision, caller, firstStep);
  expect(complete.totalWork).toEqual({ expansions: 4, links: 6 });
  expect(complete.lineageProof).toEqual({ dependence: 'established', independentOrigins: 1,
    origins: [`origin:${publication}`] });
}, 90_000);

test('a cycle beyond the first node budget terminates without establishing independence', async () => {
  const fixture = await chain(67, true);
  const first = await fixture.store.analysisSnapshot(fixture.claim, fixture.revision, fixture.caller);
  expect(first.complete).toBe(false);
  const complete = await finish(fixture.store, fixture.claim, fixture.revision, fixture.caller, first);
  expect(complete.totalWork).toEqual({ expansions: 67, links: 67 });
  expect(complete.lineageProof).toEqual({ dependence: 'circular', independentOrigins: null, origins: [] });
  expect(analyze(complete)).toMatchObject({ support: 'abstained', coverage: 'incomplete', dependence: 'circular' });
}, 90_000);

for (const change of ['retraction', 'new-lineage-head', 'new-disposition-head', 'evidence-head'] as const) {
  test(`a partial lineage continuation becomes stale after ${change}`, async () => {
    const fixture = await chain(61, false, true);
    const first = await fixture.store.analysisSnapshot(fixture.claim, fixture.revision, fixture.caller);
    bounded(first);
    expect(first.complete).toBe(false);
    const absentRoot = fixture.ids[61]!;
    const pinned = await pool.query<{ lineage_head: string | null; disposition_head: string | null }>(`
      SELECT lineage_head, disposition_head FROM verification.lineage_walk_observation
      WHERE walk_id = $1 AND observation_id = $2`, [first.walk, absentRoot]);
    expect(pinned.rows[0]).toEqual({ lineage_head: null, disposition_head: null });
    if (change === 'retraction') {
      await fixture.store.retractLineage(fixture.principal, randomUUID(), fixture.edges[0]!, 'Source link withdrawn');
    } else if (change === 'new-lineage-head') {
      await edge(fixture.store, fixture.principal, absentRoot, { origin: fixture.publication! }, 'publishes-origin');
    } else if (change === 'new-disposition-head') {
      await fixture.store.recordObservationDisposition(fixture.principal, randomUUID(), absentRoot, {
        expectedHead: null, state: 'withdrawn', reason: 'Previously available source withdrawn',
      });
    } else {
      await fixture.store.recordEvidence(fixture.principal, randomUUID(), fixture.claim, {
        claimRevision: nativeId(randomUUID()), expectedHead: fixture.revision,
        items: [{ observation: fixture.ids[0]!, stance: 'supports', availability: 'available', selector: {} }],
      });
    }
    await expect(new VerificationStore(pool).analysisSnapshot(fixture.claim, fixture.revision,
      fixture.caller, first.continuation!)).rejects.toBeInstanceOf(VerificationStale);
    // Even replay of a committed partial response must reject a changed basis.
    await expect(fixture.store.analysisSnapshot(fixture.claim, fixture.revision, fixture.caller))
      .rejects.toBeInstanceOf(VerificationStale);
  }, 90_000);
}

test('continuations bind exact evidence and all caller authority fields', async () => {
  const fixture = await chain(61);
  const first = await fixture.store.analysisSnapshot(fixture.claim, fixture.revision, fixture.caller);
  expect(first.complete).toBe(false);
  for (const field of ['principal', 'actingSubject', 'scope', 'authorityEpoch', 'requestDigest'] as const) {
    const changed = { ...fixture.caller, [field]: randomUUID() };
    await expect(fixture.store.analysisSnapshot(fixture.claim, fixture.revision, changed, first.continuation!))
      .rejects.toBeInstanceOf(VerificationMissing);
  }
  await expect(fixture.store.analysisSnapshot(nativeId(randomUUID()), fixture.revision,
    fixture.caller, first.continuation!)).rejects.toBeInstanceOf(VerificationMissing);
  await expect(fixture.store.analysisSnapshot(fixture.claim, randomUUID(),
    fixture.caller, first.continuation!)).rejects.toBeInstanceOf(VerificationMissing);
  await expect(fixture.store.analysisSnapshot(fixture.claim, fixture.revision, fixture.caller, 'invalid-token'))
    .rejects.toBeInstanceOf(VerificationMissing);
  await expect(fixture.store.analysisSnapshot(fixture.claim, fixture.revision, fixture.caller,
    `${first.walk}:99999999999999999999999`)).rejects.toBeInstanceOf(VerificationStale);
  await expect(fixture.store.recordEvidence(randomUUID(), randomUUID(), nativeId(randomUUID()), {
    claimRevision: nativeId(randomUUID()), expectedHead: null,
    items: [{ observation: fixture.ids[0]!, stance: 'supports', availability: 'available', selector: {} }],
  })).rejects.toBeInstanceOf(VerificationMissing);
  const next = await fixture.store.analysisSnapshot(fixture.claim, fixture.revision, fixture.caller, first.continuation!);
  bounded(next);
  expect(next.totalWork.expansions).toBeGreaterThan(first.totalWork.expansions);
}, 90_000);

for (const change of ['lineage', 'disposition'] as const) {
  test(`${change} source edits defer walk fan-out to bounded durable pages and reject stale replay immediately`, async () => {
    const fixture = await observations(1);
    const root = fixture.ids[0]!;
    const store = new VerificationStore(pool);
    const manifest = await evidence(store, fixture.principal, [root]);
    const caller = authority(fixture.principal);
    const walks: string[] = [];
    // More than the drain's maximum page size must still be a valid population.
    for (let index = 0; index < 205; index++) {
      const complete = await store.analysisSnapshot(manifest.claim, manifest.revision, caller,
        undefined, randomUUID());
      expect(complete.complete).toBe(true);
      walks.push(complete.walk);
    }
    const owner = `walk-fanout:${randomUUID()}`;
    for (let batch = 0; batch < 100; batch++) {
      const settled = await store.processInvalidations(owner, { pageSize: 200, maxPages: 20 });
      if (settled.pages === 0) break;
      if (batch === 99) throw new Error('prior invalidations did not settle within the fixture budget');
    }
    const publication = change === 'lineage' ? await origin(store, fixture.principal) : null;
    if (change === 'lineage') {
      await edge(store, fixture.principal, root, { origin: publication! }, 'publishes-origin');
    } else {
      await store.recordObservationDisposition(fixture.principal, randomUUID(), root, {
        expectedHead: null, state: 'withdrawn', reason: 'Source withdrawn after proof completion',
      });
    }
    const state = async () => (await pool.query<{ stale: number; walk_events: number; source_events: number }>(`
      SELECT (SELECT count(*)::int FROM verification.lineage_walk_observation
        WHERE walk_id = ANY($1::uuid[]) AND stale) AS stale,
        (SELECT count(*)::int FROM verification.invalidation
          WHERE kind = 'lineage-walk' AND reference = ANY($1::text[])) AS walk_events,
        (SELECT count(*)::int FROM verification.invalidation
          WHERE kind = $2 AND reference = $3) AS source_events`,
    [walks, change === 'lineage' ? 'source-observation' : 'source-disposition', root])).rows[0]!;
    // The source transaction touches no dependent witnesses and emits one local event.
    expect(await state()).toEqual({ stale: 0, walk_events: 0, source_events: 1 });
    for (const walk of [walks[0]!, walks.at(-1)!]) {
      await expect(new VerificationStore(pool).analysisSnapshot(manifest.claim, manifest.revision,
        caller, `${walk}:0`)).rejects.toBeInstanceOf(VerificationStale);
    }
    // A walk pinned after the edit is a fresh proof even while its source event is queued.
    const fresh = await store.analysisSnapshot(manifest.claim, manifest.revision, caller,
      undefined, randomUUID());
    expect(fresh.complete).toBe(true);
    const plan = (await pool.query<{ 'QUERY PLAN': { Plan: Record<string, unknown> }[] }>(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
      SELECT walk_id, lineage_head, disposition_head, stale FROM verification.lineage_walk_observation
      WHERE observation_id = $1 AND walk_id > '00000000-0000-0000-0000-000000000000'::uuid
      ORDER BY walk_id LIMIT 1`, [root])).rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(plan['Actual Rows']).toBe(1);
    expect(JSON.stringify(plan)).toContain('lineage_walk_observation_reverse');
    const first = await store.processInvalidations(owner, { pageSize: 50, maxPages: 1 });
    expect(first).toMatchObject({ pages: 1, rowsRead: 50, completed: 0 });
    const firstState = await state();
    expect(firstState.stale).toBeGreaterThanOrEqual(49);
    expect(firstState.stale).toBeLessThanOrEqual(50);
    expect(firstState.walk_events).toBe(firstState.stale);
    expect(firstState.stale).toBeLessThan(walks.length);
    let settled = false;
    for (let batch = 0; batch < 30; batch++) {
      const page = await new VerificationStore(pool).processInvalidations(owner, { pageSize: 50, maxPages: 20 });
      expect(page.rowsRead).toBeLessThanOrEqual(page.pages * 50);
      if (page.pages === 0) { settled = true; break; }
    }
    expect(settled).toBe(true);
    expect(await state()).toEqual({ stale: 205, walk_events: 205, source_events: 1 });
    const event = (await pool.query<{ state: string; walks_complete: boolean; cursor_walk: string }>(`
      SELECT state, walks_complete, cursor_walk FROM verification.invalidation
      WHERE kind = $1 AND reference = $2`,
    [change === 'lineage' ? 'source-observation' : 'source-disposition', root])).rows[0]!;
    expect(event).toMatchObject({ state: 'complete', walks_complete: true });
    expect(event.cursor_walk).not.toBeNull();
    for (const walk of [walks[0]!, walks.at(-1)!]) {
      await expect(store.analysisSnapshot(manifest.claim, manifest.revision, caller, `${walk}:0`))
        .rejects.toBeInstanceOf(VerificationStale);
    }
    const freshReplay = await new VerificationStore(pool).analysisSnapshot(manifest.claim,
      manifest.revision, caller, `${fresh.walk}:0`);
    replayed(freshReplay, fresh);
    expect((await pool.query<{ stale: boolean }>(`SELECT stale FROM verification.lineage_walk_observation
      WHERE walk_id = $1 AND observation_id = $2`, [fresh.walk, root])).rows[0]?.stale).toBe(false);
    expect((await pool.query(`SELECT 1 FROM verification.invalidation
      WHERE kind = 'lineage-walk' AND reference = $1`, [fresh.walk])).rowCount).toBe(0);
    expect(await store.processInvalidations(owner, { pageSize: 50, maxPages: 1 }))
      .toMatchObject({ pages: 0, rowsRead: 0, marked: 0 });
  }, 90_000);
}

test('completed proof catches up unrelated source changes in bounded pages without replacing its frontier', async () => {
  const fixture = await observations(1);
  const store = new VerificationStore(pool);
  const publication = await origin(store, fixture.principal);
  await edge(store, fixture.principal, fixture.ids[0]!, { origin: publication }, 'publishes-origin');
  const manifest = await evidence(store, fixture.principal, [fixture.ids[0]!]);
  const caller = authority(fixture.principal);
  const complete = await store.analysisSnapshot(manifest.claim, manifest.revision, caller);
  expect(complete.complete).toBe(true);
  expect(complete.lineageProof.dependence).toBe('established');
  const before = await walkState(complete.walk);
  const unrelated = await observations(LINEAGE_EDGE_BUDGET + 1, fixture.principal);
  for (const observation of unrelated.ids) {
    await edge(store, fixture.principal, observation, { origin: publication }, 'publishes-origin');
  }
  const token = `${complete.walk}:0`;
  const measured = measuredStore();
  const partial = await measured.store.analysisSnapshot(manifest.claim, manifest.revision, caller, token);
  bounded(partial);
  expect(partial.complete).toBe(false);
  expect(partial.work).toEqual({ expansions: 0, links: 0 });
  expect(partial.totalWork).toEqual(complete.totalWork);
  expect(boundedFreshness(measured.queries)).toBeGreaterThan(0);
  let current = partial;
  for (let retry = 0; !current.complete && retry < 5; retry++) {
    const resumed = measuredStore();
    current = await resumed.store.analysisSnapshot(manifest.claim, manifest.revision,
      caller, current.continuation!);
    boundedFreshness(resumed.queries);
  }
  expect(current.complete).toBe(true);
  expect(current.work).toEqual({ expansions: 0, links: 0 });
  expect(current.totalWork).toEqual(complete.totalWork);
  expect(current.lineageProof).toEqual(complete.lineageProof);
  const originalReplay = await store.analysisSnapshot(manifest.claim, manifest.revision, caller, token);
  replayed(originalReplay, complete);
  const after = await walkState(complete.walk);
  expect(after.nodes).toEqual(before.nodes);
  expect(after.origins).toEqual(before.origins);
  expect(after.steps).toEqual(expect.arrayContaining(before.steps));
  expect(after.walk.freshness_snapshot).not.toEqual(before.walk.freshness_snapshot);
  expect(after.walk.version).toBeGreaterThanOrEqual(before.walk.version);
  expect(walkWithoutFreshness(after.walk)).toEqual(walkWithoutFreshness(before.walk));
  expect((await pool.query(`SELECT 1 FROM verification.lineage_walk_observation
    WHERE walk_id = $1 AND stale`, [complete.walk])).rowCount).toBe(0);
  expect((await pool.query(`SELECT 1 FROM verification.invalidation
    WHERE kind = 'lineage-walk' AND reference = $1`, [complete.walk])).rowCount).toBe(0);
}, 90_000);

test('a stale proof behind a larger change backlog is refused before the walk fan-out drains', async () => {
  const fixture = await observations(1);
  const store = new VerificationStore(pool);
  const root = fixture.ids[0]!;
  const publication = await origin(store, fixture.principal);
  await edge(store, fixture.principal, root, { origin: publication }, 'publishes-origin');
  const manifest = await evidence(store, fixture.principal, [root]);
  const caller = authority(fixture.principal);
  const complete = await store.analysisSnapshot(manifest.claim, manifest.revision, caller);
  expect(complete.complete).toBe(true);
  const unrelated = await observations(LINEAGE_EDGE_BUDGET + 1, fixture.principal);
  for (const observation of unrelated.ids) {
    await edge(store, fixture.principal, observation, { origin: publication }, 'publishes-origin');
  }
  await store.recordObservationDisposition(fixture.principal, randomUUID(), root, {
    expectedHead: null, state: 'withdrawn', reason: 'Source changed behind queued unrelated edits',
  });
  const plan = (await pool.query<{ 'QUERY PLAN': { Plan: Record<string, unknown> }[] }>(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
    SELECT i.source_xid::text, i.id, i.reference, i.kind FROM verification.invalidation i
    WHERE i.stream_principal = $1 AND i.source_xid IS NOT NULL AND i.source_xid > '0'::xid8
    ORDER BY i.source_xid, i.id LIMIT 1`, [fixture.principal])).rows[0]!['QUERY PLAN'][0]!.Plan;
  expect(plan['Actual Rows']).toBe(1);
  expect(JSON.stringify(plan)).toContain('invalidation_source_stream_order');
  const measured = measuredStore();
  const partial = await measured.store.analysisSnapshot(manifest.claim, manifest.revision, caller, `${complete.walk}:0`);
  bounded(partial);
  expect(partial.complete).toBe(false);
  expect(partial.work).toEqual({ expansions: 0, links: 0 });
  expect(analyze(partial)).toMatchObject({ support: 'abstained', independentOrigins: null, coverage: 'incomplete' });
  expect(boundedFreshness(measured.queries)).toBeGreaterThan(0);
  await expect(new VerificationStore(pool).analysisSnapshot(manifest.claim, manifest.revision,
    caller, partial.continuation!)).rejects.toBeInstanceOf(VerificationStale);
  await expect(store.analysisSnapshot(manifest.claim, manifest.revision, caller, `${complete.walk}:0`))
    .rejects.toBeInstanceOf(VerificationStale);
  // No asynchronous walk mark was needed to refuse both continuation and replay.
  expect((await pool.query(`SELECT 1 FROM verification.lineage_walk_observation
    WHERE walk_id = $1 AND stale`, [complete.walk])).rowCount).toBe(0);
}, 90_000);

async function within<T>(work: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} waited for an unrelated transaction`)), 1_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test('independent source commits pass an active lower xid, and its later commit cannot escape proof freshness', async () => {
  const fixture = await observations(2);
  const [root, unrelated] = fixture.ids as [string, string];
  const store = new VerificationStore(pool);
  const publication = await origin(store, fixture.principal);
  await edge(store, fixture.principal, root, { origin: publication }, 'publishes-origin');
  const latePublication = await origin(store, fixture.principal);
  const manifest = await evidence(store, fixture.principal, [root]);
  const caller = authority(fixture.principal);
  const delayed = await pool.connect();
  let committed = false;
  try {
    await delayed.query('BEGIN');
    const lowerXid = (await delayed.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid;
    const lateEdge = randomUUID();
    const receipt = randomUUID();
    await delayed.query(`INSERT INTO verification.receipt
      (id, principal_id, action, idempotency_key, request_digest, outcome, result_id)
      VALUES ($1, $2, 'lineage.record', $3, $4, 'succeeded', $5)`,
    [receipt, fixture.principal, randomUUID(), createHash('sha256').update(lateEdge).digest('hex'), lateEdge]);
    await delayed.query(`INSERT INTO verification.lineage_edge
      (id, observation_id, relation, target_origin_id, basis, operation_id, principal_id)
      VALUES ($1, $2, 'publishes-origin', $3, 'declared-by-source', $4, $5)`,
    [lateEdge, root, latePublication, receipt, fixture.principal]);

    // The same principal owns both sources, so this fails any principal-wide
    // mutable head as well as the previous site-wide singleton writer.
    await within(edge(store, fixture.principal, unrelated, { origin: publication }, 'publishes-origin'),
      'Independent source commit');
    const higherXid = (await pool.query<{ xid: string }>(`SELECT source_xid::text AS xid
      FROM verification.invalidation WHERE stream_principal = $1 AND reference = $2
        AND source_xid IS NOT NULL ORDER BY source_xid DESC LIMIT 1`,
    [fixture.principal, unrelated])).rows[0]!.xid;
    expect(BigInt(higherXid)).toBeGreaterThan(BigInt(lowerXid));
    const complete = await within(store.analysisSnapshot(manifest.claim, manifest.revision, caller),
      'Proof while a source transaction is active');
    bounded(complete);
    expect(complete.complete).toBe(true);
    expect(complete.lineageProof).toEqual({ dependence: 'established', independentOrigins: 1,
      origins: [`origin:${publication}`] });
    expect((await pool.query<{ active: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM verification.lineage_walk w, pg_snapshot_xip(w.freshness_snapshot::pg_snapshot) AS xid
      WHERE w.id = $1 AND xid = $2::xid8) AS active`, [complete.walk, lowerXid])).rows[0]!.active).toBe(true);

    await delayed.query('COMMIT');
    committed = true;
    // The late event precedes the already-observed B event in xid order. It
    // must remain discoverable through the saved snapshot's active-xid holes.
    await expect(new VerificationStore(pool).analysisSnapshot(manifest.claim, manifest.revision,
      caller, `${complete.walk}:0`)).rejects.toBeInstanceOf(VerificationStale);
    await expect(store.analysisSnapshot(manifest.claim, manifest.revision, caller))
      .rejects.toBeInstanceOf(VerificationStale);
    expect((await pool.query(`SELECT 1 FROM verification.lineage_walk_observation
      WHERE walk_id = $1 AND stale`, [complete.walk])).rowCount).toBe(0);
  } finally {
    if (!committed) await delayed.query('ROLLBACK');
    delayed.release();
  }
}, 90_000);

test('active unrelated xids and other principals source churn do not gate an unchanged completed proof', async () => {
  const fixture = await observations(1);
  const store = new VerificationStore(pool);
  const publication = await origin(store, fixture.principal);
  await edge(store, fixture.principal, fixture.ids[0]!, { origin: publication }, 'publishes-origin');
  const manifest = await evidence(store, fixture.principal, [fixture.ids[0]!]);
  const caller = authority(fixture.principal);
  const active = await pool.connect();
  try {
    await active.query('BEGIN');
    await active.query('SELECT pg_current_xact_id()');
    const complete = await within(store.analysisSnapshot(manifest.claim, manifest.revision, caller),
      'Proof with an unrelated active xid');
    expect(complete.complete).toBe(true);
    const unrelated = await observations(LINEAGE_EDGE_BUDGET + 41);
    const unrelatedPublication = await origin(store, unrelated.principal);
    for (const observation of unrelated.ids) {
      await edge(store, unrelated.principal, observation, { origin: unrelatedPublication }, 'publishes-origin');
    }
    const measured = measuredStore();
    const replay = await within(measured.store.analysisSnapshot(manifest.claim, manifest.revision,
      caller, `${complete.walk}:0`), 'Unchanged proof replay during other-principal churn');
    replayed(replay, complete);
    // A fresh target snapshot may require a few empty range/hole seeks. It
    // cannot consume a page of another principal's source events.
    expect(boundedFreshness(measured.queries)).toBeLessThan(10);
  } finally {
    await active.query('ROLLBACK');
    active.release();
  }
}, 90_000);

test('forward migration retires the applied singleton, refuses a legacy stale proof and preserves a legacy partial frontier', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const runId = Bun.env.REZICS_QA_RUN_ID!;
  const stack = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
  const compose = readEnv(join(stack, 'compose.env'));
  const admin = new Client({ connectionString:
    `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres` });
  const name = `qa_verification_${randomBytes(6).toString('hex')}`;
  const directory = join(root, '.temp', `verification-upgrade-${randomUUID()}`);
  const contentDir = join(root, 'services/content/migrations');
  const url = new URL(Bun.env.CONTENT_DATABASE_URL!);
  url.pathname = `/${name}`;
  const upgrade = new Pool({ connectionString: url.toString(), max: 4 });
  await admin.connect();
  let created = false;
  try {
    await admin.query(`CREATE DATABASE ${name} WITH TEMPLATE template0 OWNER content`);
    created = true;
    mkdirSync(directory, { recursive: true });
    for (const file of schemaFiles(root, 'content').filter(file => migrationVersion(file) !== 1521)) {
      symlinkSync(join(contentDir, file), join(directory, file));
    }
    await migrateContent(upgrade, directory);
    expect((await upgrade.query(`SELECT to_regclass('verification.lineage_change_head') AS table_name`))
      .rows[0]!.table_name).not.toBeNull();
    const fixture = await observations(2, randomUUID(), upgrade);
    const old = new VerificationStore(upgrade);
    const publication = await origin(old, fixture.principal);
    const manifests = await Promise.all(fixture.ids.map(observation => evidence(old, fixture.principal, [observation])));
    for (const observation of fixture.ids) {
      await edge(old, fixture.principal, observation, { origin: publication }, 'publishes-origin');
    }
    const caller = authority(fixture.principal);
    const authorityDigest = createHash('sha256').update(JSON.stringify(caller)).digest('hex');
    const walks = [randomUUID(), randomUUID()];
    for (let index = 0; index < walks.length; index++) {
      const walk = walks[index]!;
      const observation = fixture.ids[index]!;
      const manifest = manifests[index]!;
      const complete = index === 0;
      await upgrade.query(`INSERT INTO verification.lineage_walk
        (id, claim, evidence_revision, authority_digest, start_key, root_ordinal, complete,
         origin_count, version, expansions, edges, node_count, validated_sequence)
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, 1, 1, $8, 1, revision
        FROM verification.lineage_change_head WHERE singleton`,
      [walk, manifest.claim, manifest.revision, authorityDigest, caller.requestDigest,
        Number(complete), complete, Number(complete)]);
      await upgrade.query(`INSERT INTO verification.lineage_walk_observation
        (walk_id, observation_id, lineage_head) SELECT $1, $2, revision::text
        FROM verification.lineage_head WHERE observation_id = $2`, [walk, observation]);
      await upgrade.query(`INSERT INTO verification.lineage_walk_node
        (walk_id, root_ordinal, observation_id, depth, done, phase, has_links)
        VALUES ($1, 0, $2, 0, $3, $4, $3)`, [walk, observation, complete, complete ? 2 : 0]);
      if (complete) await upgrade.query(`INSERT INTO verification.lineage_walk_origin
        (walk_id, origin_id) VALUES ($1, $2)`, [walk, publication]);
      await upgrade.query(`INSERT INTO verification.lineage_walk_step (walk_id, version, result)
        VALUES ($1, 0, $2)`, [walk, { walk, complete, continuation: complete ? null : `${walk}:1`, lineageNodes: 1,
        work: { expansions: 1, links: Number(complete) }, totalWork: { expansions: 1, links: Number(complete) },
        lineageProof: complete ? { dependence: 'established', independentOrigins: 1, origins: [`origin:${publication}`] }
          : { dependence: 'over-budget', independentOrigins: null, origins: [] } }]);
    }
    const frontier = (await upgrade.query(`SELECT to_jsonb(n) AS node FROM verification.lineage_walk_node n
      WHERE walk_id = $1`, [walks[1]])).rows[0]!.node;
    const savedSteps = (await upgrade.query(`SELECT result FROM verification.lineage_walk_step
      WHERE walk_id = $1 AND version = 0`, [walks[1]])).rows[0]!.result;
    await old.recordObservationDisposition(fixture.principal, randomUUID(), fixture.ids[0]!, {
      expectedHead: null, state: 'withdrawn', reason: 'Source changed before the forward migration',
    });
    expect(await migrateContent(upgrade)).toContain(1521);
    expect((await upgrade.query(`SELECT to_regclass('verification.lineage_change_head') AS table_name`))
      .rows[0]!.table_name).toBeNull();
    expect((await upgrade.query(`SELECT to_jsonb(n) AS node FROM verification.lineage_walk_node n
      WHERE walk_id = $1`, [walks[1]])).rows[0]!.node).toEqual(frontier);
    expect((await upgrade.query(`SELECT result FROM verification.lineage_walk_step
      WHERE walk_id = $1 AND version = 0`, [walks[1]])).rows[0]!.result).toEqual(savedSteps);
    const store = new VerificationStore(upgrade);
    expect((await upgrade.query(`SELECT stale FROM verification.lineage_walk_observation
      WHERE walk_id = $1`, [walks[0]])).rows[0]!.stale).toBe(false);
    await expect(store.analysisSnapshot(manifests[0]!.claim, manifests[0]!.revision,
      caller, `${walks[0]}:0`)).rejects.toBeInstanceOf(VerificationStale);
    let current = await store.analysisSnapshot(manifests[1]!.claim, manifests[1]!.revision, caller, `${walks[1]}:1`);
    for (let attempt = 0; !current.complete && attempt < 10; attempt++) {
      bounded(current);
      current = await store.analysisSnapshot(manifests[1]!.claim, manifests[1]!.revision, caller, current.continuation!);
    }
    expect(current.complete).toBe(true);
    expect(current.walk).toBe(walks[1]!);
    expect(current.totalWork).toEqual({ expansions: 1, links: 1 });
    expect(current.lineageProof).toEqual({ dependence: 'established', independentOrigins: 1,
      origins: [`origin:${publication}`] });
  } finally {
    await upgrade.end();
    if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);


test('the existing restore epoch invalidates native transaction checkpoints without adding a source writer head', async () => {
  const fixture = await observations(1);
  const store = new VerificationStore(pool);
  const publication = await origin(store, fixture.principal);
  await edge(store, fixture.principal, fixture.ids[0]!, { origin: publication }, 'publishes-origin');
  const manifest = await evidence(store, fixture.principal, [fixture.ids[0]!]);
  const caller = authority(fixture.principal);
  const before = await store.analysisSnapshot(manifest.claim, manifest.revision, caller);
  expect(before.complete).toBe(true);
  await pool.query('SELECT reading_position.advance_restore_epoch()');
  await expect(store.analysisSnapshot(manifest.claim, manifest.revision, caller, `${before.walk}:0`))
    .rejects.toBeInstanceOf(VerificationStale);
  const fresh = await store.analysisSnapshot(manifest.claim, manifest.revision, caller, undefined, randomUUID());
  expect(fresh.complete).toBe(true);
  expect(fresh.lineageProof).toEqual(before.lineageProof);
  const later = await origin(store, fixture.principal);
  await edge(store, fixture.principal, fixture.ids[0]!, { origin: later }, 'publishes-origin');
  await expect(store.analysisSnapshot(manifest.claim, manifest.revision, caller, `${fresh.walk}:0`))
    .rejects.toBeInstanceOf(VerificationStale);
}, 90_000);
