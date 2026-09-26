import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessOrgRealmParticipation, type OrgRealmMoveInput, type OrgRealmMoveResult }
  from '../../../services/main/src/modules/access/org-realm-participation.ts';
import { ORG_REALM_ACTION } from '../../../services/main/src/modules/access/org-realm-authority.ts';
import { AccessManagedOrganizations } from '../../../services/main/src/modules/access/managed-organizations.ts';
import { MANAGED_ORG_ACTION } from '../../../services/main/src/modules/access/managed-org-authority.ts';
import { accessStateCoverage } from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { seedOrgRealm } from '../support/org-realm.ts';
import { seedManagedOrganization } from '../support/managed-organization.ts';
import { ratingAccount } from '../support/rating-account.ts';

test('IAM24/IAM06: atomic Org Realm moves bind exact authorities, paired history and bounded receipts', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL) throw new Error('Use the QA integration tier');
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  const pool = new Pool({ connectionString: databases.urls.access });
  const accountPool = new Pool({ connectionString: databases.urls.account });
  const account = await ratingAccount({ ...Bun.env, ACCOUNT_DATABASE_URL: databases.urls.account } as Record<string, string>,
    'openid access:manage work:create');
  const costs = { calls: 0, rows: 0, writes: 0 };
  let observe: ((sql: string, values?: unknown[]) => void) | undefined;
  const measured = { connect: async () => {
    const client = await pool.connect();
    return { query: async (sql: string, values?: unknown[]) => {
      costs.calls++; observe?.(sql, values);
      const result = await client.query(sql, values);
      costs.rows += result.rows.length;
      if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) costs.writes += result.rowCount ?? 0;
      return result;
    }, release: () => client.release() };
  } } as unknown as Pool;
  const owner = new AccessOrgRealmParticipation(measured);
  const access = new AccessAdmissionRegistry(pool);
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const app = createMainApp(fuseki, { environment: { fuseki, objectDirectory: '.temp/move-api-objects',
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! } },
    account: account.verifier, access, orgRealmParticipation: owner });
  const endpoint = '/v1/access/org-realm-moves';
  const post = (path: string, body: object, key = randomUUID(), token = account.tokenB) =>
    app.handle(new Request(`http://main.local${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body) }));
  const must = async <T>(response: Response, status = 200): Promise<T> => {
    const text = await response.text(); expect(response.status, text).toBe(status); return JSON.parse(text);
  };
  const move = (input: OrgRealmMoveInput, key = randomUUID(), token = account.tokenB) =>
    post(endpoint, { profile: 'access-org-realm-move-v1', ...input }, key, token);
  try {
    const f = await seedOrgRealm(pool, account.issuer, { realm: account.a.id, org: account.b.id });
    const basis = (realm: string, generation = '0', revision = '1') => ({ realm,
      organizationSubject: f.org, expectedGeneration: generation, expectedPolicyRevision: revision });
    const issue = async (realm: string, generation = '0', token = account.tokenA) => {
      const policy = (await pool.query('SELECT revision, terms_revision FROM access.org_realm_policy WHERE realm = $1', [realm])).rows[0];
      return await must<{ proposalId: string }>(await post('/v1/access/org-realm-proposals',
        { profile: 'access-org-realm-proposal-v1', ...basis(realm, generation, policy.revision),
          termsRevision: policy.terms_revision }, randomUUID(), token));
    };
    const join = async (realm: string) => {
      const proposal = await issue(realm);
      return must<{ participationId: string; proposalId: string; generation: string }>(await post('/v1/access/org-realm-changes',
        { profile: 'access-org-realm-change-v1', ...basis(realm), action: 'join',
          proposalId: proposal.proposalId, termsRevision: 'terms-1' }));
    };
    const source = await join(f.realm);
    const unrelated = `https://rezics.com/id/${randomUUID()}`;
    await pool.query(`INSERT INTO access.org_realm_policy (realm,manager_subject,revision,terms_revision)
      VALUES ($1,$2,1,'terms-1')`, [unrelated, f.realmManager]);
    await join(unrelated);
    const managed = await seedManagedOrganization(pool, f);
    const managedOwner = new AccessManagedOrganizations(pool);
    await pool.query(`INSERT INTO access.membership
      (id,kind,owner_subject,member_subject,generation,state,policy_revision,terms_revision,consent_reference)
      VALUES ($1,'org',$2,$3,1,'joined',1,'roster-terms','move-fixture')`, [randomUUID(), f.org, f.realmManager]);
    const prepare = async (): Promise<OrgRealmMoveInput> => {
      const proposal = await issue(f.otherRealm);
      const policies = (await pool.query('SELECT realm, revision FROM access.org_realm_policy WHERE realm = ANY($1)',
        [[f.realm, f.otherRealm]])).rows;
      return { organizationSubject: f.org,
        source: { realm: f.realm, participationId: source.participationId, expectedGeneration: '1',
          expectedPolicyRevision: policies.find(p => p.realm === f.realm)!.revision, proposalId: source.proposalId },
        target: { realm: f.otherRealm, expectedGeneration: '0',
          expectedPolicyRevision: policies.find(p => p.realm === f.otherRealm)!.revision,
          proposalId: proposal.proposalId, termsRevision: 'terms-1' } };
    };
    const effectState = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM access.org_realm_participation p) AS tuples,
      (SELECT count(*) FROM access.org_realm_history) AS histories,
      (SELECT count(*) FROM access.org_realm_proposal_use) AS uses,
      (SELECT count(*) FROM access.org_realm_move) AS moves,
      (SELECT count(*) FROM access.org_realm_receipt WHERE operation = 'move') AS receipts,
      (SELECT authority_epoch FROM access.scope_gate WHERE id = 'work:create:root') AS epoch`)).rows[0];
    const deny = async (input: OrgRealmMoveInput, status: number, token = account.tokenB) => {
      const before = await effectState(); await must(await move(input, randomUUID(), token), status);
      expect(await effectState()).toEqual(before);
    };
    let input = await prepare();
    await deny(input, 401, account.noScope); await deny(input, 403, account.tokenA);
    await deny({ ...input, organizationSubject: f.realmManager }, 403);
    await deny({ ...input, target: { ...input.target, realm: f.realm } }, 403);
    for (const side of ['source', 'target'] as const) {
      await deny({ ...input, [side]: { ...input[side], expectedGeneration: '99' } }, 409);
      await deny({ ...input, [side]: { ...input[side], expectedPolicyRevision: '99' } }, 409);
    }
    await deny({ ...input, source: { ...input.source, participationId: randomUUID() } }, 409);
    await deny({ ...input, source: { ...input.source, proposalId: randomUUID() } }, 409);
    await deny({ ...input, target: { ...input.target, proposalId: source.proposalId } }, 403);
    await deny({ ...input, target: { ...input.target, termsRevision: 'different' } }, 409);
    await deny({ ...input, target: { ...input.target, realm: unrelated, expectedGeneration: '1' } }, 403);
    await must(await post(endpoint, { profile: 'access-org-realm-move-v1', ...input, managed: true }), 400);
    const selfRepresentation = randomUUID();
    await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [selfRepresentation, f.orgPrincipalId, f.realmManager, ORG_REALM_ACTION.admit]);
    const self = await issue(f.otherRealm, '0', account.tokenB);
    await deny({ ...input, target: { ...input.target, proposalId: self.proposalId } }, 403);
    const expired = randomUUID();
    await pool.query(`INSERT INTO access.org_realm_proposal
      (id,realm,organization_subject,next_generation,policy_revision,terms_revision,organization_generation,
        organization_admission_generation,principal_id,authority_epoch,realm_proof,created_at,expires_at)
      SELECT $1,realm,organization_subject,next_generation,policy_revision,terms_revision,organization_generation,
        organization_admission_generation,principal_id,authority_epoch,realm_proof,
        now() - interval '2 minutes',now() - interval '1 minute' FROM access.org_realm_proposal WHERE id = $2`,
    [expired, input.target.proposalId]);
    await deny({ ...input, target: { ...input.target, proposalId: expired } }, 403);
    for (const [table, id] of [
      ['representation', f.authority.get(ORG_REALM_ACTION.admit)!.representationId],
      ['permission_grant', f.authority.get(ORG_REALM_ACTION.admit)!.grantId],
      ['authority_subject', f.realmManager],
    ]) {
      input = await prepare();
      await pool.query(`UPDATE access.${table} SET generation = generation + 1 WHERE id = $1`, [id]);
      await deny(input, 403);
    }
    input = await prepare();
    const originalTargetGrant = f.authority.get(ORG_REALM_ACTION.admit)!.grantId;
    await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [originalTargetGrant]);
    const replacement = randomUUID();
    await pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '30 minutes')`, [replacement, f.realmManager, ORG_REALM_ACTION.admit]);
    await deny(input, 403); // an otherwise valid replacement cannot repair the saved proof
    await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [replacement]);
    await pool.query('UPDATE access.permission_grant SET active = true, generation = generation + 1 WHERE id = $1', [originalTargetGrant]);
    input = await prepare();
    await pool.query('UPDATE access.org_participation_subject SET generation = generation + 1 WHERE subject = $1', [f.org]);
    await deny(input, 409);
    input = await prepare();
    await access.strongDeactivatePrincipal(f.realmPrincipalId, '0'); await deny(input, 403);
    await pool.query('UPDATE access.principal SET active = true WHERE id = $1', [f.realmPrincipalId]);
    input = await prepare();
    await pool.query('UPDATE access.principal SET active = false WHERE id = $1', [f.orgPrincipalId]); await deny(input, 403);
    await pool.query('UPDATE access.principal SET active = true WHERE id = $1', [f.orgPrincipalId]);
    await pool.query('UPDATE access.org_participation_subject SET active = false, generation = generation + 1 WHERE subject = $1', [f.org]);
    await deny(input, 403);
    await pool.query('UPDATE access.org_participation_subject SET active = true, generation = generation + 1 WHERE subject = $1', [f.org]);
    input = await prepare();
    await pool.query("UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = 'work:create:root'");
    await deny(input, 409);
    input = await prepare();
    await pool.query('UPDATE access.org_realm_policy SET revision = revision + 1 WHERE realm = $1', [f.otherRealm]);
    await deny(input, 409);
    await deny({ ...input, target: { ...input.target, expectedPolicyRevision: '2' } }, 409);
    input = await prepare();
    await pool.query('UPDATE access.org_realm_policy SET open = false, revision = revision + 1 WHERE realm = $1', [f.otherRealm]);
    await deny({ ...input, target: { ...input.target, expectedPolicyRevision: '3' } }, 403);
    await pool.query('UPDATE access.org_realm_policy SET open = true, revision = revision + 1 WHERE realm = $1', [f.otherRealm]);
    for (const realm of [f.realm, f.otherRealm]) {
      input = await prepare();
      await pool.query(`INSERT INTO access.org_realm_ban (realm,organization_subject,active,generation,reason_reference)
        VALUES ($1,$2,true,1,'move-fixture')`, [realm, f.org]); await deny(input, 403);
      await pool.query('UPDATE access.org_realm_ban SET active = false, generation = generation + 1 WHERE realm = $1', [realm]);
    }
    input = await prepare();
    await pool.query('UPDATE access.recovery_fence SET open = false WHERE id = true'); await deny(input, 503);
    await pool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    // Organization permission expires while the target's saved representation lock waits.
    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM access.representation WHERE id = $1 FOR UPDATE',
        [f.authority.get(ORG_REALM_ACTION.admit)!.representationId]);
      await pool.query(`UPDATE access.permission_grant SET valid_until = clock_timestamp() + interval '1 second'
        WHERE id = $1`, [f.authority.get(ORG_REALM_ACTION.participate)!.grantId]);
      const reached = new Promise<boolean>(resolveReached => { observe = (sql, values) => {
        if (sql.startsWith('SELECT p.id FROM access.principal p') && values?.[2] === f.realmManager) resolveReached(true);
      }; });
      const before = await effectState(), racing = move(input);
      expect(await Promise.race([reached, Bun.sleep(800).then(() => false)])).toBe(true);
      await Bun.sleep(1050); await lock.query('COMMIT'); await must(await racing, 403);
      expect(await effectState()).toEqual(before);
    } finally { observe = undefined; await lock.query('ROLLBACK'); lock.release(); }
    await pool.query(`UPDATE access.permission_grant SET valid_until = now() + interval '1 hour', generation = generation + 1
      WHERE id = $1`, [f.authority.get(ORG_REALM_ACTION.participate)!.grantId]);
    // The invitation itself expires during that wait. All eight attempted writes must roll back.
    input = await prepare();
    const expiryLock = await pool.connect();
    try {
      await expiryLock.query('BEGIN');
      await expiryLock.query('SELECT id FROM access.representation WHERE id = $1 FOR UPDATE',
        [f.authority.get(ORG_REALM_ACTION.admit)!.representationId]);
      const shortProposal = randomUUID();
      await pool.query(`INSERT INTO access.org_realm_proposal
        (id,realm,organization_subject,next_generation,policy_revision,terms_revision,organization_generation,
          organization_admission_generation,principal_id,authority_epoch,realm_proof,expires_at)
        SELECT $1,realm,organization_subject,next_generation,policy_revision,terms_revision,organization_generation,
          organization_admission_generation,principal_id,authority_epoch,realm_proof,clock_timestamp() + interval '1 second'
        FROM access.org_realm_proposal WHERE id = $2`, [shortProposal, input.target.proposalId]);
      const reached = new Promise<boolean>(resolveReached => { observe = (sql, values) => {
        if (sql.startsWith('SELECT p.id FROM access.principal p') && values?.[2] === f.realmManager) resolveReached(true);
      }; });
      const before = await effectState(); costs.writes = 0;
      const racing = move({ ...input, target: { ...input.target, proposalId: shortProposal } });
      expect(await Promise.race([reached, Bun.sleep(800).then(() => false)])).toBe(true);
      await Bun.sleep(1050); await expiryLock.query('COMMIT'); await must(await racing, 403);
      expect(costs.writes).toBe(8); expect(await effectState()).toEqual(before);
    } finally { observe = undefined; await expiryLock.query('ROLLBACK'); expiryLock.release(); }
    // A still-valid explicit parent grant is independent of both participation policies.
    const epoch = (await pool.query("SELECT authority_epoch FROM access.scope_gate WHERE id = 'work:create:root'")).rows[0].authority_epoch;
    const managedGrant = await managedOwner.change(f.orgPrincipal, { operation: 'issue', organizationSubject: f.org,
      expectedAuthorityEpoch: epoch, recipient: { kind: 'parent', id: managed.parent }, actions: [MANAGED_ORG_ACTION.roster],
      delegationCeiling: 0, validFrom: new Date(Date.now() - 1000).toISOString(),
      validUntil: new Date(Date.now() + 600_000).toISOString() }, randomUUID());
    // A real late database constraint failure follows both tuple/history writes and rolls all back.
    input = await prepare();
    const failedKey = randomUUID(), beforeFault = await effectState();
    await pool.query('ALTER TABLE access.org_realm_move ADD CONSTRAINT move_fault CHECK (false) NOT VALID');
    await expect(owner.move(f.orgPrincipal, input, failedKey)).rejects.toThrow();
    expect(await effectState()).toEqual(beforeFault);
    await pool.query('ALTER TABLE access.org_realm_move DROP CONSTRAINT move_fault');
    // Closing the source only affects new admissions there; the organization may leave.
    await pool.query('UPDATE access.org_realm_policy SET open = false, revision = revision + 1 WHERE realm = $1', [f.realm]);
    input = { ...input, source: { ...input.source, expectedPolicyRevision: '2' } };
    const unrelatedState = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM access.membership m) AS roster,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM access.permission_grant g) AS grants,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM access.representation r) AS mandates,
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM access.managed_org_grant g) AS management,
      (SELECT to_jsonb(p) FROM access.org_realm_participation p WHERE realm = $1) AS other`, [unrelated])).rows[0];
    const unchanged = await unrelatedState(), coverage = await accessStateCoverage(pool);
    const contenders = await Promise.all([failedKey, randomUUID()].map(async key => {
      const response = await move(input, key); return { key, status: response.status, body: await response.json() };
    }));
    expect(contenders.map(r => r.status).sort()).toEqual([200, 409]);
    const winner = contenders.find(r => r.status === 200)!;
    const result = winner.body as OrgRealmMoveResult;
    expect(result.source).toMatchObject({ participationId: source.participationId, state: 'left', generation: '2', admissionOpen: false });
    expect(result.target).toMatchObject({ state: 'joined', generation: '1', mode: 'independent' });
    expect(JSON.stringify(result)).not.toContain(f.orgPrincipalId); expect(JSON.stringify(result)).not.toContain(f.realmPrincipalId);
    expect(await unrelatedState()).toEqual(unchanged); expect(await accessStateCoverage(pool)).not.toEqual(coverage);
    expect((await pool.query(`SELECT action, authority_epoch FROM access.org_realm_history
      WHERE (participation_id = $1 AND generation = 2) OR (participation_id = $2 AND generation = 1) ORDER BY action`,
    [source.participationId, result.target.participationId])).rows).toEqual([
      { action: 'join', authority_epoch: result.authorityEpoch }, { action: 'leave', authority_epoch: result.authorityEpoch }]);
    const committed = await effectState();
    const retries = await Promise.all([move(input, winner.key), move(input, winner.key)]);
    for (const retry of retries) expect(await must(retry)).toEqual({ ...result, replayed: true });
    expect(await effectState()).toEqual(committed);
    await must(await move({ ...input, target: { ...input.target, termsRevision: 'changed' } }, winner.key), 409);
    await must(await post('/v1/works', { profile: 'metadata-only-v1', title: 'No move authority', actingSubject: f.org }), 403);
    await pool.query('UPDATE access.org_realm_policy SET open = true, revision = revision + 1 WHERE realm = $1', [f.realm]);
    const returning = await issue(f.realm, '2');
    const returned = await must<OrgRealmMoveResult>(await move({ organizationSubject: f.org,
      source: { realm: f.otherRealm, participationId: result.target.participationId!, expectedGeneration: '1',
        expectedPolicyRevision: '4', proposalId: result.target.proposalId! },
      target: { realm: f.realm, expectedGeneration: '2', expectedPolicyRevision: '3',
        proposalId: returning.proposalId, termsRevision: 'terms-1' } }));
    expect(returned.target).toMatchObject({ participationId: source.participationId, generation: '3', state: 'joined' });
    expect(returned.source).toMatchObject({ generation: '2', state: 'left' });
    expect(await unrelatedState()).toEqual(unchanged);
    expect(await must(await move(input, winner.key))).toEqual({ ...result, replayed: true });
    const protectedPolicy = await managedOwner.setRosterPolicy(f.realmPrincipal,
      { organizationSubject: f.org, recipient: { kind: 'parent', id: managed.parent }, grantId: managedGrant.grantId,
        expectedGrantGeneration: '1', representationId: managed.parentRepresentation, expectedRepresentationGeneration: '0',
        expectedPolicyRevision: '1', admissionsOpen: false }, randomUUID());
    expect(protectedPolicy.admissionsOpen).toBe(false);
    await expect(pool.query('DELETE FROM access.org_realm_move')).rejects.toThrow();
    await expect(pool.query('UPDATE access.org_realm_move SET authority_epoch = authority_epoch + 1')).rejects.toThrow();
    await expect(pool.query(`INSERT INTO access.org_realm_receipt (principal_id,idempotency_key,request_digest,operation,result)
      VALUES ($1,'orphan-move',$2,'move','{}')`, [f.orgPrincipalId, 'a'.repeat(64)])).rejects.toThrow();
    // Separate fresh tuples at each history scale; background rows are bulk-built once per increment.
    const measurements: typeof costs[] = [];
    for (const size of [0, 32, 256]) {
      if (size) await pool.query(`WITH policies AS (
        INSERT INTO access.org_realm_policy (realm,manager_subject,revision,terms_revision)
          SELECT 'https://rezics.com/id/' || gen_random_uuid()::text,$3,1,'terms-1' FROM generate_series(1,$2)
          RETURNING realm
      ), proposals AS (INSERT INTO access.org_realm_proposal
        (id,realm,organization_subject,next_generation,policy_revision,terms_revision,organization_generation,
          organization_admission_generation,principal_id,authority_epoch,realm_proof,expires_at)
        SELECT gen_random_uuid(),p.realm,o.organization_subject,1,1,'terms-1',o.organization_generation,
          o.organization_admission_generation,o.principal_id,o.authority_epoch,o.realm_proof,now() + interval '5 minutes'
          FROM access.org_realm_proposal o CROSS JOIN policies p WHERE o.id = $1 RETURNING *
      ), tuples AS (INSERT INTO access.org_realm_participation
        (id,realm,organization_subject,generation,state,policy_revision,terms_revision,proposal_id)
        SELECT gen_random_uuid(),realm,organization_subject,1,'joined',1,'terms-1',id FROM proposals RETURNING *
      ), histories AS (INSERT INTO access.org_realm_history
        (participation_id,generation,action,state,policy_revision,terms_revision,proposal_id,ban_active,ban_generation,actor_proof,authority_epoch)
        SELECT t.id,1,'join','joined',1,'terms-1',t.proposal_id,false,0,h.actor_proof,h.authority_epoch
          FROM tuples t CROSS JOIN access.org_realm_history h WHERE h.participation_id = $4 AND h.generation = 1 RETURNING *
      ) INSERT INTO access.org_realm_proposal_use (proposal_id,participation_id,generation)
        SELECT proposal_id,participation_id,generation FROM histories`,
      [input.target.proposalId, size, f.realmManager, source.participationId]);
      const realms = [0, 1].map(() => `https://rezics.com/id/${randomUUID()}`);
      await pool.query(`INSERT INTO access.org_realm_policy (realm,manager_subject,revision,terms_revision)
        VALUES ($1,$3,1,'terms-1'),($2,$3,1,'terms-1')`, [...realms, f.realmManager]);
      const joined = await join(realms[0]!); const proposed = await issue(realms[1]!);
      const fresh: OrgRealmMoveInput = { organizationSubject: f.org,
        source: { realm: realms[0]!, participationId: joined.participationId, proposalId: joined.proposalId,
          expectedGeneration: '1', expectedPolicyRevision: '1' },
        target: { realm: realms[1]!, proposalId: proposed.proposalId, expectedGeneration: '0',
          expectedPolicyRevision: '1', termsRevision: 'terms-1' } };
      costs.calls = 0; costs.rows = 0; costs.writes = 0;
      const key = randomUUID(); await must(await move(fresh, key)); measurements.push({ ...costs });
      costs.calls = 0; costs.rows = 0; costs.writes = 0;
      await must(await move(fresh, key)); expect(costs.writes).toBe(0); expect(costs.calls).toBeLessThanOrEqual(12);
    }
    expect(measurements[1]).toEqual(measurements[0]); expect(measurements[2]).toEqual(measurements[0]);
    expect(measurements[0]!.calls).toBeLessThanOrEqual(33); expect(measurements[0]!.rows).toBeLessThanOrEqual(20);
    expect(measurements[0]!.writes).toBe(8);
    await pool.query('ANALYZE access.org_realm_proposal');
    expect(JSON.stringify((await pool.query('EXPLAIN (FORMAT JSON) SELECT id FROM access.org_realm_proposal WHERE id = $1',
      [input.target.proposalId])).rows)).toContain('org_realm_proposal_pkey');
    const blocked = await pool.connect();
    try {
      await blocked.query('BEGIN'); await blocked.query("SELECT id FROM access.scope_gate WHERE id = 'work:create:root' FOR SHARE");
      await must(await move(input, winner.key), 503);
    } finally { await blocked.query('ROLLBACK'); blocked.release(); }
    await accountPool.query('DELETE FROM session WHERE "userId" = $1', [account.b.id]);
    const before = await effectState(); await must(await move(input, winner.key), 401); expect(await effectState()).toEqual(before);
  } finally {
    await account.close(); await Promise.all([pool.end(), accountPool.end()]); await databases.close();
  }
}, 180_000);
