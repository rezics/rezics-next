import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AdmissionDenied, AdmissionUnavailable, AccessAdmissionRegistry }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccessOrgRealmParticipation } from '../../../services/main/src/modules/access/org-realm-participation.ts';
import { AccessOrganizationModeration } from '../../../services/main/src/modules/access/organization-moderation.ts';
import { ORGANIZATION_MODERATION_ACTION, ORGANIZATION_MODERATION_PROFILE }
  from '../../../services/main/src/modules/access/organization-publication.ts';
import { GRAPHS, ID, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { accessStateCoverage } from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { organizationPublisherEvidence } from '../../../services/main/src/modules/work/organization-publication-evidence.ts';
import { organizationRejectionInput } from '../../../services/main/src/modules/work/reject-organization-admitted.ts';
import { realmRejectionDigest, rejectRealmLocal, sealRealmRejectionAdmission }
  from '../../../services/main/src/modules/work/reject-realm.ts';
import { selectAdmittedRealmLocal } from '../../../services/main/src/modules/work/select-realm-admitted.ts';
import { editAdmittedMetadataWork } from '../../../services/main/src/modules/work/edit-admitted.ts';
import { readExactContributionDraft } from '../../../services/main/src/modules/contribution/history.ts';
import { publishAdmittedTextContribution } from '../../../services/main/src/modules/contribution/publish-admitted.ts';
import { createAdmittedRealmSpace } from '../../../services/main/src/modules/space/create-admitted.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { moderationScopes, organizationPublicationFixture } from '../support/organization-publication.ts';

const root = resolve(import.meta.dir, '../../..');

test('IAM23: exact organization publication moderation and suspension affect only the admitted Realm', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL) throw new Error('Use the QA integration tier');
  const directory = join(root, '.temp', `organization-moderation-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  const pool = new Pool({ connectionString: databases.urls.access });
  const accountPool = new Pool({ connectionString: databases.urls.account });
  const account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as Record<string, string>, moderationScopes);
  const costs = { calls: 0, rows: 0, writes: 0, graphCalls: 0, graphBytes: 0, graphWrites: 0 };
  let observe: ((sql: string) => void) | undefined;
  const measured = { connect: async () => {
    const client = await pool.connect();
    return { query: async (sql: string, values?: unknown[]) => {
      costs.calls++; observe?.(sql);
      const result = await client.query(sql, values);
      costs.rows += result.rows.length;
      if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) costs.writes += result.rowCount ?? 0;
      return result;
    }, release: () => client.release() };
  } } as unknown as Pool;
  const rawFuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const fuseki = new Proxy(rawFuseki, { get: (client, key) => {
    const value = Reflect.get(client, key);
    if (key === 'query') return async (...args: Parameters<FusekiClient['query']>) => {
      costs.graphCalls++; const result = await client.query(...args);
      costs.graphBytes += JSON.stringify(result).length; return result;
    };
    if (key === 'commandWithReceipt') return async (...args: Parameters<FusekiClient['commandWithReceipt']>) => {
      costs.graphWrites++; return client.commandWithReceipt(...args);
    };
    return typeof value === 'function' ? value.bind(client) : value;
  } });
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: join(directory, 'objects'),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! } };
  const access = new AccessAdmissionRegistry(pool);
  const owner = new AccessOrganizationModeration(measured);
  const deps = { environment: env, account: account.verifier, access,
    orgRealmParticipation: new AccessOrgRealmParticipation(pool), organizationModeration: owner };
  const app = createMainApp(fuseki, deps);
  const post = (path: string, token: string, body: object, key = randomUUID(), main = app) =>
    main.handle(new Request(`http://main.local${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body) }));
  try {
    const s = await organizationPublicationFixture(pool, env, account.verifier,
      { issuer: account.issuer, realmAccount: account.a.id, orgAccount: account.b.id,
        realmToken: account.tokenA, orgToken: account.tokenB }, post);
    let target = s.target;
    const endpoint = '/v1/organization-publication-rejections';
    const body = () => ({ profile: ORGANIZATION_MODERATION_PROFILE, ...target });
    const moderate = (key = randomUUID(), token = account.tokenA) => post(endpoint, token, body(), key);
    const must = async (response: Response, status: number) => {
      const text = await response.text(); expect(response.status, text).toBe(status);
      return JSON.parse(text);
    };
    const selectionRead = async (realm: string) => {
      const response = await app.handle(new Request(`http://main.local/v1/realms/${realm.slice(ID.length)}/main-versions/${s.work.mainVersion.slice(ID.length)}/selection`));
      return must(response, 200);
    };
    const search = async (realm?: string) => {
      const response = await post('/v1/queries', account.tokenA, realm
        ? { profile: 'public-realm-phrase-v1', context: { kind: 'realm-local', id: realm }, phrase: s.body, language: 'en' }
        : { profile: 'public-main-phrase-v1', phrase: s.body, language: 'en' });
      const result = await must(response, 200); expect(result.complete).toBe(true); return result;
    };
    const nativeBefore = await fuseki.query(`SELECT ?s ?p ?o WHERE {
      GRAPH <${GRAPHS.current}> { VALUES ?s { <${s.work.work}> <${s.draft.contribution}> <${s.work.mainVersion}> } ?s ?p ?o }
    } ORDER BY ?s ?p ?o`);
    const exactDraft = await readExactContributionDraft(env, target.contribution, target.selectedDraft, async () => true);
    expect(exactDraft.author).toBe(s.f.org);
    expect((await search()).total).toBe(1);
    expect((await search(target.realm)).total).toBe(1);
    expect((await search(s.other.realm)).total).toBe(1);
    await must(await moderate(randomUUID(), account.noScope), 401);
    await must(await moderate(randomUUID(), account.tokenB), 403);
    // Independent participation, public authorship, and an organization mandate cannot appoint the Realm manager.
    const self = await s.orgGrant(`publication:reject:${target.realm}`, ORGANIZATION_MODERATION_ACTION);
    await must(await post(endpoint, account.tokenB, { ...body(), actingSubject: s.f.org,
      representationId: self.representationId }), 403);
    const second = ID + randomUUID();
    await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [second]);
    await s.grant(second, s.f.orgPrincipalId, 'space:create:root', 'space.create');
    const secondRealm = await createAdmittedRealmSpace(env, account.verifier, access, s.orgRequest,
      { name: 'Separate manager Realm', actingSubject: second, idempotencyKey: randomUUID() });
    await pool.query(`INSERT INTO access.org_realm_policy (realm, manager_subject, revision, terms_revision)
      VALUES ($1,$2,1,'terms-1')`, [secondRealm.realm, second]);
    const secondProof = await s.grant(second, s.f.orgPrincipalId, `publication:reject:${target.realm}`, ORGANIZATION_MODERATION_ACTION);
    await must(await post(endpoint, account.tokenB, { ...body(), actingSubject: second,
      representationId: secondProof.representationId }), 403);
    // A second Realm has its own exact scope; neither membership nor the target grant crosses it.
    await must(await post(endpoint, account.tokenA, { ...body(), realm: s.other.realm,
      selection: s.other.selection.selection, participationId: s.otherJoined.participationId,
      participationGeneration: s.otherJoined.generation, proposalId: s.otherJoined.proposalId }), 403);
    await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [s.manager.grantId]);
    await s.realmGrant(`publication:reject:${target.realm}`, 'publication.reject');
    await must(await moderate(), 403);
    await pool.query('UPDATE access.permission_grant SET active = true, generation = generation + 1 WHERE id = $1', [s.manager.grantId]);
    await pool.query('UPDATE access.representation SET generation = generation + 1 WHERE id = $1', [s.manager.representationId]);
    await must(await moderate(), 403);
    target = { ...target, representationGeneration: '1' };
    await must(await post(endpoint, account.tokenA, { ...body(), proposalId: randomUUID() }), 409);
    await must(await post(endpoint, account.tokenA, { ...body(), policyRevision: '0' }), 409);
    await must(await post(endpoint, account.tokenA, { ...body(), authorName: 'Organization manager',
      organizationControl: target.realm }), 400);
    await must(await post(endpoint, account.tokenA, { ...body(), organizationSubject: second }), 503);
    const digest = () => realmRejectionDigest(organizationRejectionInput(target));
    await expect(access.register({ principal: s.f.realmPrincipal, actingSubject: target.actingSubject,
      scope: `publication:reject:${target.realm}`, action: ORGANIZATION_MODERATION_ACTION,
      idempotencyKey: randomUUID(), requestDigest: digest() })).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(pool.query("UPDATE access.admission SET action = 'publication.reject.organization' WHERE id = $1",
      [s.published.admissionId])).rejects.toThrow();
    // Hold a row acquired after manager proof selection; expiry must be checked after the wait.
    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT subject FROM access.org_participation_subject WHERE subject = $1 FOR UPDATE', [s.f.org]);
      await pool.query(`UPDATE access.permission_grant SET valid_until = clock_timestamp() + interval '1 second' WHERE id = $1`, [s.manager.grantId]);
      const reached = new Promise<boolean>(resolveReached => { observe = sql => {
        if (sql.includes('SELECT s.generation, o.generation AS admission_generation')) resolveReached(true);
      }; });
      const racing = moderate();
      expect(await Promise.race([reached, Bun.sleep(800).then(() => false)])).toBe(true);
      await Bun.sleep(1050); await lock.query('COMMIT');
      await must(await racing, 403);
    } finally { observe = undefined; await lock.query('ROLLBACK'); lock.release(); }
    await pool.query(`UPDATE access.permission_grant SET valid_until = now() + interval '1 hour', generation = generation + 1 WHERE id = $1`, [s.manager.grantId]);
    // A bounded lock timeout and either missing owner fail closed before graph writes.
    const blocked = await pool.connect();
    try {
      await blocked.query('BEGIN');
      await blocked.query("SELECT id FROM access.scope_gate WHERE id = 'work:create:root' FOR UPDATE");
      await must(await moderate(), 503);
    } finally { await blocked.query('ROLLBACK'); blocked.release(); }
    class MissingOwner extends AccessOrganizationModeration {
      override async admit(): Promise<never> { throw new AdmissionUnavailable('owner unavailable'); }
    }
    await must(await post(endpoint, account.tokenA, body(), randomUUID(),
      createMainApp(fuseki, { ...deps, organizationModeration: new MissingOwner(pool) })), 503);
    const missingGraph = new Proxy(fuseki, { get: (client, key) => key === 'query'
      ? async () => { throw new Error('graph unavailable'); } : Reflect.get(client, key) });
    await must(await post(endpoint, account.tokenA, body(), randomUUID(),
      createMainApp(fuseki, { ...deps, environment: { ...env, fuseki: missingGraph } })), 503);
    // Fixed owner probes and writes at small unrelated-history scales.
    await pool.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
      VALUES ('org',$1,1,'fixture-terms')`, [s.f.org]);
    for (const size of [0, 20, 200]) {
      if (size) await pool.query(`WITH subjects AS (
        INSERT INTO access.authority_subject (id,kind)
          SELECT 'https://rezics.com/id/' || gen_random_uuid()::text, 'agent' FROM generate_series(1,$1)
          RETURNING id
      ), members AS (
        INSERT INTO access.membership (id,kind,owner_subject,member_subject,state,generation,policy_revision)
          SELECT gen_random_uuid(),'org',$2,id,'left',1,1 FROM subjects RETURNING id
      ) INSERT INTO access.membership_history
        (membership_id,generation,state,policy_revision,changed_by_principal)
        SELECT id,1,'left',1,$3 FROM members`, [size, s.f.org, s.f.orgPrincipalId]);
      const publisher = await organizationPublisherEvidence(env, target);
      for (const key of Object.keys(costs) as (keyof typeof costs)[]) costs[key] = 0;
      const admitted = await owner.admit(s.f.realmPrincipal, target, publisher, randomUUID(), digest());
      expect(costs.calls).toBeLessThanOrEqual(22); expect(costs.rows).toBeLessThanOrEqual(12);
      expect(costs.writes).toBe(5);
      await expect(access.claim(admitted.id, digest())).rejects.toBeInstanceOf(AdmissionDenied);
      const terminal = await sealRealmRejectionAdmission(env, admitted); await access.recordGraphOutcome(admitted.id, terminal);
    }
    // A replacement valid grant cannot repair the exact saved dispatch branch.
    const revokedKey = randomUUID();
    const revoked = await owner.admit(s.f.realmPrincipal, target,
      await organizationPublisherEvidence(env, target), revokedKey, digest());
    const shorter = await s.realmGrant(`publication:reject:${target.realm}`, ORGANIZATION_MODERATION_ACTION);
    await pool.query(`UPDATE access.permission_grant SET valid_until = now() + interval '10 minutes' WHERE id = $1`, [shorter.grantId]);
    expect((await owner.admit(s.f.realmPrincipal, target, await organizationPublisherEvidence(env, target),
      revokedKey, digest())).dispatchEligible).toBe(true);
    await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [shorter.grantId]);
    await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [s.manager.grantId]);
    const replacement = await s.realmGrant(`publication:reject:${target.realm}`, ORGANIZATION_MODERATION_ACTION);
    await must(await moderate(revokedKey), 403);
    expect((await pool.query('SELECT state, graph_outcome FROM access.admission WHERE id = $1', [revoked.id])).rows[0])
      .toEqual({ state: 'sealed', graph_outcome: 'cancelled' });
    expect((await search(target.realm)).total).toBe(1);
    await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [replacement.grantId]);
    await pool.query('UPDATE access.permission_grant SET active = true, generation = generation + 1 WHERE id = $1', [s.manager.grantId]);
    await access.strongDeactivatePrincipal(s.f.realmPrincipalId, '0');
    await must(await moderate(), 403);
    await pool.query('UPDATE access.principal SET active = true WHERE id = $1', [s.f.realmPrincipalId]);
    const coverage = await accessStateCoverage(pool);
    const key = randomUUID();
    for (const name of Object.keys(costs) as (keyof typeof costs)[]) costs[name] = 0;
    const response = await moderate(key);
    const accepted = await must(response, 201);
    expect(costs.graphCalls).toBeLessThanOrEqual(20); expect(costs.graphBytes).toBeLessThan(32_000);
    expect(costs.graphWrites).toBe(1);
    expect(accepted).toMatchObject({ organizationSubject: s.f.org, participationId: s.joined.participationId,
      contribution: target.contribution, publicationDecision: target.publicationDecision,
      expectedWorkHead: target.expectedWorkHead });
    expect((await accessStateCoverage(pool)).digest).not.toBe(coverage.digest);
    await expect(pool.query('DELETE FROM access.organization_publication_moderation')).rejects.toThrow();
    await expect(pool.query("UPDATE access.organization_publication_moderation SET target = '{}'::jsonb")).rejects.toThrow();
    const replay = await must(await moderate(key), 200);
    expect(replay).toEqual({ ...accepted, replayed: true });
    await must(await post(endpoint, account.tokenA, { ...body(), expectedWorkHead: ID + randomUUID() }, key), 409);
    expect((await selectionRead(target.realm)).status).toBe('suppressed');
    expect((await search(target.realm)).total).toBe(0);
    expect((await search(s.other.realm)).total).toBe(1); expect((await search()).total).toBe(1);
    expect(await fuseki.query(`SELECT ?s ?p ?o WHERE {
      GRAPH <${GRAPHS.current}> { VALUES ?s { <${s.work.work}> <${s.draft.contribution}> <${s.work.mainVersion}> } ?s ?p ?o }
    } ORDER BY ?s ?p ?o`)).toEqual(nativeBefore);
    expect(await readExactContributionDraft(env, target.contribution, target.selectedDraft, async () => true)).toEqual(exactDraft);
    // G-012's suspension is exercised in this same real API scenario.
    const change = async (action: string, generation: string, token = account.tokenA) => post('/v1/access/org-realm-changes', token,
      { profile: 'access-org-realm-change-v1', realm: target.realm, organizationSubject: s.f.org,
        expectedGeneration: generation, expectedPolicyRevision: '1', action,
        ...(action === 'suspend' || action === 'lift-ban' ? { reasonReference: 'moderation-case' } : {}) });
    await must(await change('suspend', '1', account.tokenB), 403);
    await must(await change('suspend', '1'), 200);
    await must(await moderate(), 409);
    expect((await must(await moderate(key), 200)).rejection).toBe(accepted.rejection);
    const otherTuple = (await pool.query(`SELECT state, generation FROM access.org_realm_participation WHERE id = $1`, [s.otherJoined.participationId])).rows[0];
    expect(otherTuple).toEqual({ state: 'joined', generation: '1' });
    expect((await search(s.other.realm)).total).toBe(1); expect((await search()).total).toBe(1);
    // Neither local moderation nor suspension grants organization/source editing authority.
    expect(await access.canReadContributionDraft(s.f.realmPrincipal, s.f.realmManager, target.contribution)).toBe(false);
    await s.orgGrant(`work:edit:${target.work}`, 'work.edit');
    await expect(access.register({ principal: s.f.realmPrincipal, actingSubject: s.f.org,
      scope: `work:edit:${s.work.work}`, action: 'work.edit', idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await must(await change('leave', '2', account.tokenB), 200);
    await must(await moderate(), 409);
    await must(await change('lift-ban', '3'), 200);
    const rejoined = await s.join(target.realm, '4');
    await must(await moderate(), 409);
    target = { ...target, participationGeneration: rejoined.generation, proposalId: rejoined.proposalId };
    let localHead = accepted.rejection as string;
    const renew = async () => {
      const selected = await selectAdmittedRealmLocal(env, account.verifier, access, s.realmRequest,
        { context: { kind: 'realm-local', id: target.realm }, work: target.work, mainVersion: target.mainVersion,
          contribution: target.contribution, publicationDecision: target.publicationDecision,
          expectedSelectionHead: localHead, selectionBasis: 'realm-manager-review',
          actingSubject: target.actingSubject, idempotencyKey: randomUUID() });
      localHead = selected.selection!; return localHead;
    };
    await renew(); await must(await moderate(), 409); // old exact selection cannot suppress a newer one
    target = { ...target, selection: localHead };
    const edited = await editAdmittedMetadataWork(env, account.verifier, access, s.orgRequest,
      { work: target.work, expectedHead: target.expectedWorkHead, title: 'Independent organization publication',
        actingSubject: s.f.org, idempotencyKey: randomUUID() });
    await must(await moderate(), 409);
    target = { ...target, expectedWorkHead: edited.revision };
    const nextPublished = await publishAdmittedTextContribution(env, account.verifier, access, s.orgRequest,
      { contribution: target.contribution, expectedDraftHead: target.selectedDraft,
        expectedPublicationHead: target.publicationDecision, rightsBasis: 'original-contribution', disclosure: 'public',
        actingSubject: s.f.org, idempotencyKey: randomUUID() });
    await must(await moderate(), 409);
    target = { ...target, publicationDecision: nextPublished.publicationDecision! };
    target = { ...target, selection: await renew() };
    // A move after the atomic dispatch admission cannot retroactively rewrite or extend it.
    const destination = await createAdmittedRealmSpace(env, account.verifier, access, s.realmRequest,
      { name: 'Organization move destination', actingSubject: s.f.realmManager, idempotencyKey: randomUUID() });
    await pool.query(`INSERT INTO access.org_realm_policy (realm,manager_subject,revision,terms_revision)
      VALUES ($1,$2,1,'terms-1')`, [destination.realm, s.f.realmManager]);
    const destinationProposal = await must(await post('/v1/access/org-realm-proposals', account.tokenA,
      { profile: 'access-org-realm-proposal-v1', realm: destination.realm, organizationSubject: s.f.org,
        expectedGeneration: '0', expectedPolicyRevision: '1', termsRevision: 'terms-1' }), 200);
    const publisher = await organizationPublisherEvidence(env, target);
    const flightKey = randomUUID();
    const flight = await owner.admit(s.f.realmPrincipal, target, publisher, flightKey, digest());
    const flightBefore = (await pool.query('SELECT expires_at, claimed_at, state FROM access.admission WHERE id = $1', [flight.id])).rows[0];
    expect(Date.parse(flight.expiresAt) - Date.parse(flight.registeredAt)).toBeLessThanOrEqual(30_000);
    const graphBeforeMove = await fuseki.query(`SELECT ?s ?p ?o WHERE { GRAPH <${GRAPHS.current}> {
      VALUES ?s { <${target.work}> <${target.contribution}> <${s.local.selection.slot}> <${s.other.selection.slot}> }
      ?s ?p ?o } } ORDER BY ?s ?p ?o`);
    const moved = await must(await post('/v1/access/org-realm-moves', account.tokenB,
      { profile: 'access-org-realm-move-v1', organizationSubject: s.f.org,
        source: { realm: target.realm, participationId: target.participationId,
          expectedGeneration: rejoined.generation, expectedPolicyRevision: '1', proposalId: rejoined.proposalId },
        target: { realm: destination.realm, expectedGeneration: '0', expectedPolicyRevision: '1',
          proposalId: destinationProposal.proposalId, termsRevision: 'terms-1' } }), 200);
    expect(moved.source.state).toBe('left'); expect(moved.target.state).toBe('joined');
    expect((await pool.query('SELECT expires_at, claimed_at, state FROM access.admission WHERE id = $1', [flight.id])).rows[0])
      .toEqual(flightBefore);
    expect(await fuseki.query(`SELECT ?s ?p ?o WHERE { GRAPH <${GRAPHS.current}> {
      VALUES ?s { <${target.work}> <${target.contribution}> <${s.local.selection.slot}> <${s.other.selection.slot}> }
      ?s ?p ?o } } ORDER BY ?s ?p ?o`)).toEqual(graphBeforeMove);
    await must(await moderate(), 409);
    await expect(owner.admit(s.f.realmPrincipal, target, publisher, randomUUID(), digest())).rejects.toThrow();
    const inFlight = await rejectRealmLocal(env, flight, organizationRejectionInput(target));
    expect(inFlight.outcome).toBe('succeeded'); await access.recordGraphOutcome(flight.id, inFlight);
    expect((await must(await moderate(flightKey), 200)).rejection).toBe(inFlight.rejection);
    expect((await search(s.other.realm)).total).toBe(1); expect((await search()).total).toBe(1);
    // Account introspection denies even receipt retries when the session is deactivated.
    await accountPool.query('DELETE FROM session WHERE "userId" = $1', [account.a.id]);
    costs.writes = 0; await must(await moderate(flightKey), 401); expect(costs.writes).toBe(0);
  } finally {
    await account.close(); await Promise.all([pool.end(), accountPool.end()]);
    await databases.close(); rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
