import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { ownerEvidenceCapture, ownerTargetHeads } from '../../../services/main/src/modules/governance/evidence.ts';
import { ownerModerationEffects } from '../../../services/main/src/modules/governance/effects.ts';
import { ContentModeration } from '../../../services/content/src/moderation.ts';
import { GLOBAL_CONTEXT, GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { GovernanceRules } from '../../../services/main/src/modules/governance/rules.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { reportRoutes } from '../../../services/main/src/routes/reports.ts';
import { editAdmittedMetadataWork } from '../../../services/main/src/modules/work/edit-admitted.ts';
import { readCompositionPage } from '../../../services/main/src/modules/structure/read.ts';
import { MediaStore } from '../../../services/main/src/modules/media/store.ts';
import { png } from './media-support.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';

const root = resolve(import.meta.dir, '../../..');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const agent = () => `https://rezics.com/id/${randomUUID()}`;

async function governanceStack(name: string) {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL) throw new Error('Use the QA integration tier');
  const directory = join(root, '.temp', `governance-${name}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access', 'content']);
  const pool = new Pool({ connectionString: databases.urls.access, max: 8 });
  const contentPool = new Pool({ connectionString: databases.urls.content, max: 4 });
  await migrateContent(contentPool);
  const account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as
    Record<string, string>, 'openid work:read work:create work:edit governance:report governance:decide');
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: join(directory, 'objects'),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! } };
  const objects = (prefix: string) => new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix });
  const workObjects = objects('semantic/work/');
  await workObjects.initialize();
  env.workObjects = workObjects;
  const structureObjects = objects('semantic/structure/');
  await structureObjects.initialize();
  Object.assign(env, { structureObjects });
  await objects('media/').initialize();
  const registry = new AccessAdmissionRegistry(pool, Bun.env.FUSEKI_TITLE_ADMISSION_KEY);
  const content = new ContentCore(contentPool);
  const unreadable = new Set<string>();
  const rules = new GovernanceRules(pool);
  const ownerHeads = ownerTargetHeads({ graph: env, content: contentPool });
  let afterHeadRead: (() => Promise<void>) | null = null;
  let beforeOwnerApply: { ordinal: number; work: () => Promise<void> } | null = null;
  let loseOwnerResponse = false;
  let targetHeadReads = 0;
  let ownerApplies = 0;
  const ownerEffects = ownerModerationEffects(new ContentModeration(contentPool), env);
  const store = new GovernanceStore(pool, ownerEvidenceCapture({
    content: { core: content, canRead: async (_principal, _actor, ids) => new Set(ids.filter(id => !unreadable.has(id))) },
    graph: { env, canReadWork: (principal, actor, work) => registry.canReadWork(principal, actor, work) },
    media: { pool: contentPool, canReadWork: (principal, actor, work) =>
      registry.canReadWork(principal, actor, work) },
  }), { current: async target => {
    targetHeadReads++;
    const head = await ownerHeads.current(target);
    const race = afterHeadRead;
    afterHeadRead = null;
    if (race) await race();
    return head;
  } }, rules, { apply: async (operationId, ordinal, target) => {
    ownerApplies++;
    const race = beforeOwnerApply?.ordinal === ordinal ? beforeOwnerApply.work : null;
    if (race) { beforeOwnerApply = null; await race(); }
    await ownerEffects.apply(operationId, ordinal, target);
    if (loseOwnerResponse) { loseOwnerResponse = false; throw new Error('lost owner CAS response'); }
  } });
  const app = createMainApp(fuseki, { environment: env, account: account.verifier, access: registry,
    governance: { store, rules }, content, structureObjects,
    media: { store: new MediaStore(contentPool, content), content, objects } } as MainWorkDependencies);
  const principals = new Map<string, string>();
  const principalOf = async (user: { id: string }) => {
    if (!principals.has(user.id)) {
      const id = randomUUID();
      await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)
        ON CONFLICT (account_issuer, account_subject) DO NOTHING`, [id, account.issuer, user.id]);
      principals.set(user.id, (await pool.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2`, [account.issuer, user.id])).rows[0]!.id);
    }
    return principals.get(user.id)!;
  };
  /** Access fixture: the user represents the Agent and the Agent holds the grant on the scope gate. */
  const grant = async (user: { id: string }, actor: string, scope: string, action: string) => {
    const principal = await principalOf(user);
    await pool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent') ON CONFLICT DO NOTHING`, [actor]);
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), principal, actor, action]);
    await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action,
      valid_until) VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
  };
  const call = async (method: string, path: string, token: string, body?: object, key?: string) => {
    const response = await app.handle(new Request(`http://main.local${path}`, { method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json',
        ...('idempotencyKey' in body ? { 'idempotency-key': String(body.idempotencyKey) } : {}) } : {}),
      ...(key ? { 'idempotency-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined }));
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  // Author/reporter Agent with a real Work and a real Content body revision.
  const author = agent();
  await grant(account.a, author, 'work:create:root', 'work.create');
  const bearer = (token: string) => new Request('https://main.rezics.test/v1/works',
    { headers: { authorization: `Bearer ${token}` } });
  const work = await createAdmittedMetadataWork(env, account.verifier, registry, bearer(account.tokenA),
    { title: 'Reported original title', semanticTypes: ['https://schema.org/Book'],
      actingSubject: author, idempotencyKey: `gov-work-${randomUUID()}` });
  await grant(account.a, author, `work:read:${work.work}`, 'work.read');
  await grant(account.a, author, `work:edit:${work.work}`, 'work.edit');
  const body = async (text: string) => {
    const saved = await content.saveDraft({ operationId: `gov-body-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work.work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { fixture: 'governance-report' }, serializedJson: JSON.stringify({ text }) });
    return saved.revisionId!;
  };
  const close = async () => {
    await account.close();
    await Promise.all([pool.end(), contentPool.end()]);
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { pool, contentPool, account, env, registry, store, rules, unreadable, grant, call,
    handle: (request: Request) => app.handle(request), author, work, body,
    targetHeadReadCount: () => targetHeadReads,
    ownerApplyCount: () => ownerApplies,
    raceHeadOnce: (work: () => Promise<void>) => { afterHeadRead = work; },
    raceOwnerOnce: (work: () => Promise<void>) => { beforeOwnerApply = { ordinal: 1, work }; },
    raceOwnerAt: (ordinal: number, work: () => Promise<void>) => { beforeOwnerApply = { ordinal, work }; },
    loseOwnerResponseOnce: () => { loseOwnerResponse = true; },
    close, edit: (expectedHead: string, title: string) => editAdmittedMetadataWork(env, account.verifier, registry,
      new Request('https://main.rezics.test/v1/works', { headers: { authorization: `Bearer ${account.tokenA}` } }),
      { work: work.work, expectedHead, title, actingSubject: author, idempotencyKey: randomUUID() }) };
}

const realm = () => `https://rezics.com/id/${randomUUID()}`;

test('GOV02: a published rule has an exact scoped head, immutable revisions and an API CAS receipt', async () => {
  const s = await governanceStack('rule');
  try {
    const rules = s.rules;
    const app = reportRoutes({ account: s.account.verifier, governance: { store: s.store, rules } } as
      unknown as MainWorkDependencies);
    const scope = `governance:realm:${realm()}`;
    const actor = agent();
    await s.grant(s.account.b, actor, scope, 'governance.rule.publish');
    const call = async (path: string, body: Record<string, unknown>, token = s.account.tokenB,
      header: string | null = body.idempotencyKey as string | null) => {
      const response = await app.handle(new Request(`http://main.local${path}`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          ...(header ? { 'idempotency-key': header } : {}) }, body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const first = { profile: 'governance-rule-v1', ref: `urn:rezics:rule:${randomUUID()}`, scopeId: scope,
      actingSubject: actor, expectedRevision: null, document: { policy: 'restricted-exact-title' },
      idempotencyKey: randomUUID() };
    expect((await call('/v1/governance/rules', first, s.account.tokenA)).status).toBe(403);
    expect((await call('/v1/governance/rules', first, s.account.tokenB, null)).status).toBe(400);
    const published = await call('/v1/governance/rules', first);
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({ ref: first.ref, revision: '1', replayed: false });
    expect((await call('/v1/governance/rules', first)).body).toMatchObject({ revision: '1', replayed: true });
    expect((await call('/v1/governance/rules', { ...first, document: { policy: 'different' } })).status).toBe(409);
    const query = { profile: 'governance-rule-query-v1', ref: first.ref, scopeId: scope, actingSubject: actor };
    expect((await call('/v1/governance/rule-queries', query)).body).toMatchObject({
      revision: '1', digest: published.body.digest });
    const stale = { ...first, idempotencyKey: randomUUID(), document: { policy: 'successor' } };
    expect((await call('/v1/governance/rules', stale)).status).toBe(409);
    const successor = await call('/v1/governance/rules', { ...stale, expectedRevision: '1' });
    expect(successor.body).toMatchObject({ revision: '2' });
    expect(await rules.current(first.ref, scope)).toEqual({ revision: '2', digest: successor.body.digest });
    expect(await rules.current(first.ref, `governance:realm:${realm()}`)).toBeNull();
    expect((await s.pool.query('SELECT revision::text, digest FROM access.governance_rule_revision WHERE ref = $1 ORDER BY revision',
      [first.ref])).rows).toEqual([{ revision: '1', digest: published.body.digest },
      { revision: '2', digest: successor.body.digest }]);
    await expect(s.pool.query('DELETE FROM access.governance_rule_revision WHERE ref = $1', [first.ref]))
      .rejects.toThrow('immutable');
  } finally { await s.close(); }
}, 180_000);

test('GOV02: partial Content acceptance and stale graph CAS leave Access unchanged', async () => {
  const s = await governanceStack('gov02-partial');
  try {
    const scope = `governance:platform:${randomUUID()}`;
    const moderator = agent();
    await s.grant(s.account.b, moderator, scope, 'governance.moderate');
    await s.grant(s.account.b, moderator, scope, 'governance.rule.publish');
    const bodyRevision = await s.body('Exact body under review');
    const evidence = [
      { owner: 'content', resource: s.work.work, component: 'body',
        revision: bodyRevision, locator: null },
      { owner: 'graph', resource: s.work.work, component: 'title',
        revision: s.work.workRevision, locator: null },
    ];
    const report = await s.call('POST', '/v1/reports', s.account.tokenA, {
      ...reportBody(s, GLOBAL_CONTEXT, scope, evidence),
      authority: { kind: 'platform', scopeId: scope },
    });
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const published = await s.call('POST', '/v1/governance/rules', s.account.tokenB, {
      profile: 'governance-rule-v1', ref: `urn:rezics:rule:${randomUUID()}`,
      scopeId: scope, actingSubject: moderator, expectedRevision: null,
      document: { policy: 'two-owner-exact-review' }, idempotencyKey: randomUUID(),
    });
    expect(published.status).toBe(201);
    let newTitleHead: string | null = null;
    s.raceOwnerAt(2, async () => {
      newTitleHead = (await s.edit(s.work.workRevision, 'Title changed after Content accepted')).revision;
    });
    const decision = await s.call('POST', '/v1/moderation/decisions', s.account.tokenB, {
      profile: 'moderation-decision-v1', caseId: report.body.caseId, expectedGeneration: '0',
      actingSubject: moderator, outcome: 'restrict',
      targets: [
        { owner: 'content', resource: s.work.work, component: 'body', locator: null,
          scopeKind: 'exact_revision', revision: bodyRevision, expectedHead: bodyRevision,
          effect: 'disclosure' },
        { owner: 'graph', resource: s.work.work, component: 'title', locator: null,
          scopeKind: 'exact_revision', revision: s.work.workRevision,
          expectedHead: s.work.workRevision, effect: 'disclosure' },
      ],
      rule: { ref: published.body.ref, revision: published.body.revision,
        digest: published.body.digest }, evidenceDigest: report.body.evidenceDigest,
      reversesDecisionId: null, answersStepId: null, rationale: 'Exact two-owner review',
      disclosure: 'parties', idempotencyKey: randomUUID(),
    });
    expect(decision.status, JSON.stringify(decision.body)).toBe(409);
    expect(decision.body.code).toBe('stale_governance_basis');
    expect(newTitleHead).not.toBeNull();
    expect(s.ownerApplyCount()).toBe(2);
    expect((await s.contentPool.query(`SELECT count(*)::int AS n FROM content.moderation_effect
      WHERE resource_id = $1 AND expected_head = $2`, [s.work.work, bodyRevision])).rows[0].n).toBe(1);
    expect((await s.pool.query(`SELECT count(*)::int AS n FROM access.moderation_decision
      WHERE case_id = $1`, [report.body.caseId])).rows[0].n).toBe(0);
    expect(await s.store.readEnforcement({ owner: 'content', resource: s.work.work, component: 'body' }))
      .toEqual([]);
    expect(await s.store.readEnforcement({ owner: 'graph', resource: s.work.work, component: 'title' }))
      .toEqual([]);
    const retained = await s.call('GET', `/v1/reports/${report.body.reportId}`, s.account.tokenA);
    expect(retained.body.evidence).toEqual([
      expect.objectContaining({ revision: bodyRevision, state: 'available' }),
      expect.objectContaining({ revision: s.work.workRevision, state: 'available' }),
    ]);
  } finally { await s.close(); }
}, 180_000);

function reportBody(s: { author: string; work: { work: string } }, context: string, scopeId: string,
  evidence: object[], key = randomUUID(), component = 'title') {
  return { profile: 'content-report-v1', actingSubject: s.author,
    authority: { kind: 'realm', scopeId }, context, target: { owner: 'graph', resource: s.work.work, component },
    disclosure: 'parties', reasonCode: 'misleading', statement: 'The title misrepresents the work.',
    evidence, idempotencyKey: key };
}

test('GOV01: reports anchor exact name, body, Structure and media use with empty and unavailable states', async () => {
  const s = await governanceStack('gov01');
  try {
    const context = realm();
    const scope = `governance:realm:${context}`;
    await s.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    const bodyRevision = await s.body('Reported body text');
    const erased = await s.body('Body later erased');
    await s.contentPool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL,
      body = NULL WHERE id = $1`, [erased]);
    const composition = await s.call('POST', '/v1/compositions', s.account.tokenA,
      { profile: 'book-composition', work: s.work.work, mainVersion: s.work.mainVersion,
        actingSubject: s.author }, randomUUID());
    expect(composition.status, JSON.stringify(composition.body)).toBe(201);
    const structure = composition.body.structure as string;
    const emptyStructureRevision = composition.body.revision as string;
    const structurePath = `/v1/compositions/${structure.slice('https://rezics.com/id/'.length)}/changes`;
    const inserted = await s.call('POST', structurePath, s.account.tokenA,
      { profile: 'book-composition', expectedHead: emptyStructureRevision, actingSubject: s.author,
        operations: [{ op: 'insert', parent: structure, position: 'last', role: 'chapter',
          target: s.work.work, sourceKey: 'reported-chapter' },
        { op: 'insert', parent: structure, position: 'last', role: 'chapter',
          target: s.work.work, sourceKey: 'retained-chapter' }] }, randomUUID());
    expect(inserted.status, JSON.stringify(inserted.body)).toBe(200);
    const populatedStructureRevision = inserted.body.revision as string;
    const occurrence = inserted.body.occurrences[0] as string;
    await s.grant(s.account.a, s.author, `media:owner:${s.author}`, 'media.upload');
    await s.grant(s.account.a, s.author, `content:draft:${s.work.work}`, 'content.draft');
    const bytes = png(32, 32);
    const reserve = await s.call('POST', '/v1/media/uploads', s.account.tokenA,
      { profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png',
        byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        disclosure: 'public', actingSubject: s.author }, randomUUID());
    expect(reserve.status, JSON.stringify(reserve.body)).toBe(201);
    const upload = reserve.body as { upload: string; asset: string };
    const activatedResponse = await s.handle(new Request(`http://main.local/v1/media/uploads/${upload.upload}/bytes`,
      { method: 'PUT', headers: { authorization: `Bearer ${s.account.tokenA}` },
        body: new Blob([new Uint8Array(bytes)]) }));
    const activated = await activatedResponse.json() as { revision: string };
    expect(activatedResponse.status, JSON.stringify(activated)).toBe(201);
    const publication = await s.call('POST', '/v1/media/publications', s.account.tokenA,
      { profile: 'media-set-v1', resourceId: s.work.work, variantId: `urn:rezics:variant:${randomUUID()}`,
        expectedHead: null, assets: [upload.asset], actingSubject: s.author }, randomUUID());
    expect(publication.status, JSON.stringify(publication.body)).toBe(201);
    const use = (publication.body as { body: { items: Array<{ use: string }> } }).body.items[0]!.use;
    const unknownRevision = agent();
    const evidence = [
      { owner: 'graph', resource: s.work.work, component: 'title', revision: s.work.workRevision, locator: null },
      { owner: 'graph', resource: s.work.work, component: 'name', revision: s.work.workRevision, locator: null },
      { owner: 'graph', resource: s.work.mainVersion, component: 'body', revision: s.work.mainRevision, locator: null },
      { owner: 'content', resource: s.work.work, component: 'body', revision: bodyRevision, locator: '/text' },
      { owner: 'content', resource: s.work.work, component: 'body', revision: erased, locator: null },
      { owner: 'graph', resource: s.work.work, component: 'title', revision: unknownRevision, locator: null },
      { owner: 'graph', resource: structure, component: 'structure',
        revision: emptyStructureRevision, locator: null },
      { owner: 'graph', resource: structure, component: 'structure',
        revision: populatedStructureRevision, locator: occurrence },
      { owner: 'graph', resource: structure, component: 'structure',
        revision: unknownRevision, locator: null },
      { owner: 'graph', resource: agent(), component: 'structure', revision: unknownRevision, locator: null },
      { owner: 'media', resource: s.work.work, component: 'media_use',
        revision: activated.revision, locator: use },
      { owner: 'media', resource: s.work.work, component: 'media_use',
        revision: activated.revision, locator: randomUUID() },
    ];
    const key = randomUUID();
    const structureReport = { ...reportBody(s, context, scope, evidence, key, 'structure'),
      target: { owner: 'graph', resource: structure, component: 'structure' } };
    const wrongRealm = realm();
    expect((await s.call('POST', '/v1/reports', s.account.tokenA,
      { ...structureReport, authority: { kind: 'realm', scopeId: `governance:realm:${wrongRealm}` } }))
      .status).toBe(400);
    expect((await s.pool.query('SELECT count(*)::int AS n FROM access.governance_report')).rows[0].n).toBe(0);
    const created = await s.call('POST', '/v1/reports', s.account.tokenA, structureReport);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const exactBody = (await new ContentCore(s.contentPool).readExactBatch([bodyRevision], async ids => new Set(ids)))[0]!;
    expect(created.body.evidence.map((item: { component: string; revision: string | null; state: string;
      revisionDigest: string | null }) => [item.component, item.revision, item.state, item.revisionDigest !== null]))
      .toEqual([
        ['title', s.work.workRevision, 'available', true],
        ['name', s.work.workRevision, 'available', true],
        ['body', s.work.mainRevision, 'empty', false],
        ['body', bodyRevision, 'available', true],
        ['body', erased, 'erased', false],
        ['title', unknownRevision, 'unavailable', false],
        ['structure', emptyStructureRevision, 'empty', false],
        ['structure', populatedStructureRevision, 'available', true],
        ['structure', unknownRevision, 'unavailable', false],
        ['structure', unknownRevision, 'unavailable', false],
        ['media_use', activated.revision, 'available', true],
        ['media_use', activated.revision, 'unavailable', false],
      ]);
    expect(created.body.evidence[3].revisionDigest).toBe(exactBody.status === 'available'
      ? exactBody.reference.byteDigest : 'missing');
    const exactOccurrence = await readCompositionPage(s.env, { structure,
      revision: populatedStructureRevision, occurrence, limit: 1, canReadTarget: async () => true });
    expect(exactOccurrence.occurrences[0]).toMatchObject({ occurrence, state: 'active', target: s.work.work });
    expect(created.body.evidence[7].revisionDigest).toBe(digest(JSON.stringify([
      structure, populatedStructureRevision, exactOccurrence.occurrences[0]])));
    // The manifest, record and two order-position lookups stay bounded independently of placement count.
    expect(exactOccurrence.cost.pagesRead).toBeLessThanOrEqual(4);

    // Idempotent intake; a changed body under the same key conflicts; nothing is duplicated.
    const replay = await s.call('POST', '/v1/reports', s.account.tokenA, structureReport);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ reportId: created.body.reportId, replayed: true });
    expect((await s.call('POST', '/v1/reports', s.account.tokenA,
      { ...structureReport, evidence: evidence.slice(0, 2) })).status).toBe(409);

    // Bulk reports on the same target join one case but keep independent evidence.
    const second = await s.call('POST', '/v1/reports', s.account.tokenA,
      { ...structureReport, evidence: evidence.slice(0, 1), idempotencyKey: randomUUID() });
    expect(second.body.caseId).toBe(created.body.caseId);
    expect(second.body.reportId).not.toBe(created.body.reportId);
    expect(second.body.evidenceDigest).not.toBe(created.body.evidenceDigest);

    // A reporter who cannot read the exact revision cannot report it; nothing is written.
    s.unreadable.add(bodyRevision);
    const denied = await s.call('POST', '/v1/reports', s.account.tokenA, reportBody(s, context, scope,
      [evidence[7]!, { owner: 'content', resource: s.work.work, component: 'body',
        revision: bodyRevision, locator: null }]));
    expect(denied.status).toBe(403);
    expect((await s.pool.query('SELECT count(*)::int AS n FROM access.governance_report')).rows[0].n).toBe(2);
    // An Agent the caller does not represent cannot report.
    const foreign = reportBody(s, context, scope, evidence.slice(0, 1));
    expect((await s.call('POST', '/v1/reports', s.account.tokenA, { ...foreign, actingSubject: agent() })).status)
      .toBe(403);

    // A later edit changes the head, not the retained exact evidence.
    const edited = await s.edit(s.work.workRevision, 'Corrected title');
    const read = await s.call('GET', `/v1/reports/${created.body.reportId}`, s.account.tokenA);
    expect(read.status).toBe(200);
    expect(read.body.evidence[0]).toMatchObject({ revision: s.work.workRevision, state: 'available' });
    expect(read.body.evidence[0].revision).not.toBe(edited.revision);
    // Another caller without case authority sees nothing.
    expect((await s.call('GET', `/v1/reports/${created.body.reportId}`, s.account.tokenB)).status).toBe(404);
    // Reviewers receive the report through their case authority.
    const reviewer = agent();
    await s.grant(s.account.b, reviewer, scope, 'governance.moderate');
    const reviewed = await s.call('GET', `/v1/reports/${created.body.reportId}?actingSubject=${encodeURIComponent(reviewer)}`,
      s.account.tokenB);
    expect(reviewed.body).toMatchObject({ caseState: 'open', decisionHead: null });
  } finally { await s.close(); }
}, 180_000);

test('GOV02/GOV03: stale target or rule never applies; reversals have one effect and Realm contexts stay independent', async () => {
  const s = await governanceStack('gov02');
  try {
    const realms = [realm(), realm()];
    const scopes = realms.map(value => `governance:realm:${value}`);
    const moderators = [agent(), agent()];
    await s.grant(s.account.b, moderators[0]!, scopes[0]!, 'governance.moderate');
    await s.grant(s.account.b, moderators[1]!, scopes[1]!, 'governance.moderate');
    await s.grant(s.account.b, moderators[0]!, scopes[0]!, 'governance.rule.publish');
    await s.grant(s.account.b, moderators[1]!, scopes[1]!, 'governance.rule.publish');
    const titleEvidence = [{ owner: 'graph', resource: s.work.work, component: 'title', revision: s.work.workRevision,
      locator: null }];
    const reports = [];
    for (const [index, context] of realms.entries()) {
      const created = await s.call('POST', '/v1/reports', s.account.tokenA,
        reportBody(s, context, scopes[index]!, titleEvidence));
      expect(created.status).toBe(201);
      reports.push(created.body);
    }
    expect(reports[0].caseId).not.toBe(reports[1].caseId);
    const refs = realms.map(value => `urn:rezics:rule:misleading-title:${value.split('/').at(-1)}`);
    const publish = (index: number, expectedRevision: string | null, document: object) =>
      s.call('POST', '/v1/governance/rules', s.account.tokenB, { profile: 'governance-rule-v1',
        ref: refs[index], scopeId: scopes[index], actingSubject: moderators[index], expectedRevision,
        document, idempotencyKey: randomUUID() });
    const ruleBasis: Array<{ ref: string; revision: string; digest: string }> = [];
    for (const index of [0, 1]) {
      const published = await publish(index, null, { policy: 'review-exact-title', realm: realms[index] });
      expect(published.status).toBe(201);
      ruleBasis.push({ ref: refs[index]!, revision: published.body.revision as string,
        digest: published.body.digest as string });
    }
    const decision = (index: number, overrides: Record<string, unknown> = {}) => ({
      profile: 'moderation-decision-v1', outcome: 'restrict', caseId: reports[index].caseId, expectedGeneration: '0',
      actingSubject: moderators[index], targets: [{ owner: 'graph', resource: s.work.work, component: 'title',
        locator: null, scopeKind: 'exact_revision', revision: s.work.workRevision, expectedHead: s.work.workRevision,
        effect: 'disclosure' }],
      rule: ruleBasis[index],
      evidenceDigest: reports[index].evidenceDigest, reversesDecisionId: null, answersStepId: null,
      rationale: 'Misleading title', disclosure: 'parties', idempotencyKey: randomUUID(), ...overrides });
    const decide = (body: object, token = s.account.tokenB) => s.call('POST', '/v1/moderation/decisions', token, body);

    // Authority: the other Realm's moderator and a caller without grants are denied.
    expect((await decide({ ...decision(0), actingSubject: moderators[1] })).status).toBe(403);
    expect((await decide(decision(0), s.account.tokenA)).status).toBe(403);

    // GOV02: the target changes during review; the reviewed basis is stale and nothing is written.
    const edited = await s.edit(s.work.workRevision, 'Title changed during review');
    const stale = await decide(decision(0));
    expect(stale.body.code).toBe('stale_governance_basis');
    expect((await decide(decision(0, { targets: [{ owner: 'graph', resource: s.work.work,
      component: 'title', locator: null, scopeKind: 'exact_revision', revision: s.work.workRevision,
      expectedHead: null, effect: 'disclosure' }] }))).body.code).toBe('stale_governance_basis');
    // The rule changes during review: stale as well.
    const reviewedAfterEdit = decision(0, { targets: [{ owner: 'graph', resource: s.work.work, component: 'title',
      locator: null, scopeKind: 'exact_revision', revision: s.work.workRevision, expectedHead: edited.revision,
      effect: 'disclosure' }] });
    const successor = await publish(0, '1', { policy: 'review-exact-title-v2', realm: realms[0] });
    expect(successor.status).toBe(201);
    expect((await decide(reviewedAfterEdit)).body.code).toBe('stale_governance_basis');
    // Evidence that is not the case's retained evidence cannot be substituted.
    ruleBasis[0] = { ref: refs[0]!, revision: successor.body.revision as string,
      digest: successor.body.digest as string };
    const reReviewed = { ...reviewedAfterEdit, rule: ruleBasis[0] };
    expect((await decide({ ...reReviewed, evidenceDigest: digest('other') })).body.code)
      .toBe('stale_governance_basis');
    expect((await s.pool.query('SELECT count(*)::int AS n FROM access.moderation_decision WHERE case_id IS NOT NULL'))
      .rows[0].n).toBe(0);
    // A graph edit lands after the first owner read but before the Access decision commit.
    let racedHead: string | null = null;
    s.raceOwnerOnce(async () => { racedHead = (await s.edit(edited.revision,
      'Title changed during decision commit')).revision; });
    const readsBeforeRace = s.targetHeadReadCount();
    const raced = await decide(reReviewed);
    expect(raced.body.code).toBe('stale_governance_basis');
    expect(s.targetHeadReadCount() - readsBeforeRace).toBe(2);
    expect(racedHead).not.toBeNull();
    expect((await s.pool.query('SELECT count(*)::int AS n FROM access.moderation_decision WHERE case_id = $1',
      [reports[0].caseId])).rows[0].n).toBe(0);
    expect((await s.store.readEnforcement({ owner: 'graph', resource: s.work.work, component: 'title' }))
      .filter(fence => fence.context === realms[0])).toEqual([]);
    // A fresh review against the new head can still act on the exact reported revision.
    const freshReview = { ...reReviewed, targets: [{ ...reReviewed.targets[0]!, expectedHead: racedHead }] };
    const readsBeforeFreshReview = s.targetHeadReadCount();
    s.loseOwnerResponseOnce();
    const lostGraph = await decide(freshReview);
    expect(lostGraph.status).toBe(503);
    expect((await s.pool.query('SELECT count(*)::int AS n FROM access.moderation_decision WHERE case_id = $1',
      [reports[0].caseId])).rows[0].n).toBe(0);
    const restricted = await decide(freshReview);
    expect(restricted.status, JSON.stringify(restricted.body)).toBe(201);
    expect(s.targetHeadReadCount() - readsBeforeFreshReview).toBe(4);
    const graphEvents = await s.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?batch ?event ?sequence WHERE {
        GRAPH <urn:rezics:graph:outbox> { ?batch rv:event ?event .
          ?event a rv:ModerationEffectAcceptedEvent ; rv:receipt ?receipt . }
        GRAPH <urn:rezics:graph:receipts> { ?receipt rv:work <${s.work.work}> ; rv:sequence ?sequence . }
      }`);
    expect(graphEvents.results?.bindings).toHaveLength(1);
    const graphEvent = graphEvents.results!.bindings[0]!;
    const delivered = await readMainOutboxEnvelope(s.env.fuseki, {
      batchId: graphEvent.batch!.value, eventIds: [graphEvent.event!.value],
      dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH!,
      sequence: graphEvent.sequence!.value }, graphEvent.event!.value);
    expect(delivered.type).toBe('com.rezics.governance.moderation-effect-accepted.v1');
    const summary = (context: string) => s.call('GET',
      `/v1/resources/${s.work.work.split('/').at(-1)}?actingSubject=${encodeURIComponent(s.author)}`
      + `&context=${encodeURIComponent(context)}`, s.account.tokenA);
    // The Access fence names the prior exact revision; the edited current title remains readable.
    expect((await summary(realms[0]!)).status).toBe(200);
    const otherTarget = { owner: 'graph', resource: agent(), component: 'title', locator: null,
      scopeKind: 'component', revision: null, expectedHead: null, effect: 'disclosure' };
    expect((await decide(decision(0, { expectedGeneration: '1', targets: [otherTarget] }))).status).toBe(403);
    expect(restricted.body.enforcement).toEqual([{ owner: 'graph', resource: s.work.work, component: 'title',
      revision: s.work.workRevision, effect: 'disclosure', state: 'restricted', fenceEpoch: '1' }]);
    const fences = await s.store.readEnforcement({ owner: 'graph', resource: s.work.work, component: 'title' });
    expect(fences.filter(fence => fence.revision === edited.revision)).toEqual([]);
    // The exact evidence stays retained and readable after the target changed.
    const evidenceAfter = await s.call('GET', `/v1/reports/${reports[0].reportId}`, s.account.tokenA);
    expect(evidenceAfter.body.evidence[0]).toMatchObject({ revision: s.work.workRevision, state: 'available' });
    // A concurrent reviewer holding the old case generation is stale.
    expect((await decide(decision(0, { outcome: 'dismiss', targets: [] }))).body.code).toBe('stale_governance_basis');

    // Realm 2 explicitly restricts the component, independent of Realm 1's exact old revision.
    const second = await decide(decision(1, { targets: [{ owner: 'graph', resource: s.work.work, component: 'title',
      locator: null, scopeKind: 'component', revision: null, expectedHead: racedHead,
      effect: 'disclosure' }] }));
    expect(second.status).toBe(201);
    expect((await summary(realms[0]!)).status).toBe(200);
    expect((await summary(realms[1]!)).status).toBe(404);

    // GOV03: competing reversals of Realm 1's decision have one effect.
    const reversal = (key: string) => decision(0, { outcome: 'reverse', expectedGeneration: '1',
      reversesDecisionId: restricted.body.decisionId, idempotencyKey: key,
      targets: [{ owner: 'graph', resource: s.work.work, component: 'title', locator: null,
        scopeKind: 'exact_revision', revision: s.work.workRevision, expectedHead: racedHead,
        effect: 'disclosure' }] });
    expect((await decide({ ...reversal('wrong-target'), targets: [{ ...reversal('unused').targets[0],
      effect: 'publication' }] })).body.code).toBe('stale_governance_basis');
    const competing = await Promise.all([decide(reversal('reverse-a')), decide(reversal('reverse-b'))]);
    expect(competing.map(response => response.status).sort()).toEqual([201, 409]);
    const winner = competing.find(response => response.status === 201)!;
    expect(winner.body.enforcement[0]).toMatchObject({ state: 'released', fenceEpoch: '2' });
    // The winner's retry replays; a late second reversal against the new generation still cannot double-apply.
    const winnerKey = competing[0]!.status === 201 ? 'reverse-a' : 'reverse-b';
    const retried = await decide(reversal(winnerKey));
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ decisionId: winner.body.decisionId, replayed: true });
    expect((await decide({ ...reversal('reverse-c'), expectedGeneration: '2' })).status).toBe(409);
    const after = await s.store.readEnforcement({ owner: 'graph', resource: s.work.work, component: 'title' });
    expect(after.map(fence => [fence.context, fence.state, fence.fenceEpoch]).sort()).toEqual([
      [realms[0], 'released', '2'], [realms[1], 'restricted', '1']].sort());
    expect((await summary(realms[0]!)).status).toBe(200);
    expect((await summary(realms[1]!)).status).toBe(404);
    // Reversal appended a decision; the reversed one is preserved; one outbox fact per decision.
    expect((await s.pool.query(`SELECT outcome FROM access.moderation_decision WHERE case_id = $1
      ORDER BY case_sequence`, [reports[0].caseId])).rows.map(row => row.outcome)).toEqual(['restrict', 'reverse']);
    expect((await s.pool.query(`SELECT count(*)::int AS n FROM access.outbox WHERE kind = 'moderation.decided'`))
      .rows[0].n).toBe(3);
    await expect(s.pool.query('DELETE FROM access.moderation_decision WHERE id = $1', [restricted.body.decisionId]))
      .rejects.toThrow('immutable');

    // Cost: case join and fence reads are index ranges on the target, independent of unrelated cases.
    for (const total of [100, 1_000, 10_000]) {
      await s.pool.query(`INSERT INTO access.governance_case (id, kind, authority_kind, authority_scope_id, context,
          target_owner, target_resource, target_component, disclosure)
        SELECT gen_random_uuid(), 'content_report', 'realm', $1, $2, 'graph', 'https://rezics.com/id/' || gen_random_uuid(),
          'title', 'private' FROM generate_series(1, $3::int - (SELECT count(*)::int FROM access.governance_case))`,
      [scopes[1], realms[1], total]);
      await s.pool.query('ANALYZE access.governance_case');
      await s.pool.query('ANALYZE access.governance_enforcement');
      const caseLookup = (await s.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
        SELECT id FROM access.governance_case WHERE target_owner = 'graph' AND target_resource = $1
          AND target_component = 'title' AND context = $2 AND authority_scope_id = $3 AND kind = 'content_report'
          AND state = 'open'`, [s.work.work, realms[0], scopes[0]])).rows[0]['QUERY PLAN'][0].Plan;
      expect(caseLookup['Actual Rows']).toBe(1);
      expect(caseLookup['Shared Hit Blocks'] + caseLookup['Shared Read Blocks']).toBeLessThan(16);
      expect(caseLookup['Temp Read Blocks']).toBe(0);
      const fenceRead = (await s.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
        SELECT context, authority_scope_id, revision, effect, state, fence_epoch, decision_id
        FROM access.governance_enforcement WHERE owner = 'graph' AND resource = $1 AND component = 'title'
        ORDER BY context, authority_scope_id, effect, revision LIMIT 50`, [s.work.work])).rows[0]['QUERY PLAN'][0].Plan;
      expect(fenceRead['Actual Rows']).toBe(2);
      expect(fenceRead['Shared Hit Blocks'] + fenceRead['Shared Read Blocks']).toBeLessThan(16);
    }
  } finally { await s.close(); }
}, 180_000);

test('GOV02: a Content head changing after preflight makes the decision stale', async () => {
  const s = await governanceStack('gov02-content');
  try {
    const scope = `governance:platform:${randomUUID()}`;
    const moderator = agent();
    await s.grant(s.account.b, moderator, scope, 'governance.moderate');
    await s.grant(s.account.b, moderator, scope, 'governance.rule.publish');
    const content = new ContentCore(s.contentPool);
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = async (expectedHead: string | null, text: string) => content.saveDraft({
      operationId: `gov-content-${randomUUID()}`,
      variant: { id: variantId, resourceId: s.work.work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead, model: 'content-shape-v1', sourceRevision: null,
      provenance: { fixture: 'governance-race' }, serializedJson: JSON.stringify({ text }) });
    const original = (await draft(null, 'Reported exact body')).revisionId!;
    const report = await s.call('POST', '/v1/reports', s.account.tokenA, {
      ...reportBody(s, GLOBAL_CONTEXT, scope, [{ owner: 'content', resource: s.work.work,
        component: 'body', revision: original, locator: null }], randomUUID(), 'body'),
      authority: { kind: 'platform', scopeId: scope },
      target: { owner: 'content', resource: s.work.work, component: 'body' },
    });
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const published = await s.call('POST', '/v1/governance/rules', s.account.tokenB,
      { profile: 'governance-rule-v1', ref: `urn:rezics:rule:${randomUUID()}`, scopeId: scope,
        actingSubject: moderator, expectedRevision: null, document: { policy: 'exact-body-disclosure' },
        idempotencyKey: randomUUID() });
    expect(published.status).toBe(201);
    let successor: string | null = null;
    s.raceOwnerOnce(async () => { successor = (await draft(original, 'Edited current body')).revisionId!; });
    const readsBeforeRace = s.targetHeadReadCount();
    const decisionInput = { profile: 'moderation-decision-v1', caseId: report.body.caseId, expectedGeneration: '0',
        actingSubject: moderator, outcome: 'restrict', targets: [{ owner: 'content', resource: s.work.work,
          component: 'body', locator: null, scopeKind: 'exact_revision', revision: original,
          expectedHead: original, effect: 'disclosure' }],
        rule: { ref: published.body.ref, revision: published.body.revision,
          digest: published.body.digest }, evidenceDigest: report.body.evidenceDigest,
        reversesDecisionId: null, answersStepId: null, rationale: 'Exact body only',
        disclosure: 'parties', idempotencyKey: randomUUID() };
    const decision = await s.call('POST', '/v1/moderation/decisions', s.account.tokenB, decisionInput);
    expect(decision.status, JSON.stringify(decision.body)).toBe(409);
    expect(decision.body.code).toBe('stale_governance_basis');
    expect(s.targetHeadReadCount() - readsBeforeRace).toBe(2);
    expect(successor).not.toBeNull();
    expect((await s.pool.query('SELECT count(*)::int AS n FROM access.moderation_decision WHERE case_id = $1',
      [report.body.caseId])).rows[0].n).toBe(0);
    expect((await s.contentPool.query(`SELECT count(*)::int AS n FROM content.moderation_effect
      WHERE resource_id = $1`, [s.work.work])).rows[0].n).toBe(0);
    const currentBasis = { ...decisionInput, idempotencyKey: randomUUID(), targets: [{
      ...decisionInput.targets[0]!, expectedHead: successor,
    }] };
    const readsBeforeFreshReview = s.targetHeadReadCount();
    s.loseOwnerResponseOnce();
    const lostContent = await s.call('POST', '/v1/moderation/decisions', s.account.tokenB, currentBasis);
    expect(lostContent.status).toBe(503);
    expect((await s.pool.query('SELECT count(*)::int AS n FROM access.moderation_decision WHERE case_id = $1',
      [report.body.caseId])).rows[0].n).toBe(0);
    const applied = await s.call('POST', '/v1/moderation/decisions', s.account.tokenB, currentBasis);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect(s.targetHeadReadCount() - readsBeforeFreshReview).toBe(4);
    expect(s.ownerApplyCount()).toBe(3);
    expect((await s.contentPool.query(`SELECT expected_head::text, effect FROM content.moderation_effect
      WHERE resource_id = $1`, [s.work.work])).rows).toEqual([{
      expected_head: successor, effect: 'disclosure',
    }]);
    expect((await s.contentPool.query(`SELECT count(*)::int AS n FROM content.outbox
      WHERE recipe = 'governance-moderation-v1' AND payload->>'resource' = $1`,
    [s.work.work])).rows[0].n).toBe(1);
    const recovered = await s.call('POST', '/v1/moderation/decisions', s.account.tokenB, currentBasis);
    expect(recovered.status).toBe(200);
    expect(recovered.body.decisionId).toBe(applied.body.decisionId);
    expect((await s.contentPool.query(`SELECT count(*)::int AS n FROM content.moderation_effect
      WHERE resource_id = $1`, [s.work.work])).rows[0].n).toBe(1);
    const read = (revision: string) => s.call('GET',
      `/v1/content-revisions/${revision}?actingSubject=${encodeURIComponent(s.author)}`,
      s.account.tokenA);
    expect((await read(original)).status).toBe(404);
    expect((await read(successor!)).status).toBe(200);
    // Native owner plan stays bounded as unrelated variants grow.
    for (const total of [100, 1_000, 10_000]) {
      await s.contentPool.query(`INSERT INTO content.variant
        (id, resource_id, language_kind, direction)
        SELECT 'urn:rezics:variant:cost:' || g::text, 'urn:rezics:resource:cost', 'und', 'none'
        FROM generate_series(1, $1::int) AS g ON CONFLICT DO NOTHING`, [total]);
      await s.contentPool.query('ANALYZE content.variant');
      const plan = (await s.contentPool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
        SELECT v.id FROM content.revision r JOIN content.variant v ON v.id = r.variant_id
        WHERE r.id = $1::uuid AND v.resource_id = $2 FOR UPDATE OF v`,
      [original, s.work.work])).rows[0]['QUERY PLAN'][0].Plan;
      expect(plan['Actual Rows']).toBe(1);
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(32);
      expect(plan['Temp Read Blocks']).toBe(0);
    }
  } finally { await s.close(); }
}, 180_000);
