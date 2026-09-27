import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { validateReleaseRatingNativeShapes } from '../../../model/tests/release-rating-native.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence, releaseAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { ReleaseRatingInventoryStore, RELEASE_RATING_INVENTORY_SQL,
  readReleaseRatingAggregateInventory } from '../../../services/main/src/modules/access/rating-aggregate-inventory.ts';
import { queryReleaseRatingAggregate } from '../../../services/main/src/modules/rating/release-aggregate.ts';
import { RELEASE_RATING_WRITE_COST } from '../../../services/main/src/modules/rating/release.ts';
import { initializeRelayCheckpoint, relayCoverage, relayMainOutboxOnce,
  readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { GRAPHS, DATASET, RV, iri, initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { reconcileRetainedFixedRelease } from '../../../services/main/src/modules/work/reconcile-fixed-release.ts';
import { reconcileRetainedAdmissionCancellation, reconcileRetainedContributionDraftCreate,
  reconcileRetainedContributionPublication, reconcileRetainedMainSelection,
  reconcileRetainedRatingContext, reconcileRetainedRealmSpaceCreate,
  reconcileRetainedStandingRating, reconcileRetainedWorkCreate }
  from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { cutoverRestoredGraphLineage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
function stack(action: 'stack:up' | 'stack:reset', runId: string): void {
  const result = spawnSync('bun', ['scripts/dev/cli.ts', action, '--profile', 'qa', '--run-id', runId],
    { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) throw new Error(`${action}: ${(
    result.stderr || result.stdout || result.error?.message || '').slice(-2000)}`);
}
interface Target { work: string; mainVersion: string; mainRevision: string }
interface Opinion { observation: string; observationRevision: string; predecessor: string | null;
  value: number | null; release?: string; replayed: boolean }
interface Aggregate { context: string; mainVersion: string; release?: string; population: number;
  count: number; withdrawnCount: number; sum: number; mean: number | null; histogram: number[] }

test('WORK06: exact fixed releases and Main Version keep separate Access-backed rating populations', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCOUNT_MAIN_RESOURCE || !Bun.env.ACCOUNT_SECRET
    || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const preparation = Date.now();
  const state = join(root, '.temp', `rating-release-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 5 });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const relayPool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const restoredId = `release-${randomUUID().slice(0, 12)}`;
  let restoredStarted = false;
  let identity: Awaited<ReturnType<typeof ratingAccount>> | undefined;
  try {
    identity = await ratingAccount({ ACCOUNT_DATABASE_URL: databases.urls.account,
      ACCOUNT_SECRET: Bun.env.ACCOUNT_SECRET, ACCOUNT_MAIN_RESOURCE: Bun.env.ACCOUNT_MAIN_RESOURCE });
    await migrateContent(contentPool);
    const principals = { a: randomUUID(), b: randomUUID() };
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,$3,$4), ($2,$3,$5)`, [principals.a, principals.b, identity.issuer, identity.a.id, identity.b.id]);
    const actor = { a: `https://rezics.com/id/${randomUUID()}`,
      b: `https://rezics.com/id/${randomUUID()}` };
    for (const value of Object.values(actor)) {
      await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [value]);
    }
    const owner = { a: principals.a, b: principals.b };
    async function grant(scope: string, action: string, who: 'a' | 'b' = 'a') {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), owner[who], actor[who], action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor[who], scope, action]);
    }
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL,
      Bun.env.FUSEKI_MAINTENANCE_TOKEN, Bun.env.FUSEKI_COMMAND_TOKEN);
    const environment = { fuseki, objectDirectory: join(state, 'objects'),
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH } };
    const content = new ContentCore(contentPool);
    const access = new AccessAdmissionRegistry(accessPool);
    const inventory = new ReleaseRatingInventoryStore(accessPool);
    const main = createMainApp(fuseki, { environment, account: identity.verifier,
      access, content, contentAuthoring: content, releaseRatingInventory: inventory });
    const token = { a: identity.tokenA, b: identity.tokenB };
    const post = (path: string, body: object, who: 'a' | 'b' = 'a', key = randomUUID(),
      bearer = token[who]) => main.handle(new Request(`http://main.local${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${bearer}`,
          'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) }));
    const meteredWrite = async (write: () => Promise<Response>) => {
      const budget = { signal: AbortSignal.timeout(RELEASE_RATING_WRITE_COST.commandDeadlineMs),
        callsLeft: RELEASE_RATING_WRITE_COST.graphCalls,
        bytesLeft: RELEASE_RATING_WRITE_COST.graphBytes };
      const response = await fusekiReadBudget.run(budget, write);
      const cost = { calls: RELEASE_RATING_WRITE_COST.graphCalls - budget.callsLeft,
        bytes: RELEASE_RATING_WRITE_COST.graphBytes - budget.bytesLeft };
      expect(cost.calls).toBeGreaterThan(0);
      expect(cost.calls).toBeLessThanOrEqual(RELEASE_RATING_WRITE_COST.graphCalls);
      expect(cost.bytes).toBeGreaterThan(0);
      expect(cost.bytes).toBeLessThan(RELEASE_RATING_WRITE_COST.graphBytes);
      return { response, cost };
    };
    const aggregate = (context: string, profile: string, target: object) => main.handle(new Request(
      'http://main.local/v1/rating-aggregates', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile, context, ...target }) }));
    async function success<T>(response: Response, status = 201): Promise<T> {
      const data = await response.json();
      expect({ status: response.status, error: response.status >= 400 ? data : undefined })
        .toEqual({ status, error: undefined });
      return data as T;
    }
    await grant('work:create:root', 'work.create');
    await grant('space:create:root', 'space.create');
    expect(Date.now() - preparation).toBeLessThan(600_000);
    const work = await success<Target>(await post('/v1/works', {
      profile: 'metadata-only-v1', title: `Release rating ${randomUUID()}`, actingSubject: actor.a }));
    const realm = (await success<{ realm: string }>(await post('/v1/spaces', {
      profile: 'space-realm-v1', name: `Rating Realm ${randomUUID()}`,
      capabilities: ['realm'], actingSubject: actor.a }))).realm;
    await grant(`rating:context:${realm}`, 'rating.context.create');
    const mainContext = (await success<{ context: string }>(await post('/v1/rating-contexts', {
      profile: 'realm-standing-rating-context-v1', realm, question: 'Whole Main Version quality',
      actingSubject: actor.a }))).context;
    const releaseContextBody = { profile: 'realm-release-rating-context-v1', realm,
      question: 'This exact release quality', actingSubject: actor.a };
    expect((await post('/v1/rating-contexts', releaseContextBody, 'a', randomUUID(), identity.noScope)).status).toBe(401);
    const contextKey = randomUUID();
    const contextWrite = await meteredWrite(() => post('/v1/rating-contexts', releaseContextBody, 'a', contextKey));
    const releaseContext = (await success<{ context: string; targetGrain: string }>(
      contextWrite.response)).context;
    expect(await success(await post('/v1/rating-contexts', releaseContextBody, 'a', contextKey), 200))
      .toMatchObject({ context: releaseContext, replayed: true });
    expect((await post('/v1/rating-contexts', { ...releaseContextBody, question: 'Other' }, 'a', contextKey)).status).toBe(409);
    expect(await success(await main.handle(new Request(
      `http://main.local/v1/rating-contexts/${releaseContext.split('/').at(-1)}`)), 200))
      .toMatchObject({ targetGrain: 'fixedRelease', profile: 'realm-release-rating-context-v1' });

    // Content owns the immutable body and publication. Main pins that selection into two distinct releases.
    await grant(`contribution:create:${work.work}`, 'contribution.create');
    const draft = await success<{ contribution: string; draftRevision: string }>(await post('/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en',
      body: `Pinned release text ${randomUUID()}`, actingSubject: actor.a }));
    await grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    const published = await success<{ publicationDecision: string }>(await post('/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor.a }));
    await grant(`publication:select:${work.mainVersion}`, 'publication.select');
    const selected = await success<{ selection: string; mainRevision: string }>(await post('/v1/publication-selections', {
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
      work: work.work, contribution: draft.contribution, publicationDecision: published.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor.a }));
    await grant(`release:seal:${work.mainVersion}`, 'release.seal');
    const releaseBody = { profile: 'fixed-native-text-release-v1', work: work.work,
      mainVersion: work.mainVersion, expectedMainRevision: selected.mainRevision,
      expectedSelection: selected.selection, actingSubject: actor.a };
    const first = (await success<{ release: string }>(await post('/v1/fixed-releases', releaseBody))).release;
    const second = (await success<{ release: string }>(await post('/v1/fixed-releases', releaseBody))).release;
    expect(first).not.toBe(second);

    for (const who of ['a', 'b'] as const) {
      await grant(`rating:observe:${releaseContext}`, 'rating.observation.set', who);
      await grant(`rating:observe:${mainContext}`, 'rating.observation.set', who);
      await grant(`rating:read:${releaseContext}`, 'rating.observation.read', who);
    }
    const set = (who: 'a' | 'b', context: string, release: string,
      value: number | null, expectedRevisionHead: string | null = null, key = randomUUID()) =>
      post('/v1/rating-observations', { profile: 'realm-release-rating-observation-v1',
        context, work: work.work, mainVersion: work.mainVersion, release,
        value, expectedRevisionHead, actingSubject: actor[who] }, who, key);
    const mainSet = () => post('/v1/rating-observations', {
      profile: 'realm-standing-rating-observation-v1', context: mainContext,
      work: work.work, mainVersion: work.mainVersion, value: 2,
      expectedRevisionHead: null, actingSubject: actor.a });
    await success<Opinion>(await mainSet());
    expect((await set('a', mainContext, first, 7)).status).toBe(422);
    expect((await post('/v1/rating-observations', {
      profile: 'realm-standing-rating-observation-v1', context: releaseContext,
      work: work.work, mainVersion: work.mainVersion, value: 7,
      expectedRevisionHead: null, actingSubject: actor.a })).status).toBe(422);
    const wrong = await set('a', releaseContext, work.mainVersion, 7);
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const firstKey = randomUUID();
    const firstWrite = await meteredWrite(() => set('a', releaseContext, first, 7, null, firstKey));
    const firstA = await success<Opinion>(firstWrite.response);
    expect(firstA).toMatchObject({ release: first, value: 7, replayed: false });
    expect(await success(await set('a', releaseContext, first, 7, null, firstKey), 200))
      .toMatchObject({ observation: firstA.observation, replayed: true });
    expect((await set('a', releaseContext, first, 8, null, firstKey)).status).toBe(409);
    const firstB = await success<Opinion>(await set('b', releaseContext, first, 3));
    const secondWrite = await meteredWrite(() => set('a', releaseContext, second, 9));
    const secondA = await success<Opinion>(secondWrite.response);
    expect(secondWrite.cost.calls).toBe(firstWrite.cost.calls);
    expect(secondA.observation).not.toBe(firstA.observation);
    const heads = await accessPool.query<{ target_release: string; main_version: string }>(
      'SELECT target_release, main_version FROM access.rating_aggregate_head WHERE context = $1 ORDER BY slot',
      [releaseContext]);
    expect(heads.rows.map(row => row.target_release).sort()).toEqual([first, first, second].sort());
    expect(heads.rows.every(row => row.main_version === work.mainVersion)).toBe(true);
    expect((await readReleaseRatingAggregateInventory(accessPool, releaseContext, first)).heads).toHaveLength(2);
    expect((await readReleaseRatingAggregateInventory(accessPool, releaseContext, second)).heads).toHaveLength(1);
    const mainScore = await success<Aggregate>(await aggregate(mainContext, 'realm-standing-latest-mean-v1',
      { work: work.work, mainVersion: work.mainVersion }), 200);
    expect(mainScore).toMatchObject({ count: 1, population: 1, sum: 2, mean: 2 });
    const firstResponse = await aggregate(releaseContext, 'realm-release-latest-mean-v1', { release: first });
    if (firstResponse.status !== 200) {
      await queryReleaseRatingAggregate(environment, inventory, { context: releaseContext, release: first });
    }
    const firstScore = await success<Aggregate>(firstResponse, 200);
    expect(firstScore).toMatchObject({ release: first, count: 2, population: 2, sum: 10, mean: 5 });
    expect(await success<Aggregate>(await aggregate(releaseContext, 'realm-release-latest-mean-v1',
      { release: second }), 200)).toMatchObject({ release: second, count: 1, sum: 9, mean: 9 });

    // Jena may commit while delivery to Access is interrupted. Its unsealed head
    // cannot be published as a complete population; same-key retry seals it.
    const interrupted = new Proxy(access, { get(target, key) {
      if (key === 'recordGraphOutcome') return async () => { throw new Error('simulated lost owner outcome'); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const interruptedMain = createMainApp(fuseki, { environment, account: identity.verifier,
      access: interrupted, content, contentAuthoring: content, releaseRatingInventory: inventory });
    const partialKey = randomUUID();
    const partialBody = { profile: 'realm-release-rating-observation-v1', context: releaseContext,
      work: work.work, mainVersion: work.mainVersion, release: second,
      value: 4, expectedRevisionHead: null, actingSubject: actor.b };
    const partial = await interruptedMain.handle(new Request('http://main.local/v1/rating-observations', {
      method: 'POST', headers: { authorization: `Bearer ${token.b}`,
        'content-type': 'application/json', 'idempotency-key': partialKey },
      body: JSON.stringify(partialBody) }));
    expect(partial.status).toBe(202);
    expect((await aggregate(releaseContext, 'realm-release-latest-mean-v1', { release: second })).status).toBe(503);
    await success<Opinion>(await set('b', releaseContext, second, 4, null, partialKey), 200);
    expect(await success<Aggregate>(await aggregate(releaseContext, 'realm-release-latest-mean-v1',
      { release: second }), 200)).toMatchObject({ population: 2, count: 2, sum: 13, mean: 6.5 });

    const race = await Promise.all([set('a', releaseContext, first, 8, firstA.observationRevision),
      set('a', releaseContext, first, 6, firstA.observationRevision)]);
    expect(race.map(response => response.status).sort()).toEqual([201, 409]);
    const winner = await success<Opinion>(race.find(response => response.status === 201)!, 201);
    expect((await set('a', releaseContext, first, 5, firstA.observationRevision)).status).toBe(409);
    const withdrawn = await success<Opinion>(await set('b', releaseContext, first, null, firstB.observationRevision));
    expect(await success<Aggregate>(await aggregate(releaseContext, 'realm-release-latest-mean-v1',
      { release: first }), 200)).toMatchObject({ population: 2, count: 1, withdrawnCount: 1,
        sum: winner.value });
    expect((await set('b', releaseContext, first, 4, firstB.observationRevision)).status).toBe(409);
    await success<Opinion>(await set('b', releaseContext, first, 4, withdrawn.observationRevision));
    const revisionUrl = `http://main.local/v1/rating-observations/${firstA.observation.split('/').at(-1)}`
      + `/revisions/${firstA.observationRevision.split('/').at(-1)}`;
    const exact = await main.handle(new Request(revisionUrl
      + `?profile=realm-release-rating-observation-v1&context=${encodeURIComponent(releaseContext)}`
      + `&release=${encodeURIComponent(first)}&actingSubject=${encodeURIComponent(actor.a)}`,
    { headers: { authorization: `Bearer ${token.a}` } }));
    expect(await success(exact, 200)).toMatchObject({ value: 7, release: first });

    // Bound check: the release index and one owner snapshot remain exact-key reads as sibling data grows.
    const index = await accessPool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'access' AND indexname = 'rating_aggregate_head_release'");
    expect(index.rows[0]?.indexdef).toContain('(context, target_release, slot)');
    const planner = await accessPool.connect();
    let releaseIndexWork: Array<{ rows: number; loops: number; hitBlocks: number }> = [];
    try {
      await planner.query('BEGIN');
      await planner.query('SET LOCAL enable_seqscan = off');
      const plan = await planner.query<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${RELEASE_RATING_INVENTORY_SQL}`,
        [releaseContext, first]);
      const nodes: Array<Record<string, unknown>> = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) visit(child);
      };
      visit(plan.rows[0]!['QUERY PLAN'][0]!.Plan);
      expect(nodes.some(node => node['Index Name'] === 'rating_aggregate_head_release'
        && String(node['Index Cond']).includes('target_release'))).toBe(true);
      expect(nodes.filter(node => node['Index Name'] === 'rating_aggregate_head_release')
        .every(node => Number(node['Actual Rows']) <= 101)).toBe(true);
      releaseIndexWork = nodes.filter(node => node['Index Name'] === 'rating_aggregate_head_release')
        .map(node => ({ rows: Number(node['Actual Rows']), loops: Number(node['Actual Loops']),
          hitBlocks: Number(node['Shared Hit Blocks'] ?? 0) }));
      await planner.query('ROLLBACK');
    } finally { planner.release(); }
    const measure = async (release: string) => {
      const budget = { signal: AbortSignal.timeout(10_000), callsLeft: 8, bytesLeft: 1_048_576 };
      const response = await fusekiReadBudget.run(budget, () => aggregate(releaseContext,
        'realm-release-latest-mean-v1', { release }));
      expect(response.status).toBe(200);
      return { calls: 8 - budget.callsLeft, bytes: 1_048_576 - budget.bytesLeft };
    };
    const firstCost = await measure(first), siblingCost = await measure(second);
    expect(firstCost.calls).toBeGreaterThan(0);
    expect(firstCost.calls).toBeLessThanOrEqual(2);
    expect(siblingCost.calls).toBe(firstCost.calls);
    expect(firstCost.bytes).toBeGreaterThan(0);
    expect(firstCost.bytes).toBeLessThan(1_048_576);
    expect(siblingCost.bytes).toBeLessThan(1_048_576);
    if (Bun.env.REZICS_QA_ARTIFACT_DIR) {
      writeFileSync(join(Bun.env.REZICS_QA_ARTIFACT_DIR, 'rating-release-costs.json'),
        JSON.stringify({ contract: { graphCalls: 2, graphBytes: 1_048_576,
          ownerCandidateRows: 101, manifestBytes: 1_048_576 },
        dimensions: { firstReleaseSlots: 2, siblingReleaseSlots: 2, mainVersionSlots: 1 },
        contextWriteCost: contextWrite.cost, firstWriteCost: firstWrite.cost,
        siblingWriteCost: secondWrite.cost, firstCost, siblingCost, releaseIndexWork,
        limitation: 'Native Jena operator work and host capacity are not measured.' }, null, 2));
    }
    const saved = join(state, 'saved-objects');
    cpSync(environment.objectDirectory, saved, { recursive: true });
    rmSync(environment.objectDirectory, { recursive: true, force: true });
    expect((await aggregate(releaseContext, 'realm-release-latest-mean-v1', { release: first })).status).toBe(503);
    cpSync(saved, environment.objectDirectory, { recursive: true });
    const generation = await engageAccessRecoveryFence(accessPool);
    expect((await aggregate(releaseContext, 'realm-release-latest-mean-v1', { release: first })).status).toBe(503);
    await releaseAccessRecoveryFence(accessPool, generation);
    expect((await aggregate(releaseContext, 'realm-release-latest-mean-v1', { release: first })).status).toBe(200);
    const consumer = `release-rating:${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, consumer, environment.lineage.dataEpoch);
    const retained = new Map<string, Awaited<ReturnType<typeof readMainOutboxEnvelope>>>();
    while (true) {
      const batch = await relayMainOutboxOnce(fuseki, relayPool, consumer);
      if (!batch) break;
      retained.set(batch.sequence, await readMainOutboxEnvelope(fuseki, batch, batch.eventIds[0]!));
    }
    const coverage = await relayCoverage(relayPool, consumer);
    expect(retained.size).toBe(Number(coverage.sequence));
    expect([...retained.values()].some(envelope => envelope.type === 'com.rezics.rating.observation-changed.v1'
      && envelope.data.receipt.ratingObservation === firstA.observation)).toBe(true);
    const finalLive = await success<Aggregate>(await aggregate(releaseContext,
      'realm-release-latest-mean-v1', { release: first }), 200);
    const fenceGeneration = await engageAccessRecoveryFence(accessPool);
    stack('stack:up', restoredId);
    restoredStarted = true;
    const restoredApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: restoredId }), 'apps.env'));
    const restoredFuseki = new FusekiClient(restoredApps.FUSEKI_URL!,
      restoredApps.FUSEKI_MAINTENANCE_TOKEN!, restoredApps.FUSEKI_COMMAND_TOKEN!);
    const restorePrior = { dataEpoch: environment.lineage.dataEpoch, routingEpoch: '1' };
    await initializeFreshGraph(restoredFuseki, restorePrior);
    const nextLineage = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(restoredFuseki,
      { prior: { ...restorePrior, sequence: '0' }, next: nextLineage });
    const restoredObjects = join(state, 'restored-objects');
    cpSync(environment.objectDirectory, restoredObjects, { recursive: true, errorOnExist: true });
    const recovered = { fuseki: restoredFuseki, objectDirectory: restoredObjects, lineage: nextLineage };
    for (let n = 1; n <= Number(coverage.sequence); n++) {
      const sequence = String(n);
      const type = retained.get(sequence)?.type;
      const replay = type === 'com.rezics.work.created.v1' ? reconcileRetainedWorkCreate
        : type === 'com.rezics.space.created.v1' ? reconcileRetainedRealmSpaceCreate
          : type === 'com.rezics.contribution.draft-created.v1' ? reconcileRetainedContributionDraftCreate
            : type === 'com.rezics.contribution.eligibility-recorded.v1' ? reconcileRetainedContributionPublication
              : type === 'com.rezics.publication.selection-changed.v1' ? reconcileRetainedMainSelection
                : type === 'com.rezics.release.sealed.v1' ? reconcileRetainedFixedRelease
                  : type === 'com.rezics.rating.context-created.v1' ? reconcileRetainedRatingContext
                    : type === 'com.rezics.rating.observation-changed.v1' ? reconcileRetainedStandingRating
                      : reconcileRetainedAdmissionCancellation;
      await replay(recovered, accessPool, relayPool, coverage, sequence);
      await replay(recovered, accessPool, relayPool, coverage, sequence);
    }
    const recoveredHead = await restoredFuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(firstA.observation)} rv:observationHead ?head } }`);
    expect(recoveredHead.results?.bindings?.[0]?.head?.value).toBe(winner.observationRevision);
    const restoredApi = createMainApp(restoredFuseki, { environment: recovered,
      account: identity.verifier, access, releaseRatingInventory: inventory });
    const restoredAggregate = () => restoredApi.handle(new Request('http://main.local/v1/rating-aggregates', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'realm-release-latest-mean-v1', context: releaseContext, release: first }) }));
    expect((await restoredAggregate()).status).toBe(503);
    // Test-only release after replay; the production owner-cut gate is exercised elsewhere.
    await restoredFuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:restoreHold true } }`);
    await releaseAccessRecoveryFence(accessPool, fenceGeneration);
    const restoredScore = await success<Aggregate>(await restoredAggregate(), 200);
    expect({ ...restoredScore, sourcePosition: undefined })
      .toEqual({ ...finalLive, sourcePosition: undefined });
    // The second disposable graph is no longer needed for replay, so probe
    // native Jena bindings there without clearing the shared integration graph.
    await validateReleaseRatingNativeShapes(restoredApps.FUSEKI_URL!, restoredApps.FUSEKI_COMMAND_TOKEN!);
  } finally {
    await identity?.close();
    await accessPool.end();
    await contentPool.end();
    await relayPool.end();
    await databases.close();
    if (restoredStarted) stack('stack:reset', restoredId);
    rmSync(state, { recursive: true, force: true });
  }
}, 240_000);
