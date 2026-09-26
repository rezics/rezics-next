import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { classificationPropositionDigest, createClassificationProposition }
  from '../../../services/main/src/modules/classification/proposition.ts';
import { sourceAcquisitionServices } from '../../../services/main/src/modules/source/acquisition.ts';
import { readVndbConceptRun } from '../../../services/main/src/modules/source/vndb-concept-run.ts';
import { projectVndbConceptCaptures } from '../../../services/main/src/modules/source/field-vndb.ts';
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import { exportRoutes } from '../../../services/main/src/routes/exports.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { captureVndbFixtureRun, vndbConceptBodies } from '../fixtures/vndb-concept.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { contextFixture, nativeId, RV } from './context-fixture.ts';

const agent = () => `https://rezics.com/id/${randomUUID()}`;

test('LIVE01/LIVE07: frozen VNDB concept evidence exports exact source dispositions with qualified residuals', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Use the isolated QA integration tier');
  }
  const databases = await cloneQaOwnerDatabases(runId, ['account', 'access', 'content']);
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
  const contentPool = new Pool({ connectionString: databases.urls.content, max: 4 });
  const objectDirectory = resolve('.temp', `export-vndb-${randomUUID()}`);
  mkdirSync(objectDirectory, { recursive: true, mode: 0o700 });
  let account: Awaited<ReturnType<typeof ratingAccount>> | undefined;
  try {
    await migrateContent(contentPool);
    account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as
      Record<string, string>, 'openid export:create export:read');
    const principalId = randomUUID();
    const actor = agent();
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,$2,$3)`, [principalId, account.issuer, account.a.id]);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')`, [actor]);

    const source = sourceAcquisitionServices(contentPool, { reserve: async () => {} });
    const sourceBodies = new Map<string, Buffer>(vndbConceptBodies('base'));
    const run = await captureVndbFixtureRun(source.runs, principalId, `vndb-export-${randomUUID()}`,
      sourceBodies);
    const snapshot = await readVndbConceptRun(source.runs, principalId, run.run.split('/').at(-1)!);
    const selection = { kind: 'vndb-concept-run', reference: snapshot.run,
      expectedPosition: snapshot.position } as const;
    const grant = async (scope: string, action: string) => {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, actor, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
    };

    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL, Bun.env.FUSEKI_MAINTENANCE_TOKEN,
      Bun.env.FUSEKI_COMMAND_TOKEN);
    const dependencies = { environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH }, objectDirectory },
      account: account.verifier, access: new AccessAdmissionRegistry(accessPool),
      exports: new ExportStore(contentPool), sourceAcquisitions: source } as MainWorkDependencies;
    const app = exportRoutes(dependencies);
    const body = { profile: 'export-create-v1', actingSubject: actor, useScope: 'evaluation', selection };
    const call = (method: string, path: string, payload?: object, key = `export-${randomUUID()}`,
      token: string | null = account!.tokenA) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}) }));

    expect((await call('POST', '/v1/exports', body, 'no-token', null)).status).toBe(401);
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [`export:${snapshot.run}`]);
    expect((await call('POST', '/v1/exports', body, 'access-denied')).status).toBe(403);
    await grant(`export:${snapshot.run}`, 'export.create');
    const created = await call('POST', '/v1/exports', body, 'vndb-source-export');
    expect(created.status, await created.clone().text()).toBe(201);
    const saved = await created.json() as { manifestId: string; manifestDigest: string; plan: {
      targetProfile: string; completeness: string; licenseScope: string;
      members: Array<{ exactRef: string; sourceGrain: string; data: Record<string, unknown> }>;
      residuals: Array<{ kind: string; detail: Record<string, unknown> }>;
      work: { members: number; residuals: number; bytes: number } } };
    expect(saved.plan.targetProfile).toBe('rezics-vndb-concept-source-v1');
    expect(saved.plan.completeness).toBe('partial');
    expect(saved.plan.licenseScope).toBe('uncertain');
    expect(saved.plan.members).toHaveLength(5);
    expect(saved.plan.members.every(member => member.data.rightsIdentity !== undefined)).toBe(true);
    expect(saved.plan.members.slice(0, 4).map(member =>
      (member.data.rightsIdentity as { target: { resource: string; revision: string } }).target.revision))
      .toEqual(saved.plan.members.slice(0, 4).map(member => member.exactRef));
    expect(saved.plan.work).toMatchObject({ members: 5, residuals: 1 });
    expect(saved.plan.work.bytes).toBeLessThanOrEqual(1_048_576);
    expect(saved.plan.members.slice(0, 4).map(member => member.sourceGrain))
      .toEqual(['source_observation', 'source_observation', 'source_observation', 'source_observation']);
    for (const member of saved.plan.members.slice(0, 4)) {
      const original = sourceBodies.get(member.data.surface as string);
      expect(original).toBeDefined();
      expect(Buffer.from(member.data.rawBytesBase64 as string, 'base64')).toEqual(original);
    }
    const vn = saved.plan.members.find(member => member.data.surface === 'vn')!;
    expect(Buffer.from(vn.data.rawBytesBase64 as string, 'base64').toString()).toContain('"rating":2.500');
    const projection = saved.plan.members.at(-1)!.data.projection as { concepts: Array<{ sourceId: string;
      label: string; display: string }>; claims: Array<{ kind: string; unresolved: string | null;
      release: string | null; role: string | null; spoiler: number;
      score: { kind: string; lexical: string } | null; lie: boolean | null }>;
      fieldInventory: Array<{ grain: string; field: string; disposition: string; reason: string }> };
    expect(projection.concepts.filter(concept => concept.label === 'Lead').map(concept => concept.sourceId))
      .toEqual(['vndb:tag:g1', 'vndb:tag:g2', 'vndb:trait:i1']);
    expect(projection.concepts.find(concept => concept.sourceId === 'vndb:trait:i1')?.display).toBe('Role / Lead');
    expect(projection.claims.find(claim => claim.unresolved === 'vndb:tag:g99')).toMatchObject({
      kind: 'tag', score: { kind: 'decimal', lexical: '1' }, spoiler: 0, lie: false,
    });
    expect(projection.claims.filter(claim => claim.kind === 'appearance').map(claim =>
      [claim.release, claim.role, claim.spoiler])).toEqual([
      ['vndb:release:r1', 'main', 0], ['vndb:release:r2', 'side', 2],
    ]);
    expect(projection.fieldInventory).toContainEqual(expect.objectContaining({ grain: 'vn',
      field: 'tags.rating', disposition: 'structured-source-only' }));
    expect(saved.plan.residuals).toContainEqual(expect.objectContaining({ kind: 'qualified_claim',
      detail: expect.objectContaining({ count: 5 }) }));
    expect(saved.plan.members.at(-1)!.data.exportDisposition).toMatchObject({
      status: 'exact-source-capture', nativeDisposition: 'candidate-only',
      residual: 'Native Statement export needs a separately accepted Context, speaker and decision.',
    });

    expect((await call('POST', '/v1/exports', body, 'vndb-source-export')).status).toBe(200);
    const read = await call('GET', `/v1/exports/${saved.manifestId}`);
    expect(read.status, await read.clone().text()).toBe(200);
    expect((await read.json() as { manifestDigest: string }).manifestDigest).toBe(saved.manifestDigest);
    expect((await call('GET', `/v1/exports/${saved.manifestId}`, undefined, 'other-user', account.tokenB)).status)
      .toBe(403);
    const stale = { ...body, selection: { ...selection,
      expectedPosition: { ...selection.expectedPosition, dataEpoch: '0'.repeat(64) } } };
    expect((await call('POST', '/v1/exports', stale, 'vndb-stale')).status).toBe(409);
  } finally {
    await account?.close();
    await Promise.all([accessPool.end(), contentPool.end()]);
    await databases.close();
    rmSync(objectDirectory, { recursive: true, force: true });
  }
}, 120_000);

test('LIVE07: source concepts stay distinct while a named narrower concept round-trips in two accepted Context meanings',
  async () => {
    const f = await contextFixture(Bun.env as Record<string, string>);
    try {
      const bodies = vndbConceptBodies('base');
      const captures = [...bodies.entries()].map(([kind, bytes]) => ({ kind, bytes,
        digest: createHash('sha256').update(bytes).digest('hex'), complete: true }));
      const projection = projectVndbConceptCaptures(captures);
      const tagG1 = projection.concepts.find(concept => concept.sourceId === 'vndb:tag:g1')!;
      const tagG2 = projection.concepts.find(concept => concept.sourceId === 'vndb:tag:g2')!;
      expect([tagG1.label, tagG2.label]).toEqual(['Lead', 'Lead']);
      expect(tagG1.sourceId).not.toBe(tagG2.sourceId);
      expect(projection.nativeCandidates.find(candidate => candidate.sourceId === tagG1.sourceId))
        .toMatchObject({ target: 'classification-proposition-v1#concept' });
      const realmA = await f.realm('VNDB tag interpretation');
      const realmB = await f.realm('VNDB trait interpretation');

      const proposition = async (label: string) => {
        const input = { label, actingSubject: f.actorA };
        const digest = classificationPropositionDigest(input);
        const admission: RegisteredAdmission = { id: randomUUID(), principalId: randomUUID(),
          actingSubject: f.actorA, scope: 'classification:define:global', action: 'classification.proposition.define',
          idempotencyKey: `vndb-proposition-${randomUUID()}`, requestDigest: digest, authorityEpoch: '0',
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), state: 'claimed',
          dispatchEligible: true, replayed: false };
        const receipt = await createClassificationProposition(f.env, admission, input);
        if (receipt.outcome !== 'succeeded' || !receipt.definitions) throw new Error('native concept fixture failed');
        return receipt.definitions;
      };
      const narrowG1 = await proposition('Lead (content concept)');
      const narrowG2 = await proposition('Lead (technical concept)');
      const meaningA = await proposition('Lead interpreted as a work tag');
      const meaningB = await proposition('Lead interpreted as a character trait');
      expect(narrowG1.concept).not.toBe(narrowG2.concept);

      const relation = `${RV}classifiedAs`;
      await f.grant('context:create:root', 'context.create');
      const context = async (definition: string) => f.json<{ context: string; semanticRevision: string }>(
        await f.call('POST', '/v1/contexts', { profile: 'context-v1', role: 'shared', disclosure: 'public',
          base: null, entries: [{ target: narrowG1.concept, relation, state: 'defined', definition,
            applicability: [] }], actingSubject: f.actorA }), 201);
      const contextA = await context(meaningA.sense);
      const contextB = await context(meaningB.sense);
      const select = async (realm: { realm: string }, selected: typeof contextA) => {
        await f.grant(`context:select:${realm.realm}`, 'context.select');
        return f.call('POST', `/v1/realms/${realm.realm.split('/').at(-1)}/context-selections`, {
          profile: 'context-selection-v1', scope: { kind: 'object', object: narrowG1.concept },
          selection: { context: selected.context, semanticRevision: selected.semanticRevision },
          expectedHead: null, actingSubject: f.actorA });
      };
      expect((await select(realmA, contextA)).status).toBe(201);
      expect((await select(realmB, contextB)).status).toBe(201);
      const work = await f.work('VNDB contextual source claim');
      if (!work.mainVersion) throw new Error('native Work fixture failed');
      const record = async (realm: { realm: string }) => {
        await f.grant(`statement:speak:${realm.realm}`, 'statement.record');
        return f.json<{ statement: string; meaningKey: string }>(await f.call('POST', '/v1/statements', {
          profile: 'statement-v1', speaker: { kind: 'realm', realm: realm.realm }, subject: work.mainVersion,
          predicate: relation, relationDefinition: nativeId(), value: { kind: 'resource', iri: narrowG1.concept },
          applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA,
        }), 201);
      };
      const statementA = await record(realmA);
      const statementB = await record(realmB);
      expect(statementA.meaningKey).not.toBe(statementB.meaningKey);
      const decide = async (realm: { realm: string }, statement: string) => {
        await f.grant(`classification:decide:${realm.realm}`, 'statement.decide');
        return f.json<{ decision: string; slot: string }>(await f.call('POST', '/v1/statement-decisions', {
          profile: 'statement-decision-v1', target: { kind: 'statement', statement },
          acceptance: { kind: 'realm', realm: realm.realm }, expectedDecisionHead: null,
          outcome: 'accepted', actingSubject: f.actorA }), 201);
      };
      const acceptanceA = await decide(realmA, statementA.statement);
      const acceptanceB = await decide(realmB, statementB.statement);
      expect(acceptanceA.slot).not.toBe(acceptanceB.slot);
      const resolve = async (realm: { realm: string }, statement: string) => f.json<{ result: {
        state: string; source?: string; decision?: string } }>(await f.call('POST', '/v1/statement-resolutions', {
        profile: 'statement-resolution-v1', target: { kind: 'statement', statement },
        acceptance: { kind: 'realm', realm: realm.realm },
      }), 200);
      expect(await resolve(realmA, statementA.statement)).toMatchObject({ result: {
        state: 'accepted', source: 'local', decision: acceptanceA.decision,
      } });
      expect(await resolve(realmB, statementB.statement)).toMatchObject({ result: {
        state: 'accepted', source: 'local', decision: acceptanceB.decision,
      } });
      const read = async (statement: string) => f.json<{ speaker: string; meaningBasis: {
        state: string; semanticRevision?: string; interpretationDefinitions?: string[] };
        export: Record<string, unknown> }>(await f.call('GET', `/v1/statements/${statement.split('/').at(-1)}`), 200);
      const readA = await read(statementA.statement);
      const readB = await read(statementB.statement);
      expect(readA).toMatchObject({ speaker: realmA.realm,
        meaningBasis: { state: 'readable', semanticRevision: contextA.semanticRevision,
          interpretationDefinitions: [meaningA.sense] } });
      expect(readB).toMatchObject({ speaker: realmB.realm,
        meaningBasis: { state: 'readable', semanticRevision: contextB.semanticRevision,
          interpretationDefinitions: [meaningB.sense] } });
      expect(readA.export[`${RV}speaker`]).toEqual([{ '@id': realmA.realm }]);
      expect(readB.export[`${RV}speaker`]).toEqual([{ '@id': realmB.realm }]);
      expect(readA.export[`${RV}semanticContextRevision`]).toEqual([{ '@id': contextA.semanticRevision }]);
      expect(readB.export[`${RV}semanticContextRevision`]).toEqual([{ '@id': contextB.semanticRevision }]);
      expect(JSON.parse(JSON.stringify([readA.export, readB.export]))).toEqual([readA.export, readB.export]);
    } finally { await f.close(); }
  }, 120_000);
