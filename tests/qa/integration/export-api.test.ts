import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { createAdmittedTextContribution } from '../../../services/main/src/modules/contribution/create-admitted.ts';
import { publishAdmittedTextContribution } from '../../../services/main/src/modules/contribution/publish-admitted.ts';
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import { createAdmittedFixedRelease, readFixedRelease } from '../../../services/main/src/modules/work/fixed-release.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { selectAdmittedMainDefault } from '../../../services/main/src/modules/work/select-main-admitted.ts';
import { exportRoutes } from '../../../services/main/src/routes/exports.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
const agent = () => `https://rezics.com/id/${randomUUID()}`;

test('LIVE10: real fixed Main Version export pins its owner position, residuals and current disclosure', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Use the isolated QA integration tier');
  }
  const databases = await cloneQaOwnerDatabases(runId, ['account', 'access', 'content']);
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
  const contentPool = new Pool({ connectionString: databases.urls.content, max: 4 });
  const directory = join(root, '.temp', `export-api-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let account: Awaited<ReturnType<typeof ratingAccount>> | undefined;
  try {
    await migrateContent(contentPool);
    account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as
      Record<string, string>, 'openid export:create export:read');
    const principalId = randomUUID();
    const actor = agent();
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const environment = { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
      routingEpoch: Bun.env.MAIN_ROUTING_EPOCH }, objectDirectory: directory };
    const registry = new AccessAdmissionRegistry(accessPool);
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,$2,$3)`, [principalId, account.issuer, account.a.id]);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')`, [actor]);
    const grant = async (scope: string, action: string) => {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, actor, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
    };
    const principal = await account.verifier.verify(new Request('http://main.local',
      { headers: { authorization: `Bearer ${account.tokenA}` } }), ['export:create']);
    const setupAccount = { verify: async () => principal };
    const setupRequest = new Request('http://main.local', { headers: { authorization: 'Bearer setup' } });
    await grant('work:create:root', 'work.create');
    const work = await createAdmittedMetadataWork(environment, setupAccount, registry, setupRequest,
      { title: 'Export fixture', actingSubject: actor,
        semanticTypes: ['https://schema.org/Book'], idempotencyKey: `work-${randomUUID()}` });
    await grant(`contribution:create:${work.work}`, 'contribution.create');
    const draft = await createAdmittedTextContribution(environment, setupAccount, registry, setupRequest,
      { work: work.work, language: 'en', body: 'Rights-unassessed body stays out of this export',
        actingSubject: actor, idempotencyKey: `draft-${randomUUID()}` });
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('Contribution fixture was unavailable');
    }
    await grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    const publication = await publishAdmittedTextContribution(environment, setupAccount, registry, setupRequest,
      { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
        actingSubject: actor, idempotencyKey: `publication-${randomUUID()}` });
    if (publication.outcome !== 'succeeded' || !publication.publicationDecision) {
      throw new Error('Publication fixture was unavailable');
    }
    await grant(`publication:select:${work.mainVersion}`, 'publication.select');
    const selection = await selectAdmittedMainDefault(environment, setupAccount, registry, setupRequest,
      { context: { kind: 'main-version-default', id: work.mainVersion }, work: work.work,
        contribution: draft.contribution, publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor,
        idempotencyKey: `selection-${randomUUID()}` });
    if (selection.outcome !== 'succeeded' || !selection.selection || !selection.mainRevision) {
      throw new Error('Main selection fixture was unavailable');
    }
    await grant(`release:seal:${work.mainVersion}`, 'release.seal');
    const sealed = await createAdmittedFixedRelease(environment, setupAccount, registry, setupRequest,
      { work: work.work, mainVersion: work.mainVersion,
        expectedMainRevision: selection.mainRevision, expectedSelection: selection.selection,
        actingSubject: actor, idempotencyKey: `release-${randomUUID()}` });
    const exact = await readFixedRelease(environment, sealed.release, async () => true);
    await grant(`work:read:${work.work}`, 'work.read');
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [`export:${sealed.release}`]);
    const store = new ExportStore(contentPool);
    const dependencies = { environment, account: account.verifier, access: registry,
      exports: store } as MainWorkDependencies;
    const app = exportRoutes(dependencies);
    const body = { profile: 'export-create-v1', actingSubject: actor, useScope: 'evaluation',
      selection: { kind: 'fixed-release', reference: sealed.release,
        expectedPosition: { dataEpoch: exact.sourcePosition.dataEpoch,
          sequence: exact.sourcePosition.sequence } } };
    const call = (method: string, path: string, payload?: object, key = `export-${randomUUID()}`,
      token: string | null = account!.tokenA) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}) }));
    expect((await call('POST', '/v1/exports', body, 'missing-token', null)).status).toBe(401);
    expect([401, 403]).toContain((await call('POST', '/v1/exports', body,
      'missing-scope', account.noScope)).status);
    expect((await call('POST', '/v1/exports', body, 'denied')).status).toBe(403);
    await grant(`export:${sealed.release}`, 'export.create');
    const created = await call('POST', '/v1/exports', body, 'accepted');
    expect(created.status, await created.clone().text()).toBe(201);
    const saved = await created.json() as { manifestId: string; manifestDigest: string;
      plan: { licenseScope: string; completeness: string; members: Array<{ sourceGrain: string;
        exactRef: string; data: Record<string, unknown> }>; residuals: Array<{ kind: string }> } };
    expect(saved.plan.members).toHaveLength(1);
    expect(saved.plan.members[0]?.sourceGrain).toBe('main_version');
    expect(saved.plan.members[0]?.exactRef).toBe(exact.mainRevision);
    expect(saved.plan.members[0]?.data.body).toBeUndefined();
    expect(saved.plan.residuals.map(item => item.kind)).toEqual(['missing_member', 'rights_excluded']);
    expect(saved.plan.completeness).toBe('partial');
    expect(saved.plan.licenseScope).toBe('uncertain');
    expect((await call('POST', '/v1/exports', body, 'accepted')).status).toBe(200);
    expect((await call('POST', '/v1/exports', { ...body, useScope: 'full' }, 'accepted')).status).toBe(409);
    expect((await call('POST', '/v1/exports', { ...body, selection: {
      ...body.selection, expectedPosition: { ...body.selection.expectedPosition, sequence: '0' } } },
    'stale')).status).toBe(409);
    const missingRelease = agent();
    await grant(`export:${missingRelease}`, 'export.create');
    expect((await call('POST', '/v1/exports', { ...body, selection: {
      ...body.selection, reference: missingRelease } }, 'missing-release')).status).toBe(404);
    const blockedApp = exportRoutes({ ...dependencies, exportRights: async (members, useScope) => [{
      basisKind: 'unprotected_fact', basisRef: null, licenseExpression: null, notice: null,
      obligations: [], useScope, result: 'prohibited',
      memberOrdinals: members.map((_, index) => index + 1),
    }] });
    const blocked = await blockedApp.handle(new Request('http://main.local/v1/exports', {
      method: 'POST', headers: { authorization: `Bearer ${account.tokenA}`,
        'content-type': 'application/json', 'idempotency-key': 'blocked-use' },
      body: JSON.stringify(body),
    }));
    expect(blocked.status, await blocked.clone().text()).toBe(403);
    const cancelled = (await accessPool.query<{ id: string; state: string }>(
      `SELECT id, state FROM access.admission WHERE principal_id = $1
       AND action = 'export.create' AND idempotency_key = 'blocked-use'`, [principalId])).rows[0];
    expect(cancelled?.state).toBe('sealed');
    expect((await contentPool.query<{ outcome: string }>(`SELECT outcome FROM content.receipt
      WHERE operation_id = $1`, [`export:${cancelled?.id}`])).rows[0]?.outcome).toBe('rejected');
    expect((await call('GET', `/v1/exports/${randomUUID()}`)).status).toBe(404);
    const read = await call('GET', `/v1/exports/${saved.manifestId}`);
    expect(read.status, await read.clone().text()).toBe(200);
    expect((await read.json() as { manifestDigest: string }).manifestDigest).toBe(saved.manifestDigest);
    await accessPool.query(`UPDATE access.scope_gate SET open = false WHERE id = $1`,
      [`work:read:${work.work}`]);
    expect((await call('GET', `/v1/exports/${saved.manifestId}`)).status).toBe(404);
  } finally {
    await account?.close();
    await Promise.all([accessPool.end(), contentPool.end()]);
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
