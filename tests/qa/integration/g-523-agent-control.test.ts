import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { sealMetadataWorkAdmission } from '../../../services/main/src/modules/work/seal.ts';
import { readWorkTerminalReceipt } from '../../../services/main/src/modules/work/receipt.ts';
import {
  startAgentControlHarness,
  type AuthorityHarness,
  type AuthorityUser,
} from './g-523-harness.ts';

const root = 'work:create:root';
const offerProfile = 'access-agent-invitation-v1';
const acceptProfile = 'access-agent-invitation-acceptance-v1';
async function create(h: AuthorityHarness, user: AuthorityUser, kind: 'person' | 'organization') {
  const result = await h.call('POST', '/v1/agents', user.token, {
    profile: 'agent-provision-v1',
    kind,
    displayName: user.name,
  });
  expect(result.status).toBe(201);
  expect(result.body.state).toBe('active');
  return String(result.body.agent);
}
async function offer(
  h: AuthorityHarness,
  user: AuthorityUser,
  issuer: string,
  recipient: string,
  kind: 'control' | 'represent' | 'manage',
  options: Record<string, unknown> = {},
) {
  const invitationId = randomUUID();
  const scope = String(options.scopeId ?? root);
  const result = await h.call('POST', '/v1/agents/invitations', user.token, {
    profile: offerProfile,
    invitationId,
    issuerSubject: issuer,
    recipientSubject: recipient,
    offer: kind,
    issuerLifetime: 'institutional',
    expectedAuthorityEpoch: await h.epoch(scope),
    ...(kind === 'control'
      ? {}
      : {
          actions: ['work.create'],
          grantValidUntil: new Date(Date.now() + 3600_000).toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
    ...options,
  });
  expect(result.status).toBe(200);
  return invitationId;
}
const accessPath = (subject: string) => `/v1/agents/${subject.slice(-36)}/access`;
const controllerBody = (
  subjectId: string,
  representationId: string,
  expectedAuthorityEpoch: string,
) => ({
  profile: 'access-agent-controller-change-v1',
  action: 'remove',
  subjectId,
  representationId,
  expectedGeneration: '0',
  expectedAuthorityEpoch,
});

test('G-523: create Organization, invite/accept controller, leave, retain floor and private identities', async () => {
  const h = await startAgentControlHarness('g-523-transfer');
  try {
    const a = await h.user('A');
    const b = await h.user('B');
    const aPerson = await create(h, a, 'person');
    const bPerson = await create(h, b, 'person');
    const organization = await create(h, a, 'organization');
    const other = await create(h, a, 'organization');
    expect(
      (
        await h.accessPool.query('SELECT 1 FROM access.agent_control WHERE subject_id = $1', [
          organization,
        ])
      ).rowCount,
    ).toBe(0);
    const before = await h.call('GET', accessPath(organization), a.token);
    expect(before.status).toBe(200);
    const aMandate = String(
      (before.body.you as { representationId: string }[])[0]!.representationId,
    );
    expect(
      (
        await h.call(
          'POST',
          '/v1/agents/controller-changes',
          a.token,
          controllerBody(organization, aMandate, await h.epoch()),
        )
      ).status,
    ).toBe(409);
    const invitationId = await offer(h, a, organization, bPerson, 'control');
    const inbox = await h.call('GET', '/v1/me/agent-invitations', b.token);
    expect(inbox.status).toBe(200);
    expect(inbox.body.items).toContainEqual(
      expect.objectContaining({ invitationId, offer: 'control', status: 'pending' }),
    );
    expect(
      (
        await h.call('POST', '/v1/agents/invitation-acceptances', a.token, {
          profile: acceptProfile,
          invitationId,
          representationId: randomUUID(),
          expectedAuthorityEpoch: await h.epoch(),
        })
      ).status,
    ).toBe(403);
    const bMandate = randomUUID();
    const acceptance = {
      profile: acceptProfile,
      invitationId,
      representationId: bMandate,
      expectedAuthorityEpoch: await h.epoch(),
    };
    const key = randomUUID();
    const accepted = await h.call(
      'POST',
      '/v1/agents/invitation-acceptances',
      b.token,
      acceptance,
      key,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      offer: 'control',
      status: 'accepted',
      controllerRepresentationId: bMandate,
      grantId: null,
      edgeId: null,
    });
    expect(
      (await h.call('POST', '/v1/agents/invitation-acceptances', b.token, acceptance, key)).body
        .replayed,
    ).toBe(true);
    expect(
      (
        await h.call(
          'POST',
          '/v1/agents/invitation-acceptances',
          b.token,
          { ...acceptance, representationId: randomUUID() },
          key,
        )
      ).status,
    ).toBe(409);
    const privateRoster = await h.call('GET', accessPath(organization), a.token);
    const json = JSON.stringify(privateRoster.body);
    expect(json).not.toContain(a.principalId);
    expect(json).not.toContain(b.principalId);
    expect(json).not.toContain(b.accountId);
    expect(json).not.toContain(bMandate);
    expect(privateRoster.body.otherControllers).toBe(1);
    expect((await h.call('GET', accessPath(other), b.token)).status).toBe(403);
    // Control of one Agent cannot issue a grant on the global catalogue.
    expect(
      (
        await h.call('POST', '/v1/access/grant-changes', b.token, {
          profile: 'work-create-agent-grant-change-v1',
          action: 'create',
          issuerSubject: organization,
          recipientSubject: bPerson,
          grantId: randomUUID(),
          validUntil: new Date(Date.now() + 60_000).toISOString(),
          expectedAuthorityEpoch: await h.epoch(),
        })
      ).status,
    ).toBe(403);
    const leave = controllerBody(organization, aMandate, await h.epoch());
    const leaveKey = randomUUID();
    expect(
      (await h.call('POST', '/v1/agents/controller-changes', a.token, leave, leaveKey)).status,
    ).toBe(200);
    expect(
      (await h.call('POST', '/v1/agents/controller-changes', a.token, leave, leaveKey)).body
        .replayed,
    ).toBe(true);
    expect((await h.call('GET', accessPath(organization), a.token)).status).toBe(403);
    expect((await h.call('GET', accessPath(organization), b.token)).body.you).toEqual([
      { representationId: bMandate, generation: '0' },
    ]);
    expect(
      (
        await h.call(
          'POST',
          '/v1/agents/controller-changes',
          b.token,
          controllerBody(organization, bMandate, await h.epoch()),
        )
      ).status,
    ).toBe(409);
    const successor = await offer(h, b, organization, aPerson, 'control');
    expect(
      (
        await h.call('POST', '/v1/agents/invitation-revocations', b.token, {
          profile: 'access-agent-invitation-revocation-v1',
          invitationId: successor,
          expectedAuthorityEpoch: await h.epoch(),
        })
      ).status,
    ).toBe(200);
    expect(
      (await h.call('GET', `/v1/agents/${aPerson.slice(-36)}/library-visibility`, a.token))
        .status,
    ).toBe(200);
    expect(
      (await h.call('GET', `/v1/agents/${aPerson.slice(-36)}/library-visibility`, b.token))
        .status,
    ).toBe(403);
    expect(
      (await h.call('GET', `/v1/me/shelves?actingSubject=${encodeURIComponent(aPerson)}`, b.token))
        .status,
    ).toBe(403);
    // Raw owner writes have the same floor as the product API.
    await expect(
      h.accessPool.query('UPDATE access.representation SET active = false WHERE id = $1', [
        bMandate,
      ]),
    ).rejects.toThrow('agent control continuity');
    await expect(
      h.accessPool.query(`UPDATE access.representation SET action = 'work.create' WHERE id = $1`, [
        bMandate,
      ]),
    ).rejects.toThrow('agent controller episode is immutable');
  } finally {
    await h.close();
  }
}, 120_000);

test('G-523: principal × Agent × action matrix keeps representation, resource management and control distinct', async () => {
  const h = await startAgentControlHarness('g-523-matrix');
  try {
    const [a, b, c] = await Promise.all([
      h.user('controller'),
      h.user('representative'),
      h.user('manager'),
    ]);
    const bPerson = await create(h, b, 'person');
    const cPerson = await create(h, c, 'person');
    const organization = await create(h, a, 'organization');
    const other = await create(h, a, 'organization');
    const workCeiling = await h.grant(organization, organization, 'work.create');
    // Other owners' installed action and resource fixtures are independent of
    // the invitation. No issuing/accepting/assignment mandate is seeded.
    const represented = await offer(h, a, organization, bPerson, 'represent');
    const edgeId = randomUUID();
    expect(
      (
        await h.call('POST', '/v1/agents/invitation-acceptances', b.token, {
          profile: acceptProfile,
          invitationId: represented,
          edgeId,
          expectedAuthorityEpoch: await h.epoch(),
        })
      ).status,
    ).toBe(200);
    const publish = { profile: 'metadata-only-v1', actingSubject: organization,
      title: 'Delegated Organization Work', language: 'en',
      semanticTypes: ['https://schema.org/Book'], authoring: 'own-work' };
    const publishKey = randomUUID();
    const published = await h.call('POST', '/v1/works', b.token, publish, publishKey);
    expect(published).toMatchObject({ status: 201, body: { replayed: false } });
    expect((await h.call('POST', '/v1/works', b.token, publish, publishKey)).body)
      .toMatchObject({ work: published.body.work, replayed: true });
    const controllerPublished = await h.call('POST', '/v1/works', a.token,
      { ...publish, title: 'Controller Organization Work' });
    expect(controllerPublished.status).toBe(201);
    const proof = (await h.accessPool.query<{ id: string; edge_id: string; grant_id: string }>(`
      SELECT a.id,s.edge_id,o.grant_id FROM access.admission a
      JOIN access.admission_obligation o ON o.admission_id = a.id
      JOIN access.representation_path_step s ON s.path_id = o.path_id
      WHERE a.principal_id = $1 AND a.idempotency_key = $2`, [b.principalId,publishKey])).rows[0]!;
    expect(proof).toMatchObject({ edge_id: edgeId, grant_id: workCeiling });
    const admissionId = proof.id;
    expect((await readWorkTerminalReceipt(h.environment.fuseki, admissionId))?.outcome).toBe('succeeded');
    const credits = await h.environment.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?agent WHERE { GRAPH <urn:rezics:graph:current> {
        ?credit a rv:NativeAgentCredit ; rv:work <${String(published.body.work)}> ; rv:agent ?agent . } } LIMIT 2`);
    expect(credits.results?.bindings.map(row => row.agent?.value)).toEqual([organization]);
    // A Person controller plus an invitation is one publishing hop, never an
    // unrestricted action-preserving path through other Agents.
    await expect(h.accessPool.query(`INSERT INTO access.representation_path_proof
      (id,principal_id,principal_epoch,representation_id,representation_generation,mandate_action,
        origin_subject,acting_subject,action,edge_count,topology_epoch,valid_until)
      SELECT gen_random_uuid(),p.principal_id,p.principal_epoch,p.representation_id,
        p.representation_generation,p.mandate_action,p.origin_subject,p.acting_subject,
        p.action,2,p.topology_epoch,p.valid_until FROM access.representation_path_proof p
      JOIN access.admission_obligation o ON o.path_id = p.id WHERE o.admission_id = $1`, [admissionId]))
      .rejects.toThrow('controller path lacks its publishing offer');
    for (const type of ['https://rezics.com/vocab/ModPackage','https://schema.org/SoftwareApplication',
      'https://schema.org/SoftwareSourceCode']) {
      expect((await h.call('POST', '/v1/works', b.token, { ...publish, semanticTypes: [type] })).status).toBe(403);
    }
    const delegate = await h.accountVerifier.verify(new Request('http://main.local',
      { headers: { authorization: `Bearer ${b.token}` } }), ['work:create']);
    expect(await h.registry.hasNonBaselineWorkCreateAuthority(delegate, organization)).toBe(false);
    // Publishing is action-specific and cannot become an exact Work edit grant.
    expect((await h.call('POST', `/v1/works/${String(published.body.work).slice(-36)}/scalar-value`, b.token,
      { profile: 'work-scalar-state-v1', actingSubject: organization,
        expectedHead: published.body.workRevision, scalarValue: { kind: 'unknown' } })).status).toBe(403);
    await h.accessPool.query(
      `INSERT INTO access.scope_gate (id) VALUES ('space:create:root') ON CONFLICT DO NOTHING`,
    );
    await h.mandate(a.principalId, organization, 'space.create');
    await h.accessPool.query(
      `INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,'space:create:root','space.create',now() + interval '2 hours')`,
      [randomUUID(), organization],
    );
    const space = await h.call('POST', '/v1/spaces', a.token, {
      profile: 'space-realm-v1',
      name: 'G-523 Realm',
      capabilities: ['realm'],
      actingSubject: organization,
    });
    expect(space.status).toBe(201);
    const realm = String(space.body.realm);
    const realmPath = `/v1/realms/${realm.slice(-36)}`;
    expect(
      (await h.call('POST', `${realmPath}/management`, a.token, { actingSubject: organization }))
        .status,
    ).toBe(200);
    const scopeId = `governance:realm:${realm}`;
    const managed = await offer(h, a, organization, cPerson, 'manage', {
      scopeId,
      actions: ['realm.settings.manage', 'governance.rule.publish'],
    });
    expect(
      (
        await h.call('POST', '/v1/agents/invitation-acceptances', c.token, {
          profile: acceptProfile,
          invitationId: managed,
          grantId: randomUUID(),
          expectedAuthorityEpoch: await h.epoch(scopeId),
        })
      ).status,
    ).toBe(200);
    const settings = await h.call(
      'GET',
      `${realmPath}/settings?actingSubject=${encodeURIComponent(cPerson)}`,
      c.token,
    );
    expect(settings.status).toBe(200);
    const change = await h.call('PUT', `${realmPath}/settings`, c.token, {
      actingSubject: cPerson,
      expectedGeneration: settings.body.generation,
      expectedRulesRevision: null,
      reason: 'Manage as myself',
      settings: { visibility: 'public', reviewRequired: true, whoMaySubmit: 'members', rules: [] },
    });
    expect(change.status).toBe(201);
    expect((await h.call('POST', '/v1/works', c.token, publish)).status).toBe(403);
    const audit = (
      await h.accessPool.query<{ acting_subject: string }>(
        `SELECT acting_subject FROM access.realm_admin_receipt
      WHERE id = $1`,
        [change.body.receiptId],
      )
    ).rows[0];
    expect(audit?.acting_subject).toBe(cPerson);
    for (const user of [b, c]) {
      expect((await h.call('GET', accessPath(organization), user.token)).status).toBe(403);
      expect(
        (
          await h.call('POST', '/v1/agents/invitations', user.token, {
            profile: offerProfile,
            offer: 'control',
            invitationId: randomUUID(),
            issuerSubject: organization,
            recipientSubject: bPerson,
            issuerLifetime: 'institutional',
            expectedAuthorityEpoch: await h.epoch(),
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await h.call(
          'GET',
          `${realmPath}/settings?actingSubject=${encodeURIComponent(bPerson)}`,
          b.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.call(
          'GET',
          `${realmPath}/settings?actingSubject=${encodeURIComponent(organization)}`,
          c.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.call('POST', '/v1/agents/invitations', a.token, {
          profile: offerProfile,
          offer: 'manage',
          invitationId: randomUUID(),
          issuerSubject: other,
          recipientSubject: cPerson,
          scopeId,
          issuerLifetime: 'institutional',
          expectedAuthorityEpoch: await h.epoch(scopeId),
          actions: ['realm.settings.manage'],
          grantValidUntil: new Date(Date.now() + 3600_000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.accessPool.query(
          `SELECT 1 FROM access.representation_edge
      WHERE representative_subject = $1 AND represented_subject = $2 AND active`,
          [cPerson, organization],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await h.accessPool.query(
          `SELECT 1 FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND active`,
          [bPerson, scopeId],
        )
      ).rowCount,
    ).toBe(0);
    const revokeBody = {
      profile: 'access-agent-invitation-revocation-v1',
      invitationId: represented,
      expectedAuthorityEpoch: await h.epoch(),
    };
    const revoked = await h.call('POST', '/v1/agents/invitation-revocations', a.token, revokeBody);
    expect(revoked.status).toBe(200);
    const revocationId = String((revoked.body.revocationIds as string[])[0]);
    const drainPath = `/v1/access/revocations/${revocationId}?issuerSubject=${encodeURIComponent(organization)}`;
    expect((await h.call('GET', drainPath, a.token)).body).toMatchObject({
      state: 'completed',
      affectedWork: 0,
      pending: 0,
      target: { kind: 'representation_edge', id: edgeId },
    });
    expect(
      (await h.call('POST', `/v1/me/authority-admissions/${admissionId}/checks`, b.token)).status,
    ).toBe(403);
    expect((await h.call('POST', '/v1/works', b.token, publish)).status).toBe(403);
    expect((await h.call('GET', drainPath, a.token)).body).toMatchObject({
      state: 'completed',
      pending: 0,
    });
    expect(
      (await h.call('POST', `/v1/me/authority-admissions/${admissionId}/checks`, b.token)).status,
    ).toBe(403);
    expect(
      (
        await h.call('POST', '/v1/agents/invitation-revocations', a.token, {
          profile: revokeBody.profile,
          invitationId: managed,
          expectedAuthorityEpoch: await h.epoch(scopeId),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.call(
          'GET',
          `${realmPath}/settings?actingSubject=${encodeURIComponent(cPerson)}`,
          c.token,
        )
      ).status,
    ).toBe(403);
  } finally {
    await h.close();
  }
}, 120_000);

test('G-523: edge revocation cancels real registered and running Work commands and drains terminal receipts', async () => {
  const h = await startAgentControlHarness('g-523-running');
  const releases: (() => void)[] = [];
  const running: Promise<unknown>[] = [];
  try {
    const a = await h.user('controller');
    const b = await h.user('delegate');
    const person = await create(h,b,'person');
    const organization = await create(h,a,'organization');
    const other = await create(h,a,'organization');
    expect((await h.call('POST','/v1/works',a.token,{ profile: 'metadata-only-v1',
      actingSubject: organization,title: 'No Work ceiling',language: 'en' })).status).toBe(403);
    await h.grant(organization,organization,'work.create');
    const invitationId = await offer(h,a,organization,person,'represent');
    const edgeId = randomUUID();
    expect((await h.call('POST','/v1/agents/invitation-acceptances',b.token,
      { profile: acceptProfile,invitationId,edgeId,expectedAuthorityEpoch: await h.epoch() })).status).toBe(200);
    const body = { profile: 'metadata-only-v1',actingSubject: organization,
      title: 'Revoked before publishing',language: 'en',semanticTypes: ['https://schema.org/Book'] };
    expect((await h.call('POST','/v1/works',b.token,{ ...body,actingSubject: other })).status).toBe(403);
    const idle = h.pauseWorkClaim('registered');
    releases.push(idle.resume);
    const idleRequest = h.call('POST','/v1/works',b.token,body);
    running.push(idleRequest);
    const idleAdmission = await idle.entered;
    const active = h.pauseWorkClaim('claimed');
    releases.push(active.resume);
    const activeRequest = h.call('POST','/v1/works',b.token,{ ...body,title: 'Running publishing command' });
    running.push(activeRequest);
    const activeAdmission = await active.entered;
    expect((await h.accessPool.query('SELECT state FROM access.admission WHERE id = $1',
      [activeAdmission.id])).rows[0]?.state).toBe('claimed');
    const revoke = await h.call('POST','/v1/agents/invitation-revocations',a.token,
      { profile: 'access-agent-invitation-revocation-v1',invitationId,
        expectedAuthorityEpoch: await h.epoch() });
    expect(revoke.status).toBe(200);
    const revocationId = (revoke.body.revocationIds as string[])[0]!;
    const drain = `/v1/access/revocations/${revocationId}?issuerSubject=${encodeURIComponent(organization)}`;
    expect((await h.call('GET',drain,a.token)).body).toMatchObject({
      state: 'draining',affectedWork: 2,pending: 2,target: { kind: 'representation_edge',id: edgeId } });
    await expect(h.registry.claim(idleAdmission.id,idleAdmission.requestDigest)).rejects.toThrow('epoch is stale');
    await expect(h.accessPool.query(`UPDATE access.revocation SET state = 'completed',
      completed_at = clock_timestamp() WHERE id = $1`,[revocationId]))
      .rejects.toThrow('revocation still has admitted work pending');
    expect((await h.call('POST','/v1/works',b.token,body)).status).toBe(403);
    idle.resume();
    expect((await idleRequest).status).toBe(409);
    expect((await readWorkTerminalReceipt(h.environment.fuseki,idleAdmission.id))?.outcome).toBe('cancelled');
    expect((await h.call('GET',drain,a.token)).body).toMatchObject({ state: 'draining',pending: 1 });
    // The existing sealer races execution at the same real Jena receipt. A
    // running command remains in the drain until that terminal fact is durable.
    const terminal = await sealMetadataWorkAdmission(h.environment,activeAdmission);
    expect(terminal.outcome).toBe('cancelled');
    await h.registry.recordGraphOutcome(activeAdmission.id,terminal);
    active.resume();
    expect((await activeRequest).status).toBe(409);
    expect((await readWorkTerminalReceipt(h.environment.fuseki,activeAdmission.id))?.outcome).toBe('cancelled');
    expect((await h.call('GET',drain,a.token)).body).toMatchObject({ state: 'completed',pending: 0 });
    expect((await h.accessPool.query(`SELECT state FROM access.admission WHERE id = ANY($1::uuid[])`,
      [[idleAdmission.id,activeAdmission.id]])).rows.every(row => row.state === 'sealed')).toBe(true);
  } finally {
    for (const release of releases) release();
    await Promise.allSettled(running);
    await h.close();
  }
},120_000);

test('G-523: access and inbox pages preserve all offers and use recipient indexes as unrelated history grows', async () => {
  const h = await startAgentControlHarness('g-523-pages');
  try {
    const a = await h.user('issuer');
    const b = await h.user('recipient');
    const recipient = await create(h, b, 'person');
    const organization = await create(h, a, 'organization');
    const ids: string[] = [];
    for (let n = 0; n < 55; n++) ids.push(await offer(h, a, organization, recipient, 'control'));
    const walk = async (path: string, token: string) => {
      const seen: string[] = [];
      let after: string | null = null;
      do {
        const result = await h.call('GET', `${path}${after ? `?after=${after}` : ''}`, token);
        expect(result.status).toBe(200);
        const items = result.body.items as { invitationId: string; authorityEpoch: string }[];
        expect(items.length).toBeLessThanOrEqual(50);
        for (const item of items) {
          expect(item.authorityEpoch).toBe(await h.epoch());
          seen.push(item.invitationId);
        }
        after = result.body.nextCursor as string | null;
      } while (after);
      expect(seen).toEqual([...ids].sort());
    };
    await walk(accessPath(organization), a.token);
    await walk('/v1/me/agent-invitations', b.token);
    expect((await h.call('GET', '/v1/me/agent-invitations', a.token)).body.items).toEqual([]);
    const unrelated = `https://rezics.com/id/${randomUUID()}`;
    const probe = async (count: number) => {
      // Unrelated historical facts use the same exact offer/mandate basis.
      await h.accessPool.query(
        `INSERT INTO access.agent_invitation (id,issuer_subject,recipient_subject,scope_id,
        action,offer,actions,grant_valid_until,issuer_lifetime,issued_by_principal,issuer_representation_id,
        issuer_representation_generation,issuer_representation_action,ceiling_grant_id,ceiling_grant_generation,
        ceiling_scope_id,ceiling_action,expires_at)
        SELECT gen_random_uuid(),i.issuer_subject,$2,i.scope_id,i.action,i.offer,i.actions,i.grant_valid_until,
          i.issuer_lifetime,i.issued_by_principal,i.issuer_representation_id,i.issuer_representation_generation,
          i.issuer_representation_action,i.ceiling_grant_id,i.ceiling_grant_generation,i.ceiling_scope_id,i.ceiling_action,i.expires_at
        FROM access.agent_invitation i CROSS JOIN generate_series(1,$3::integer) n WHERE i.id = $1`,
        [ids[0], unrelated, count],
      );
      await h.accessPool.query('VACUUM (ANALYZE) access.agent_invitation');
      const plan = (
        await h.accessPool.query<{
          'QUERY PLAN': {
            Plan: {
              'Actual Rows': number;
              'Shared Hit Blocks': number;
              'Shared Read Blocks': number;
            };
          }[];
        }>(
          `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
        SELECT id FROM access.agent_invitation WHERE recipient_subject = $1 ORDER BY id LIMIT 51`,
          [recipient],
        )
      ).rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(JSON.stringify(plan)).toContain('agent_invitation_recipient');
      expect(plan['Actual Rows']).toBe(51);
      return plan['Shared Hit Blocks'] + plan['Shared Read Blocks'];
    };
    const small = await probe(1024);
    const large = await probe(15_000);
    expect(small).toBeLessThanOrEqual(80);
    expect(large).toBeLessThanOrEqual(small + 12);
    await walk('/v1/me/agent-invitations', b.token);
    // Owned-Agent reads also preserve the exact page over a recovered owner.
    const recovered = await h.snapshotAccess();
    try {
      const { AccessInvitations } =
        await import('../../../services/main/src/modules/access/invitation.ts');
      const inbox = await new AccessInvitations(recovered).addressed({
        issuer: h.accountIssuer,
        subject: b.accountId,
      });
      expect(inbox.items.map((i) => i.invitationId)).toEqual([...ids].sort().slice(0, 50));
      expect(inbox.nextCursor).toBe([...ids].sort()[49]!);
    } finally {
      await recovered.end();
    }
  } finally {
    await h.close();
  }
}, 120_000);

test('G-523: stale, expired, concurrent and recovery-held acceptance has no partial authority', async () => {
  const h = await startAgentControlHarness('g-523-adverse');
  try {
    const a = await h.user('A');
    const b = await h.user('B');
    const bPerson = await create(h, b, 'person');
    const organization = await create(h, a, 'organization');
    const id = await offer(h, a, organization, bPerson, 'control');
    const body = {
      profile: acceptProfile,
      invitationId: id,
      representationId: randomUUID(),
      expectedAuthorityEpoch: await h.epoch(),
    };
    expect(
      (
        await h.call('POST', '/v1/agents/invitation-acceptances', b.token, {
          ...body,
          expectedAuthorityEpoch: '999999',
        })
      ).status,
    ).toBe(409);
    await h.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
    expect((await h.call('POST', '/v1/agents/invitation-acceptances', b.token, body)).status).toBe(
      503,
    );
    await h.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');
    const results = await Promise.all(
      [1, 2].map(() => h.call('POST', '/v1/agents/invitation-acceptances', b.token, body)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (
        await h.accessPool.query(
          'SELECT 1 FROM access.agent_invitation_acceptance WHERE invitation_id = $1',
          [id],
        )
      ).rowCount,
    ).toBe(1);
    const expired = await offer(h, a, organization, bPerson, 'control', {
      expiresAt: new Date(Date.now() + 500).toISOString(),
    });
    await Bun.sleep(550);
    expect(
      (
        await h.call('POST', '/v1/agents/invitation-acceptances', b.token, {
          ...body,
          invitationId: expired,
          representationId: randomUUID(),
          expectedAuthorityEpoch: await h.epoch(),
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await h.accessPool.query(
          'SELECT 1 FROM access.agent_invitation_acceptance WHERE invitation_id = $1',
          [expired],
        )
      ).rowCount,
    ).toBe(0);
    // Both controllers concurrently leaving serialize; exactly one stays.
    const aView = await h.call('GET', accessPath(organization), a.token);
    const aMandate = String(
      (aView.body.you as { representationId: string }[])[0]!.representationId,
    );
    const epoch = await h.epoch();
    const leaves = await Promise.all([
      h.call(
        'POST',
        '/v1/agents/controller-changes',
        a.token,
        controllerBody(organization, aMandate, epoch),
      ),
      h.call(
        'POST',
        '/v1/agents/controller-changes',
        b.token,
        controllerBody(organization, body.representationId, epoch),
      ),
    ]);
    expect(leaves.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (
        await h.accessPool.query<{ count: number }>(
          'SELECT access.agent_controller_count($1) AS count',
          [organization],
        )
      ).rows[0]?.count,
    ).toBe(1);
    // Removal fences every scope in which the Agent holds work authority.
    const registry = new AccessAdmissionRegistry(h.accessPool);
    const p = { issuer: h.accountIssuer, subject: a.accountId };
    const queued = await h.agent();
    await h.mandate(a.principalId, queued, 'agent.control', { until: 'infinity' });
    await h.grant(queued, queued, 'work.create');
    const mandate = (
      await h.accessPool.query<{ id: string }>(
        `SELECT id FROM access.representation
      WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'`,
        [a.principalId, queued],
      )
    ).rows[0]!.id;
    const peer = await offer(h, a, queued, bPerson, 'control');
    expect(
      (
        await h.call('POST', '/v1/agents/invitation-acceptances', b.token, {
          profile: acceptProfile,
          invitationId: peer,
          representationId: randomUUID(),
          expectedAuthorityEpoch: await h.epoch(),
        })
      ).status,
    ).toBe(200);
    const admission = await registry.register({
      principal: p,
      actingSubject: queued,
      scope: root,
      action: 'work.create',
      authorityPath: 'represented-agent',
      idempotencyKey: randomUUID(),
      requestDigest: 'a'.repeat(64),
    });
    expect(
      (
        await h.call(
          'POST',
          '/v1/agents/controller-changes',
          a.token,
          controllerBody(queued, mandate, await h.epoch()),
        )
      ).status,
    ).toBe(200);
    await expect(registry.claim(admission.id, 'a'.repeat(64))).rejects.toThrow(
      'admission scope epoch is stale',
    );
  } finally {
    await h.close();
  }
}, 120_000);
