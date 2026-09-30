import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessAdmissionRegistry, AdmissionDenied, AdmissionConflict,
  engageAccessRecoveryFence, releaseAccessRecoveryFence,
  type AdmissionRequest, type RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { BASELINE_SPACE_QUOTA_POLICY } from '../../../services/main/src/modules/access/baseline-quota.ts';
import { baselineMemberProof } from '../../../services/main/src/modules/access/baseline.ts';
import { AccessActingContexts, ActingContextDenied } from '../../../services/main/src/modules/access/contexts.ts';
import { AccessSessionAgents } from '../../../services/main/src/modules/access/session-agent.ts';
import { globalContextPattern } from '../../../services/main/src/modules/rating/global.ts';
import { receiptFamilyFor } from '../../../services/main/src/modules/access/receipt-families.ts';
import { createAdmittedTextContribution } from '../../../services/main/src/modules/contribution/create-admitted.ts';
import { publishAdmittedTextContribution } from '../../../services/main/src/modules/contribution/publish-admitted.ts';
import { createAdmittedOwner } from '../../../services/main/src/modules/zone/owner-create.ts';
import { agentProvisionHarness } from './agent-provision-support.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';

const iri = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const bearer = (token: string) => new Request('http://main.local', {
  headers: { authorization: `Bearer ${token}` } });

async function fixture() {
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID!);
  const accountUrl = Bun.env.ACCOUNT_DATABASE_URL;
  const accessUrl = Bun.env.ACCESS_DATABASE_URL;
  Bun.env.ACCOUNT_DATABASE_URL = databases.urls.account;
  Bun.env.ACCESS_DATABASE_URL = databases.urls.access;
  let h: Awaited<ReturnType<typeof agentProvisionHarness>>;
  try { h = await agentProvisionHarness(); }
  catch (error) { await databases.close(); throw error; }
  finally {
    Bun.env.ACCOUNT_DATABASE_URL = accountUrl;
    Bun.env.ACCESS_DATABASE_URL = accessUrl;
  }
  const access = new AccessAdmissionRegistry(h.accessPool);
  access.configureBaseline(h.fuseki);
  const app = createMainApp(h.fuseki, { environment: h.env, account: h.verifier, access });
  async function agent(kind: 'person' | 'organization' = 'person') {
    const response = await h.call(h.main(), h.token, `baseline-${randomUUID()}`, {
      profile: 'agent-provision-v1', kind, displayName: 'Baseline member' });
    expect(response.status).toBe(201);
    return (await response.json() as { agent: string }).agent;
  }
  async function verified() {
    // The fixture controls Account state, never installs Access permissions.
    await h.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [h.user.id]);
    return h.verifier.verify(bearer(h.token), ['agent:create']);
  }
  const subject = await agent();
  async function replacementController(agent: string) {
    // Revoking the caller's mandate preserves the Agent's controller floor.
    await h.accessPool.query(`WITH replacement AS (
      INSERT INTO access.principal (id,account_issuer,account_subject)
      VALUES (gen_random_uuid(),'fixture://replacement',gen_random_uuid()::text) RETURNING id)
      INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      SELECT gen_random_uuid(),id,$1,'agent.control','infinity' FROM replacement`, [agent]);
  }
  function work(key = `baseline-work-${randomUUID()}`, token = h.wrongScopeToken) {
    return app.handle(new Request('http://main.local/v1/works', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': key },
      body: JSON.stringify({ profile: 'metadata-only-v1', language: 'en', title: 'Member Work', actingSubject: subject }) }));
  }
  return { ...h, access, app, subject, agent, verified, work, replacementController,
    close: async () => { await h.close(); await databases.close(); } };
}

test('baseline: current verified email enables real Work creation, without SQL grants; suspension fences the same token', async () => {
  const h = await fixture();
  try {
    expect((await h.work()).status).toBe(403);
    expect((await h.verifier.verify(bearer(h.token), ['agent:create'])).emailVerified).toBeUndefined();
    const principal = await h.verified();
    const key = `baseline-work-${randomUUID()}`;
    const created = await h.work(key);
    expect(created.status).toBe(201);
    const result = await created.json() as { work: string; admissionId: string };
    expect(result.work).toMatch(/^https:\/\/rezics.com\/id\//);
    expect((await h.work(key)).status).toBe(200);
    const grants = await h.accessPool.query('SELECT action,scope_id FROM access.permission_grant WHERE recipient_subject = $1', [h.subject]);
    expect(grants.rows).toEqual([{ action: 'access.membership.consent',scope_id: 'work:create:root' }]);
    const proofs = await h.accessPool.query(`SELECT a.state, b.policy_id FROM access.admission a
      JOIN access.baseline_admission b ON b.admission_id = a.id WHERE a.idempotency_key = $1`, [key]);
    expect(proofs.rows).toEqual([{ state: 'sealed', policy_id: 'baseline-member-v1' }]);
    expect((await h.work(undefined, h.token)).status).toBe(401); // OAuth ceiling still applies.
    const pending = await h.access.register({ principal, actingSubject: h.subject,
      scope: 'work:create:root', action: 'work.create', idempotencyKey: randomUUID(), requestDigest: digest('pending') });
    await expect(h.access.claim(pending.id, pending.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    await h.accountPool.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', [h.user.id]);
    await expect(h.access.claim(pending.id, pending.requestDigest, principal)).rejects.toBeInstanceOf(AdmissionDenied);
    await h.verified();
    await h.accountPool.query(`UPDATE rezics_account_security SET suspended_at = now(),
      generation = generation + 1 WHERE user_id = $1`, [h.user.id]);
    expect((await h.work()).status).toBe(401);
    await expect(h.access.claim(pending.id, pending.requestDigest, principal)).rejects.toBeInstanceOf(AdmissionDenied);
  } finally { await h.close(); }
}, 120_000);

test('baseline: discovery and preflight require verified membership; saved Agent choices require live authority', async () => {
  const h = await fixture();
  try {
    const contexts = new AccessActingContexts(h.accessPool, h.env);
    const choices = new AccessSessionAgents(h.accessPool, contexts);
    const unverified = await h.verifier.verify(bearer(h.token), ['agent:create']);
    expect((await contexts.discover(unverified)).contexts).toEqual([]);
    const principal = await h.verified();
    const penName = await h.agent();
    const organization = await h.agent('organization');
    const discovery = await contexts.discover(principal);
    expect(discovery.contexts.map(row => row.actingSubject).sort()).toEqual([h.subject, penName].sort());
    expect(discovery.directContexts).toEqual([]);
    expect((await contexts.check(principal, penName, discovery.authorityEpoch)).decision).toBe('eligible-now');
    await expect(contexts.check(principal, organization, discovery.authorityEpoch)).rejects.toBeInstanceOf(ActingContextDenied);
    await contexts.setPreference(principal, { actingSubject: penName, expectedRevision: null, idempotencyKey: randomUUID() });
    expect((await contexts.discover(principal)).preferredActingSubject).toBe(penName);
    const session = randomUUID();
    const mainChoice = await choices.setMain(principal, { actingSubject: h.subject, expectedRevision: null, idempotencyKey: randomUUID() });
    expect((await choices.readSession(principal, session)).initialActingSubject).toBe(h.subject);
    const sessionChoice = await choices.setSession(principal, session, { actingSubject: penName, expectedRevision: null, idempotencyKey: randomUUID() });
    expect((await choices.readSession(principal, session)).sessionAgent.eligible).toBe(true);
    await h.accountPool.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', [h.user.id]);
    const current = await h.verifier.verify(bearer(h.token), ['agent:create']);
    expect((await contexts.discover(current)).contexts).toEqual([]);
    // Identity choices remain usable while the provisioned Agent's live control
    // mandate survives, even when verified-member task authority is unavailable.
    expect((await choices.readSession(current, session)).sessionAgent.eligible).toBe(true);
    expect((await choices.readMain(current)).mainAgent.eligible).toBe(true);
    await expect(contexts.check(current, penName, discovery.authorityEpoch)).rejects.toBeInstanceOf(ActingContextDenied);
    await h.replacementController(penName);
    await h.accessPool.query(`UPDATE access.representation SET active = false, generation = generation + 1
      WHERE subject_id = $1 AND action = 'agent.control'
        AND principal_id = (SELECT principal_id FROM access.agent_provision WHERE agent_id = $1)`, [penName]);
    expect((await h.accessPool.query('SELECT state FROM access.agent_provision WHERE agent_id = $1',
      [penName])).rows[0].state).toBe('active');
    expect((await contexts.discoverAgents(current)).items.map(row => row.actingSubject)).not.toContain(penName);
    expect((await choices.readSession(current, session)).sessionAgent).toMatchObject({
      actingSubject: penName, eligible: false });
    await expect(choices.setSession(current, session, { actingSubject: penName,
      expectedRevision: sessionChoice.revision, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ActingContextDenied);
    await expect(choices.setMain(current, { actingSubject: penName,
      expectedRevision: mainChoice.revision, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ActingContextDenied);
    await h.accessPool.query('UPDATE access.baseline_member_policy SET active = false, generation = generation + 1');
    expect((await contexts.discover(await h.verified())).contexts).toEqual([]);
  } finally { await h.close(); }
}, 120_000);

test('baseline: current public targets permit contribution, translation, rating, personal Statements and exact public comments', async () => {
  const h = await fixture();
  try {
    const principal = await h.verified();
    const work = iri();
    const main = iri();
    const contribution = iri();
    const publication = iri();
    const selection = iri();
    const draft = iri();
    const context = iri();
    const privateContext = iri();
    const variant = `urn:rezics:variant:${randomUUID()}`;
    const sourceRevision = randomUUID();
    const contentPublication = iri();
    const eligibility = iri();
    // Owner-state fixture only: no Access admission attributes this Work to the
    // test account. This exercises the public rule, not the own-Work fallback.
    await h.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/>
      INSERT DATA {
        GRAPH <urn:rezics:graph:current> {
          <${work}> a schema:CreativeWork ; rv:head <${iri()}> ; rv:mainVersion <${main}> .
          <${main}> a rv:MainVersion ; rv:work <${work}> ; rv:selectionHead <${selection}> .
          <${contribution}> rv:work <${work}> ; rv:publicationHead <${publication}> .
          ${globalContextPattern(context)} .
          <${privateContext}> a rv:RealmRatingContext ; rv:contextState rv:Active .
          <${variant}> rv:resource <${work}> ; rv:contentPublicationHead <${contentPublication}> ;
            rv:publicSearchEligibilityHead <${eligibility}> .
        }
        GRAPH <urn:rezics:graph:revisions> {
          <${selection}> a rv:PublicationSelection ; rv:work <${work}> ; rv:mainVersion <${main}> ;
            rv:contribution <${contribution}> ; rv:publicationDecision <${publication}> ; rv:selectedDraft <${draft}> .
          <${publication}> a rv:PublicationDecision ; rv:component <${contribution}> ; rv:work <${work}> ;
            rv:contribution <${contribution}> ; rv:disclosure rv:Public ; rv:selectedDraft <${draft}> .
          <${draft}> a rv:RevisionAnchor ; rv:component <${contribution}> .
          <${contentPublication}> a rv:ContentPublicationDecision ; rv:resource <${work}> ;
            rv:contentRevision <urn:rezics:content:revision:${sourceRevision}> .
          <${eligibility}> rv:publicationDecision <${contentPublication}> ; rv:disclosure rv:Public .
        }
      }`);
    const base = { principal, actingSubject: h.subject, requestDigest: digest('public-target') };
    const admit = (action: string, scope: string, extra: Partial<AdmissionRequest> = {}) => h.access.register({
      ...base, action, scope, idempotencyKey: randomUUID(), ...extra });
    for (const [action, scope, extra] of [
      ['contribution.create', `contribution:create:${work}`, {}],
      ['translation.link', `translation:link:${work}`, { baselineRelatedWork: work }],
      ['rating.observation.set', `rating:observe:${context}`, { baselineRelatedWork: work }],
      ['statement.record', `statement:speak:${h.subject}`, {}],
      ['statement.withdraw', `statement:speak:${h.subject}`, {}],
      ['content.comment', `content:comment:${work}`, { baselineSourceRevision: sourceRevision }],
    ] as const) {
      const admission = await admit(action, scope, extra);
      expect((await h.access.claim(admission.id, admission.requestDigest, principal)).state).toBe('claimed');
    }
    await expect(admit('rating.observation.set', `rating:observe:${privateContext}`,
      { baselineRelatedWork: work })).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(admit('statement.record', `statement:speak:${iri()}`)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(admit('translation.link', `translation:link:${work}`,
      { baselineRelatedWork: iri() })).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(admit('content.comment', `content:comment:${work}`,
      { baselineSourceRevision: randomUUID() })).rejects.toBeInstanceOf(AdmissionDenied);
    const comment = await admit('content.comment', `content:comment:${work}`,
      { baselineSourceRevision: sourceRevision });
    await h.fuseki.update(`DELETE WHERE { GRAPH <urn:rezics:graph:current> {
      <${variant}> <https://rezics.com/vocab/publicSearchEligibilityHead> ?head } }`);
    await expect(h.access.claim(comment.id, comment.requestDigest, principal)).rejects.toBeInstanceOf(AdmissionDenied);
    const contributionAdmission = await admit('contribution.create', `contribution:create:${work}`);
    await h.fuseki.update(`DELETE WHERE { GRAPH <urn:rezics:graph:current> {
      <${main}> <https://rezics.com/vocab/selectionHead> ?head } }`);
    await expect(h.access.claim(contributionAdmission.id, contributionAdmission.requestDigest, principal)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(admit('contribution.create', `contribution:create:${work}`)).rejects.toBeInstanceOf(AdmissionDenied);
    await h.access.closeScope(`statement:speak:${h.subject}`, '0');
    await expect(admit('statement.record', `statement:speak:${h.subject}`)).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await h.accessPool.query('SELECT open, authority_epoch::text FROM access.scope_gate WHERE id = $1',
      [`statement:speak:${h.subject}`])).rows).toEqual([{ open: false, authority_epoch: '1' }]);

    const principalId = (await h.accessPool.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_subject = $1', [h.user.id])).rows[0]!.id;
    await h.accessPool.query(`INSERT INTO access.agent_provision (id, principal_id, idempotency_key,
      request_digest, agent_id, agent_kind, display_name, principal_epoch)
      SELECT gen_random_uuid(), $1, 'unrelated-baseline-' || n, repeat('a',64),
        'https://rezics.com/id/' || gen_random_uuid(), 'person', 'Unrelated', 0
      FROM generate_series(1,1024) n`, [principalId]);
    await h.accessPool.query('ANALYZE access.agent_provision');
    const client = await h.accessPool.connect();
    try {
      let captured = { sql: '', args: [] as unknown[] };
      const measured = { query: async (sql: string, args: unknown[]) => {
        captured = { sql, args }; return client.query(sql, args);
      } } as unknown as PoolClient;
      expect(await baselineMemberProof(measured, principalId, h.subject)).not.toBeNull();
      type Plan = { 'Relation Name'?: string; 'Actual Rows': number;
        'Rows Removed by Filter'?: number; Plans?: Plan[] };
      const plan = (await client.query<{ 'QUERY PLAN': [{ Plan: Plan }] }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${captured.sql}`, captured.args)).rows[0]!['QUERY PLAN'][0]!.Plan;
      const visited = (node: Plan): number => (node['Relation Name'] === 'agent_provision'
        ? node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) : 0)
        + (node.Plans ?? []).reduce((sum, child) => sum + visited(child), 0);
      expect(visited(plan)).toBeLessThanOrEqual(2);
    } finally { client.release(); }
  } finally { await h.close(); }
}, 120_000);

test('baseline: owned drafts and Collections work; other private targets and organization Agents stay denied', async () => {
  const h = await fixture();
  try {
    const principal = await h.verified();
    const account = { verify: async () => principal };
    const response = await h.work();
    expect(response.status).toBe(201);
    const work = (await response.json() as { work: string }).work;
    const contribution = await createAdmittedTextContribution(h.env, account, h.access, bearer(h.token), {
      work, language: 'en', body: 'A member draft.', actingSubject: h.subject,
      idempotencyKey: `baseline-contribution-${randomUUID()}` });
    expect(contribution.contribution).toBeDefined();
    const published = await publishAdmittedTextContribution(h.env, account, h.access, bearer(h.token), {
      contribution: contribution.contribution!, expectedDraftHead: contribution.draftRevision!,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: h.subject, idempotencyKey: `baseline-publication-${randomUUID()}` });
    expect(published.publicationDecision).toBeDefined();
    const collection = iri();
    await createAdmittedOwner(h.env, account, h.access, bearer(h.token), {
      kind: 'collection', owner: collection, actingSubject: h.subject, name: 'My shelf',
      disclosure: 'private', idempotencyKey: `baseline-collection-${randomUUID()}`, requestDigest: digest(collection) });
    expect(await h.access.canReadSemanticResource(principal, h.subject, collection)).toBe(true);
    const request: AdmissionRequest = { principal, actingSubject: h.subject,
      scope: `collection:edit:${collection}`, action: 'collection.edit',
      idempotencyKey: randomUUID(), requestDigest: digest(collection) };
    const edit = await h.access.register(request);
    expect((await h.access.claim(edit.id, edit.requestDigest, principal)).state).toBe('claimed');
    const other = await h.agent();
    await expect(h.access.register({ ...request, actingSubject: other, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(h.access.register({ ...request, scope: `collection:edit:${iri()}`, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(h.access.register({ ...request, scope: `contribution:create:${iri()}`,
      action: 'contribution.create', idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(AdmissionDenied);
    const organization = await h.agent('organization');
    await expect(h.access.register({ ...request, actingSubject: organization, scope: 'work:create:root',
      action: 'work.create', idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(AdmissionDenied);
    const pen = await h.access.register({ ...request, actingSubject: other, scope: 'work:create:root',
      action: 'work.create', idempotencyKey: randomUUID() });
    expect(pen.dispatchEligible).toBe(true);
  } finally { await h.close(); }
}, 120_000);

test('baseline: three monthly Spaces share one account quota, concurrent reservations and receipt settlement are exact', async () => {
  const h = await fixture();
  try {
    const principal = await h.verified();
    const pen = await h.agent();
    const request = (actingSubject = h.subject): AdmissionRequest => ({ principal, actingSubject,
      scope: 'space:create:root', action: 'space.create', idempotencyKey: randomUUID(), requestDigest: digest('space') });
    const first = request();
    const admission = await h.access.register(first);
    expect((await h.access.register(first)).id).toBe(admission.id);
    await expect(h.access.register({ ...first, requestDigest: digest('changed') })).rejects.toBeInstanceOf(AdmissionConflict);
    const parallel = await Promise.allSettled([h.access.register(request()),
      h.access.register(request(pen)), h.access.register(request(pen))]);
    expect(parallel.filter(item => item.status === 'fulfilled')).toHaveLength(2);
    expect(parallel.filter(item => item.status === 'rejected')).toHaveLength(1);
    const failed = parallel.find(item => item.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason instanceof AdmissionDenied).toBe(true);
    const ledger = async () => (await h.accessPool.query(`SELECT l.reserved::text, l.consumed::text
      FROM quota.ledger l JOIN access.principal p ON l.beneficiary = 'https://rezics.com/id/' || p.id
      WHERE l.policy_id = $1 AND p.account_subject = $2`, [BASELINE_SPACE_QUOTA_POLICY, h.user.id])).rows;
    expect(await ledger()).toEqual([{ reserved: '3', consumed: '0' }]);
    const terminal = (row: RegisteredAdmission, outcome: 'succeeded' | 'cancelled') => ({
      admissionId: row.id, requestDigest: row.requestDigest, authorityEpoch: row.authorityEpoch,
      scope: row.scope, receipt: `urn:rezics:receipt:${digest(`${row.id}\0${receiptFamilyFor(row.action)}`)}`,
      dataEpoch: 'baseline-fixture', sequence: '1', outcome });
    await expect(h.access.recordGraphOutcome(admission.id,
      { ...terminal(admission, 'cancelled'), requestDigest: digest('wrong') })).rejects.toBeInstanceOf(AdmissionConflict);
    expect(await ledger()).toEqual([{ reserved: '3', consumed: '0' }]);
    await h.access.recordGraphOutcome(admission.id, terminal(admission, 'cancelled'));
    await h.access.recordGraphOutcome(admission.id, terminal(admission, 'cancelled'));
    expect(await ledger()).toEqual([{ reserved: '2', consumed: '0' }]);
    const replacement = await h.access.register(request(pen));
    await h.access.claim(replacement.id, replacement.requestDigest, principal);
    await h.access.recordGraphOutcome(replacement.id, terminal(replacement, 'succeeded'));
    expect(await ledger()).toEqual([{ reserved: '2', consumed: '1' }]);
    await expect(h.access.register(request())).rejects.toBeInstanceOf(AdmissionDenied);
  } finally { await h.close(); }
}, 120_000);

test('baseline: pinned control, principal and policy generations fence retries and claims; recovery remains closed', async () => {
  const h = await fixture();
  try {
    const principal = await h.verified();
    const request: AdmissionRequest = { principal, actingSubject: h.subject, scope: 'work:create:root',
      action: 'work.create', idempotencyKey: randomUUID(), requestDigest: digest('pinned') };
    const admission = await h.access.register(request);
    await h.replacementController(h.subject);
    await h.accessPool.query(`UPDATE access.representation SET active = false, generation = generation + 1
      WHERE subject_id = $1 AND action = 'agent.control'
        AND principal_id = (SELECT principal_id FROM access.agent_provision WHERE agent_id = $1)`, [h.subject]);
    expect((await h.access.register(request)).dispatchEligible).toBe(false);
    await expect(h.access.claim(admission.id, admission.requestDigest, principal)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(h.accessPool.query(`UPDATE access.representation SET active = true, generation = generation + 1
      WHERE subject_id = $1 AND action = 'agent.control'
        AND principal_id = (SELECT principal_id FROM access.agent_provision WHERE agent_id = $1)`, [h.subject]))
      .rejects.toThrow('a revoked controller cannot be restored');
    expect((await h.access.register(request)).dispatchEligible).toBe(false);
    request.actingSubject = await h.agent();
    const next = await h.access.register({ ...request, idempotencyKey: randomUUID() });
    await h.accessPool.query(`UPDATE access.principal SET enforcement_epoch = enforcement_epoch + 1
      WHERE account_subject = $1`, [h.user.id]);
    await expect(h.access.claim(next.id, next.requestDigest, principal)).rejects.toBeInstanceOf(AdmissionDenied);
    const policyAdmission = await h.access.register({ ...request, idempotencyKey: randomUUID() });
    await h.accessPool.query(`UPDATE access.baseline_member_policy SET generation = generation + 1`);
    await expect(h.access.claim(policyAdmission.id, policyAdmission.requestDigest, principal)).rejects.toBeInstanceOf(AdmissionDenied);
    const expiring = await h.access.register({ ...request, idempotencyKey: randomUUID() });
    await h.accessPool.query(`UPDATE access.admission SET expires_at = clock_timestamp() + interval '500 milliseconds'
      WHERE id = $1`, [expiring.id]);
    await expect(h.access.claim(expiring.id, expiring.requestDigest, { ...principal,
      currentAssertion: async () => {
        // A slow authoritative check must not extend the registered lease.
        await Bun.sleep(550);
        return principal;
      } })).rejects.toThrow('baseline admission expired during claim verification');
    const generation = await engageAccessRecoveryFence(h.accessPool);
    try { await expect(h.access.register({ ...request, idempotencyKey: randomUUID() })).rejects.toThrow('Access is held for recovery'); }
    finally { await releaseAccessRecoveryFence(h.accessPool, generation); }
    await h.access.strongDeactivateAccountSubject(principal.issuer, principal.subject);
    await expect(h.access.register({ ...request, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(AdmissionDenied);
  } finally { await h.close(); }
}, 120_000);
