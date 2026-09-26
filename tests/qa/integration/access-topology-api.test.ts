import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { startAuthorityHarness } from './access-topology-harness.ts';

const profile = 'access-representation-edge-change-v1';
const admissionProfile = 'access-compound-admission-v1';
const grantProfile = 'access-delegated-grant-change-v1';
const until = () => new Date(Date.now() + 60 * 60_000).toISOString();

test('IAM27/IAM28/IAM31: admitted path is exact, acyclic and loses revoked edges', async () => {
  const h = await startAuthorityHarness('topology-api');
  try {
    const user = await h.user('operator');
    const [a, b] = await Promise.all([h.agent(), h.agent()]);
    const origin = await h.mandate(user.principalId, a, 'work.create', { maxPathEdges: 1 });
    await h.mandate(user.principalId, b, 'access.representation.manage');
    await h.mandate(user.principalId, a, 'access.representation.manage');
    await h.grant(b, b, 'access.representation.assign.work.create');
    await h.grant(a, a, 'access.representation.assign.work.create');
    const workGrant = await h.grant(b, b, 'work.create');
    const edgeId = randomUUID();
    const edge = await h.call('POST', '/v1/access/representation-edge-changes', user.token,
      { profile, action: 'create', edgeId, representativeSubject: a, representedSubject: b,
        edgeAction: 'work.create', maxPathEdges: 1, validUntil: until(),
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

    const admissionId = randomUUID();
    const admission = await h.call('POST', '/v1/me/authority-admissions', user.token,
      { profile: admissionProfile, admissionId, actingSubject: b, command: 'work.create',
        obligations: [{ obligation: 'work.create', representationId: origin,
          edgeIds: [edgeId], grantId: workGrant }] });
    expect(admission.status).toBe(200);
    expect(admission.body).toMatchObject({ admissionId, replayed: false });
    expect((await h.call('POST', `/v1/me/authority-admissions/${admissionId}/checks`,
      user.token)).status).toBe(200);
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
    const [issuer, middle, recipient] = await Promise.all([h.agent(), h.agent(), h.agent()]);
    await h.mandate(user.principalId, issuer, 'access.grant.assign.work.create');
    await h.mandate(user.principalId, middle, 'access.grant.assign.work.create');
    await h.grant(issuer, issuer, 'access.grant.assign.work.create');
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
    const childId = randomUUID();
    const child = await h.call('POST', '/v1/access/delegated-grant-changes', user.token,
      { profile: grantProfile, action: 'create', issuerSubject: middle,
        expectedAuthorityEpoch: await h.epoch(), grantId: childId,
        recipientSubject: recipient, validUntil: grantUntil, lifetime: 'dependent',
        upstreamGrantId: rootId, redelegationDepth: 0 });
    expect(child.status).toBe(200);
    const read = await h.call('GET', `/v1/access/grants/${childId}/lineage`
      + `?issuerSubject=${encodeURIComponent(middle)}`, user.token);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ lineage: { lifetime: 'dependent',
      upstreamGrantId: rootId, rootGrantId: rootId } });
    await h.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1',
      [rootId]);
    const state = await h.accessPool.query<{ active: boolean }>(
      'SELECT active FROM access.permission_grant WHERE id = $1', [childId]);
    expect(state.rows[0]?.active).toBe(false);
  } finally { await h.close(); }
});

test('IAM12: invitation remains pending until the recipient Agent admits its representative', async () => {
  const h = await startAuthorityHarness('invitation-api');
  try {
    const issuerUser = await h.user('issuer');
    const recipientUser = await h.user('recipient');
    const [issuer, recipient] = await Promise.all([h.agent(), h.agent()]);
    await h.mandate(issuerUser.principalId, issuer, 'access.invitation.issue');
    await h.grant(issuer, issuer, 'access.grant.assign.work.create', '30 days');
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
    await h.mandate(recipientUser.principalId, recipient, 'access.invitation.accept');
    const accepted = await h.call('POST', '/v1/agents/invitation-acceptances',
      recipientUser.token, { profile: 'access-agent-invitation-acceptance-v1',
        invitationId, grantId });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ invitationId, status: 'accepted', grantId });
    expect((await h.call('GET', `/v1/agents/invitations/${invitationId}`,
      recipientUser.token)).status).toBe(200);
  } finally { await h.close(); }
});

test('IAM32: an approved policy admits roster change and refuses unapproved widening', async () => {
  const h = await startAuthorityHarness('policy-api');
  try {
    const manager = await h.user('institution-manager');
    const representative = await h.user('roster-representative');
    const [institution, grantor] = await Promise.all([h.agent(), h.agent()]);
    await h.mandate(manager.principalId, institution, 'access.representation.manage');
    await h.mandate(manager.principalId, grantor, 'access.grant.assign.work.create');
    await h.grant(institution, institution, 'access.representation.assign.work.create');
    await h.grant(grantor, grantor, 'access.grant.assign.work.create');
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
    const requested = await h.call('POST', '/v1/agents/recoveries', claimant.token,
      { profile: 'access-agent-recovery-v1', recoveryId, subjectId: subject,
        reason: 'controller-compromised',
        expectedControlGeneration: (configured.body as { generation: string }).generation });
    expect(requested.status).toBe(200);
    const approved = await h.call('POST', '/v1/access/protected-change-approvals',
      approver.token, { profile: 'access-protected-change-approval-v1',
        proposalId: recoveryId, approverSubject: recoverySubject,
        changeDigest: (requested.body as { changeDigest: string }).changeDigest });
    expect(approved.status).toBe(200);
    const activated = await h.call('POST', '/v1/access/protected-change-activations',
      claimant.token, { profile: 'access-protected-change-activation-v1',
        proposalId: recoveryId });
    expect(activated.status).toBe(200);
    const state = await h.accessPool.query<{ principal_id: string }>(`SELECT principal_id
      FROM access.representation WHERE subject_id = $1 AND action = 'agent.control'
        AND active`, [subject]);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.principal_id).toBe(claimant.principalId);
  } finally { await h.close(); }
});

test('IAM05/IAM30: a protected group member needs an independent approved activation', async () => {
  const h = await startAuthorityHarness('protected-api');
  try {
    const manager = await h.user('manager');
    const approver = await h.user('approver');
    const [owner, approvalSubject, member] = await Promise.all([
      h.agent(), h.agent(), h.agent()]);
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
    const proposed = await h.call('POST', '/v1/access/protected-change-proposals',
      manager.token, { profile: 'access-protected-change-v1', proposalId,
        issuerSubject: owner, expectedAuthorityEpoch: await h.epoch(),
        change: { kind: 'group-member', groupId, memberId, agentSubject: member } });
    expect(proposed.status).toBe(200);
    const approval = { profile: 'access-protected-change-approval-v1', proposalId,
      approverSubject: approvalSubject,
      changeDigest: (proposed.body as { changeDigest: string }).changeDigest };
    expect((await h.call('POST', '/v1/access/protected-change-approvals',
      manager.token, approval)).status).toBe(403);
    expect((await h.call('POST', '/v1/access/protected-change-approvals',
      approver.token, approval)).status).toBe(200);
    const activated = await h.call('POST', '/v1/access/protected-change-activations',
      manager.token, { profile: 'access-protected-change-activation-v1', proposalId });
    expect(activated.status).toBe(200);
    expect((await h.accessPool.query<{ id: string }>(`SELECT id FROM access.group_member
      WHERE id = $1 AND agent_subject = $2`, [memberId, member])).rows).toHaveLength(1);
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
    await h.grant(owner, owner, 'access.grant.assign.work.create');
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
    const activation = await h.call('POST', '/v1/access/protected-change-activations',
      manager.token, { profile: 'access-protected-change-activation-v1', proposalId });
    expect(activation.status).toBe(200);
    const bindings = await h.accessPool.query<{ role_revision: string; active: boolean }>(`
      SELECT role_revision, active FROM access.role_binding WHERE family_id = $1
      ORDER BY role_revision`, [familyId]);
    expect(bindings.rows).toEqual([{ role_revision: '1', active: false },
      { role_revision: '2', active: true }]);
  } finally { await h.close(); }
});
