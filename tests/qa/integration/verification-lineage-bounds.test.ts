import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
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

async function observations(count: number, principal = randomUUID()) {
  const record = randomUUID();
  const ids = Array.from({ length: count }, () => randomUUID());
  await pool.query(`INSERT INTO source.record (id, provider, namespace, external_id)
    VALUES ($1, 'fixture', 'verification-walk', $2)`, [record, record]);
  await pool.query(`INSERT INTO source.observation (id, record_id, principal_id, media_type,
    retention, coverage, rights_evidence)
    SELECT id, $2::uuid, $3::uuid, 'application/json', 'not-retained', '{}', '{}'
    FROM unnest($1::uuid[]) AS id`, [ids, record, principal]);
  return { principal, ids };
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
  expect(await walkState(resumed.walk)).toEqual(beforeRead);
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
  const sequence = async () => BigInt((await pool.query<{ validated_sequence: string }>(`
    SELECT validated_sequence::text FROM verification.lineage_walk WHERE id = $1`,
  [complete.walk])).rows[0]!.validated_sequence);
  let validated = await sequence();
  const unrelated = await observations(LINEAGE_EDGE_BUDGET + 1, fixture.principal);
  for (const observation of unrelated.ids) {
    await edge(store, fixture.principal, observation, { origin: publication }, 'publishes-origin');
  }
  const token = `${complete.walk}:0`;
  const partial = await new VerificationStore(pool).analysisSnapshot(manifest.claim, manifest.revision, caller, token);
  bounded(partial);
  expect(partial.complete).toBe(false);
  expect(partial.work).toEqual({ expansions: 0, links: 0 });
  expect(partial.totalWork).toEqual(complete.totalWork);
  const advanced = await sequence();
  expect(advanced - validated).toBe(BigInt(LINEAGE_EDGE_BUDGET));
  validated = advanced;
  let current = partial;
  for (let retry = 0; !current.complete && retry < 5; retry++) {
    current = await new VerificationStore(pool).analysisSnapshot(manifest.claim, manifest.revision,
      caller, current.continuation!);
    const next = await sequence();
    expect(next - validated).toBeGreaterThanOrEqual(0n);
    expect(next - validated).toBeLessThanOrEqual(BigInt(LINEAGE_EDGE_BUDGET));
    validated = next;
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
  const { validated_sequence: beforeSequence, version: beforeVersion, ...beforeWalk } = before.walk;
  const { validated_sequence: afterSequence, version: afterVersion, ...afterWalk } = after.walk;
  expect(BigInt(afterSequence) - BigInt(beforeSequence)).toBe(BigInt(LINEAGE_EDGE_BUDGET + 1));
  expect(afterVersion).toBeGreaterThanOrEqual(beforeVersion);
  expect(afterWalk).toEqual(beforeWalk);
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
  const before = (await pool.query<{ validated_sequence: string }>(`SELECT validated_sequence::text
    FROM verification.lineage_walk WHERE id = $1`, [complete.walk])).rows[0]!.validated_sequence;
  const unrelated = await observations(LINEAGE_EDGE_BUDGET + 1, fixture.principal);
  for (const observation of unrelated.ids) {
    await edge(store, fixture.principal, observation, { origin: publication }, 'publishes-origin');
  }
  await store.recordObservationDisposition(fixture.principal, randomUUID(), root, {
    expectedHead: null, state: 'withdrawn', reason: 'Source changed behind queued unrelated edits',
  });
  const plan = (await pool.query<{ 'QUERY PLAN': { Plan: Record<string, unknown> }[] }>(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
    SELECT i.local_sequence::text, i.reference, i.kind FROM verification.invalidation i
    WHERE i.local_sequence > $1::bigint ORDER BY i.local_sequence LIMIT 1`,
  [before])).rows[0]!['QUERY PLAN'][0]!.Plan;
  expect(plan['Actual Rows']).toBe(1);
  expect(JSON.stringify(plan)).toContain('invalidation_local_sequence');
  const partial = await store.analysisSnapshot(manifest.claim, manifest.revision, caller, `${complete.walk}:0`);
  bounded(partial);
  expect(partial.complete).toBe(false);
  expect(partial.work).toEqual({ expansions: 0, links: 0 });
  expect(analyze(partial)).toMatchObject({ support: 'abstained', independentOrigins: null, coverage: 'incomplete' });
  const after = (await pool.query<{ validated_sequence: string }>(`SELECT validated_sequence::text
    FROM verification.lineage_walk WHERE id = $1`, [complete.walk])).rows[0]!.validated_sequence;
  expect(BigInt(after) - BigInt(before)).toBe(BigInt(LINEAGE_EDGE_BUDGET));
  await expect(new VerificationStore(pool).analysisSnapshot(manifest.claim, manifest.revision,
    caller, partial.continuation!)).rejects.toBeInstanceOf(VerificationStale);
  await expect(store.analysisSnapshot(manifest.claim, manifest.revision, caller, `${complete.walk}:0`))
    .rejects.toBeInstanceOf(VerificationStale);
  // No asynchronous walk mark was needed to refuse both continuation and replay.
  expect((await pool.query(`SELECT 1 FROM verification.lineage_walk_observation
    WHERE walk_id = $1 AND stale`, [complete.walk])).rowCount).toBe(0);
}, 90_000);
