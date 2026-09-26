import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { ownerEvidenceCapture, ownerTargetHeads } from '../../../services/main/src/modules/governance/evidence.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { editAdmittedMetadataWork } from '../../../services/main/src/modules/work/edit-admitted.ts';
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
    Record<string, string>, 'openid work:read work:create work:edit realm:reject');
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: join(directory, 'objects'),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! } };
  const registry = new AccessAdmissionRegistry(pool);
  const content = new ContentCore(contentPool);
  const unreadable = new Set<string>();
  // Governance rules have no owner yet: this registry stands in for the current rule revision.
  const rules = new Map<string, { revision: string; digest: string }>();
  const store = new GovernanceStore(pool, ownerEvidenceCapture({
    content: { core: content, canRead: async (_principal, _actor, ids) => new Set(ids.filter(id => !unreadable.has(id))) },
    graph: { env, canReadWork: (principal, actor, work) => registry.canReadWork(principal, actor, work) },
  }), ownerTargetHeads({ graph: env, content: contentPool }), { current: async ref => rules.get(ref) ?? null });
  const app = createMainApp(fuseki, { environment: env, account: account.verifier, access: registry,
    governance: { store } } as MainWorkDependencies);
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
  const call = async (method: string, path: string, token: string, body?: object) => {
    const response = await app.handle(new Request(`http://main.local${path}`, { method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
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
    { title: 'Reported original title', actingSubject: author, idempotencyKey: `gov-work-${randomUUID()}` });
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
  return { pool, contentPool, account, env, registry, store, rules, unreadable, grant, call, author, work, body,
    close, edit: (expectedHead: string, title: string) => editAdmittedMetadataWork(env, account.verifier, registry,
      new Request('https://main.rezics.test/v1/works', { headers: { authorization: `Bearer ${account.tokenA}` } }),
      { work: work.work, expectedHead, title, actingSubject: author, idempotencyKey: randomUUID() }) };
}

const realm = () => `https://rezics.com/id/${randomUUID()}`;
function reportBody(s: { author: string; work: { work: string } }, context: string, scopeId: string,
  evidence: object[], key = randomUUID(), component = 'title') {
  return { profile: 'content-report-v1', actingSubject: s.author,
    authority: { kind: 'realm', scopeId }, context, target: { owner: 'graph', resource: s.work.work, component },
    disclosure: 'parties', reasonCode: 'misleading', statement: 'The title misrepresents the work.',
    evidence, idempotencyKey: key };
}

test('GOV01: reports anchor exact name, body, empty and unsupported grains without substituting current heads', async () => {
  const s = await governanceStack('gov01');
  try {
    const context = realm();
    const scope = `governance:realm:${context}`;
    await s.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    const bodyRevision = await s.body('Reported body text');
    const erased = await s.body('Body later erased');
    await s.contentPool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL,
      body = NULL WHERE id = $1`, [erased]);
    const unknownRevision = agent();
    const evidence = [
      { owner: 'graph', resource: s.work.work, component: 'title', revision: s.work.workRevision, locator: null },
      { owner: 'graph', resource: s.work.mainVersion, component: 'body', revision: s.work.mainRevision, locator: null },
      { owner: 'content', resource: s.work.work, component: 'body', revision: bodyRevision, locator: '/text' },
      { owner: 'content', resource: s.work.work, component: 'body', revision: erased, locator: null },
      { owner: 'graph', resource: s.work.work, component: 'title', revision: unknownRevision, locator: null },
      { owner: 'graph', resource: s.work.work, component: 'structure', revision: null, locator: 'chapter/2' },
      { owner: 'media', resource: agent(), component: 'media_use', revision: null, locator: null },
    ];
    const key = randomUUID();
    const created = await s.call('POST', '/v1/reports', s.account.tokenA, reportBody(s, context, scope, evidence, key));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const exactBody = (await new ContentCore(s.contentPool).readExactBatch([bodyRevision], async ids => new Set(ids)))[0]!;
    expect(created.body.evidence.map((item: { component: string; revision: string | null; state: string;
      revisionDigest: string | null }) => [item.component, item.revision, item.state, item.revisionDigest !== null]))
      .toEqual([
        ['title', s.work.workRevision, 'available', true],
        ['body', s.work.mainRevision, 'empty', false],
        ['body', bodyRevision, 'available', true],
        ['body', erased, 'erased', false],
        ['title', unknownRevision, 'unavailable', false],
        ['structure', null, 'unsupported', false],
        ['media_use', null, 'unsupported', false],
      ]);
    expect(created.body.evidence[2].revisionDigest).toBe(exactBody.status === 'available'
      ? exactBody.reference.byteDigest : 'missing');

    // Idempotent intake; a changed body under the same key conflicts; nothing is duplicated.
    const replay = await s.call('POST', '/v1/reports', s.account.tokenA, reportBody(s, context, scope, evidence, key));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ reportId: created.body.reportId, replayed: true });
    expect((await s.call('POST', '/v1/reports', s.account.tokenA,
      reportBody(s, context, scope, evidence.slice(0, 2), key))).status).toBe(409);

    // Bulk reports on the same target join one case but keep independent evidence.
    const second = await s.call('POST', '/v1/reports', s.account.tokenA,
      reportBody(s, context, scope, evidence.slice(0, 1)));
    expect(second.body.caseId).toBe(created.body.caseId);
    expect(second.body.reportId).not.toBe(created.body.reportId);
    expect(second.body.evidenceDigest).not.toBe(created.body.evidenceDigest);

    // A reporter who cannot read the exact revision cannot report it; nothing is written.
    s.unreadable.add(bodyRevision);
    const denied = await s.call('POST', '/v1/reports', s.account.tokenA, reportBody(s, context, scope,
      [{ owner: 'content', resource: s.work.work, component: 'body', revision: bodyRevision, locator: null }]));
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
    s.rules.set('https://rezics.com/id/rule-misleading-titles', { revision: 'rule-r1', digest: digest('rule-r1') });
    const decision = (index: number, overrides: Record<string, unknown> = {}) => ({
      profile: 'moderation-decision-v1', outcome: 'restrict', caseId: reports[index].caseId, expectedGeneration: '0',
      actingSubject: moderators[index], targets: [{ owner: 'graph', resource: s.work.work, component: 'title',
        locator: null, scopeKind: 'exact_revision', revision: s.work.workRevision, expectedHead: s.work.workRevision,
        effect: 'disclosure' }],
      rule: { ref: 'https://rezics.com/id/rule-misleading-titles', revision: 'rule-r1', digest: digest('rule-r1') },
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
    s.rules.set('https://rezics.com/id/rule-misleading-titles', { revision: 'rule-r2', digest: digest('rule-r2') });
    expect((await decide(reviewedAfterEdit)).body.code).toBe('stale_governance_basis');
    // Evidence that is not the case's retained evidence cannot be substituted.
    s.rules.set('https://rezics.com/id/rule-misleading-titles', { revision: 'rule-r1', digest: digest('rule-r1') });
    expect((await decide({ ...reviewedAfterEdit, evidenceDigest: digest('other') })).body.code)
      .toBe('stale_governance_basis');
    expect((await s.pool.query('SELECT count(*)::int AS n FROM access.moderation_decision WHERE case_id IS NOT NULL'))
      .rows[0].n).toBe(0);
    // Re-reviewed against the current head, the decision restricts only the exact reported revision.
    const restricted = await decide(reviewedAfterEdit);
    expect(restricted.status, JSON.stringify(restricted.body)).toBe(201);
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

    // Realm 2 decides independently on the same component.
    const second = await decide(decision(1, { targets: [{ owner: 'graph', resource: s.work.work, component: 'title',
      locator: null, scopeKind: 'exact_revision', revision: s.work.workRevision, expectedHead: edited.revision,
      effect: 'disclosure' }] }));
    expect(second.status).toBe(201);

    // GOV03: competing reversals of Realm 1's decision have one effect.
    const reversal = (key: string) => decision(0, { outcome: 'reverse', expectedGeneration: '1',
      reversesDecisionId: restricted.body.decisionId, idempotencyKey: key,
      targets: [{ owner: 'graph', resource: s.work.work, component: 'title', locator: null,
        scopeKind: 'exact_revision', revision: s.work.workRevision, expectedHead: edited.revision,
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
