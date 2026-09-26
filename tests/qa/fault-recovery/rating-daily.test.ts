import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, fusekiReadBudget, FusekiReadBudgetExceeded, type CommandEnvelope }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { initializeRelayCheckpoint, relayCoverage, relayMainOutboxOnce, readMainOutboxEnvelope }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { dailyRatingSlotIri } from '../../../services/main/src/modules/rating/calendar.ts';
import { readDailyRevisionPeriod } from '../../../services/main/src/modules/rating/daily-period.ts';
import { EXPERIENCE_CONTEXT_ID, EXPERIENCE_OBSERVATION_ID, experienceRatingIdentity,
  readExperienceRevision } from '../../../services/main/src/modules/rating/experience.ts';
import { standingRatingDigest, standingRatingSlotIri }
  from '../../../services/main/src/modules/rating/observation.ts';
import { readComponentState } from '../../../services/main/src/modules/work/history.ts';
import { GRAPHS, ID, RV, iri, initializeFreshGraph, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { reconcileRetainedRatingContext, reconcileRetainedStandingRating,
  reconcileRetainedRealmSpaceCreate, reconcileRetainedWorkCreate, reconcileRetainedAdmissionCancellation,
  RetainedEffectConflict } from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { cutoverRestoredGraphLineage }
  from '../../../services/main/src/modules/work/restore-lineage.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
function stack(action: 'stack:up' | 'stack:reset', runId: string): void {
  const result = spawnSync('corepack', ['yarn', action, '--profile', 'qa', '--run-id', runId],
    { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 2_000_000 });
  if (result.status !== 0 || result.error) throw new Error(`${action}: ${(
    result.stderr || result.stdout || result.error?.message || '').slice(-2000)}`);
}
interface Opinion {
  observation: string; observationRevision: string; predecessor: string | null;
  context: string; work: string; mainVersion: string; value: number | null;
  availability: string; profile: string; day?: string; periodStart?: string; periodEnd?: string;
  occasion?: string;
  sourcePosition: { sequence: string }; replayed: boolean;
}

test('RATE02/RATE03/OPS03: standing daily and experience identities survive real API races and graph loss', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery tier');
  const nonce = randomUUID().slice(0, 12);
  const liveId = `rating-${nonce}-l`, restoredId = `rating-${nonce}-r`;
  const directory = join(root, '.temp', `rating-daily-${nonce}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const started: string[] = [];
  let accessPool: Pool | undefined, relayPool: Pool | undefined;
  let identity: Awaited<ReturnType<typeof ratingAccount>> | undefined;
  try {
    const preparationStart = Date.now();
    for (const id of [liveId, restoredId]) { started.push(id); stack('stack:up', id); }
    const apps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: liveId }), 'apps.env'));
    const restoredApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: restoredId }), 'apps.env'));
    accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 5 });
    relayPool = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
    for (const [owner, pool] of [['access', accessPool], ['relay', relayPool]] as const) {
      const migrations = join(root, `services/main/migrations/${owner}`);
      for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort()) {
        await pool.query(readFileSync(join(migrations, file), 'utf8'));
      }
    }
    identity = await ratingAccount(apps);
    class MeteredFuseki extends FusekiClient {
      writes = 0; writeBytes = 0;
      override async command(envelope: CommandEnvelope) {
        this.writes++; this.writeBytes += Buffer.byteLength(JSON.stringify(envelope));
        return super.command(envelope);
      }
    }
    const liveFuseki = new MeteredFuseki(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    const restoredFuseki = new FusekiClient(restoredApps.FUSEKI_URL!,
      restoredApps.FUSEKI_MAINTENANCE_TOKEN!, restoredApps.FUSEKI_COMMAND_TOKEN!);
    expect((await liveFuseki.commandHealth()).moduleVersion).toBe('0.5.25');
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    const env: WorkActivationEnvironment = { fuseki: liveFuseki, lineage,
      objectDirectory: join(directory, 'objects') };
    await initializeFreshGraph(liveFuseki, lineage);
    const consumer = `rating:${nonce}`;
    await initializeRelayCheckpoint(relayPool, consumer, lineage.dataEpoch);
    const principalA = randomUUID(), principalB = randomUUID();
    const personaA = ID + randomUUID(), personaB = ID + randomUUID(), other = ID + randomUUID();
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3), ($4, $2, $5)`,
    [principalA, identity.issuer, identity.a.id, principalB, identity.b.id]);
    for (const actor of [personaA, personaB, other]) {
      await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    }
    async function grant(scope: string, action: string, actor = personaA, principal = principalA) {
      await accessPool!.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await accessPool!.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), principal, actor, action]);
      await accessPool!.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
    }
    const access = new AccessAdmissionRegistry(accessPool);
    const main = createMainApp(liveFuseki, { environment: env, account: identity.verifier, access });
    const costs: { branch: string; calls: number; responseBytes: number; writes: number; writeBytes: number }[] = [];
    async function measured<T>(branch: string, operation: () => Promise<T>): Promise<T> {
      const budget = { signal: AbortSignal.timeout(10_000), callsLeft: 24, bytesLeft: 65_536 };
      const before = { writes: liveFuseki.writes, bytes: liveFuseki.writeBytes };
      const result = await fusekiReadBudget.run(budget, operation);
      const calls = 24 - budget.callsLeft, responseBytes = 65_536 - budget.bytesLeft;
      expect(calls).toBeGreaterThan(0); expect(responseBytes).toBeGreaterThan(0);
      const writes = liveFuseki.writes - before.writes, writeBytes = liveFuseki.writeBytes - before.bytes;
      expect(writes).toBeLessThanOrEqual(2); expect(writeBytes).toBeLessThanOrEqual(32_768);
      costs.push({ branch, calls, responseBytes, writes, writeBytes });
      return result;
    }
    const post = (path: string, body: object, key = randomUUID(), token = identity!.tokenA) =>
      main.handle(new Request(`http://main.local${path}`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'idempotency-key': key }, body: JSON.stringify(body) }));
    async function success<T>(response: Response, status = 201): Promise<T> {
      const data = await response.json();
      expect({ status: response.status, error: response.status >= 400 ? data : undefined })
        .toEqual({ status, error: undefined });
      return data as T;
    }
    await grant('work:create:root', 'work.create');
    await grant('space:create:root', 'space.create');
    const preparationMs = Date.now() - preparationStart;
    expect(preparationMs).toBeLessThan(600_000);
    const work = await success<{ work: string; mainVersion: string }>(await post('/v1/works',
      { profile: 'metadata-only-v1', title: `Daily target ${nonce}`, actingSubject: personaA }));
    const realm = (await success<{ realm: string }>(await post('/v1/spaces',
      { profile: 'space-realm-v1', name: `Daily Realm ${nonce}`, capabilities: ['realm'], actingSubject: personaA }))).realm;
    await grant(`rating:context:${realm}`, 'rating.context.create');
    const contextBody = { profile: 'realm-daily-rating-context-v1', realm,
      question: 'Quality today', timeZone: 'America/New_York', actingSubject: personaA };
    expect((await post('/v1/rating-contexts', { ...contextBody, timeZone: '-05:00' })).status).toBe(400);
    const context = (await success<{ context: string }>(await post('/v1/rating-contexts', contextBody))).context;
    const readContext = await main.handle(new Request(`http://main.local/v1/rating-contexts/${context.split('/').at(-1)}`));
    expect(await readContext.json()).toMatchObject({ context, cadence: 'daily', timeZone: 'America/New_York', calendar: 'iso8601' });
    for (const [actor, principal] of [[personaA, principalA], [personaB, principalA], [other, principalB]]) {
      await grant(`rating:observe:${context}`, 'rating.observation.set', actor!, principal!);
      await grant(`rating:read:${context}`, 'rating.observation.read', actor!, principal!);
    }
    const body = (value: number | null, expectedRevisionHead: string | null = null, actor = personaA) =>
      ({ profile: 'realm-daily-rating-observation-v1', context, work: work.work, mainVersion: work.mainVersion, value, expectedRevisionHead, actingSubject: actor });
    // This disposable owner's database default is the trusted clock. HTTP inputs cannot set it.
    async function serverTime(instant: string) {
      if (new Date(instant).toISOString() !== instant) throw new Error('noncanonical fixture time');
      await accessPool!.query(`ALTER TABLE access.admission ALTER COLUMN registered_at SET DEFAULT '${instant}'::timestamptz`);
    }
    const set = (value: number | null, head: string | null = null, actor = personaA,
      key = randomUUID(), token = identity!.tokenA) => post('/v1/rating-observations', body(value, head, actor), key, token);
    await serverTime('2026-03-08T06:59:59.999Z');
    expect((await post('/v1/rating-observations', body(4), randomUUID(), identity.noScope)).status).toBe(401);
    const unknownActor = ID + randomUUID();
    expect((await set(4, null, unknownActor)).status).toBe(403);
    const firstKey = randomUUID();
    const first = await measured('first', async () => success<Opinion>(await set(2, null, personaA, firstKey)));
    expect(first).toMatchObject({ day: '2026-03-08', periodStart: '2026-03-08T05:00:00.000Z',
      periodEnd: '2026-03-09T04:00:00.000Z', value: 2 });
    await serverTime('2026-03-08T07:00:00.000Z');
    expect((await set(4, null, personaB)).status).toBe(409);
    for (const extras of [{ day: '2026-03-09' }, { submittedAt: '2030-01-01T00:00:00Z' },
      { timeZone: 'Pacific/Auckland' }, { offset: '+13:00' }, { principalId: principalB }]) {
      const injected = await post('/v1/rating-observations', { ...body(3), ...extras });
      expect([400, 422]).toContain(injected.status);
    }
    const correction = await measured('correction', async () => success<Opinion>(await set(8, first.observationRevision, personaB)));
    expect(correction.observation).toBe(first.observation);
    const staleKey = randomUUID();
    expect((await measured('stale', () => set(4, first.observationRevision, personaA, staleKey))).status).toBe(409);
    expect((await set(4, first.observationRevision, personaA, staleKey)).status).toBe(409);
    const withdrawn = await success<Opinion>(await set(null, correction.observationRevision));
    expect(withdrawn).toMatchObject({ observation: first.observation, value: null, availability: 'withdrawn' });
    const head = await liveFuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?value ?old WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(first.observation)} rv:observationHead ?head . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(first.observationRevision)} rv:ratingValue ?old . }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?head rv:ratingValue ?value } } }`);
    expect(head.results?.bindings).toHaveLength(1);
    expect(head.results?.bindings[0]?.head?.value).toBe(withdrawn.observationRevision);
    expect(head.results?.bindings[0]?.old?.value).toBe('2');
    expect(head.results?.bindings[0]?.value).toBeUndefined();
    const read = (opinion: Opinion, token = identity!.tokenA, actor = personaB) => main.handle(new Request(
      `http://main.local/v1/rating-observations/${opinion.observation.split('/').at(-1)}/revisions/${opinion.observationRevision.split('/').at(-1)}?${
        new URLSearchParams({ ...(opinion.profile === 'realm-standing-rating-observation-v1' ? {} : { profile: opinion.profile }), context: opinion.context,
          mainVersion: work.mainVersion, actingSubject: actor })}`, { headers: { authorization: `Bearer ${token}` } }));
    const exactFirst = await measured('exact-read', async () => success<Record<string, unknown>>(await read(first), 200));
    expect(exactFirst).toMatchObject({ value: 2, day: '2026-03-08',
      evaluatedAt: '2026-03-08T06:59:59.999Z', originalSubmissionAt: '2026-03-08T06:59:59.999Z' });
    expect((await read(first, identity.tokenB, other)).status).toBe(404);
    const independent = await success<Opinion>(await set(6, null, other, randomUUID(), identity.tokenB));
    expect(independent.observation).not.toBe(first.observation);
    await serverTime('2026-03-09T04:00:00.000Z');
    expect(await measured('retry', async () => success<Opinion>(await set(2, null, personaA, firstKey), 200)))
      .toMatchObject({ ...first, replayed: true });
    const next = await success<Opinion>(await set(3));
    expect(next.day).toBe('2026-03-09');
    expect(next.observation).not.toBe(first.observation);
    let restoredOpinion = await success<Opinion>(await set(9, withdrawn.observationRevision));
    expect(restoredOpinion).toMatchObject({ day: '2026-03-08', observation: first.observation, value: 9 });
    expect(await success<Record<string, unknown>>(await read(restoredOpinion), 200))
      .toMatchObject({ originalSubmissionAt: exactFirst.originalSubmissionAt,
        evaluatedAt: exactFirst.evaluatedAt, submittedAt: '2026-03-09T04:00:00.000Z' });
    // Grow one slot's immutable history geometrically; an exact-head edit must not walk it.
    for (let n = 1; n <= 8; n++) {
      restoredOpinion = await measured(`history-${n}`, async () =>
        success<Opinion>(await set(n, restoredOpinion.observationRevision)));
    }
    const historyCosts = [1, 4, 8].map(n => costs.find(cost => cost.branch === `history-${n}`)!);
    expect(new Set(historyCosts.map(cost => cost.calls)).size).toBe(1);
    expect(Math.max(...historyCosts.map(cost => cost.responseBytes))
      - Math.min(...historyCosts.map(cost => cost.responseBytes))).toBeLessThan(1024);
    await expect(fusekiReadBudget.run({ signal: AbortSignal.timeout(10_000), callsLeft: 1, bytesLeft: 4096 }, async () => {
      await liveFuseki.query('ASK {}'); await liveFuseki.query('ASK {}');
    })).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    await serverTime('2026-11-01T05:30:00.000Z');
    const fallKeys = [randomUUID(), randomUUID()];
    const races = await Promise.all(fallKeys.map((key, i) => set(5, null, i ? personaB : personaA, key)));
    expect(races.map(response => response.status).sort()).toEqual([201, 409]);
    const winner = races.findIndex(response => response.status === 201);
    const fall = await success<Opinion>(races[winner]!);
    expect(fall).toMatchObject({ day: '2026-11-01', periodStart: '2026-11-01T04:00:00.000Z',
      periodEnd: '2026-11-02T05:00:00.000Z' });
    await serverTime('2026-11-01T06:30:00.000Z');
    expect((await set(5, null, personaB)).status).toBe(409);
    expect(await success<Opinion>(await set(5, null, winner ? personaB : personaA, fallKeys[winner]), 200))
      .toMatchObject({ ...fall, replayed: true });
    // A registered retry keeps its original database instant even if no graph command ran before midnight.
    await serverTime('2026-11-02T04:59:59.999Z');
    const pendingKey = randomUUID();
    const pendingBody = body(7, null, other);
    const admission = await access.register({ principal: { issuer: identity.issuer, subject: identity.b.id },
      actingSubject: other, action: 'rating.observation.set', scope: `rating:observe:${context}`,
      idempotencyKey: pendingKey, requestDigest: standingRatingDigest(pendingBody, true) });
    expect(admission.registeredAt).toBe('2026-11-02T04:59:59.999Z');
    await serverTime('2026-11-02T05:00:00.000Z');
    const afterMidnight = await success<Opinion>(await set(7, null, other, pendingKey, identity.tokenB), 200);
    expect(afterMidnight.day).toBe('2026-11-01');
    await accessPool.query(`UPDATE access.permission_grant SET active = false WHERE recipient_subject = $1
      AND scope_id = $2 AND action = 'rating.observation.set'`, [personaB, `rating:observe:${context}`]);
    expect((await set(7, null, personaB)).status).toBe(403);
    await accessPool.query(`UPDATE access.permission_grant SET active = true WHERE recipient_subject = $1
      AND scope_id = $2 AND action = 'rating.observation.set'`, [personaB, `rating:observe:${context}`]);
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [principalB]);
    expect((await set(7, null, other, randomUUID(), identity.tokenB)).status).toBe(403);
    await accessPool.query('UPDATE access.principal SET active = true WHERE id = $1', [principalB]);
    // Standing remains a distinct profile, with the same receipt/manifest path used before daily support.
    const standingContext = (await success<{ context: string }>(await post('/v1/rating-contexts', {
      profile: 'realm-standing-rating-context-v1', realm, question: 'Standing quality', actingSubject: personaA }))).context;
    await grant(`rating:observe:${standingContext}`, 'rating.observation.set');
    const standing = await success<Opinion>(await post('/v1/rating-observations', {
      ...body(4), profile: 'realm-standing-rating-observation-v1', context: standingContext }));
    expect(standing.day).toBeUndefined();
    const standingRevision = await liveFuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(standing.observationRevision)} rv:manifest ?manifest } }`);
    const standingState = readComponentState(env.objectDirectory,
      standingRevision.results!.bindings![0]!.manifest!.value, standing.observation,
      'https://rezics.com/definition/realm-standing-rating-observation-v1');
    expect(Object.keys(standingState).sort()).toEqual(['observation', 'slot', 'context', 'contextRevision',
      'realm', 'work', 'mainVersion', 'revision', 'predecessor', 'availability', 'value',
      'evaluatedAt', 'submittedAt', 'originalSubmissionAt', 'revisedAt'].sort());
    expect(standingState.slot).toBe(standingRatingSlotIri(principalA, standingContext, work.mainVersion));
    await grant(`rating:read:${standingContext}`, 'rating.observation.read');
    const standingCorrection = await success<Opinion>(await post('/v1/rating-observations', {
      ...body(8, standing.observationRevision), profile: standing.profile, context: standingContext }));
    expect(standingCorrection.observation).toBe(standing.observation);
    expect(standingCorrection.observationRevision).not.toBe(standing.observationRevision);
    expect(await success<Record<string, unknown>>(await read(standing, identity.tokenA, personaA), 200))
      .toMatchObject({ value: 4, evaluatedAt: standingState.evaluatedAt });

    const experienceContext = (await success<{ context: string }>(await post('/v1/rating-contexts', {
      profile: EXPERIENCE_CONTEXT_ID, realm, question: 'Quality this experience', actingSubject: personaA }))).context;
    expect(await success<Record<string, unknown>>(await main.handle(new Request(
      `http://main.local/v1/rating-contexts/${experienceContext.split('/').at(-1)}`)), 200))
      .toMatchObject({ context: experienceContext, cadence: 'experience', profile: EXPERIENCE_CONTEXT_ID });
    for (const [actor, principal] of [[personaA, principalA], [personaB, principalA], [other, principalB]]) {
      await grant(`rating:observe:${experienceContext}`, 'rating.observation.set', actor!, principal!);
      await grant(`rating:read:${experienceContext}`, 'rating.observation.read', actor!, principal!);
    }
    const occasion = randomUUID(), experienceKey = randomUUID();
    const experienceBody = (value: number | null, head: string | null = null, marker = occasion, actor = personaA) => ({
      ...body(value, head, actor), profile: EXPERIENCE_OBSERVATION_ID, context: experienceContext, occasion: marker });
    const experienceSet = (value: number | null, head: string | null = null, marker = occasion,
      actor = personaA, key = randomUUID(), token = identity!.tokenA) =>
      post('/v1/rating-observations', experienceBody(value, head, marker, actor), key, token);
    await serverTime('2026-11-03T09:00:00.000Z');
    for (const extras of [{ occasion: 'arbitrary' }, { occasion: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, { occasion: null },
      { principalId: principalB }, { slot: standingState.slot }, { submittedAt: '2020-01-01T00:00:00Z' },
      { day: '2026-11-02' }, { timeZone: 'UTC' }, { observation: standing.observation }]) {
      expect([400, 422]).toContain((await post('/v1/rating-observations', { ...experienceBody(2), ...extras })).status);
    }
    const { occasion: _marker, ...withoutOccasion } = experienceBody(2);
    expect([400, 422]).toContain((await post('/v1/rating-observations', withoutOccasion)).status);
    expect((await post('/v1/rating-observations', experienceBody(2), randomUUID(), identity.noScope)).status).toBe(401);
    expect((await experienceSet(2, null, occasion, unknownActor)).status).toBe(403);
    expect((await experienceSet(2, null, occasion, other)).status).toBe(403);
    const experienceFirst = await measured('experience-first', async () =>
      success<Opinion>(await experienceSet(2, null, occasion, personaA, experienceKey)));
    expect(experienceFirst).toMatchObject({ occasion, profile: EXPERIENCE_OBSERVATION_ID, value: 2 });
    expect((await experienceSet(3, null, occasion, personaA, experienceKey)).status).toBe(409);
    expect((await experienceSet(2, null, randomUUID(), personaA, experienceKey)).status).toBe(409);
    const sameOccasionKey = randomUUID();
    expect((await measured('experience-reused-occasion', () => experienceSet(2, null, occasion, personaB, sameOccasionKey))).status).toBe(409);
    expect((await experienceSet(8, null, occasion)).status).toBe(409);
    expect((await experienceSet(2, null, occasion, personaB, sameOccasionKey)).status).toBe(409);
    await serverTime('2026-11-03T10:00:00.000Z');
    const correctionKey = randomUUID();
    const experienceCorrection = await measured('experience-correction', async () => success<Opinion>(
      await experienceSet(8, experienceFirst.observationRevision, occasion, personaB, correctionKey)));
    expect(experienceCorrection.observation).toBe(experienceFirst.observation);
    expect(experienceCorrection.observationRevision).not.toBe(experienceFirst.observationRevision);
    expect(await success<Opinion>(await experienceSet(8, experienceFirst.observationRevision, occasion, personaB, correctionKey), 200))
      .toMatchObject({ ...experienceCorrection, replayed: true });
    expect(await success<Record<string, unknown>>(await read(experienceCorrection), 200)).toMatchObject({
      occasion, evaluatedAt: '2026-11-03T09:00:00.000Z', originalSubmissionAt: '2026-11-03T09:00:00.000Z',
      submittedAt: '2026-11-03T10:00:00.000Z', revisedAt: '2026-11-03T10:00:00.000Z' });
    expect((await experienceSet(3, experienceFirst.observationRevision)).status).toBe(409);
    expect((await experienceSet(3, experienceCorrection.observationRevision, randomUUID())).status).toBe(409);
    expect((await read(experienceFirst, identity.tokenB, other)).status).toBe(404);
    const experienceWithdrawn = await measured('experience-withdrawal', async () => success<Opinion>(
      await experienceSet(null, experienceCorrection.observationRevision)));
    expect(experienceWithdrawn).toMatchObject({ observation: experienceFirst.observation, value: null, availability: 'withdrawn' });
    const experienceHead = await liveFuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?value WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(experienceFirst.observation)} rv:observationHead ?head }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?head rv:ratingValue ?value } } }`);
    expect(experienceHead.results?.bindings).toHaveLength(1);
    expect(experienceHead.results?.bindings[0]?.head?.value).toBe(experienceWithdrawn.observationRevision);
    expect(experienceHead.results?.bindings[0]?.value).toBeUndefined();
    expect(await measured('experience-original-retry', async () => success<Opinion>(
      await experienceSet(2, null, occasion, personaA, experienceKey), 200)))
      .toMatchObject({ ...experienceFirst, replayed: true });
    expect(await success<Record<string, unknown>>(await read(experienceFirst), 200)).toMatchObject({ value: 2, occasion });
    const experienceRestored = await success<Opinion>(await experienceSet(9, experienceWithdrawn.observationRevision));
    expect(experienceRestored.observation).toBe(experienceFirst.observation);
    const secondOccasion = randomUUID();
    const experienceNext = await success<Opinion>(await experienceSet(3, null, secondOccasion));
    expect(experienceNext.observation).not.toBe(experienceFirst.observation);
    const experienceOther = await success<Opinion>(await experienceSet(6, null, occasion, other, randomUUID(), identity.tokenB));
    expect(experienceOther.observation).not.toBe(experienceFirst.observation);
    const raceOccasion = randomUUID(), experienceRaceKeys = [randomUUID(), randomUUID()];
    const experienceRaces = await Promise.all(experienceRaceKeys.map((key, i) =>
      experienceSet(5, null, raceOccasion, i ? personaB : personaA, key)));
    expect(experienceRaces.map(response => response.status).sort()).toEqual([201, 409]);
    const experienceWinner = experienceRaces.findIndex(response => response.status === 201);
    const experienceRace = await success<Opinion>(experienceRaces[experienceWinner]!);
    expect(await success<Opinion>(await experienceSet(5, null, raceOccasion, experienceWinner ? personaB : personaA,
      experienceRaceKeys[experienceWinner]), 200)).toMatchObject({ ...experienceRace, replayed: true });
    const retryOccasion = randomUUID(), concurrentKey = randomUUID();
    const concurrentRetries = await Promise.all([0, 1].map(() => experienceSet(7, null, retryOccasion, personaA, concurrentKey)));
    for (const response of concurrentRetries) expect([200, 201, 202]).toContain(response.status);
    const concurrentOpinion = await success<Opinion>(await experienceSet(7, null, retryOccasion, personaA, concurrentKey), 200);
    const concurrentSlot = experienceRatingIdentity(principalA, experienceContext, work.mainVersion, retryOccasion).slot;
    const concurrentCount = await liveFuseki.query(`PREFIX rv: <${RV}> SELECT ?observation WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?observation rv:ratingSlot ${iri(concurrentSlot)} } }`);
    expect(concurrentCount.results?.bindings).toHaveLength(1);
    expect(concurrentCount.results?.bindings?.[0]?.observation?.value).toBe(concurrentOpinion.observation);
    const unavailableContext = ID + randomUUID();
    await grant(`rating:observe:${unavailableContext}`, 'rating.observation.set');
    expect((await post('/v1/rating-observations', { ...experienceBody(4), context: unavailableContext })).status).toBe(409);
    // Revoke a registered operation before dispatch; it must seal without adding an occasion.
    const revokedKey = randomUUID(), revokedOccasion = randomUUID();
    await access.register({ principal: { issuer: identity.issuer, subject: identity.a.id }, actingSubject: personaB,
      action: 'rating.observation.set', scope: `rating:observe:${experienceContext}`, idempotencyKey: revokedKey,
      requestDigest: standingRatingDigest(experienceBody(7, null, revokedOccasion, personaB)) });
    await accessPool.query(`UPDATE access.permission_grant SET active = false WHERE recipient_subject = $1
      AND scope_id = $2 AND action = 'rating.observation.set'`, [personaB, `rating:observe:${experienceContext}`]);
    expect([403, 409]).toContain((await experienceSet(7, null, revokedOccasion, personaB, revokedKey)).status);
    expect((await experienceSet(7, null, randomUUID(), personaB)).status).toBe(403);
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [principalB]);
    expect((await experienceSet(7, null, randomUUID(), other, randomUUID(), identity.tokenB)).status).toBe(403);
    expect((await read(experienceOther, identity.tokenB, other)).status).toBe(403);
    await accessPool.query('UPDATE access.principal SET active = true WHERE id = $1', [principalB]);
    // Bulk fixture-only imports grow unrelated slots; product writes never seed this background.
    const background = Array.from({ length: 64 }, () => {
      const node = ID + randomUUID(), rev = ID + randomUUID();
      const identity = experienceRatingIdentity(randomUUID(), experienceContext, work.mainVersion, randomUUID());
      return `${iri(node)} a rv:RatingObservation, rv:ExperienceRatingObservation ; rv:ratingContext ${iri(experienceContext)} ;
        rv:targetMainVersion ${iri(work.mainVersion)} ; rv:ratingSlot ${iri(identity.slot)} ;
        rv:ratingOccasion ${iri(identity.occasionKey)} ; rv:observationHead ${iri(rev)} .`;
    });
    let growthHead = experienceRestored;
    for (const n of [0, 16, 64]) {
      if (n) await liveFuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${background.slice(n === 16 ? 0 : 16, n).join('\n')} } }`);
      growthHead = await measured(`experience-unrelated-${n}`, async () => success<Opinion>(
        await experienceSet(8, growthHead.observationRevision)));
      expect(await measured(`experience-read-unrelated-${n}`, async () => success<Record<string, unknown>>(
        await read(experienceFirst, identity!.tokenA, personaA), 200))).toMatchObject({ value: 2, occasion });
    }
    for (const prefix of ['experience-unrelated-', 'experience-read-unrelated-']) {
      const growthCosts = costs.filter(cost => cost.branch.startsWith(prefix));
      expect(new Set(growthCosts.map(cost => cost.calls)).size).toBe(1);
      expect(new Set(growthCosts.map(cost => cost.writes)).size).toBe(1);
      expect(Math.max(...growthCosts.map(cost => cost.responseBytes)) - Math.min(...growthCosts.map(cost => cost.responseBytes))).toBeLessThan(1024);
      expect(Math.max(...growthCosts.map(cost => cost.writeBytes)) - Math.min(...growthCosts.map(cost => cost.writeBytes))).toBeLessThan(1024);
    }
    const publicGraph = JSON.stringify(await liveFuseki.query(`SELECT ?s ?p ?o WHERE {
      VALUES ?g { ${iri(GRAPHS.current)} ${iri(GRAPHS.revisions)} ${iri(GRAPHS.receipts)} }
      GRAPH ?g { ?s ?p ?o } }`));
    for (const secret of [principalA, principalB, identity.a.id, identity.b.id, occasion, secondOccasion]) expect(publicGraph).not.toContain(secret);
    await identity.expireSessions(identity.b.id);
    expect((await experienceSet(4, null, randomUUID(), other, randomUUID(), identity.tokenB)).status).toBe(401);
    expect((await read(experienceOther, identity.tokenB, other)).status).toBe(401);
    await identity.stop();
    const beforeUnavailable = await accessPool.query('SELECT count(*)::integer AS count FROM access.admission');
    expect((await experienceSet(4, null, randomUUID())).status).toBe(503);
    const afterUnavailable = await accessPool.query('SELECT count(*)::integer AS count FROM access.admission');
    expect(afterUnavailable.rows).toEqual(beforeUnavailable.rows);
    const expectedEnvelope = new Map<string, string>();
    const batches = new Map<string, NonNullable<Awaited<ReturnType<typeof relayMainOutboxOnce>>>>();
    while (true) {
      const relayed = await relayMainOutboxOnce(liveFuseki, relayPool, consumer);
      if (!relayed) break;
      batches.set(relayed.sequence, relayed);
      expectedEnvelope.set(relayed.sequence, JSON.stringify(await readMainOutboxEnvelope(liveFuseki, relayed, relayed.eventIds[0]!)));
    }
    const coverage = await relayCoverage(relayPool, consumer);
    await engageAccessRecoveryFence(accessPool);
    const backupDirectory = join(directory, 'retained-backup');
    const restoredDirectory = join(directory, 'restored-objects');
    cpSync(env.objectDirectory, backupDirectory, { recursive: true, errorOnExist: true });
    cpSync(backupDirectory, restoredDirectory, { recursive: true, errorOnExist: true });
    expect(Date.now() - preparationStart).toBeLessThan(600_000);
    await initializeFreshGraph(restoredFuseki, lineage);
    const nextLineage = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(restoredFuseki, { prior: { ...lineage, sequence: '0' }, next: nextLineage });
    const recovered = { ...env, objectDirectory: restoredDirectory, fuseki: restoredFuseki, lineage: nextLineage };
    for (let n = 1; n <= Number(coverage.sequence); n++) {
      const sequence = String(n);
      const envelope = JSON.parse(expectedEnvelope.get(sequence)!) as { type: string };
      const replay = envelope.type === 'com.rezics.work.created.v1' ? reconcileRetainedWorkCreate
        : envelope.type === 'com.rezics.space.created.v1' ? reconcileRetainedRealmSpaceCreate
        : envelope.type === 'com.rezics.rating.context-created.v1' ? reconcileRetainedRatingContext
        : envelope.type === 'com.rezics.rating.observation-changed.v1' ? reconcileRetainedStandingRating
        : reconcileRetainedAdmissionCancellation;
      await replay(recovered, accessPool, relayPool, coverage, sequence);
      await replay(recovered, accessPool, relayPool, coverage, sequence);
      expect(JSON.stringify(await readMainOutboxEnvelope(restoredFuseki, batches.get(sequence)!, batches.get(sequence)!.eventIds[0]!)))
        .toBe(expectedEnvelope.get(sequence));
    }
    expect(await readDailyRevisionPeriod(recovered, first.observation, first.observationRevision))
      .toMatchObject({ day: first.day, periodStart: first.periodStart, periodEnd: first.periodEnd });
    expect(await readExperienceRevision(recovered, experienceFirst.observation, experienceFirst.observationRevision))
      .toEqual({ occasion, occasionKey: experienceRatingIdentity(principalA, experienceContext, work.mainVersion, occasion).occasionKey });
    for (const opinion of [standingCorrection, growthHead, experienceNext, experienceOther, experienceRace, concurrentOpinion]) {
      const restoredHead = await restoredFuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(opinion.observation)} rv:observationHead ?head } }`);
      expect(restoredHead.results?.bindings?.[0]?.head?.value).toBe(opinion.observationRevision);
    }
    const counts = await restoredFuseki.query(`PREFIX rv: <${RV}> SELECT ?observation ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?observation rv:ratingSlot ${iri(dailyRatingSlotIri(principalA, context, work.mainVersion, '2026-03-08'))} ;
        rv:observationHead ?head . } }`);
    expect(counts.results?.bindings).toHaveLength(1);
    expect(counts.results?.bindings?.[0]?.head?.value).toBe(restoredOpinion.observationRevision);
    // Retained public envelopes contain no private Account/principal identifier or client clock.
    const retained = [...expectedEnvelope.values()].join('\n');
    for (const secret of [principalA, principalB, identity.a.id, identity.b.id, occasion, secondOccasion]) expect(retained).not.toContain(secret);
    await accessPool.query(`UPDATE access.admission SET registered_at = registered_at + interval '1 second'
      WHERE graph_sequence = $1 AND graph_data_epoch = $2`, [experienceFirst.sourcePosition.sequence, lineage.dataEpoch]);
    await expect(reconcileRetainedStandingRating(recovered, accessPool, relayPool, coverage, experienceFirst.sourcePosition.sequence))
      .rejects.toBeInstanceOf(RetainedEffectConflict);
    const modified = await accessPool.query<{ id: string }>(`UPDATE access.admission SET registered_at = registered_at + interval '1 second'
      WHERE graph_sequence = $1 AND graph_data_epoch = $2 RETURNING id`, [first.sourcePosition.sequence, lineage.dataEpoch]);
    expect(modified.rowCount).toBe(1);
    await expect(reconcileRetainedStandingRating(recovered, accessPool, relayPool, coverage, first.sourcePosition.sequence))
      .rejects.toBeInstanceOf(RetainedEffectConflict);
    if (Bun.env.REZICS_QA_ARTIFACT_DIR) writeFileSync(join(Bun.env.REZICS_QA_ARTIFACT_DIR, 'rating-daily-costs.json'),
      JSON.stringify({ preparationMs, costs,
        scope: 'Real Main-to-Fuseki read attempts and response bytes; native operator work and host capacity unmeasured.' }, null, 2));
  } finally {
    await identity?.close();
    await accessPool?.end(); await relayPool?.end();
    for (const id of started.reverse()) stack('stack:reset', id);
    rmSync(directory, { recursive: true, force: true });
  }
}, 360_000);
