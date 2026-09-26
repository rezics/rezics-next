import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { AccessGrants } from '../../../services/main/src/modules/access/grants.ts';
import { accountRecoveryCoverage, assertAccountRecoveryCoverage } from
  '../../../services/account/src/recovery-coverage.ts';
import { startAuthorityHarness } from './access-topology-harness.ts';

const profile = 'access-representation-edge-change-v1';
const admissionProfile = 'access-compound-admission-v1';
const grantProfile = 'access-delegated-grant-change-v1';
const until = () => new Date(Date.now() + 60 * 60_000).toISOString();

test('IAM27/IAM28: two complete P-to-A-to-B-to-C proofs consume one real grant revocation', async () => {
  const h = await startAuthorityHarness('selected-grant-api');
  try {
    const user = await h.user('path-operator');
    const [a, b, c, recipient] = await Promise.all([
      h.agent(), h.agent(), h.agent(), h.agent()]);
    const assign = 'access.grant.assign.work.create';
    const delegatedRevoke = 'access.grant.delegated-revoke.work.create';
    const origin = await h.mandate(user.principalId, a, assign, { maxPathEdges: 2 });
    const revokeOrigin = await h.mandate(user.principalId, a, delegatedRevoke,
      { maxPathEdges: 2 });
    await h.mandate(user.principalId, b, 'access.representation.manage');
    await h.mandate(user.principalId, c, 'access.representation.manage');
    await h.grant(b, b, `access.representation.assign.${assign}`);
    await h.grant(c, c, `access.representation.assign.${assign}`);
    await h.grant(b, b, `access.representation.assign.${delegatedRevoke}`);
    await h.grant(c, c, `access.representation.assign.${delegatedRevoke}`);
    const ceiling = await h.grant(c, c, assign);
    const revokeCeiling = await h.grant(c, c, delegatedRevoke);
    const grantId = await h.grant(c, recipient, 'work.create');
    const edgeId = randomUUID();
    expect((await h.call('POST', '/v1/access/representation-edge-changes', user.token,
      { profile, action: 'create', edgeId, representativeSubject: a, representedSubject: b,
        edgeAction: assign, maxPathEdges: 2, validUntil: until(),
        expectedTopologyEpoch: await h.epoch('access:representation-topology') })).status).toBe(200);
    const secondEdgeId = randomUUID();
    expect((await h.call('POST', '/v1/access/representation-edge-changes', user.token,
      { profile, action: 'create', edgeId: secondEdgeId, representativeSubject: b,
        representedSubject: c, edgeAction: assign, maxPathEdges: 2, validUntil: until(),
        expectedTopologyEpoch: await h.epoch('access:representation-topology') })).status).toBe(200);
    const revokeEdgeId = randomUUID();
    expect((await h.call('POST', '/v1/access/representation-edge-changes', user.token,
      { profile, action: 'create', edgeId: revokeEdgeId, representativeSubject: a,
        representedSubject: b, edgeAction: delegatedRevoke, maxPathEdges: 2,
        validUntil: until(), expectedTopologyEpoch: await h.epoch('access:representation-topology') })).status).toBe(200);
    const secondRevokeEdgeId = randomUUID();
    expect((await h.call('POST', '/v1/access/representation-edge-changes', user.token,
      { profile, action: 'create', edgeId: secondRevokeEdgeId, representativeSubject: b,
        representedSubject: c, edgeAction: delegatedRevoke, maxPathEdges: 2,
        validUntil: until(), expectedTopologyEpoch: await h.epoch('access:representation-topology') })).status).toBe(200);
    const direct = await h.call('POST', '/v1/access/grant-changes', user.token,
      { profile: 'work-create-agent-grant-change-v1', action: 'revoke', issuerSubject: c,
        expectedAuthorityEpoch: await h.epoch(), grantId, expectedObjectGeneration: '0' });
    expect(direct.status).toBe(403);
    const incompleteId = randomUUID();
    expect((await h.call('POST', '/v1/me/authority-admissions', user.token,
      { profile: admissionProfile, admissionId: incompleteId, actingSubject: c,
        command: `grant.revoke.${grantId}`, obligations: [{ obligation: assign,
          representationId: origin, edgeIds: [edgeId, secondEdgeId], grantId: ceiling }] })).status).toBe(200);
    expect((await h.call('POST', '/v1/access/delegated-grant-changes', user.token,
      { profile: grantProfile, action: 'revoke', issuerSubject: c,
        expectedAuthorityEpoch: await h.epoch(), grantId,
        expectedObjectGeneration: '0', selectedAdmissionId: incompleteId })).status).toBe(403);
    const admissionId = randomUUID();
    const admitted = await h.call('POST', '/v1/me/authority-admissions', user.token,
      { profile: admissionProfile, admissionId, actingSubject: c,
        command: `grant.revoke.${grantId}`, obligations: [{ obligation: assign,
          representationId: origin, edgeIds: [edgeId, secondEdgeId], grantId: ceiling },
        { obligation: delegatedRevoke, representationId: revokeOrigin,
          edgeIds: [revokeEdgeId, secondRevokeEdgeId], grantId: revokeCeiling }] });
    expect(admitted.status).toBe(200);
    const revoke = { profile: grantProfile, action: 'revoke', issuerSubject: c,
      expectedAuthorityEpoch: await h.epoch(), grantId, expectedObjectGeneration: '0',
      selectedAdmissionId: admissionId };
    const key = `selected-${randomUUID()}`;
    const consumed = await h.call('POST', '/v1/access/delegated-grant-changes',
      user.token, revoke, key);
    expect(consumed.status).toBe(200);
    const read = await h.call('GET', `/v1/me/authority-admissions/${admissionId}/consumption`,
      user.token);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ admissionId, grantId, issuerSubject: c,
      grantActive: false });
    expect((await h.accessPool.query<{ selected_admission_id: string }>(`SELECT
      selected_admission_id FROM access.grant_change_receipt WHERE grant_id = $1
        AND action = 'revoke'`, [grantId])).rows).toEqual([{ selected_admission_id: admissionId }]);
    expect((await h.call('POST', '/v1/access/delegated-grant-changes',
      user.token, revoke, key)).status).toBe(200);
    expect((await h.call('POST', '/v1/access/delegated-grant-changes',
      user.token, { ...revoke, expectedAuthorityEpoch: await h.epoch() })).status).toBe(403);
    expect((await h.call('POST', `/v1/me/authority-admissions/${admissionId}/checks`,
      user.token)).status).toBe(403);

    const staleGrantId = await h.grant(c, recipient, 'work.create');
    const staleAdmissionId = randomUUID();
    expect((await h.call('POST', '/v1/me/authority-admissions', user.token,
      { profile: admissionProfile, admissionId: staleAdmissionId, actingSubject: c,
        command: `grant.revoke.${staleGrantId}`, obligations: [{ obligation: assign,
          representationId: origin, edgeIds: [edgeId, secondEdgeId], grantId: ceiling },
        { obligation: delegatedRevoke, representationId: revokeOrigin,
          edgeIds: [revokeEdgeId, secondRevokeEdgeId], grantId: revokeCeiling }] })).status).toBe(200);
    const staleRevoke = { ...revoke, grantId: staleGrantId,
      selectedAdmissionId: staleAdmissionId, expectedAuthorityEpoch: await h.epoch() };
    await h.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    expect((await h.call('POST', '/v1/access/delegated-grant-changes', user.token,
      staleRevoke)).status).toBe(503);
    await h.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    expect((await h.call('POST', '/v1/access/representation-edge-changes', user.token,
      { profile, action: 'revoke', edgeId: revokeEdgeId, representedSubject: b,
        expectedObjectGeneration: '0',
        expectedTopologyEpoch: await h.epoch('access:representation-topology') })).status).toBe(200);
    expect((await h.call('POST', '/v1/access/delegated-grant-changes', user.token,
      staleRevoke)).status).toBe(403);
    expect((await h.accessPool.query<{ active: boolean }>(`SELECT active
      FROM access.permission_grant WHERE id = $1`, [staleGrantId])).rows[0]?.active).toBe(true);
    expect((await h.accessPool.query(`SELECT 1 FROM access.grant_change_receipt
      WHERE selected_admission_id = $1`, [staleAdmissionId])).rowCount).toBe(0);
    const survivingId = randomUUID();
    expect((await h.call('POST', '/v1/me/authority-admissions', user.token,
      { profile: admissionProfile, admissionId: survivingId, actingSubject: c,
        command: `grant.revoke.${staleGrantId}`, obligations: [{ obligation: assign,
          representationId: origin, edgeIds: [edgeId, secondEdgeId], grantId: ceiling }] })).status).toBe(200);
    expect((await h.call('POST', `/v1/me/authority-admissions/${survivingId}/checks`,
      user.token)).status).toBe(200);

    // Physical exact-key probe at two unrelated receipt volumes. The selected
    // admission index must visit one row regardless of background receipts.
    const probe = async (from: number, to: number) => {
      await h.accessPool.query(`INSERT INTO access.grant_change_receipt
        (principal_id,idempotency_key,request_digest,issuer_subject,action,grant_id,
          result_authority_epoch)
        SELECT $1,'background-' || g,repeat('0',64),$2,'create',$3,0
        FROM generate_series($4::integer,$5::integer) g`,
      [user.principalId, c, grantId, from, to]);
      await h.accessPool.query('ANALYZE access.grant_change_receipt');
      const explain = await h.accessPool.query<{ 'QUERY PLAN': Array<{ Plan: {
        'Node Type': string; 'Actual Rows': number; 'Shared Hit Blocks': number;
        'Shared Read Blocks': number; 'Index Name'?: string } }> }>(`EXPLAIN
        (ANALYZE, BUFFERS, FORMAT JSON) SELECT grant_id
        FROM access.grant_change_receipt WHERE selected_admission_id = $1`, [admissionId]);
      const plan = explain.rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(plan['Actual Rows']).toBe(1);
      return { blocks: plan['Shared Hit Blocks'] + plan['Shared Read Blocks'],
        index: plan['Index Name'], node: plan['Node Type'] };
    };
    const small = await probe(1, 64);
    const large = await probe(65, 16_000);
    expect(small.blocks).toBeLessThanOrEqual(12);
    expect(large.blocks).toBeLessThanOrEqual(12);
    expect(large.index).toBe('grant_change_selected_admission_once');
    expect(large.node).toMatch(/Index (Only )?Scan/);
    // The second required proof adds one selected row, while unrelated saved
    // admissions cannot turn the command check into a corpus scan.
    const obligationProbe = async (from: number, to: number) => {
      const inserted = await h.accessPool.query<{ id: string }>(`INSERT INTO access.admission (id, principal_id,
        acting_subject, scope_id, action, authority_path, idempotency_key,
        request_digest, authority_epoch, expires_at, state)
        SELECT gen_random_uuid(), principal_id, acting_subject, scope_id,
          action, authority_path, 'proof-background-' || g, request_digest,
          authority_epoch, expires_at, state
        FROM access.admission CROSS JOIN generate_series($2::integer,$3::integer) g
        WHERE id = $1 RETURNING id`, [admissionId, from, to]);
      await h.accessPool.query(`INSERT INTO access.admission_obligation
        (admission_id, obligation, principal_id, acting_subject, scope_id,
          path_id, source_kind, grant_id, grant_generation)
        SELECT a.id, o.obligation, o.principal_id, o.acting_subject, o.scope_id,
          o.path_id, o.source_kind, o.grant_id, o.grant_generation
        FROM access.admission a CROSS JOIN access.admission_obligation o
        WHERE a.id = ANY($2::uuid[]) AND o.admission_id = $1`,
      [admissionId, inserted.rows.map(row => row.id)]);
      await h.accessPool.query('ANALYZE access.admission_obligation');
      const explained = await h.accessPool.query<{ 'QUERY PLAN': Array<{ Plan: {
        'Actual Rows': number; 'Shared Hit Blocks': number;
        'Shared Read Blocks': number; 'Index Name'?: string } }> }>(`EXPLAIN
        (ANALYZE, BUFFERS, FORMAT JSON) SELECT obligation
        FROM access.admission_obligation WHERE admission_id = $1
        ORDER BY obligation LIMIT 9`, [admissionId]);
      const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(plan['Actual Rows']).toBe(2);
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThanOrEqual(12);
      return JSON.stringify(plan);
    };
    await obligationProbe(1, 64);
    expect(await obligationProbe(65, 2_048)).toContain('admission_obligation_pkey');
    const restored = await h.snapshotAccess();
    try {
      const owner = new AccessGrants(restored);
      const principal = { issuer: h.accountIssuer, subject: user.accountId };
      expect(await owner.readAdmissionConsumption(principal, admissionId))
        .toMatchObject({ admissionId, grantId, issuerSubject: c, grantActive: false });
      await expect(owner.control.topology.recheckAdmission(principal, admissionId))
        .rejects.toThrow('already consumed');
      await expect(owner.control.topology.recheckAdmission(principal, staleAdmissionId))
        .rejects.toThrow('lost its selected proof');
      expect((await restored.query<{ active: boolean }>(`SELECT active FROM
        access.permission_grant WHERE id = $1`, [staleGrantId])).rows[0]?.active).toBe(true);
    } finally { await restored.end(); }
  } finally { await h.close(); }
});

test('IAM27/IAM28/IAM31: admitted path is exact, acyclic and loses revoked edges', async () => {
  const h = await startAuthorityHarness('topology-api');
  try {
    const user = await h.user('operator');
    const [a, b, c] = await Promise.all([h.agent(), h.agent(), h.agent()]);
    const origin = await h.mandate(user.principalId, a, 'work.create', { maxPathEdges: 2 });
    const secondOrigin = await h.mandate(user.principalId, a, 'access.custom',
      { maxPathEdges: 1 });
    await h.mandate(user.principalId, b, 'access.representation.manage');
    await h.mandate(user.principalId, a, 'access.representation.manage');
    await h.mandate(user.principalId, c, 'access.representation.manage');
    await h.grant(b, b, 'access.representation.assign.work.create');
    await h.grant(a, a, 'access.representation.assign.work.create');
    await h.grant(c, c, 'access.representation.assign.work.create');
    await h.grant(b, b, 'access.representation.assign.access.custom');
    const workGrant = await h.grant(b, b, 'work.create');
    const secondGrant = await h.grant(b, b, 'access.custom');
    const thirdGrant = await h.grant(c, c, 'work.create');
    const wrongHolderGrant = await h.grant(a, a, 'access.custom');
    const edgeId = randomUUID();
    const edge = await h.call('POST', '/v1/access/representation-edge-changes', user.token,
      { profile, action: 'create', edgeId, representativeSubject: a, representedSubject: b,
        edgeAction: 'work.create', maxPathEdges: 2, validUntil: until(),
        expectedTopologyEpoch: await h.epoch('access:representation-topology') });
    expect(edge.status).toBe(200);
    expect(edge.body).toMatchObject({ edgeId, generation: '0', replayed: false });
    const edgeRead = await h.call('GET', `/v1/access/representation-edges/${edgeId}`
      + `?representedSubject=${encodeURIComponent(b)}`, user.token);
    expect(edgeRead.status).toBe(200);
    expect(edgeRead.body).toMatchObject({ edgeId, active: true });

    const cycle = await h.call('POST', '/v1/access/representation-edge-changes', user.token,
      { profile, action: 'create', edgeId: randomUUID(), representativeSubject: b,
        representedSubject: a, edgeAction: 'work.create', maxPathEdges: 1,
        validUntil: until(),
        expectedTopologyEpoch: await h.epoch('access:representation-topology') });
    expect(cycle.status).toBe(409);

    const secondEdgeId = randomUUID();
    expect((await h.call('POST', '/v1/access/representation-edge-changes', user.token,
      { profile, action: 'create', edgeId: secondEdgeId, representativeSubject: a,
        representedSubject: b, edgeAction: 'access.custom', maxPathEdges: 1,
        validUntil: until(),
        expectedTopologyEpoch: await h.epoch('access:representation-topology') })).status).toBe(200);
    const thirdEdgeId = randomUUID();
    expect((await h.call('POST', '/v1/access/representation-edge-changes', user.token,
      { profile, action: 'create', edgeId: thirdEdgeId, representativeSubject: b,
        representedSubject: c, edgeAction: 'work.create', maxPathEdges: 2,
        validUntil: until(),
        expectedTopologyEpoch: await h.epoch('access:representation-topology') })).status).toBe(200);

    const admissionId = randomUUID();
    const admission = await h.call('POST', '/v1/me/authority-admissions', user.token,
      { profile: admissionProfile, admissionId, actingSubject: b, command: 'work.create',
        obligations: [{ obligation: 'work.create', representationId: origin,
          edgeIds: [edgeId], grantId: workGrant },
        { obligation: 'access.custom', representationId: secondOrigin,
          edgeIds: [secondEdgeId], grantId: secondGrant }] });
    expect(admission.status).toBe(200);
    expect(admission.body).toMatchObject({ admissionId, replayed: false });
    expect((await h.call('POST', `/v1/me/authority-admissions/${admissionId}/checks`,
      user.token)).status).toBe(200);
    const pooled = await h.call('POST', '/v1/me/authority-admissions', user.token,
      { profile: admissionProfile, admissionId: randomUUID(), actingSubject: b,
        command: 'work.create', obligations: [
          { obligation: 'work.create', representationId: origin,
            edgeIds: [edgeId], grantId: workGrant },
          { obligation: 'access.custom', representationId: secondOrigin,
            edgeIds: [secondEdgeId], grantId: wrongHolderGrant }] });
    expect(pooled.status).toBe(403);
    const twoHop = await h.call('POST', '/v1/me/authority-admissions', user.token,
      { profile: admissionProfile, admissionId: randomUUID(), actingSubject: c,
        command: 'work.create', obligations: [
          { obligation: 'work.create', representationId: origin,
            edgeIds: [edgeId, thirdEdgeId], grantId: thirdGrant }] });
    expect(twoHop.status).toBe(200);
    const revoked = await h.call('POST', '/v1/access/representation-edge-changes', user.token,
      { profile, action: 'revoke', edgeId, representedSubject: b,
        expectedObjectGeneration: '0',
        expectedTopologyEpoch: await h.epoch('access:representation-topology') });
    expect(revoked.status).toBe(200);
    expect((await h.call('POST', `/v1/me/authority-admissions/${admissionId}/checks`,
      user.token)).status).toBe(403);
  } finally { await h.close(); }
});

test('IAM13/IAM14: dependent grants revoke with their upstream and replay exactly', async () => {
  const h = await startAuthorityHarness('lineage-api');
  try {
    const user = await h.user('operator');
    const successor = await h.user('successor');
    const [issuer, middle, recipient] = await Promise.all([h.agent(), h.agent(), h.agent()]);
    const originalMandate = await h.mandate(user.principalId, issuer,
      'access.grant.assign.work.create');
    const successorMandate = await h.mandate(successor.principalId, issuer,
      'access.grant.assign.work.create');
    const originalMiddleMandate = await h.mandate(user.principalId, middle,
      'access.grant.assign.work.create');
    const issuerCeiling = await h.grant(issuer, issuer,
      'access.grant.assign.work.create');
    const rootId = randomUUID();
    const grantUntil = until();
    const root = { profile: grantProfile, action: 'create', issuerSubject: issuer,
      expectedAuthorityEpoch: await h.epoch(), grantId: rootId,
      recipientSubject: middle, validUntil: grantUntil, lifetime: 'institutional',
      redelegationDepth: 1 };
    const key = `root-${randomUUID()}`;
    const made = await h.call('POST', '/v1/access/delegated-grant-changes', user.token, root, key);
    expect(made.status).toBe(200);
    expect((await h.call('POST', '/v1/access/delegated-grant-changes', user.token,
      root, key)).status).toBe(200);
    await h.accessPool.query('UPDATE access.representation SET active = false WHERE id = $1',
      [originalMiddleMandate]);
    await h.mandate(successor.principalId, middle, 'access.grant.assign.work.create');
    const childId = randomUUID();
    const child = await h.call('POST', '/v1/access/delegated-grant-changes', successor.token,
      { profile: grantProfile, action: 'create', issuerSubject: middle,
        expectedAuthorityEpoch: await h.epoch(), grantId: childId,
        recipientSubject: recipient, validUntil: grantUntil, lifetime: 'dependent',
        upstreamGrantId: rootId, redelegationDepth: 0 });
    expect(child.status).toBe(200);
    const read = await h.call('GET', `/v1/access/grants/${childId}/lineage`
      + `?issuerSubject=${encodeURIComponent(middle)}`, successor.token);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ lineage: { lifetime: 'dependent',
      upstreamGrantId: rootId, rootGrantId: rootId } });
    expect((await h.accessPool.query<{ assigned_by_principal: string }>(`SELECT
      assigned_by_principal FROM access.grant_lineage WHERE grant_id = $1`,
    [childId])).rows[0]?.assigned_by_principal).toBe(successor.principalId);
    await h.accessPool.query('UPDATE access.representation SET active = false WHERE id = $1',
      [originalMandate]);
    expect((await h.accessPool.query<{ active: boolean }>(`SELECT active
      FROM access.permission_grant WHERE id = $1`, [rootId])).rows[0]?.active).toBe(true);
    const revoked = await h.call('POST', '/v1/access/grant-changes', successor.token,
      { profile: 'work-create-agent-grant-change-v1', action: 'revoke',
        issuerSubject: issuer, expectedAuthorityEpoch: await h.epoch(),
        grantId: rootId, expectedObjectGeneration: '0' });
    expect(revoked.status).toBe(200);
    const state = await h.accessPool.query<{ active: boolean }>(
      'SELECT active FROM access.permission_grant WHERE id = $1', [childId]);
    expect(state.rows[0]?.active).toBe(false);
    const client = await h.accessPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TEMP TABLE lineage_bg (id uuid PRIMARY KEY) ON COMMIT DROP');
      await client.query(`INSERT INTO lineage_bg SELECT gen_random_uuid()
        FROM generate_series(1, 16000)`);
      await client.query(`INSERT INTO access.permission_grant (id,issuer_subject,
        recipient_subject,scope_id,action,valid_until,assigned_by_principal)
        SELECT id,$1,$2,'work:create:root','work.create',now() + interval '1 hour',$3
        FROM lineage_bg`, [issuer, middle, successor.principalId]);
      await client.query(`INSERT INTO access.grant_lineage (grant_id,issuer_subject,
        recipient_subject,scope_id,action,lifetime,assigned_by_principal,
        issuer_representation_id,issuer_representation_generation,
        issuer_representation_action,ceiling_grant_id,ceiling_grant_generation,
        ceiling_scope_id,ceiling_action,root_grant_id,depth,redelegation_depth)
        SELECT id,$1,$2,'work:create:root','work.create','institutional',$3,
          $4,0,'access.grant.assign.work.create',$5,0,'work:create:root',
          'access.grant.assign.work.create',id,0,0 FROM lineage_bg`,
      [issuer, middle, successor.principalId, successorMandate, issuerCeiling]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    await h.accessPool.query('ANALYZE access.grant_lineage');
    const explained = await h.accessPool.query<{ 'QUERY PLAN': Array<{ Plan: {
      'Index Name'?: string; 'Actual Rows': number; 'Shared Hit Blocks': number;
      'Shared Read Blocks': number } }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT grant_id FROM access.grant_lineage WHERE upstream_grant_id = $1`, [rootId]);
    const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(plan['Index Name']).toBe('grant_lineage_upstream');
    expect(plan['Actual Rows']).toBe(1);
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThanOrEqual(12);
    const restored = await h.snapshotAccess();
    try {
      const owner = new AccessGrants(restored);
      const principal = { issuer: h.accountIssuer, subject: successor.accountId };
      expect(await owner.readLineage(principal, issuer, rootId))
        .toMatchObject({ grant: { active: false },
          lineage: { lifetime: 'institutional', rootGrantId: rootId } });
      expect(await owner.readLineage(principal, middle, childId))
        .toMatchObject({ grant: { active: false },
          lineage: { lifetime: 'dependent', upstreamGrantId: rootId } });
    } finally { await restored.end(); }
  } finally { await h.close(); }
});

test('IAM12: invitation remains pending until the recipient Agent admits its representative', async () => {
  const h = await startAuthorityHarness('invitation-api');
  try {
    const issuerUser = await h.user('issuer');
    const recipientUser = await h.user('recipient');
    const sameNameUser = await h.user('recipient');
    const [issuer, recipient] = await Promise.all([h.agent(), h.agent()]);
    const issuerMandate = await h.mandate(issuerUser.principalId, issuer,
      'access.invitation.issue');
    const issuerCeiling = await h.grant(issuer, issuer,
      'access.grant.assign.work.create', '30 days');
    const invitationId = randomUUID();
    const grantId = randomUUID();
    const offered = await h.call('POST', '/v1/agents/invitations', issuerUser.token,
      { profile: 'access-agent-invitation-v1', invitationId, issuerSubject: issuer,
        recipientSubject: recipient, grantValidUntil: new Date(Date.now()
          + 21 * 24 * 60 * 60_000).toISOString(), issuerLifetime: 'institutional',
        expectedAuthorityEpoch: await h.epoch() });
    expect(offered.status).toBe(200);
    expect(offered.body).toMatchObject({ invitationId, status: 'pending' });
    const pending = await h.call('POST', '/v1/agents/invitation-acceptances',
      recipientUser.token, { profile: 'access-agent-invitation-acceptance-v1',
        invitationId, grantId });
    expect(pending.status).toBe(403);
    expect((await h.accessPool.query('SELECT id FROM access.permission_grant WHERE id = $1',
      [grantId])).rowCount).toBe(0);
    expect(await h.renameAccount(sameNameUser, 'edited recipient')).toBe(200);
    expect((await h.call('POST', '/v1/agents/invitation-acceptances',
      sameNameUser.token, { profile: 'access-agent-invitation-acceptance-v1',
        invitationId, grantId })).status).toBe(403);
    await h.mandate(recipientUser.principalId, recipient, 'access.invitation.accept');
    await h.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    expect((await h.call('POST', '/v1/agents/invitation-acceptances',
      recipientUser.token, { profile: 'access-agent-invitation-acceptance-v1',
        invitationId, grantId })).status).toBe(503);
    await h.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    const accepted = await h.call('POST', '/v1/agents/invitation-acceptances',
      recipientUser.token, { profile: 'access-agent-invitation-acceptance-v1',
        invitationId, grantId });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ invitationId, status: 'accepted', grantId });
    expect((await h.call('GET', `/v1/agents/invitations/${invitationId}`,
      recipientUser.token)).status).toBe(200);
    await h.accessPool.query(`INSERT INTO access.agent_invitation (id,issuer_subject,
      recipient_subject,scope_id,action,grant_valid_until,issuer_lifetime,
      issued_by_principal,issuer_representation_id,issuer_representation_generation,
      issuer_representation_action,ceiling_grant_id,ceiling_grant_generation,
      ceiling_scope_id,ceiling_action,expires_at)
      SELECT gen_random_uuid(),$1,$2,'work:create:root','work.create',
        now() + interval '21 days','institutional',$3,$4,0,
        'access.invitation.issue',$5,0,'work:create:root',
        'access.grant.assign.work.create',now() + interval '10 minutes'
      FROM generate_series(1, 16000)`,
    [issuer, recipient, issuerUser.principalId, issuerMandate, issuerCeiling]);
    await h.accessPool.query('ANALYZE access.agent_invitation');
    const explained = await h.accessPool.query<{ 'QUERY PLAN': Array<{ Plan: {
      'Index Name'?: string; 'Actual Rows': number; 'Shared Hit Blocks': number;
      'Shared Read Blocks': number } }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id FROM access.agent_invitation WHERE id = $1`, [invitationId]);
    const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(plan['Index Name']).toBe('agent_invitation_pkey');
    expect(plan['Actual Rows']).toBe(1);
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThanOrEqual(12);
    const staleInvitationId = randomUUID();
    const staleGrantId = randomUUID();
    expect((await h.call('POST', '/v1/agents/invitations', issuerUser.token,
      { profile: 'access-agent-invitation-v1', invitationId: staleInvitationId,
        issuerSubject: issuer, recipientSubject: recipient,
        grantValidUntil: new Date(Date.now() + 21 * 24 * 60 * 60_000).toISOString(),
        issuerLifetime: 'institutional', expectedAuthorityEpoch: await h.epoch() })).status).toBe(200);
    await h.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1',
      [issuerCeiling]);
    expect((await h.call('POST', '/v1/agents/invitation-acceptances',
      recipientUser.token, { profile: 'access-agent-invitation-acceptance-v1',
        invitationId: staleInvitationId, grantId: staleGrantId })).status).toBe(403);
    expect((await h.accessPool.query('SELECT 1 FROM access.permission_grant WHERE id = $1',
      [staleGrantId])).rowCount).toBe(0);
    const restored = await h.snapshotAccess();
    try {
      expect((await restored.query<{ invitation_id: string }>(`SELECT invitation_id
        FROM access.agent_invitation_acceptance WHERE invitation_id = $1`,
      [invitationId])).rows).toEqual([{ invitation_id: invitationId }]);
      expect((await restored.query(`SELECT 1 FROM access.agent_invitation_acceptance
        WHERE invitation_id = $1`, [staleInvitationId])).rowCount).toBe(0);
      expect((await restored.query(`SELECT 1 FROM access.permission_grant
        WHERE id = $1`, [staleGrantId])).rowCount).toBe(0);
    } finally { await restored.end(); }
  } finally { await h.close(); }
});

test('IAM32: an approved policy admits roster change and refuses unapproved widening', async () => {
  const h = await startAuthorityHarness('policy-api');
  try {
    const manager = await h.user('institution-manager');
    const representative = await h.user('roster-representative');
    const successor = await h.user('roster-successor');
    const approver = await h.user('grantor-approver');
    const [institution, grantor] = await Promise.all([h.agent(), h.agent()]);
    await h.mandate(manager.principalId, institution, 'access.representation.manage');
    await h.mandate(manager.principalId, grantor, 'access.grant.assign.work.create');
    await h.mandate(approver.principalId, grantor, 'access.protected-change.approve');
    await h.grant(institution, institution, 'access.representation.assign.work.create');
    await h.grant(grantor, grantor, 'access.grant.assign.work.create');
    await h.grant(grantor, grantor, 'access.protected-change.approve');
    const policyId = randomUUID();
    const ceiling = { actions: ['work.create'], maxRepresentatives: 1, maxMandateDays: 2 };
    const created = await h.call('POST', '/v1/access/representative-policy-changes',
      manager.token, { profile: 'access-representative-policy-change-v1', action: 'create',
        policyId, institutionSubject: institution, approvalSubject: grantor, ceiling });
    expect(created.status).toBe(200);
    const requestId = randomUUID();
    const mandateId = randomUUID();
    await h.accessPool.query(`INSERT INTO access.representation_request (id,
      recipient_principal, subject_id, action, valid_until, idempotency_key,
      request_digest, expires_at) VALUES ($1,$2,$3,'work.create',
        now() + interval '1 hour',$4,$5,now() + interval '10 minutes')`,
    [requestId, representative.principalId, institution, `policy-${randomUUID()}`,
      '0'.repeat(64)]);
    const accepted = await h.call('POST', '/v1/access/representative-roster-changes',
      manager.token, { profile: 'access-representative-roster-change-v1', action: 'accept',
        policyId, institutionSubject: institution, requestId, representationId: mandateId });
    expect(accepted.status).toBe(200);
    const read = await h.call('GET', `/v1/access/representative-policies/${policyId}`
      + `?institutionSubject=${encodeURIComponent(institution)}`, manager.token);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ policyId, rosterSize: 1 });
    const widening = await h.call('POST', '/v1/access/representative-policy-changes',
      manager.token, { profile: 'access-representative-policy-change-v1', action: 'revise',
        policyId, institutionSubject: institution,
        expectedGeneration: (read.body as { generation: string }).generation,
        ceiling: { ...ceiling, maxRepresentatives: 2 } });
    expect(widening.status).toBe(403);

    const grantId = randomUUID();
    const granted = await h.call('POST', '/v1/access/delegated-grant-changes', manager.token,
      { profile: grantProfile, action: 'create', issuerSubject: grantor,
        expectedAuthorityEpoch: await h.epoch(), grantId,
        recipientSubject: institution, validUntil: until(), lifetime: 'institutional',
        redelegationDepth: 0, representativePolicyId: policyId });
    expect(granted.status).toBe(200);
    const admission = await h.call('POST', '/v1/me/authority-admissions',
      representative.token, { profile: admissionProfile, admissionId: randomUUID(),
        actingSubject: institution, command: 'work.create', obligations: [
          { obligation: 'work.create', representationId: mandateId,
            edgeIds: [], grantId }] });
    expect(admission.status).toBe(200);
    await h.accessPool.query('UPDATE access.representation SET active = false WHERE id = $1',
      [mandateId]);
    const nextRequestId = randomUUID();
    const nextMandateId = randomUUID();
    await h.accessPool.query(`INSERT INTO access.representation_request (id,
      recipient_principal, subject_id, action, valid_until, idempotency_key,
      request_digest, expires_at) VALUES ($1,$2,$3,'work.create',
        now() + interval '1 hour',$4,$5,now() + interval '10 minutes')`,
    [nextRequestId, successor.principalId, institution, `policy-${randomUUID()}`,
      '0'.repeat(64)]);
    expect((await h.call('POST', '/v1/access/representative-roster-changes',
      manager.token, { profile: 'access-representative-roster-change-v1', action: 'accept',
        policyId, institutionSubject: institution, requestId: nextRequestId,
        representationId: nextMandateId })).status).toBe(200);
    expect((await h.accessPool.query<{ active: boolean }>(`SELECT active FROM
      access.permission_grant WHERE id = $1`, [grantId])).rows[0]?.active).toBe(true);
    expect((await h.call('POST', '/v1/me/authority-admissions', successor.token,
      { profile: admissionProfile, admissionId: randomUUID(),
        actingSubject: institution, command: 'work.create', obligations: [
          { obligation: 'work.create', representationId: nextMandateId,
            edgeIds: [], grantId }] })).status).toBe(200);
    const policyAfterRoster = await h.call('GET', `/v1/access/representative-policies/${policyId}`
      + `?institutionSubject=${encodeURIComponent(institution)}`, manager.token);
    expect(policyAfterRoster.status).toBe(200);
    const proposalId = randomUUID();
    const widened = { ...ceiling, maxRepresentatives: 2 };
    const proposed = await h.call('POST', '/v1/access/protected-change-proposals',
      manager.token, { profile: 'access-protected-change-v1', proposalId,
        issuerSubject: institution, expectedAuthorityEpoch: await h.epoch(),
        change: { kind: 'representative-policy', policyId,
          expectedGeneration: (policyAfterRoster.body as { generation: string }).generation,
          ceiling: widened } });
    expect(proposed.status).toBe(200);
    expect((await h.call('POST', '/v1/access/protected-change-approvals',
      approver.token, { profile: 'access-protected-change-approval-v1', proposalId,
        approverSubject: grantor,
        changeDigest: (proposed.body as { changeDigest: string }).changeDigest })).status).toBe(200);
    expect((await h.call('POST', '/v1/access/protected-change-activations',
      manager.token, { profile: 'access-protected-change-activation-v1',
        proposalId })).status).toBe(200);
    expect((await h.call('GET', `/v1/access/representative-policies/${policyId}`
      + `?institutionSubject=${encodeURIComponent(institution)}`, manager.token)).body)
      .toMatchObject({ ceiling: widened });
    expect((await h.call('POST', '/v1/access/representative-policy-changes',
      manager.token, { profile: 'access-representative-policy-change-v1', action: 'revise',
        policyId, institutionSubject: institution,
        expectedGeneration: (policyAfterRoster.body as { generation: string }).generation,
        ceiling })).status).toBe(409);

    const policyProbe = async (count: number) => {
      const client = await h.accessPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('CREATE TEMP TABLE policy_bg (id uuid PRIMARY KEY) ON COMMIT DROP');
        await client.query(`INSERT INTO policy_bg SELECT gen_random_uuid()
          FROM generate_series(1, $1::integer)`, [count]);
        await client.query(`INSERT INTO access.representative_policy
          (id,institution_subject,approval_subject,active_revision,created_by_principal)
          SELECT id,$1,$2,1,$3 FROM policy_bg`,
        [institution, grantor, manager.principalId]);
        await client.query(`INSERT INTO access.representative_policy_revision
          (policy_id,revision,actions,max_representatives,max_mandate_days,widening,
            created_by_principal)
          SELECT id,1,'{work.create}'::text[],1,2,false,$1 FROM policy_bg`,
        [manager.principalId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
      await h.accessPool.query('ANALYZE access.representative_policy');
      const explained = await h.accessPool.query<{ 'QUERY PLAN': Array<{ Plan: {
        'Node Type': string; 'Actual Rows': number; 'Shared Hit Blocks': number;
        'Shared Read Blocks': number; 'Index Name'?: string } }> }>(`EXPLAIN
        (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM access.representative_policy
        WHERE id = $1 AND institution_subject = $2`, [policyId, institution]);
      const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(plan['Actual Rows']).toBe(1);
      return { index: plan['Index Name'],
        blocks: plan['Shared Hit Blocks'] + plan['Shared Read Blocks'] };
    };
    expect((await policyProbe(64)).blocks).toBeLessThanOrEqual(12);
    const largePlan = await policyProbe(15_936);
    expect(largePlan.blocks).toBeLessThanOrEqual(12);
    expect(largePlan.index).toMatch(/representative_policy_(pkey|id_.*_key)/);
    const restored = await h.snapshotAccess();
    try {
      const owner = new AccessGrants(restored);
      const principal = { issuer: h.accountIssuer, subject: manager.accountId };
      expect(await owner.control.policies.read(principal, policyId, institution))
        .toMatchObject({ ceiling: widened, rosterSize: 1 });
      expect((await restored.query<{ active: boolean }>(`SELECT active
        FROM access.permission_grant WHERE id = $1`, [grantId])).rows[0]?.active).toBe(true);
      expect((await restored.query<{ active: boolean }>(`SELECT active FROM
        access.representation WHERE id = $1`, [nextMandateId])).rows[0]?.active).toBe(true);
    } finally { await restored.end(); }
  } finally { await h.close(); }
});

test('IAM08: last controller is retained and independent recovery replaces it', async () => {
  const h = await startAuthorityHarness('recovery-api');
  try {
    const controller = await h.user('controller');
    const claimant = await h.user('claimant');
    const approver = await h.user('approver');
    const [subject, recoverySubject] = await Promise.all([h.agent(), h.agent()]);
    const controllerId = await h.mandate(controller.principalId, subject, 'agent.control',
      { until: 'infinity' });
    await h.mandate(approver.principalId, recoverySubject,
      'access.protected-change.approve');
    await h.grant(recoverySubject, recoverySubject, 'access.protected-change.approve');
    const configured = await h.call('POST', '/v1/agents/control', controller.token,
      { profile: 'access-agent-control-v1', subjectId: subject,
        recoverySubject, recoveryApprovals: 1, recoveryDelaySeconds: 0,
        minControllers: 1, maxControllers: 2 });
    expect(configured.status).toBe(200);
    const removal = await h.call('POST', '/v1/agents/controller-changes', controller.token,
      { profile: 'access-agent-controller-change-v1', action: 'remove',
        subjectId: subject, representationId: controllerId, expectedGeneration: '0' });
    expect(removal.status).toBe(409);
    const recoveryId = randomUUID();
    expect((await h.call('POST', '/v1/agents/recoveries', claimant.token,
      { profile: 'access-agent-recovery-v1', recoveryId, subjectId: subject,
        reason: 'controller-compromised', expectedControlGeneration: '999' })).status).toBe(409);
    const requested = await h.call('POST', '/v1/agents/recoveries', claimant.token,
      { profile: 'access-agent-recovery-v1', recoveryId, subjectId: subject,
        reason: 'controller-compromised',
        expectedControlGeneration: (configured.body as { generation: string }).generation });
    expect(requested.status).toBe(200);
    expect((await h.call('POST', '/v1/access/protected-change-approvals', claimant.token,
      { profile: 'access-protected-change-approval-v1', proposalId: recoveryId,
        approverSubject: recoverySubject,
        changeDigest: (requested.body as { changeDigest: string }).changeDigest })).status).toBe(403);
    const approved = await h.call('POST', '/v1/access/protected-change-approvals',
      approver.token, { profile: 'access-protected-change-approval-v1',
        proposalId: recoveryId, approverSubject: recoverySubject,
        changeDigest: (requested.body as { changeDigest: string }).changeDigest });
    expect(approved.status).toBe(200);
    await h.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    expect((await h.call('POST', '/v1/access/protected-change-activations', claimant.token,
      { profile: 'access-protected-change-activation-v1',
        proposalId: recoveryId })).status).toBe(503);
    await h.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    const activated = await h.call('POST', '/v1/access/protected-change-activations',
      claimant.token, { profile: 'access-protected-change-activation-v1',
        proposalId: recoveryId });
    expect(activated.status).toBe(200);
    const state = await h.accessPool.query<{ principal_id: string }>(`SELECT principal_id
      FROM access.representation WHERE subject_id = $1 AND action = 'agent.control'
        AND active`, [subject]);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.principal_id).toBe(claimant.principalId);
    await h.accessPool.query(`INSERT INTO access.representation
      (id,principal_id,subject_id,action,valid_until)
      SELECT gen_random_uuid(),$1,$2,'agent.control','infinity'::timestamptz
      FROM generate_series(1, 16000)`, [approver.principalId, recoverySubject]);
    await h.accessPool.query('ANALYZE access.representation');
    const explained = await h.accessPool.query<{ 'QUERY PLAN': Array<{ Plan: {
      'Index Name'?: string; 'Actual Rows': number; 'Shared Hit Blocks': number;
      'Shared Read Blocks': number } }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id FROM access.representation WHERE subject_id = $1
        AND action = 'agent.control' AND active LIMIT 17`, [subject]);
    const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(JSON.stringify(plan)).toMatch(/representation_(controller_lookup|subject_fk)/);
    expect(plan['Actual Rows']).toBe(1);
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThanOrEqual(12);
    const restored = await h.snapshotAccess();
    try {
      expect((await restored.query<{ principal_id: string }>(`SELECT principal_id
        FROM access.representation WHERE subject_id = $1 AND action = 'agent.control'
          AND active`, [subject])).rows).toEqual([{ principal_id: claimant.principalId }]);
      expect((await restored.query<{ generation: string }>(`SELECT generation
        FROM access.agent_control WHERE subject_id = $1`, [subject])).rows).toHaveLength(1);
    } finally { await restored.end(); }
  } finally { await h.close(); }
});

test('IAM08: independent Account claim replaces a compromised credential and fences old tokens', async () => {
  const h = await startAuthorityHarness('account-recovery-api');
  try {
    const owner = await h.user('recovery-owner');
    const guardian = await h.user('independent-guardian');
    const other = await h.user('unrelated-account');
    const subject = await h.agent();
    await h.mandate(owner.principalId, subject, 'agent.control', { until: 'infinity' });
    const recoverySubject = await h.agent();
    expect((await h.call('POST', '/v1/agents/control', owner.token,
      { profile: 'access-agent-control-v1', subjectId: subject,
        recoverySubject, recoveryApprovals: 1, recoveryDelaySeconds: 0,
        minControllers: 1, maxControllers: 2 })).status).toBe(200);
    const controlPath = `/v1/agents/control?subjectId=${encodeURIComponent(subject)}`;
    expect((await h.call('GET', controlPath, owner.token)).status).toBe(200);
    const code = randomBytes(32).toString('base64url');
    const policy = { currentPassword: owner.password, guardianEmail: guardian.email,
      recoveryCode: code };
    expect((await h.accountRequest('/api/account/recovery-policy',
      { ...policy, currentPassword: 'wrong-password' }, owner.sessionCookie)).status).toBe(403);
    expect((await h.accountRequest('/api/account/recovery-policy',
      { ...policy, guardianEmail: owner.email }, owner.sessionCookie)).status).toBe(403);
    expect((await h.accountRequest('/api/account/recovery-policy', policy,
      owner.sessionCookie)).status).toBe(200);
    expect((await h.accountRequest('/api/account/recovery-policy', policy,
      owner.sessionCookie)).status).toBe(200);
    const claimId = randomUUID();
    const claimPath = '/api/account/recovery-claims';
    const claim = { claimId, targetEmail: owner.email, recoveryCode: code };
    expect((await h.accountRequest(claimPath,
      { ...claim, recoveryCode: randomBytes(32).toString('base64url') })).status).toBe(403);
    const requested = await h.accountRequest(claimPath, claim);
    expect(requested.status).toBe(200);
    expect((await requested.json() as { approved: boolean }).approved).toBe(false);
    const replay = await h.accountRequest(claimPath, claim);
    expect(replay.status).toBe(200);
    expect((await replay.json() as { replayed: boolean }).replayed).toBe(true);
    const activatePath = `${claimPath}/${claimId}/activation`;
    const nextPassword = 'independent recovered credential 2026';
    const activation = { recoveryCode: code, newPassword: nextPassword };
    expect((await h.accountRequest(activatePath, activation)).status).toBe(403);
    const approvalPath = `${claimPath}/${claimId}/approval`;
    expect((await h.accountRequest(approvalPath, {}, owner.sessionCookie)).status).toBe(403);
    expect((await h.accountRequest(approvalPath, {}, other.sessionCookie)).status).toBe(403);
    expect((await h.accountRequest(approvalPath, {}, guardian.sessionCookie)).status).toBe(200);
    expect((await h.accountRequest(activatePath, activation)).status).toBe(409);
    await h.accountPool.query(`UPDATE public.rezics_account_recovery_claim
      SET not_before = clock_timestamp() - interval '1 second' WHERE id = $1`, [claimId]);
    const secondClaimId = randomUUID();
    expect((await h.accountRequest(claimPath,
      { ...claim, claimId: secondClaimId })).status).toBe(200);
    expect((await h.accountRequest(`${claimPath}/${secondClaimId}/approval`, {},
      guardian.sessionCookie)).status).toBe(200);
    const pendingCode = await h.codeFor(owner);
    const refreshBasis = await h.codeFor(owner, 'openid offline_access access:grant');
    const refreshExchange = await h.exchangeCode(refreshBasis.code, refreshBasis.verifier);
    expect(refreshExchange.status).toBe(200);
    const oldRefreshToken = (await refreshExchange.json() as { refresh_token?: string }).refresh_token;
    expect(oldRefreshToken).toBeTruthy();
    const outcomes = await Promise.all([h.accountRequest(activatePath, activation),
      h.accountRequest(activatePath, activation)]);
    expect(outcomes.map(response => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(outcomes.map(async response => response.json() as Promise<{
      recoveryGeneration: string; replayed: boolean }>));
    expect(bodies.map(body => body.replayed).sort()).toEqual([false, true]);
    expect(bodies.map(body => body.recoveryGeneration)).toEqual(['1', '1']);
    expect((await h.accountRequest(activatePath,
      { ...activation, newPassword: 'a different recovered credential' })).status).toBe(409);
    expect((await h.accountRequest(`${claimPath}/${secondClaimId}/activation`,
      activation)).status).toBe(409);
    expect((await h.exchangeCode(pendingCode.code, pendingCode.verifier)).status).not.toBe(200);
    expect((await h.refreshToken(oldRefreshToken!)).status).not.toBe(200);
    const old = await h.request('GET', controlPath, owner.token);
    expect(old.status).not.toBe(200);
    const oldSession = await fetch(`${h.accountBase}/api/auth/get-session`,
      { headers: { cookie: owner.sessionCookie } });
    expect((await oldSession.json() as { user?: unknown } | null)?.user).toBeUndefined();
    const signInOld = await fetch(`${h.accountBase}/api/auth/sign-in/email`, { method: 'POST',
      headers: { origin: h.accountBase, 'content-type': 'application/json' },
      body: JSON.stringify({ email: owner.email, password: owner.password }) });
    expect(signInOld.status).not.toBe(200);
    const fresh = await h.tokenFor({ email: owner.email, password: nextPassword });
    expect((await h.call('GET', controlPath, fresh)).status).toBe(200);
    expect((await h.accountPool.query<{ generation: string; code_hash: string | null }>(`SELECT
      generation, code_hash FROM public.rezics_account_recovery_policy WHERE id = $1`,
    [owner.accountId])).rows).toEqual([{ generation: '1', code_hash: null }]);
    const recoveredSignIn = await fetch(`${h.accountBase}/api/auth/sign-in/email`, {
      method: 'POST', headers: { origin: h.accountBase, 'content-type': 'application/json' },
      body: JSON.stringify({ email: owner.email, password: nextPassword }) });
    expect(recoveredSignIn.status).toBe(200);
    const recoveredCookie = recoveredSignIn.headers.get('set-cookie')!;
    const replacementCode = randomBytes(32).toString('base64url');
    const rotatedCode = randomBytes(32).toString('base64url');
    const nextPolicy = { currentPassword: nextPassword, guardianEmail: other.email,
      recoveryCode: replacementCode };
    expect((await h.accountRequest('/api/account/recovery-policy', nextPolicy,
      recoveredCookie)).status).toBe(200);
    expect((await h.accountRequest('/api/account/recovery-policy',
      { ...nextPolicy, guardianEmail: guardian.email, recoveryCode: rotatedCode,
        previousRecoveryCode: randomBytes(32).toString('base64url') },
      recoveredCookie)).status).toBe(409);
    const rotated = await h.accountRequest('/api/account/recovery-policy',
      { ...nextPolicy, guardianEmail: guardian.email, recoveryCode: rotatedCode,
        previousRecoveryCode: replacementCode }, recoveredCookie);
    expect(rotated.status).toBe(200);
    expect((await rotated.json() as { generation: string }).generation).toBe('2');
    expect((await h.request('GET', controlPath, fresh)).status).not.toBe(200);
    const claimRead = await h.accountRequest(`${claimPath}/${claimId}/read`,
      { recoveryCode: code });
    expect(claimRead.status).toBe(200);
    expect(await claimRead.json()).toMatchObject({ claimId, approved: true, activated: true });
    const recoveryPlan = async (from: number, to: number) => {
      await h.accountPool.query(`INSERT INTO public.rezics_account_recovery_claim
        (id, target_user_id, policy_generation, code_hash, request_digest,
          not_before, expires_at)
        SELECT gen_random_uuid(), $1, 0, repeat('0',64), repeat('0',64),
          now() + interval '1 day', now() + interval '7 days'
        FROM generate_series($2::integer,$3::integer)`, [owner.accountId, from, to]);
      await h.accountPool.query('ANALYZE public.rezics_account_recovery_claim');
      const explained = await h.accountPool.query<{ 'QUERY PLAN': Array<{ Plan: {
        'Node Type': string; 'Index Name'?: string; 'Actual Rows': number;
        'Shared Hit Blocks': number; 'Shared Read Blocks': number } }> }>(`EXPLAIN
        (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM
        public.rezics_account_recovery_claim WHERE id = $1`, [claimId]);
      const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(plan['Actual Rows']).toBe(1);
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThanOrEqual(12);
      return plan;
    };
    await recoveryPlan(1, 64);
    const largePlan = await recoveryPlan(65, 16_000);
    expect(largePlan['Node Type']).toMatch(/Index (Only )?Scan/);
    expect(largePlan['Index Name']).toBe('rezics_account_recovery_claim_pkey');
    const restored = await h.snapshotAccount();
    try {
      const rows = await restored.query<{ generation: string; code_hash: string | null }>(`SELECT
        generation, code_hash FROM public.rezics_account_recovery_policy WHERE id = $1`,
      [owner.accountId]);
      expect(rows.rows[0]?.generation).toBe('2');
      expect(rows.rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect((await restored.query(`SELECT id FROM public.rezics_account_recovery_activation
        WHERE id = $1`, [claimId])).rowCount).toBe(1);
      expect((await restored.query(`SELECT id FROM public."session" WHERE "userId" = $1
        AND "createdAt" < (SELECT recovered_at FROM public.rezics_account_recovery_policy
          WHERE id = $1)`, [owner.accountId])).rowCount).toBe(0);
      const coverage = await accountRecoveryCoverage(restored);
      await expect(assertAccountRecoveryCoverage(restored, coverage)).resolves.toBeUndefined();
      await restored.query(`UPDATE public.rezics_account_recovery_policy
        SET code_hash = repeat('1',64) WHERE id = $1`, [owner.accountId]);
      await expect(assertAccountRecoveryCoverage(restored, coverage))
        .rejects.toThrow('Account rows differ');
    } finally { await restored.end(); }
  } finally { await h.close(); }
}, 30_000);

test('IAM05/IAM30: a protected group member needs an independent approved activation', async () => {
  const h = await startAuthorityHarness('protected-api');
  try {
    const manager = await h.user('manager');
    const approver = await h.user('approver');
    const [owner, approvalSubject] = await Promise.all([h.agent(), h.agent()]);
    const member = owner;
    await h.mandate(manager.principalId, owner, 'access.group.manage');
    await h.grant(owner, owner, 'access.group.manage');
    await h.mandate(approver.principalId, approvalSubject,
      'access.protected-change.approve');
    await h.grant(approvalSubject, approvalSubject, 'access.protected-change.approve');
    const groupId = randomUUID();
    const groupPath = `/v1/access/group-scope?issuerSubject=${encodeURIComponent(owner)}`;
    const initial = await h.call('GET', groupPath, manager.token);
    expect(initial.status).toBe(200);
    const created = await h.call('POST', '/v1/access/group-changes', manager.token,
      { profile: 'work-create-group-change-v1', issuerSubject: owner,
        expectedGroupGeneration: (initial.body as { groupGeneration: string }).groupGeneration,
        action: 'create', groupId, parentId: null });
    expect(created.status).toBe(200);
    await h.accessPool.query(`INSERT INTO access.group_permission_grant
      (id,group_id,issuer_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$3,'work:create:root','work.create',now() + interval '1 hour')`,
    [randomUUID(), groupId, owner]);
    const protectedSet = await h.call('POST', '/v1/access/protected-sets', manager.token,
      { profile: 'access-protected-set-v1', objectKind: 'group', objectId: groupId,
        issuerSubject: owner, approvalSubject, requiredApprovals: 1 });
    expect(protectedSet.status).toBe(200);
    const memberId = randomUUID();
    const direct = await h.call('POST', '/v1/access/group-changes', manager.token,
      { profile: 'work-create-group-change-v1', issuerSubject: owner,
        expectedGroupGeneration: (await h.call('GET', groupPath, manager.token)
          .then(r => r.body as { groupGeneration: string })).groupGeneration,
        action: 'add-member', memberId, groupId, agentSubject: member });
    expect(direct.status).toBe(403);
    const proposalId = randomUUID();
    const proposal = { profile: 'access-protected-change-v1', proposalId,
        issuerSubject: owner, expectedAuthorityEpoch: await h.epoch(),
        change: { kind: 'group-member', groupId, memberId, agentSubject: member } };
    expect((await h.call('POST', '/v1/access/protected-change-proposals',
      manager.token, proposal)).status).toBe(403);
    await h.grant(owner, owner, 'access.group.assign.work.create');
    const proposed = await h.call('POST', '/v1/access/protected-change-proposals',
      manager.token, proposal);
    expect(proposed.status).toBe(200);
    const approval = { profile: 'access-protected-change-approval-v1', proposalId,
      approverSubject: approvalSubject,
      changeDigest: (proposed.body as { changeDigest: string }).changeDigest };
    expect((await h.call('POST', '/v1/access/protected-change-approvals',
      manager.token, approval)).status).toBe(403);
    expect((await h.call('POST', '/v1/access/protected-change-approvals',
      approver.token, approval)).status).toBe(403);
    await h.grant(approvalSubject, approvalSubject, 'access.grant.assign.work.create');
    expect((await h.call('POST', '/v1/access/protected-change-approvals',
      approver.token, approval)).status).toBe(200);
    const activated = await h.call('POST', '/v1/access/protected-change-activations',
      manager.token, { profile: 'access-protected-change-activation-v1', proposalId });
    expect(activated.status).toBe(200);
    expect((await h.accessPool.query<{ id: string }>(`SELECT id FROM access.group_member
      WHERE id = $1 AND agent_subject = $2`, [memberId, member])).rows).toHaveLength(1);
    await h.accessPool.query(`INSERT INTO access.protected_change_proposal
      (id,kind,target_subject,target_object,scope_id,expected_authority_epoch,
        expected_object_generation,resulting_ceiling,staged_change,change_digest,
        approval_subject,required_approvals,requested_by,requester_subject,
        not_before,expires_at)
      SELECT gen_random_uuid(),'group-member',$1,$2,'work:create:root',0,0,
        '{}'::text[],'{}'::jsonb,repeat('0',64),$3,1,$4,$1,
        clock_timestamp(),clock_timestamp() + interval '1 day'
      FROM generate_series(1, 16000)`,
    [owner, groupId, approvalSubject, manager.principalId]);
    await h.accessPool.query('ANALYZE access.protected_change_proposal');
    const explained = await h.accessPool.query<{ 'QUERY PLAN': Array<{ Plan: {
      'Index Name'?: string; 'Actual Rows': number; 'Shared Hit Blocks': number;
      'Shared Read Blocks': number } }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id FROM access.protected_change_proposal WHERE id = $1`, [proposalId]);
    const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(plan['Index Name']).toMatch(/protected_change_proposal_(pkey|id_.*_key)/);
    expect(plan['Actual Rows']).toBe(1);
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThanOrEqual(12);
    const restored = await h.snapshotAccess();
    try {
      expect((await restored.query<{ id: string }>(`SELECT id FROM access.group_member
        WHERE id = $1 AND agent_subject = $2`, [memberId, member])).rows)
        .toEqual([{ id: memberId }]);
      expect((await restored.query<{ proposal_id: string }>(`SELECT proposal_id FROM
        access.protected_change_activation WHERE proposal_id = $1`, [proposalId])).rows)
        .toEqual([{ proposal_id: proposalId }]);
    } finally { await restored.end(); }
  } finally { await h.close(); }
});

test('IAM05/IAM30: a populated protected role changes only with approved rebind', async () => {
  const h = await startAuthorityHarness('protected-role-api');
  try {
    const manager = await h.user('manager');
    const approver = await h.user('approver');
    const [owner, approvalSubject, recipient] = await Promise.all([
      h.agent(), h.agent(), h.agent()]);
    await h.mandate(manager.principalId, owner, 'access.role.manage');
    await h.mandate(manager.principalId, owner, 'access.role.bind');
    await h.grant(owner, owner, 'access.role.manage');
    await h.grant(owner, owner, 'access.role.bind');
    const assignCeiling = await h.grant(owner, owner,
      'access.grant.assign.work.create');
    await h.mandate(approver.principalId, approvalSubject,
      'access.protected-change.approve');
    await h.grant(approvalSubject, approvalSubject, 'access.protected-change.approve');
    const familyId = randomUUID();
    const created = await h.call('POST', '/v1/access/roles', manager.token,
      { profile: 'work-create-role-family-v1', familyId, issuerSubject: owner,
        expectedAuthorityEpoch: await h.epoch(), permissions: ['work.create'] });
    expect(created.status).toBe(200);
    const bindingId = randomUUID();
    const bound = await h.call('POST', '/v1/access/role-bindings', manager.token,
      { profile: 'work-create-role-binding-change-v1', issuerSubject: owner,
        expectedAuthorityEpoch: await h.epoch(), action: 'bind', bindingId,
        familyId, roleRevision: '1', recipientSubject: recipient, validUntil: until() });
    expect(bound.status).toBe(200);
    const protect = await h.call('POST', '/v1/access/protected-sets', manager.token,
      { profile: 'access-protected-set-v1', objectKind: 'role-family', objectId: familyId,
        issuerSubject: owner, approvalSubject, requiredApprovals: 1 });
    expect(protect.status).toBe(200);
    const revision = { profile: 'work-create-role-revision-v1', familyId,
      issuerSubject: owner, expectedAuthorityEpoch: await h.epoch(),
      expectedHeadRevision: '1', permissions: [] };
    expect((await h.call('POST', '/v1/access/role-revisions',
      manager.token, revision)).status).toBe(403);
    const proposalId = randomUUID();
    const proposal = await h.call('POST', '/v1/access/protected-change-proposals',
      manager.token, { profile: 'access-protected-change-v1', proposalId,
        issuerSubject: owner, expectedAuthorityEpoch: await h.epoch(),
        change: { kind: 'role-revision', familyId, expectedHeadRevision: '1',
          permissions: [] } });
    expect(proposal.status).toBe(200);
    const approval = await h.call('POST', '/v1/access/protected-change-approvals',
      approver.token, { profile: 'access-protected-change-approval-v1', proposalId,
        approverSubject: approvalSubject,
        changeDigest: (proposal.body as { changeDigest: string }).changeDigest });
    expect(approval.status).toBe(200);
    await h.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    expect((await h.call('POST', '/v1/access/protected-change-activations',
      manager.token, { profile: 'access-protected-change-activation-v1',
        proposalId })).status).toBe(503);
    await h.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    const activation = await h.call('POST', '/v1/access/protected-change-activations',
      manager.token, { profile: 'access-protected-change-activation-v1', proposalId });
    expect(activation.status).toBe(200);
    const bindings = await h.accessPool.query<{ role_revision: string; active: boolean }>(`
      SELECT role_revision, active FROM access.role_binding WHERE family_id = $1
      ORDER BY role_revision`, [familyId]);
    expect(bindings.rows).toEqual([{ role_revision: '1', active: false },
      { role_revision: '2', active: true }]);
    const staleProposalId = randomUUID();
    const staleProposal = await h.call('POST', '/v1/access/protected-change-proposals',
      manager.token, { profile: 'access-protected-change-v1', proposalId: staleProposalId,
        issuerSubject: owner, expectedAuthorityEpoch: await h.epoch(),
        change: { kind: 'role-revision', familyId, expectedHeadRevision: '2',
          permissions: ['work.create'] } });
    expect(staleProposal.status).toBe(200);
    await h.grant(approvalSubject, approvalSubject, 'access.grant.assign.work.create');
    expect((await h.call('POST', '/v1/access/protected-change-approvals',
      approver.token, { profile: 'access-protected-change-approval-v1',
        proposalId: staleProposalId, approverSubject: approvalSubject,
        changeDigest: (staleProposal.body as { changeDigest: string }).changeDigest })).status).toBe(200);
    await h.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1',
      [assignCeiling]);
    expect((await h.call('POST', '/v1/access/protected-change-activations',
      manager.token, { profile: 'access-protected-change-activation-v1',
        proposalId: staleProposalId })).status).toBe(403);
    expect((await h.accessPool.query<{ head_revision: string }>(`SELECT head_revision
      FROM access.role_family WHERE id = $1`, [familyId])).rows[0]?.head_revision).toBe('2');
    const restored = await h.snapshotAccess();
    try {
      expect((await restored.query<{ head_revision: string }>(`SELECT head_revision
        FROM access.role_family WHERE id = $1`, [familyId])).rows[0]?.head_revision).toBe('2');
      expect((await restored.query(`SELECT 1 FROM access.protected_change_activation
        WHERE proposal_id = $1`, [staleProposalId])).rowCount).toBe(0);
    } finally { await restored.end(); }
  } finally { await h.close(); }
});

test('IAM30: privileged automation requires the owner and approver ceilings', async () => {
  const h = await startAuthorityHarness('automation-api');
  try {
    const manager = await h.user('manager');
    const approver = await h.user('approver');
    const workload = await h.user('workload');
    const [owner, approvalSubject] = await Promise.all([h.agent(), h.agent()]);
    const action = 'access.group.manage';
    const assign = `access.representation.assign.${action}`;
    await h.mandate(manager.principalId, owner, 'access.representation.manage');
    await h.grant(owner, owner, assign);
    await h.mandate(approver.principalId, approvalSubject,
      'access.protected-change.approve');
    await h.grant(approvalSubject, approvalSubject, 'access.protected-change.approve');
    const enrollmentId = randomUUID();
    const installationId = randomUUID();
    const enrolled = await h.call('POST', '/v1/me/automation-enrollments',
      workload.token, { profile: 'access-automation-enrollment-v1', enrollmentId,
        ownerSubject: owner, actions: [action], validUntil: until() });
    expect(enrolled.status).toBe(200);
    const direct = await h.call('POST', '/v1/access/automation-installations',
      manager.token, { profile: 'access-automation-installation-v1', installationId,
        ownerSubject: owner, enrollmentId });
    expect(direct.status).toBe(403);
    const proposalId = randomUUID();
    const proposed = await h.call('POST', '/v1/access/protected-change-proposals',
      manager.token, { profile: 'access-protected-change-v1', proposalId,
        issuerSubject: owner, expectedAuthorityEpoch: await h.epoch(),
        change: { kind: 'automation-install', installationId, enrollmentId,
          approvalSubject } });
    expect(proposed.status).toBe(200);
    const approval = { profile: 'access-protected-change-approval-v1', proposalId,
      approverSubject: approvalSubject,
      changeDigest: (proposed.body as { changeDigest: string }).changeDigest };
    expect((await h.call('POST', '/v1/access/protected-change-approvals',
      approver.token, approval)).status).toBe(403);
    await h.grant(approvalSubject, approvalSubject, assign);
    expect((await h.call('POST', '/v1/access/protected-change-approvals',
      approver.token, approval)).status).toBe(200);
    const activation = await h.call('POST', '/v1/access/protected-change-activations',
      manager.token, { profile: 'access-protected-change-activation-v1', proposalId });
    expect(activation.status).toBe(200);
    const installed = await h.accessPool.query<{ principal_id: string }>(`SELECT principal_id
      FROM access.representation WHERE automation_installation_id = $1 AND active`,
    [installationId]);
    expect(installed.rows).toEqual([{ principal_id: workload.principalId }]);
    const restored = await h.snapshotAccess();
    try {
      expect((await restored.query<{ principal_id: string }>(`SELECT principal_id FROM
        access.representation WHERE automation_installation_id = $1 AND active`,
      [installationId])).rows).toEqual([{ principal_id: workload.principalId }]);
    } finally { await restored.end(); }
  } finally { await h.close(); }
});
