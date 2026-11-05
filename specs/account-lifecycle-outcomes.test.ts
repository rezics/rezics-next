import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AccountLifecycleDriver,
  Credential,
  Login,
  Registration,
  Session,
  Token,
} from './account-lifecycle-driver';

setDefaultTimeout(30_000);
let driver: AccountLifecycleDriver | undefined;
const d = () => {
  if (!driver) throw new Error('Account lifecycle driver was not initialized');
  return driver;
};
beforeEach(async () => {
  const location = process.env.ACCOUNT_LIFECYCLE_OUTCOME_DRIVER;
  if (!location) throw new Error('Account lifecycle outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:')) {
    throw new Error('ACCOUNT_LIFECYCLE_OUTCOME_DRIVER must be an absolute path or file URL');
  }
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Account lifecycle driver must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createAccountLifecycleDriver !== 'function') {
    throw new Error('Account lifecycle driver must export createAccountLifecycleDriver');
  }
  driver = await binding.createAccountLifecycleDriver();
}, 30_000);
afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
}, 30_000);

function registration(value: Registration | 'denied'): Registration {
  expect(value).not.toBe('denied');
  if (value === 'denied') throw new Error('Registration positive control failed');
  return value;
}
async function authenticated(result: Promise<Login>): Promise<Session> {
  const login = await result;
  expect(login.outcome).toBe('authenticated');
  if (login.outcome !== 'authenticated') throw new Error('Authentication positive control failed');
  expect(await d().validateSession(login.session)).toBe('permitted');
  return login.session;
}
async function person(handle: string) {
  const pending = registration(await d().beginRegistration({ handle, key: handle }));
  const credential = await d().newCredential('password');
  expect(await d().installRegistrationCredential(pending, credential)).toBe('permitted');
  expect(await d().activate(pending)).toBe('permitted');
  const session = await authenticated(d().signIn(pending.accountId, credential));
  return { id: pending.accountId, session, credential };
}
async function automated(owner: Awaited<ReturnType<typeof person>>, handle = 'automated', operatorId = owner.id) {
  const id = await d().createAutomated(owner.session, operatorId, handle);
  expect(id).not.toBe('denied');
  expect(await d().account(id)).toMatchObject({ id, kind: 'actor', operatorId, state: 'active' });
  return id;
}
async function token(session: Session): Promise<Token> {
  const result = await d().issueToken(session);
  expect(result).not.toBe('denied');
  if (result === 'denied') throw new Error('Token positive control failed');
  expect(await d().validateToken(result)).toBe('permitted');
  return result;
}
async function credentialFor(owner: Session, id: string, kind: 'password' | 'key' = 'password'): Promise<Credential> {
  const credential = await d().newCredential(kind);
  expect(await d().setCredential(owner, id, credential, true)).toBe('permitted');
  return credential;
}

test('person registration claims pending handle and authenticates the same immutable account through Better Auth', async () => {
  const pending = registration(await d().beginRegistration({ handle: 'person', key: 'registration' }));
  expect(await d().account(pending.accountId)).toMatchObject({ kind: 'actor', state: 'pending', handle: 'person' });
  expect(await d().resolveHandle('person')).toEqual({ accountId: pending.accountId, redirect: false });
  const credential = await d().newCredential('password');
  expect(await d().installRegistrationCredential(pending, credential)).toBe('permitted');
  expect(await d().authInventory()).toEqual({
    identityAccountIds: [pending.accountId],
    credentialAccountIds: [pending.accountId],
  });
  expect(await d().signIn(pending.accountId, credential)).toEqual({ outcome: 'denied' });
  expect(await d().activate(pending)).toBe('permitted');
  const session = await authenticated(d().signIn(pending.accountId, credential));
  expect(await d().session(session)).toMatchObject({ subjectId: pending.accountId });
  await token(session);
  expect(await d().account(pending.accountId)).toMatchObject({ id: pending.accountId, state: 'active' });
  expect(await d().authInventory()).toEqual({
    identityAccountIds: [pending.accountId],
    credentialAccountIds: [pending.accountId],
  });
});

test('interrupted registration cannot issue a token and retry installs exactly one identity and credential', async () => {
  const input = { handle: 'interrupted', key: 'retry' };
  const pending = registration(await d().beginRegistration(input));
  expect(await d().signIn(pending.accountId)).toEqual({ outcome: 'denied' });
  const credential = await d().newCredential('password');
  expect(await d().installRegistrationCredential(pending, credential)).toBe('permitted');
  expect(await d().signIn(pending.accountId, credential)).toEqual({ outcome: 'denied' });
  expect(await d().beginRegistration(input)).toEqual(pending);
  expect(await d().installRegistrationCredential(pending, credential)).toBe('permitted');
  expect(await d().activate(pending)).toBe('permitted');
  expect(await d().activate(pending)).toBe('permitted');
  await token(await authenticated(d().signIn(pending.accountId, credential)));
  expect(await d().authInventory()).toEqual({
    identityAccountIds: [pending.accountId],
    credentialAccountIds: [pending.accountId],
  });
});

test('expired pending registration releases its handle and orphan credentials cannot sign in', async () => {
  const pending = registration(await d().beginRegistration({ handle: 'reclaim', key: 'old' }));
  const credential = await d().newCredential('password');
  expect(await d().installRegistrationCredential(pending, credential)).toBe('permitted');
  expect(await d().beginRegistration({ handle: 'reclaim', key: 'blocked' })).toBe('denied');
  await d().advanceTo(pending.expiresAt);
  expect(await d().resolveHandle('reclaim')).toBeNull();
  expect(await d().activate(pending)).toBe('denied');
  expect(await d().signIn(pending.accountId, credential)).toEqual({ outcome: 'denied' });
  const replacement = await person('reclaim');
  expect(replacement.id).not.toBe(pending.accountId);
});

test('only actor and organization kinds exist and account kind and ID cannot change', async () => {
  expect(await d().beginRegistration({ handle: 'invalid', key: 'invalid', kind: 'bot' })).toBe('denied');
  const human = await person('human');
  const org = await d().createOrganization(human.session, 'organization');
  expect(await d().account(org)).toMatchObject({ kind: 'organization', id: org });
  expect(await d().patchAccount(human.session, human.id, { kind: 'organization' })).toBe('denied');
  expect(await d().patchAccount(human.session, human.id, { id: 'replacement' })).toBe('denied');
  expect(await d().patchAccount(human.session, org, { kind: 'actor' })).toBe('denied');
  expect(await d().patchAccount(human.session, org, { id: human.id })).toBe('denied');
  expect(await d().account(human.id)).toMatchObject({ kind: 'actor', id: human.id });
  expect(await d().account(org)).toMatchObject({ kind: 'organization', id: org });
});

test('actors and organizations share unique handles and rename reserves a redirect', async () => {
  const human = await person('shared');
  const org = await d().createOrganization(human.session, 'org');
  expect(await d().patchAccount(human.session, org, { handle: 'shared' })).toBe('denied');
  expect(await d().beginRegistration({ handle: 'org', key: 'collision' })).toBe('denied');
  expect(await d().patchAccount(human.session, human.id, { handle: 'renamed' })).toBe('permitted');
  expect(await d().resolveHandle('renamed')).toEqual({ accountId: human.id, redirect: false });
  expect(await d().resolveHandle('shared')).toEqual({ accountId: human.id, redirect: true });
  expect(await d().beginRegistration({ handle: 'shared', key: 'reserved' })).toBe('denied');
  expect(await d().patchAccount(human.session, org, { handle: 'shared' })).toBe('denied');
  expect(await d().account(org)).toMatchObject({ handle: 'org' });
});

test('an organization has no credentials and cannot sign in or become a session subject', async () => {
  const human = await person('owner');
  const org = await d().createOrganization(human.session, 'organization');
  const credential = await d().newCredential('password');
  expect(await d().setCredential(human.session, org, credential, true)).toBe('denied');
  expect((await d().authInventory()).credentialAccountIds).not.toContain(org);
  expect(await d().signIn(org, credential)).toEqual({ outcome: 'denied' });
  expect(await d().signIn(org, human.credential)).toEqual({ outcome: 'denied' });
  expect(await d().openSession(human.session, org)).toEqual({ outcome: 'denied' });
});

test('automated profile and attribution disclose operator while private data stays absent', async () => {
  const owner = await person('owner');
  const agent = await automated(owner);
  const privateData = await d().populatePrivateData(agent);
  expect(privateData.populated).toBe(true);
  expect(privateData.secretValues.length).toBeGreaterThan(0);
  for (const view of [await d().profile(agent), await d().attribution(agent)]) {
    expect(view).toMatchObject({ id: agent, kind: 'actor', automated: true, operatorId: owner.id });
    const inspect = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        expect(key.replaceAll('_', '').toLowerCase()).not.toMatch(/email|controller|session|consent|privatesettings/);
        inspect(child);
      }
    };
    inspect(view.raw);
    for (const secret of privateData.secretValues) expect(JSON.stringify(view.raw)).not.toContain(secret);
  }
  expect(await d().profile(owner.id)).toMatchObject({ automated: false });
  expect(await d().attribution(owner.id)).toMatchObject({ automated: false });
  expect((await d().profile(owner.id)).operatorId).toBeUndefined();
  expect((await d().attribution(owner.id)).operatorId).toBeUndefined();
});

test('human and organization operators are eligible but automated operators and responsibility chains are rejected', async () => {
  const owner = await person('owner');
  const agent = await automated(owner);
  const org = await d().createOrganization(owner.session, 'organization');
  await automated(owner, 'organization-agent', org);
  expect(await d().createAutomated(owner.session, agent, 'child')).toBe('denied');
  expect(await d().setOperator(owner.session, agent, agent)).toBe('denied');
  expect(await d().setOperator(owner.session, owner.id, agent)).toBe('denied');
  const other = await person('other');
  // Making an existing operator automated would create a longer chain even
  // though the proposed new operator is an otherwise eligible human.
  expect(await d().setOperator(owner.session, owner.id, other.id)).toBe('denied');
  expect(await d().setOperator(owner.session, owner.id, owner.id)).toBe('denied');
  const second = await automated(other, 'second');
  expect(await d().setOperator(owner.session, agent, second)).toBe('denied');
  expect(await d().setOperator(other.session, other.id, agent)).toBe('denied');
  expect(await d().account(owner.id)).toMatchObject({ operatorId: null });
  expect(await d().account(agent)).toMatchObject({ operatorId: owner.id });
  expect(await d().account(second)).toMatchObject({ operatorId: other.id });
});

test('a person opens a session only with its own credential', async () => {
  const human = await person('human');
  const unrelated = await person('unrelated');
  expect(await d().session(await authenticated(d().signIn(human.id, human.credential)))).toMatchObject({
    subjectId: human.id,
  });
  expect(await d().signIn(human.id, unrelated.credential)).toEqual({ outcome: 'denied' });
  expect(await d().openSession(unrelated.session, human.id)).toEqual({ outcome: 'denied' });
});

test('an automated actor with a credential permits exactly self login and authorized operator session opening', async () => {
  const owner = await person('owner');
  const agent = await automated(owner);
  const credential = await credentialFor(owner.session, agent);
  expect(await d().session(await authenticated(d().signIn(agent, credential)))).toMatchObject({ subjectId: agent });
  expect(await d().session(await authenticated(d().openSession(owner.session, agent)))).toMatchObject({
    subjectId: agent,
    actingHumanId: owner.id,
  });
  const stranger = await person('stranger');
  const otherOperator = await person('other-operator');
  await automated(otherOperator, 'other-agent');
  expect(await d().signIn(agent, owner.credential)).toEqual({ outcome: 'denied' });
  expect(await d().signIn(agent, stranger.credential)).toEqual({ outcome: 'denied' });
  expect(await d().openSession(stranger.session, agent)).toEqual({ outcome: 'denied' });
  expect(await d().openSession(otherOperator.session, agent)).toEqual({ outcome: 'denied' });
  expect(await d().setCredential(stranger.session, agent, credential, false)).toBe('denied');
  expect(await d().setManagement(owner.session, owner.id, owner.id, false)).toBe('permitted');
  expect(await d().openSession(owner.session, agent)).toEqual({ outcome: 'denied' });
  await authenticated(d().signIn(agent, credential));
});

test('a credentialless automated actor permits only its authorized operator to open a session', async () => {
  const owner = await person('owner');
  const agent = await automated(owner);
  expect((await d().authInventory()).credentialAccountIds).not.toContain(agent);
  expect(await d().signIn(agent)).toEqual({ outcome: 'denied' });
  expect(await d().signIn(agent, owner.credential)).toEqual({ outcome: 'denied' });
  expect(await d().session(await authenticated(d().openSession(owner.session, agent)))).toMatchObject({
    subjectId: agent,
    actingHumanId: owner.id,
  });
  const stranger = await person('stranger');
  const otherOperator = await person('other-operator');
  await automated(otherOperator, 'other-agent');
  expect(await d().openSession(stranger.session, agent)).toEqual({ outcome: 'denied' });
  expect(await d().openSession(otherOperator.session, agent)).toEqual({ outcome: 'denied' });
  expect(await d().setManagement(owner.session, owner.id, owner.id, false)).toBe('permitted');
  expect(await d().openSession(owner.session, agent)).toEqual({ outcome: 'denied' });
});

test('organization owners and delegated members may manage while ordinary members cannot and audit preserves the human', async () => {
  const owner = await person('owner');
  const member = await person('member');
  const org = await d().createOrganization(owner.session, 'organization');
  expect(await d().setMembership(owner.session, org, member.id, 'member')).toBe('permitted');
  const agent = await automated(owner, 'agent', org);
  expect(await d().session(await authenticated(d().openSession(owner.session, agent)))).toMatchObject({
    subjectId: agent,
    actingHumanId: owner.id,
  });
  expect(await d().audit(agent)).toContainEqual({
    action: 'session-opened',
    actingHumanId: owner.id,
    subjectId: agent,
    operatorId: org,
  });
  expect(await d().openSession(member.session, agent)).toEqual({ outcome: 'denied' });
  expect(await d().setManagement(owner.session, org, member.id, true)).toBe('permitted');
  const managed = await authenticated(d().openSession(member.session, agent));
  expect(await d().session(managed)).toMatchObject({ subjectId: agent, actingHumanId: member.id });
  expect(await d().audit(agent)).toContainEqual({
    action: 'session-opened',
    actingHumanId: member.id,
    subjectId: agent,
    operatorId: org,
  });
  expect(await d().setManagement(owner.session, org, member.id, false)).toBe('permitted');
  expect(await d().openSession(member.session, agent)).toEqual({ outcome: 'denied' });
});

test('adding and removing credentials changes independent login without changing actor kind or enabling email recovery', async () => {
  const owner = await person('owner');
  const agent = await automated(owner);
  expect(await d().signIn(agent)).toEqual({ outcome: 'denied' });
  const password = await credentialFor(owner.session, agent, 'password');
  await authenticated(d().signIn(agent, password));
  expect(await d().setCredential(owner.session, agent, password, false)).toBe('permitted');
  expect(await d().signIn(agent, password)).toEqual({ outcome: 'denied' });
  await authenticated(d().openSession(owner.session, agent));
  const key = await credentialFor(owner.session, agent, 'key');
  await authenticated(d().signIn(agent, key));
  const humanKey = await credentialFor(owner.session, owner.id, 'key');
  await authenticated(d().signIn(owner.id, humanKey));
  expect(await d().account(agent)).toMatchObject({ kind: 'actor', operatorId: owner.id });
  expect(await d().startEmailRecovery(owner.id)).not.toBe('denied');
  expect(await d().startEmailRecovery(agent)).toBe('denied');
});

test('operator transfer invalidates old management and never inherits either operators resource grants', async () => {
  const old = await person('old');
  const next = await person('next');
  const agent = await automated(old);
  const oldResource = await d().createResource(old.session);
  const nextResource = await d().createResource(next.session);
  expect(await d().useResource(old.session, oldResource)).toBe('permitted');
  expect(await d().useResource(next.session, nextResource)).toBe('permitted');
  const before = await authenticated(d().openSession(old.session, agent));
  expect(await d().useResource(before, oldResource)).toBe('denied');
  expect(await d().setOperator(old.session, agent, next.id)).toBe('denied');
  expect(await d().acceptOperator(old.session, agent, next.id)).toBe('denied');
  expect(await d().acceptOperator(next.session, agent, next.id)).toBe('permitted');
  expect(await d().setOperator(old.session, agent, next.id)).toBe('permitted');
  expect(await d().account(agent)).toMatchObject({ operatorId: next.id });
  expect(await d().openSession(old.session, agent)).toEqual({ outcome: 'denied' });
  expect(await d().setCredential(old.session, agent, await d().newCredential('key'), true)).toBe('denied');
  const after = await authenticated(d().openSession(next.session, agent));
  expect(await d().useResource(after, oldResource)).toBe('denied');
  expect(await d().useResource(after, nextResource)).toBe('denied');
  expect(await d().grantResource(next.session, nextResource, agent)).toBe('permitted');
  expect(await d().useResource(after, nextResource)).toBe('permitted');
  expect(await d().setOperator(next.session, agent, agent)).toBe('denied');
  const ineligible = await automated(next, 'ineligible');
  expect(await d().setOperator(next.session, agent, ineligible)).toBe('denied');
  expect(await d().account(agent)).toMatchObject({ operatorId: next.id });
});

test('an operator cannot be deleted until its operated accounts transfer or delete', async () => {
  const owner = await person('owner');
  const next = await person('next');
  const first = await automated(owner, 'first');
  const second = await automated(owner, 'second');
  expect(await d().deleteAccount(owner.session, owner.id)).toBe('denied');
  expect(await d().account(owner.id)).toMatchObject({ state: 'active' });
  expect(await d().acceptOperator(next.session, first, next.id)).toBe('permitted');
  expect(await d().setOperator(owner.session, first, next.id)).toBe('permitted');
  expect(await d().deleteAccount(owner.session, owner.id)).toBe('denied');
  expect(await d().deleteAccount(owner.session, second)).toBe('permitted');
  expect(await d().deleteAccount(owner.session, owner.id)).toBe('permitted');
  expect(await d().account(owner.id)).toMatchObject({ state: 'deleted' });
  await authenticated(d().openSession(next.session, first));
});

test('suspending an operator fences it and its operated actors including independent logins', async () => {
  const owner = await person('owner');
  const agent = await automated(owner);
  const credential = await credentialFor(owner.session, agent);
  const session = await authenticated(d().signIn(agent, credential));
  const ownerToken = await token(owner.session);
  const agentToken = await token(session);
  expect(await d().suspend(owner.id)).toBe('permitted');
  expect(await d().account(owner.id)).toMatchObject({ state: 'suspended', fenced: true });
  expect(await d().account(agent)).toMatchObject({ fenced: true });
  expect(await d().validateSession(owner.session)).toBe('denied');
  expect(await d().validateSession(session)).toBe('denied');
  expect(await d().validateToken(ownerToken)).toBe('denied');
  expect(await d().validateToken(agentToken)).toBe('denied');
  expect(await d().signIn(agent, credential)).toEqual({ outcome: 'denied' });
  expect(await d().openSession(owner.session, agent)).toEqual({ outcome: 'denied' });
});

async function fenceBeforeRevocation(failAuthRevocation: boolean) {
  const human = await person('human');
  const oldToken = await token(human.session);
  const oldEpoch = (await d().session(human.session)).authnEpoch;
  const proof = await d().startEmailRecovery(human.id);
  expect(proof).not.toBe('denied');
  if (proof === 'denied') throw new Error('Recovery positive control failed');
  let observed = false;
  const result = await d().revokeSessions(human.id, {
    failAuthRevocation,
    beforeAuthRevocation: async () => {
      observed = true;
      const receipt = await d().fenceReceipt(human.id);
      expect(receipt).not.toBeNull();
      expect(receipt!.id.length).toBeGreaterThan(0);
      expect(receipt!.accountId).toBe(human.id);
      expect(receipt!.minimumAuthnEpoch).toBeGreaterThan(oldEpoch);
      expect(await d().account(human.id)).toMatchObject({
        fenced: true,
        minimumAuthnEpoch: receipt!.minimumAuthnEpoch,
      });
      expect(await d().validateSession(human.session)).toBe('denied');
      expect(await d().validateToken(oldToken)).toBe('denied');
    },
  });
  expect(observed).toBe(true);
  expect(result).toBe(failAuthRevocation ? 'revocation-failed' : 'revoked');
  expect(await d().validateSession(human.session)).toBe('denied');
  expect(await d().validateToken(oldToken)).toBe('denied');
  expect(await d().issueToken(human.session)).toBe('denied');
  const fenced = await d().account(human.id);
  const receipt = await d().fenceReceipt(human.id);
  expect(await d().recover(human.id, proof)).toBe('denied');
  expect(await d().account(human.id)).toEqual(fenced);
  expect(await d().fenceReceipt(human.id)).toEqual(receipt);
  if (failAuthRevocation) expect(fenced.fenced).toBe(true);
}

test('Access commits epoch fence and durable receipt before Auth revokes sessions and stale recovery cannot undo it', async () => {
  await fenceBeforeRevocation(false);
});

test('failed Auth revocation leaves the durable Access fence denying old sessions tokens and stale recovery', async () => {
  await fenceBeforeRevocation(true);
});

test('organization retains at least one owner and rejects automated members', async () => {
  const owner = await person('owner');
  const successor = await person('successor');
  const org = await d().createOrganization(owner.session, 'organization');
  expect(await d().members(org)).toEqual([{ accountId: owner.id, role: 'owner' }]);
  expect(await d().setMembership(owner.session, org, owner.id, null)).toBe('denied');
  expect(await d().setMembership(owner.session, org, owner.id, 'member')).toBe('denied');
  expect(await d().deleteAccount(owner.session, owner.id)).toBe('denied');
  const agent = await automated(owner);
  expect(await d().setMembership(owner.session, org, agent, 'member')).toBe('denied');
  expect(await d().setMembership(owner.session, org, agent, 'owner')).toBe('denied');
  expect(await d().members(org)).toEqual([{ accountId: owner.id, role: 'owner' }]);
  expect(await d().setMembership(owner.session, org, successor.id, 'owner')).toBe('permitted');
  expect(await d().setMembership(owner.session, org, owner.id, null)).toBe('permitted');
  expect(await d().members(org)).toEqual([{ accountId: successor.id, role: 'owner' }]);
});
