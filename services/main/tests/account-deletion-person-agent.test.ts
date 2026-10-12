import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { AccountHasOwnedAgents } from '../src/modules/access/account-deletion-agents.ts';
import { commandError } from '../src/routes/problems.ts';
import { startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';

type Member = Awaited<ReturnType<MediaStack['member']>>;
type DeactivationOutcome =
  | { status: 'succeeded'; fence: { principalId: string; enforcementEpoch: string } | null }
  | { status: 'rejected'; errorClass: string; message: string };

let stack: MediaStack | undefined;
let personOnly: { member: Member; personAgent: string };
let realmOwner: { member: Member; personAgent: string; ownedAgent: string; realm: string };
let sharedController: {
  member: Member;
  personAgent: string;
  invitedMember: Member;
  invitedPersonAgent: string;
};

function mainStack(): MediaStack {
  if (!stack) throw new Error('Access deletion fixture is not ready');
  return stack;
}

async function provisionAgent(member: Member, kind: 'person' | 'organization', displayName: string): Promise<string> {
  const response = await member.send('POST', '/v1/agents', {
    profile: 'agent-provision-v1', kind, displayName,
  });
  const text = await response.text();
  expect(response.status, text).toBe(201);
  const result = JSON.parse(text) as { agent: string; state: string };
  expect(result.state).toBe('active');
  return result.agent;
}

async function controlledSubjects(principalId: string): Promise<string[]> {
  const result = await mainStack().accessPool.query<{ subject_id: string }>(`SELECT DISTINCT subject_id
    FROM access.representation WHERE principal_id = $1 AND action = 'agent.control'
      AND active AND valid_until > clock_timestamp() ORDER BY subject_id`, [principalId]);
  return result.rows.map(row => row.subject_id);
}

async function observeDeactivation(member: Member): Promise<DeactivationOutcome> {
  try {
    const fence = await mainStack().access.strongDeactivateAccountSubject(
      member.principal.issuer, member.principal.subject);
    return { status: 'succeeded', fence: fence
      ? { principalId: fence.principalId, enforcementEpoch: fence.enforcementEpoch } : null };
  } catch (error) {
    return { status: 'rejected',
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
      message: error instanceof Error ? error.message : String(error) };
  }
}

async function assertPrincipalFence(member: Member): Promise<void> {
  const principal = await mainStack().accessPool.query<{ active: boolean; enforcement_epoch: string }>(`
    SELECT active, enforcement_epoch::text FROM access.principal WHERE id = $1`, [member.principalId]);
  const markers = await mainStack().accessPool.query<{ count: string }>(`SELECT count(*)::text AS count
    FROM access.outbox WHERE principal_id = $1 AND kind = 'account.deletion_fenced'`, [member.principalId]);
  expect(principal.rows[0]).toEqual({ active: false, enforcement_epoch: '1' });
  expect(markers.rows[0]?.count).toBe('1');
}

beforeAll(async () => {
  stack = await startMediaStack('account-deletion-person-agent');

  const personMember = await stack.member(`person-only-${randomUUID()}`, { verified: true });
  const personAgent = await provisionAgent(personMember, 'person', 'Person Agent');
  personOnly = { member: personMember, personAgent };
  expect(await controlledSubjects(personMember.principalId)).toEqual([personAgent]);

  const owner = await stack.member(`realm-owner-${randomUUID()}`, { verified: true });
  const ownerPersonAgent = await provisionAgent(owner, 'person', 'Realm Owner Person');
  const ownedAgent = await provisionAgent(owner, 'organization', 'Realm Steward');
  await grantFixtureAuthority(stack.accessPool, {
    scope: 'space:create:root',
    requireDispatch: true,
    representations: [{ principalId: owner.principalId, actor: ownedAgent,
      action: 'space.create', lifetime: 'infinity' }],
    grant: { actor: ownedAgent, action: 'space.create', lifetime: 'infinity' },
  });
  const createdRealmResponse = await owner.send('POST', '/v1/spaces', {
    profile: 'space-realm-v2', name: `Deletion Realm ${randomUUID()}`,
    capabilities: ['realm'], actingSubject: ownedAgent, topics: [],
  });
  const createdRealmText = await createdRealmResponse.text();
  expect(createdRealmResponse.status, createdRealmText).toBe(201);
  const createdRealm = JSON.parse(createdRealmText) as { realm: string };
  const bootstrap = await stack.accessPool.query<{ owner_subject: string; principal_id: string }>(`
    SELECT owner_subject, principal_id FROM access.realm_admin_owner_bootstrap WHERE realm = $1`,
  [createdRealm.realm]);
  expect(bootstrap.rows).toEqual([{ owner_subject: ownedAgent, principal_id: owner.principalId }]);
  realmOwner = { member: owner, personAgent: ownerPersonAgent, ownedAgent, realm: createdRealm.realm };
  expect((await controlledSubjects(owner.principalId)).sort()).toEqual([ownerPersonAgent, ownedAgent].sort());

  const controller = await stack.member(`controller-owner-${randomUUID()}`, { verified: true });
  const controllerPersonAgent = await provisionAgent(controller, 'person', 'Controller Owner');
  const invitee = await stack.member(`controller-invitee-${randomUUID()}`, { verified: true });
  const inviteePersonAgent = await provisionAgent(invitee, 'person', 'Invited Controller');
  const invitationId = randomUUID();
  const scopeEpoch = async () => (await stack!.accessPool.query<{ authority_epoch: string }>(`
    SELECT authority_epoch::text FROM access.scope_gate WHERE id = 'work:create:root'`))
    .rows[0]!.authority_epoch;
  const offer = await controller.send('POST', '/v1/agents/invitations', {
    profile: 'access-agent-invitation-v1', invitationId,
    issuerSubject: controllerPersonAgent, recipientSubject: inviteePersonAgent,
    offer: 'control', issuerLifetime: 'institutional',
    expectedAuthorityEpoch: await scopeEpoch(),
  });
  const offerText = await offer.text();
  expect(offer.status, offerText).toBe(200);
  const accepted = await invitee.send('POST', '/v1/agents/invitation-acceptances', {
    profile: 'access-agent-invitation-acceptance-v1', invitationId,
    representationId: randomUUID(), expectedAuthorityEpoch: await scopeEpoch(),
  });
  const acceptedText = await accepted.text();
  expect(accepted.status, acceptedText).toBe(200);
  expect(JSON.parse(acceptedText)).toMatchObject({ offer: 'control', status: 'accepted' });
  const controllers = await stack.accessPool.query<{ principal_id: string }>(`SELECT principal_id
    FROM access.representation WHERE subject_id = $1 AND action = 'agent.control'
      AND active AND valid_until > clock_timestamp() ORDER BY principal_id`, [controllerPersonAgent]);
  expect(controllers.rows.map(row => row.principal_id).sort())
    .toEqual([controller.principalId, invitee.principalId].sort());
  sharedController = { member: controller, personAgent: controllerPersonAgent,
    invitedMember: invitee, invitedPersonAgent: inviteePersonAgent };
}, 180_000);

afterAll(async () => { await stack?.stop(); });

test('deleting an account ends its solely controlled provisioned Person Agent atomically', async () => {
  const observed = await observeDeactivation(personOnly.member);
  expect(observed, JSON.stringify(observed)).toMatchObject({ status: 'succeeded' });
  await assertPrincipalFence(personOnly.member);
  const authority = await mainStack().accessPool.query<{ active: boolean; controllers: number }>(`
    SELECT active, access.agent_controller_count(id) AS controllers
    FROM access.authority_subject WHERE id = $1`, [personOnly.personAgent]);
  expect(authority.rows[0]).toEqual({ active: false, controllers: 0 });
  expect((await mainStack().accessPool.query(`SELECT 1 FROM access.account_deletion_orphan_agent
    WHERE agent_id = $1`, [personOnly.personAgent])).rowCount).toBe(0);
  // A lost response cannot duplicate the account fence or reactivate authority.
  expect(await observeDeactivation(personOnly.member)).toEqual(observed);
  await assertPrincipalFence(personOnly.member);
});

test('a Realm owner gets a typed refusal and explicit consent leaves the Realm steward standing', async () => {
  let refusal: AccountHasOwnedAgents | undefined;
  try {
    await mainStack().access.strongDeactivateAccountSubject(
      realmOwner.member.principal.issuer, realmOwner.member.principal.subject);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AccountHasOwnedAgents);
    refusal = error as AccountHasOwnedAgents;
  }
  expect(refusal?.agents).toEqual([{ id: realmOwner.ownedAgent, kind: 'organization', displayName: 'Realm Steward' }]);
  const response = commandError(refusal);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'account_has_owned_agents',
    agents: refusal!.agents, hasMore: false, moreCount: 0 });
  const before = await mainStack().accessPool.query<{ active: boolean }>(`
    SELECT active FROM access.authority_subject WHERE id = $1`, [realmOwner.personAgent]);
  expect(before.rows[0]?.active).toBe(true);
  expect((await mainStack().accessPool.query(`SELECT 1 FROM access.outbox
    WHERE principal_id = $1 AND kind = 'account.deletion_fenced'`, [realmOwner.member.principalId])).rowCount).toBe(0);
  await mainStack().access.strongDeactivateAccountSubject(
    realmOwner.member.principal.issuer, realmOwner.member.principal.subject, { leaveOwnedAgentsStanding: true });
  await assertPrincipalFence(realmOwner.member);
  const authority = await mainStack().accessPool.query<{ active: boolean; controllers: number }>(`
    SELECT active, access.agent_controller_count(id) AS controllers
    FROM access.authority_subject WHERE id = $1`, [realmOwner.ownedAgent]);
  expect(authority.rows[0]).toEqual({ active: true, controllers: 0 });
  const orphan = await mainStack().accessPool.query<{ deleted_principal_id: string; operation_id: string }>(`
    SELECT deleted_principal_id, operation_id FROM access.account_deletion_orphan_agent WHERE agent_id = $1`,
    [realmOwner.ownedAgent]);
  const fence = await mainStack().accessPool.query<{ id: string }>(`SELECT id FROM access.outbox
    WHERE principal_id = $1 AND kind = 'account.deletion_fenced'`, [realmOwner.member.principalId]);
  expect(orphan.rows).toEqual([{ deleted_principal_id: realmOwner.member.principalId, operation_id: fence.rows[0]!.id }]);
  expect((await mainStack().accessPool.query(`SELECT 1 FROM access.realm_admin_owner_bootstrap
    WHERE realm = $1 AND owner_subject = $2`, [realmOwner.realm, realmOwner.ownedAgent])).rowCount).toBe(1);
});

test('an accepted control invitation lets the former sole controller delete their account', async () => {
  const observed = await observeDeactivation(sharedController.member);
  expect(observed, JSON.stringify(observed)).toMatchObject({
    status: 'succeeded',
    fence: { principalId: sharedController.member.principalId, enforcementEpoch: '1' },
  });
  const controls = await mainStack().accessPool.query<{ principal_id: string }>(`SELECT principal_id
    FROM access.representation r JOIN access.principal p ON p.id = r.principal_id AND p.active
    WHERE r.subject_id = $1 AND r.action = 'agent.control'
      AND r.active AND r.valid_until > clock_timestamp() ORDER BY r.principal_id`, [sharedController.personAgent]);
  expect(controls.rows.map(row => row.principal_id)).toEqual([sharedController.invitedMember.principalId]);
  expect((await mainStack().accessPool.query(`SELECT active FROM access.authority_subject
    WHERE id = $1`, [sharedController.personAgent])).rows[0]?.active).toBe(true);
  expect((await mainStack().accessPool.query(`SELECT 1 FROM access.account_deletion_orphan_agent
    WHERE agent_id = $1`, [sharedController.personAgent])).rowCount).toBe(0);
});

test('forty owned Agents have an honest bounded refusal and consent orphans every Agent', async () => {
  const member = await mainStack().member(`many-owner-${randomUUID()}`, { verified: true });
  const person = await provisionAgent(member, 'person', 'Forty Agent Owner');
  const agents: string[] = [];
  for (let i = 0; i < 40; i++) agents.push(await provisionAgent(member, 'organization', `Owned Agent ${i}`));
  let refusal: AccountHasOwnedAgents | undefined;
  try {
    await mainStack().access.strongDeactivateAccountSubject(member.principal.issuer, member.principal.subject);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AccountHasOwnedAgents);
    refusal = error as AccountHasOwnedAgents;
  }
  expect(refusal?.agents.map(agent => agent.id)).toEqual([...agents].sort().slice(0, 16));
  expect(refusal).toMatchObject({ hasMore: true, moreCount: 24 });
  // A request cannot claim the provisioned Organization is a Person.
  const options = { leaveOwnedAgentsStanding: true, kind: 'person' };
  await mainStack().access.strongDeactivateAccountSubject(member.principal.issuer, member.principal.subject, options);
  const standing = await mainStack().accessPool.query<{ agent_id: string; active: boolean; controllers: number }>(`
    SELECT o.agent_id, s.active, access.agent_controller_count(o.agent_id) AS controllers
    FROM access.account_deletion_orphan_agent o JOIN access.authority_subject s ON s.id = o.agent_id
    WHERE o.deleted_principal_id = $1 ORDER BY o.agent_id`, [member.principalId]);
  expect(standing.rows).toEqual([...agents].sort().map(agent_id => ({ agent_id, active: true, controllers: 0 })));
  expect((await mainStack().accessPool.query(`SELECT active FROM access.authority_subject WHERE id = $1`, [person]))
    .rows[0]?.active).toBe(false);
}, 180_000);

test('a non-Person Agent with another live controller is neither listed nor orphaned', async () => {
  const owner = await mainStack().member(`shared-org-owner-${randomUUID()}`, { verified: true });
  const other = await mainStack().member(`shared-org-controller-${randomUUID()}`, { verified: true });
  const agent = await provisionAgent(owner, 'organization', 'Shared organization');
  await grantFixtureAuthority(mainStack().accessPool, { scope: 'work:create:root', requireDispatch: true, representations: [
    { principalId: other.principalId, actor: agent, action: 'agent.control', lifetime: 'infinity' },
  ], grant: { actor: agent, action: 'agent.control', lifetime: 'infinity' } });
  await mainStack().access.strongDeactivateAccountSubject(owner.principal.issuer, owner.principal.subject);
  expect((await mainStack().accessPool.query(`SELECT active, access.agent_controller_count(id) AS controllers
    FROM access.authority_subject WHERE id = $1`, [agent])).rows[0]).toEqual({ active: true, controllers: 1 });
  expect((await mainStack().accessPool.query(`SELECT 1 FROM access.account_deletion_orphan_agent
    WHERE agent_id = $1`, [agent])).rowCount).toBe(0);
});
