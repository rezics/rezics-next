import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
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

async function logPrincipalFence(member: Member, outcome: DeactivationOutcome, label: string): Promise<void> {
  const principal = await mainStack().accessPool.query<{ active: boolean; enforcement_epoch: string }>(`
    SELECT active, enforcement_epoch::text FROM access.principal WHERE id = $1`, [member.principalId]);
  const markers = await mainStack().accessPool.query<{ count: string }>(`SELECT count(*)::text AS count
    FROM access.outbox WHERE principal_id = $1 AND kind = 'account.deletion_fenced'`, [member.principalId]);
  console.info(`[OBSERVED ${label}]`, JSON.stringify({ outcome, principal: principal.rows[0],
    deletionFenceRows: markers.rows[0]?.count }));
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

test.failing('known gap: deleting an account with only its Person Agent succeeds', async () => {
  const observed = await observeDeactivation(personOnly.member);
  await logPrincipalFence(personOnly.member, observed, 'Person Agent only');
  expect(observed, JSON.stringify(observed)).toMatchObject({ status: 'succeeded' });
});

test.failing('known gap: an owned Agent with a Realm requires an explicit transfer or retirement reason', async () => {
  const observed = await observeDeactivation(realmOwner.member);
  await logPrincipalFence(realmOwner.member, observed, 'second Agent owns Realm');
  expect(observed, JSON.stringify(observed)).toMatchObject({
    status: 'rejected',
    errorClass: 'AdmissionControllerContinuity',
    message: expect.stringMatching(/(?=.*owned Agent)(?=.*transfer)(?=.*retir(e|ement))/i),
  });
});

test('an accepted control invitation lets the former sole controller delete their account', async () => {
  const observed = await observeDeactivation(sharedController.member);
  console.info('[OBSERVED control invitation accepted]', JSON.stringify(observed));
  expect(observed, JSON.stringify(observed)).toMatchObject({
    status: 'succeeded',
    fence: { principalId: sharedController.member.principalId, enforcementEpoch: '1' },
  });
  const controls = await mainStack().accessPool.query<{ principal_id: string }>(`SELECT principal_id
    FROM access.representation r JOIN access.principal p ON p.id = r.principal_id AND p.active
    WHERE r.subject_id = $1 AND r.action = 'agent.control'
      AND r.active AND r.valid_until > clock_timestamp() ORDER BY r.principal_id`, [sharedController.personAgent]);
  expect(controls.rows.map(row => row.principal_id)).toEqual([sharedController.invitedMember.principalId]);
});
