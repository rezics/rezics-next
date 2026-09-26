import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { EventQueryRestart, EventTemporalQueries }
  from '../../../services/main/src/modules/event/queries.ts';
import { eventTimeSlotIri }
  from '../../../services/main/src/modules/event/observation.ts';
import { ID, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { AccessAdmissionRegistry }
  from '../../../services/main/src/modules/access/admission.ts';
import { classificationContextDigest, createClassificationContext }
  from '../../../services/main/src/modules/classification/context.ts';
import { createRealmSpace, spaceCreationDigest }
  from '../../../services/main/src/modules/space/create.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `${ID}${randomUUID()}`;

test('RATE07/RATE08/RATE09: event precision, shared occurrence slots and generation restart cross Main, Access and Jena', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const stateDir = join(root, '.temp', `event-time-${randomUUID()}`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL, Bun.env.FUSEKI_MAINTENANCE_TOKEN,
    Bun.env.FUSEKI_COMMAND_TOKEN);
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access', 'content']);
  const access = new Pool({ connectionString: databases.urls.access, max: 8 });
  const contentPool = new Pool({ connectionString: databases.urls.content, max: 4 });
  await migrateContent(contentPool);
  const content = new ContentCore(contentPool);
  const identity = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as Record<string, string>,
    'openid work:create event:submit event:read classification:define statement:write statement:decide');
  const env: WorkActivationEnvironment = { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
    routingEpoch: Bun.env.MAIN_ROUTING_EPOCH }, objectDirectory: join(stateDir, 'objects') };
  const queries = new EventTemporalQueries(access, env, Buffer.alloc(32, 7));
  const actor = native();
  const eventA = native(), eventB = native();
  const principal = randomUUID();
  const accessRegistry = new AccessAdmissionRegistry(access);
  const main = createMainApp(fuseki, { environment: env, account: identity.verifier, access: accessRegistry,
    content, eventQueries: queries });
  await access.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [principal, identity.issuer, identity.a.id]);
  await access.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
  async function grantEvent(event: string) {
    const scope = `event:observe:${event}`;
    await access.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await access.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,'event.observation.set',now() + interval '1 hour')`,
    [randomUUID(), principal, actor]);
    await access.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'event.observation.set',now() + interval '1 hour')`, [randomUUID(), actor, scope]);
  }
  async function grant(scope: string, action: string) {
    await access.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await access.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until) VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
    [randomUUID(), principal, actor, action]);
    await access.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
  }
  async function post(path: string, body: object, key = randomUUID(), token = identity.tokenA) {
    return main.handle(new Request(`http://main.local${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        ...(!path.endsWith('/queries') ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) }));
  }
  const makeBody = (event: string, lexical: string, expectedRevisionHead: string | null,
    actingSubject = actor, timeStatus: 'actual' | 'planned' = 'actual', timeEvidence?: string) => ({ profile: 'event-time-observation-v1', event, timeStatus,
    temporalKind: 'instant', start: { state: 'known', value: { kind: 'temporal', lexical,
      precision: 'month', calendar: 'gregorian' } }, expectedRevisionHead, actingSubject,
    ...(timeEvidence ? { timeEvidence } : {}) });
  const write = async (event: string, lexical: string, expectedRevisionHead: string | null,
    timeStatus: 'actual' | 'planned' = 'actual', key = randomUUID(), timeEvidence?: string) => {
    const response = await post('/v1/events/observations',
      makeBody(event, lexical, expectedRevisionHead, actor, timeStatus, timeEvidence), key);
    const data = await response.json() as { event?: string; eventTime?: string; observationRevision?: string; predecessor?: string | null;
      sourcePosition?: { sequence: string }; code?: string; title?: string };
    if (response.status !== 201 || data.event !== event) {
      throw new Error(`event observation failed: ${response.status} ${JSON.stringify(data)}`);
    }
    expect({ status: response.status, event: data.event }).toMatchObject({ status: 201, event });
    return data;
  };
  const createWork = async (title: string) => {
    const response = await post('/v1/works', { profile: 'metadata-only-v1', title, actingSubject: actor });
    const data = await response.json() as { work?: string };
    if (response.status !== 201 || !data.work) throw new Error(`evidence Work failed: ${response.status} ${JSON.stringify(data)}`);
    return data.work;
  };
  const saveContentEvidence = async (resourceId: string, body: string) => {
    const saved = await content.saveDraft({ operationId: `event-time-evidence:${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { fixture: 'event-time-exact-evidence' }, serializedJson: JSON.stringify({ body }) });
    if (saved.outcome !== 'succeeded' || !saved.revisionId) throw new Error('Content owner rejected event evidence');
    return saved.revisionId;
  };
  try {
    const commandHealth = await fuseki.commandHealth();
    expect(commandHealth.profiles['event-time-v1']).toBe(profileRegistry['event-time-v1'].sha256);
    const deniedActor = native(), deniedEvent = native();
    await access.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [deniedActor]);
    await access.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [`event:observe:${deniedEvent}`]);
    await grantEvent(eventA); await grantEvent(eventB);
    await grant('work:create:root', 'work.create');
    await grant('classification:define:global', 'classification.proposition.define');
    await grant(`statement:speak:${actor}`, 'statement.record');
    await grant('classification:decide:global', 'statement.decide');
    const evidenceWork = await createWork(`Event evidence Work ${randomUUID()}`);
    const privateEvidenceWork = await createWork(`Private event evidence Work ${randomUUID()}`);
    await grant(`work:read:${evidenceWork}`, 'work.read');
    const exactEvidence = await saveContentEvidence(evidenceWork, 'Primary event date evidence');
    const privateEvidence = await saveContentEvidence(privateEvidenceWork, 'Private event date evidence');
    const denied = await post('/v1/events/observations', makeBody(deniedEvent, '2026-05', null, deniedActor));
    expect(denied.status).toBe(403);
    const firstKey = randomUUID();
    const deniedEvidenceEvent = native();
    await grantEvent(deniedEvidenceEvent);
    const deniedEvidenceResponse = await post('/v1/events/observations',
      makeBody(deniedEvidenceEvent, '2026-05', null, actor, 'actual', privateEvidence));
    expect(deniedEvidenceResponse.status).toBe(403);
    expect(await deniedEvidenceResponse.json()).toMatchObject({ code: 'authority_denied' });
    const first = await write(eventA, '2026-05', null, 'actual', firstKey, exactEvidence);
    const replayResponse = await post('/v1/events/observations',
      makeBody(eventA, '2026-05', null, actor, 'actual', exactEvidence), firstKey);
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toMatchObject({ event: eventA, eventTime: first.eventTime,
      observationRevision: first.observationRevision, replayed: true });
    await write(eventB, '2026-05', null);
    const planned = await write(eventA, '2026-05', null, 'planned');
    expect(planned.eventTime).toBe(eventTimeSlotIri(eventA, 'planned'));
    expect(first.eventTime).toBe(eventTimeSlotIri(eventA, 'actual'));
    expect(planned.eventTime).not.toBe(first.eventTime);
    const queryBody = (match: 'possible' | 'definite', start = '2026-05-15', end = start, pageSize = 10,
      continuation?: string) => ({ profile: 'event-query-v1', interpretation: 'civil-date', match,
      grain: 'day', start, end, pageSize, ...(continuation ? { continuation } : {}) });
    const possibleResponse = await post('/v1/events/queries', queryBody('possible'));
    expect(possibleResponse.status).toBe(200);
    const possible = await possibleResponse.json() as { items: { event: string; timeStatus: string; certainty: string }[];
      histogram: { timeStatus: string; definite: number; possible: number }[] };
    expect([...new Set(possible.items.map(item => item.event))].sort()).toEqual([eventA, eventB].sort());
    expect(possible.items.map(item => `${item.event}/${item.timeStatus}`).sort()).toEqual([
      `${eventA}/actual`, `${eventA}/planned`, `${eventB}/actual`].sort());
    expect(possible.items.every(item => item.certainty === 'possible')).toBe(true);
    expect(possible.histogram.find(bucket => bucket.timeStatus === 'actual'))
      .toMatchObject({ definite: 0, possible: 2 });
    expect(possible.histogram.find(bucket => bucket.timeStatus === 'planned'))
      .toMatchObject({ definite: 0, possible: 1 });
    const definiteResponse = await post('/v1/events/queries', queryBody('definite'));
    expect(definiteResponse.status).toBe(200);
    const definite = await definiteResponse.json() as { items: unknown[] };
    expect(definite.items).toHaveLength(0);

    // The first Realm classification context installs the retained Global acceptance scope.
    const fixtureAdmission = (scope: string, action: string, requestDigest: string) => ({
      id: randomUUID(), principalId: principal, actingSubject: actor, scope, action,
      idempotencyKey: randomUUID(), requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      state: 'claimed' as const, dispatchEligible: true, replayed: false });
    const spaceInput = { name: `Event topic Realm ${randomUUID()}`, actingSubject: actor };
    const space = await createRealmSpace(env, fixtureAdmission('space:create:root', 'space.create',
      spaceCreationDigest(spaceInput)), spaceInput);
    if (!space.realm) throw new Error('topic acceptance Realm failed');
    const contextInput = { realm: space.realm, actingSubject: actor };
    const context = await createClassificationContext(env,
      fixtureAdmission(`classification:context:${space.realm}`, 'classification.context.configure',
        classificationContextDigest(contextInput)), contextInput);
    if (!context.context) throw new Error('topic acceptance context failed');

    const topicConcepts: string[] = [];
    for (const label of ['first alias', 'second alias', 'rejected topic']) {
      const response = await post('/v1/classification-propositions', {
        profile: 'classification-proposition-v1', label: `Event ${label} ${randomUUID()}`,
        actingSubject: actor });
      const data = await response.json() as { concept?: string };
      if (response.status !== 201 || !data.concept) {
        throw new Error(`topic Concept failed: ${response.status} ${JSON.stringify(data)}`);
      }
      topicConcepts.push(data.concept);
    }
    const topicStatements: string[] = [];
    for (const [index, topic] of topicConcepts.entries()) {
      const response = await post('/v1/statements', {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject: topic,
        predicate: 'https://rezics.com/vocab/denotesEvent',
        relationDefinition: 'https://rezics.com/definition/event-time-v1',
        value: { kind: 'resource', iri: index === 2 ? eventB : eventA },
        applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: actor });
      const data = await response.json() as { statement?: string };
      if (response.status !== 201 || !data.statement) {
        throw new Error(`topic Statement failed: ${response.status} ${JSON.stringify(data)}`);
      }
      topicStatements.push(data.statement);
    }
    for (const [index, statement] of topicStatements.entries()) {
      const response = await post('/v1/statement-decisions', {
        profile: 'statement-decision-v1', target: { kind: 'statement', statement },
        acceptance: { kind: 'global' }, expectedDecisionHead: null,
        outcome: index === 2 ? 'rejected' : 'accepted', actingSubject: actor });
      if (response.status !== 201) {
        throw new Error(`topic decision failed: ${response.status} ${await response.text()}`);
      }
    }
    const topicQuery = (topics: string[]) => ({ ...queryBody('possible'), timeStatus: 'actual',
      topics, acceptance: { kind: 'global' } });
    const aliasesResponse = await post('/v1/events/queries', topicQuery(topicStatements));
    expect(aliasesResponse.status).toBe(200);
    const aliases = await aliasesResponse.json() as { items: { event: string; eventTime: string;
      timeRevision: string; topicStatements: string[] }[] };
    expect(aliases.items).toHaveLength(1);
    expect(aliases.items[0]).toMatchObject({ event: eventA, eventTime: first.eventTime,
      timeRevision: first.observationRevision });
    expect(aliases.items[0]!.topicStatements).toEqual(topicStatements.slice(0, 2));
    const rejectedResponse = await post('/v1/events/queries', topicQuery([topicStatements[2]!]));
    expect(rejectedResponse.status).toBe(200);
    expect((await rejectedResponse.json() as { items: unknown[] }).items).toHaveLength(0);
    const singleAliasResponse = await post('/v1/events/queries', topicQuery([topicStatements[1]!]));
    expect(singleAliasResponse.status).toBe(200);
    expect((await singleAliasResponse.json() as { items: { event: string; topicStatements: string[] }[] }).items)
      .toEqual([expect.objectContaining({ event: eventA, topicStatements: [topicStatements[1]] })]);

    const pagedResponse = await post('/v1/events/queries', queryBody('possible', '2026-05-01', '2026-05-31', 1));
    expect(pagedResponse.status).toBe(200);
    const paged = await pagedResponse.json() as { continuation: string | null };
    expect(paged.continuation).not.toBeNull();
    const correction = await write(eventA, '2026-06', first.observationRevision!);
    expect(correction.predecessor).toBe(first.observationRevision);
    const stale = await post('/v1/events/observations', makeBody(eventA, '2026-07', first.observationRevision!));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'stale_head' });
    await expect(queries.query({ interpretation: 'civil-date', match: 'possible', grain: 'day',
      start: '2026-05-01', end: '2026-05-31', pageSize: 1,
      continuation: paged.continuation! })).rejects.toBeInstanceOf(EventQueryRestart);

    const competing = await Promise.all(['2026-07', '2026-08'].map(lexical => post('/v1/events/observations',
      makeBody(eventA, lexical, correction.observationRevision!))));
    expect(competing.map(response => response.status).sort()).toEqual([201, 409]);
    const winner = competing.find(response => response.status === 201)!;
    const winnerData = await winner.json() as { observationRevision: string };

    // A correction committed after the snapshot but before generation activation must fence it.
    const originalQuery = fuseki.query.bind(fuseki);
    let injected = false;
    fuseki.query = async (sparql: string) => {
      if (!injected && sparql.includes('SELECT ?epoch ?sequence WHERE')) {
        injected = true;
        await write(eventA, '2026-07', winnerData.observationRevision);
      }
      return originalQuery(sparql);
    };
    try {
      await expect(queries.query({ interpretation: 'civil-date', match: 'possible', grain: 'day',
        start: '2030-01-01', end: '2030-01-01', pageSize: 10 })).rejects.toBeInstanceOf(EventQueryRestart);
      expect(injected).toBe(true);
    } finally { fuseki.query = originalQuery; }
    const recovered = await queries.query({ interpretation: 'civil-date', match: 'possible', grain: 'day',
      start: '2030-01-01', end: '2030-01-01', pageSize: 10 }) as { sourcePosition: { sequence: string } };
    expect(BigInt(recovered.sourcePosition.sequence)).toBeGreaterThan(BigInt(first.sourcePosition!.sequence));
  } finally {
    await identity.close();
    await Promise.all([access.end(), contentPool.end()]);
    await databases.close();
  }
}, 30_000);
