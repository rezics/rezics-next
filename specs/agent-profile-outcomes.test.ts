import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AGENT_PROFILE_MISSING_DRIVER,
  type Account,
  type AgentProfileDriver,
  type AgentProfileFixture,
  type Credential,
  type ProfilePatch,
} from './agent-profile-driver.ts';

setDefaultTimeout(240_000);
let driver: AgentProfileDriver | undefined;
beforeEach(async () => {
  const location = process.env.AGENT_PROFILE_DRIVER;
  if (!location) throw new Error(AGENT_PROFILE_MISSING_DRIVER);
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('AGENT_PROFILE_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('AGENT_PROFILE_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createAgentProfileDriver !== 'function')
    throw new Error('Expected createAgentProfileDriver factory');
  driver = await binding.createAgentProfileDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
});
const native = () => driver!;
const pathOf = (account: Account) => `/v1/accounts/${account.accountId}`;
const idsPath = (accounts: Account[]) =>
  `/v1/accounts?ids=${encodeURIComponent(accounts.map((a) => a.accountId).join(','))}`;
const profilePath = (account: Account) => `/v1/accounts?handle=${encodeURIComponent(account.handle)}`;
const writeInit = (method: string, body: unknown, key: string = crypto.randomUUID()): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': JSON.stringify(key) },
  body: JSON.stringify(body),
});
const patch = (credential: Credential | null, account: Account, body: unknown, key?: string) =>
  native().request(credential, pathOf(account), writeInit('PATCH', body, key));
const page = (credential: Credential | null, target: { account: string } | { subject: string }) =>
  native().request(credential, '/v1/pages:read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  });
async function ok(response: Response) {
  expect(response.status).toBe(200);
  return response.json();
}
async function profile(account: Account, credential: Credential | null = null) {
  const body = await ok(await native().request(credential, profilePath(account)));
  expect(body.accounts).toHaveLength(1);
  expect(body.accounts[0].id).toBe(account.accountId);
  return body.accounts[0];
}
async function invalid(response: Response) {
  expect(response.status).toBe(400);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  expect(await response.json()).toMatchObject({ status: 400, code: 'invalid_request' });
}
async function denied(response: Response) {
  expect([401, 403, 404]).toContain(response.status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  return response.json();
}
const identityKeys = ['id', 'kind', 'handle', 'displayName', 'state', 'automated', 'operatorId'];
const profileKeys = [...identityKeys, 'bio', 'links', 'avatar', 'publicViews', 'subject', 'verified'];
function noPrivateValues(f: AgentProfileFixture, body: unknown) {
  expect(f.privateValues.length).toBeGreaterThan(0);
  const serialized = JSON.stringify(body);
  for (const value of f.privateValues) {
    expect(value.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(value);
  }
  const privateKeys = new Set([
    'email',
    'credentials',
    'password',
    'passwordHash',
    'sessions',
    'consent',
    'controller',
    'controllerId',
    'birthDate',
    'preferences',
    'contentPreferences',
    'minimumAuthnEpoch',
    'fenced',
    'suspensionReason',
    'accessToken',
    'refreshToken',
  ]);
  const visit = (value: unknown) => {
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      expect(privateKeys.has(key)).toBe(false);
      visit(child);
    }
  };
  visit(body);
}
async function publicOnly(f: AgentProfileFixture, account: Account, credential: Credential | null) {
  const batch = await ok(await native().request(credential, idsPath([account])));
  expect(batch.accounts).toHaveLength(1);
  expect(Object.keys(batch.accounts[0]).sort()).toEqual([...identityKeys].sort());
  const full = await profile(account, credential);
  const keys = account.accountId === f.organization.accountId ? [...profileKeys, 'speakersListed'] : profileKeys;
  expect(Object.keys(full).sort()).toEqual([...keys].sort());
  noPrivateValues(f, { batch, full });
  noPrivateValues(f, await ok(await page(credential, { account: account.handle })));
}

test('an anonymous reader gets exactly one correctly typed public identity for a person an organization and a software agent with no Person fallback for the software agent', async () => {
  const f = await native().fixture();
  const accounts = [f.alice, f.organization, f.software];
  const batch = await ok(await native().request(f.anonymous, idsPath([...accounts, f.software])));
  expect(batch.accounts).toEqual(
    accounts.map((a, index) => ({
      id: a.accountId,
      handle: a.handle,
      displayName: a.displayName,
      state: 'active',
      kind: index === 1 ? 'organization' : 'actor',
      automated: index === 2,
      operatorId: index === 2 ? f.software.operator.accountId : null,
    })),
  );
  for (const [index, type] of ['schema:Person', 'schema:Organization', 'schema:SoftwareApplication'].entries()) {
    const account = accounts[index]!;
    const full = await profile(account);
    expect(full.subject).toMatchObject({ id: account.subjectId, type });
    const answer = await ok(await page(f.anonymous, { account: account.handle }));
    expect(answer.template).toEqual({ scope: 'type', key: type });
    expect(answer.account).toBe(account.accountId);
  }
});

test("the software agent's identity names its operator", async () => {
  const f = await native().fixture();
  const software = await profile(f.software);
  expect(software).toMatchObject({ kind: 'actor', automated: true, operatorId: f.software.operator.accountId });
  const operator = await profile(f.software.operator);
  expect(operator).toMatchObject({ handle: f.software.operator.handle, displayName: f.software.operator.displayName });
  const answer = await ok(await page(f.anonymous, { account: f.software.handle }));
  expect(JSON.stringify(answer.reads)).toContain(f.software.operator.accountId);
});

test("the page read for a verified person's subject address answers 308 to the account's handle page while the account is active and serves the subject page with no handle while it is suspended", async () => {
  const f = await native().fixture();
  const verified = await native().verifyPerson(f.alice);
  expect(verified.request.status).toBe(201);
  expect(verified.approval.status).toBe(200);
  const byAgent = await ok(
    await native().request(f.anonymous, `/v1/accounts?agent=${encodeURIComponent(verified.subjectId)}`),
  );
  expect(byAgent.accounts).toHaveLength(1);
  expect(byAgent.accounts[0]).toMatchObject({
    id: f.alice.accountId,
    verified: true,
    subject: { id: verified.subjectId },
  });
  const response = await page(f.anonymous, { subject: verified.subjectId });
  expect(response.status).toBe(308);
  expect(await response.json()).toEqual({ redirect: { from: verified.subjectId, to: f.alice.handle } });
  const destination = await ok(await page(f.anonymous, { account: f.alice.handle }));
  expect(destination).toMatchObject({ account: f.alice.accountId, subject: verified.subjectId });
  await native().suspend(f.alice);
  const suspended = await page(f.anonymous, { subject: verified.subjectId });
  expect(suspended.headers.get('location')).toBeNull();
  const subject = await ok(suspended);
  expect(subject.subject).toBe(verified.subjectId);
  expect(subject).not.toHaveProperty('account');
  expect(subject).not.toHaveProperty('redirect');
  expect(JSON.stringify(subject)).not.toContain(f.alice.handle);
});

test("the operator of a software agent edits its profile through account:manage on the operator while the software's own bearer and an outsider are refused with no change", async () => {
  const f = await native().fixture();
  const credential = f.software.operator.credential;
  await publicOnly(f, f.software, credential);
  noPrivateValues(f, await denied(await native().request(credential, `${pathOf(f.software)}/preferences`)));
  await ok(await patch(credential, f.software, { biography: 'Profile managed by the operator' }));
  expect((await profile(f.software)).bio).toBe('Profile managed by the operator');
  const before = await native().inspect(f.software);
  for (const credential of [f.software.credential, f.bob.credential]) {
    await denied(await patch(credential, f.software, { biography: 'Unauthorized profile change' }));
    expect(await native().inspect(f.software)).toEqual(before);
  }
});

test('an outsider reads no private field of any account', async () => {
  const f = await native().fixture();
  for (const account of [f.alice, f.organization, f.software]) {
    for (const credential of [f.anonymous, f.bob.credential]) {
      await publicOnly(f, account, credential);
      noPrivateValues(f, await denied(await native().request(credential, `${pathOf(account)}/preferences`)));
      noPrivateValues(f, await denied(await native().request(credential, `${pathOf(account)}/verification`)));
    }
  }
});

test('alice edits display name biography links and avatar with one PATCH and her public identity read shows them', async () => {
  const f = await native().fixture();
  const { mediaId } = await native().uploadAvatar(f.alice, 'completed');
  const change: ProfilePatch = {
    displayName: 'Alice the reader',
    biography: 'I read and collect books.',
    avatar: mediaId,
    links: [{ label: 'Reading notes', url: 'https://example.test/notes' }],
  };
  await ok(await patch(f.alice.credential, f.alice, change));
  expect(await profile(f.alice)).toMatchObject({
    displayName: change.displayName,
    bio: change.biography,
    links: change.links,
    avatar: { media: mediaId, credit: null },
  });
  const batch = await ok(await native().request(f.anonymous, idsPath([f.alice])));
  expect(batch.accounts[0].displayName).toBe(change.displayName);
});

test('a field left out keeps its value and null clears a nullable field', async () => {
  const f = await native().fixture();
  const { mediaId } = await native().uploadAvatar(f.alice, 'completed');
  await ok(
    await patch(f.alice.credential, f.alice, {
      displayName: 'Keep my name',
      biography: 'Clear this biography',
      avatar: mediaId,
      links: [{ label: 'Keep this link', url: 'https://example.test/keep' }],
      publicViews: { posts: true, reviews: true, collections: true, realms: false },
    }),
  );
  const before = await profile(f.alice);
  await ok(
    await patch(f.alice.credential, f.alice, { biography: null, avatar: null, publicViews: { reviews: false } }),
  );
  expect(await profile(f.alice)).toEqual({
    ...before,
    bio: null,
    avatar: null,
    publicViews: { ...before.publicViews, reviews: false },
  });
});

test('alice hides her public collections and posts and an anonymous reader and bob no longer see them on her page while alice still sees her own', async () => {
  const f = await native().fixture();
  const readers = [f.anonymous, f.bob.credential, f.alice.credential];
  const listed = async (credential: Credential | null, visible: boolean) => {
    const answer = await ok(await page(credential, { account: f.alice.handle }));
    for (const read of Object.values(answer.reads) as { status: number }[]) expect(read.status).toBe(200);
    const posts = await ok(await native().request(credential, `${pathOf(f.alice)}/posts`));
    const collections = await ok(await native().request(credential, `${pathOf(f.alice)}/collections?view=BASIC`));
    for (const [body, id] of [
      [answer.reads, f.publicPostId],
      [answer.reads, f.publicCollectionId],
      [posts, f.publicPostId],
      [collections, f.publicCollectionId],
    ] as const) {
      expect(JSON.stringify(body).includes(id)).toBe(visible);
    }
  };
  for (const reader of readers) await listed(reader, true);
  await ok(await patch(f.alice.credential, f.alice, { publicViews: { collections: false, posts: false } }));
  await listed(f.anonymous, false);
  await listed(f.bob.credential, false);
  await listed(f.alice.credential, true);
});

test("bob an unscoped token a revoked token and an anonymous caller change nothing on alice's profile", async () => {
  const f = await native().fixture();
  const before = await native().inspect(f.alice);
  for (const credential of [
    f.bob.credential,
    await native().unscoped('account:update'),
    f.revoked.credential,
    f.anonymous,
  ]) {
    await denied(await patch(credential, f.alice, { displayName: 'Unauthorized name', biography: null }));
    expect(await native().inspect(f.alice)).toEqual(before);
  }
});

test('an unknown or read-only field or an invalid value is refused with no partial change', async () => {
  const f = await native().fixture();
  const foreign = await native().uploadAvatar(f.bob, 'completed');
  const incomplete = await native().uploadAvatar(f.alice, 'incomplete');
  const before = await native().inspect(f.alice);
  const bad = [
    { unknown: true },
    { id: f.bob.accountId },
    { kind: 'organization' },
    { handle: 'renamed' },
    { state: 'suspended' },
    { operatorId: f.bob.accountId },
    { subject: f.bob.subjectId },
    { automated: true },
    { avatarUrl: 'https://example.test/avatar.png' },
    { birthDate: '2000-01-01' },
    { displayName: 42 },
    { biography: {} },
    { links: Array.from({ length: 6 }, () => ({ label: 'Site', url: 'https://example.test' })) },
    { links: [{ label: '', url: 'https://example.test' }] },
    { links: [{ label: 'Site', url: 'javascript:alert(1)' }] },
    { links: [{ label: 'Site', url: 'https://user:password@example.test' }] },
    { publicViews: { posts: 'false' } },
    { publicViews: { unknown: false } },
    { speakersListed: true },
    { avatar: foreign.mediaId },
    { avatar: incomplete.mediaId },
    { avatar: 'not-a-media-id' },
  ];
  for (const invalidPatch of bad) {
    await invalid(
      await patch(f.alice.credential, f.alice, { biography: 'Must not partially commit', ...invalidPatch }),
    );
    expect(await native().inspect(f.alice)).toEqual(before);
  }
  await invalid(
    await native().request(f.alice.credential, pathOf(f.alice), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ biography: 'Missing key' }),
    }),
  );
  expect(await native().inspect(f.alice)).toEqual(before);
});

test('a replay with the same idempotency key applies once and returns the same answer', async () => {
  const f = await native().fixture();
  const before = await native().inspect(f.alice);
  const key = crypto.randomUUID();
  const change = { biography: 'One application only' };
  const first = await ok(await patch(f.alice.credential, f.alice, change, key));
  const once = await native().inspect(f.alice);
  expect(once.receipts).toHaveLength(before.receipts.length + 1);
  expect(once.events).toHaveLength(before.events.length + 1);
  expect((await profile(f.alice)).bio).toBe(change.biography);
  expect(await ok(await patch(f.alice.credential, f.alice, change, key))).toEqual(first);
  expect(await native().inspect(f.alice)).toEqual(once);
});

test('verification and preferences are not accepted by the profile update and keep their own commands', async () => {
  const f = await native().fixture();
  const before = await native().inspect(f.alice);
  for (const field of [
    { verified: true },
    { agentSubjectId: f.bob.subjectId },
    { agentVerified: true },
    { preferences: { spoilerLevel: 2 } },
    { contentPreferences: { suitability: 'show' } },
    { spoilerLevel: 2 },
  ]) {
    await invalid(await patch(f.alice.credential, f.alice, { displayName: 'Must not change', ...field }));
    expect(await native().inspect(f.alice)).toEqual(before);
  }
  const preferencesPath = `${pathOf(f.alice)}/preferences`;
  const preferences = await ok(await native().request(f.alice.credential, preferencesPath));
  const changed = await ok(
    await native().request(
      f.alice.credential,
      preferencesPath,
      writeInit('PATCH', {
        expectedVersion: preferences.version,
        spoilerLevel: preferences.spoilerLevel === 2 ? 0 : 2,
      }),
    ),
  );
  expect(changed.version).toBe(preferences.version + 1);
  expect(await ok(await native().request(f.alice.credential, preferencesPath))).toEqual(changed);
  const verified = await native().verifyPerson(f.alice);
  expect(verified.request.status).toBe(201);
  expect(verified.approval.status).toBe(200);
  expect(await profile(f.alice)).toMatchObject({ verified: true, subject: { id: verified.subjectId } });
  await ok(await patch(f.alice.credential, f.alice, { biography: 'Profile remains independently editable' }));
  const after = await native().inspect(f.alice);
  expect(after.preferences).not.toEqual(before.preferences);
  expect(after.verification).not.toEqual(before.verification);
  expect(await ok(await native().request(f.alice.credential, preferencesPath))).toEqual(changed);
  expect(await profile(f.alice)).toMatchObject({ verified: true, subject: { id: verified.subjectId } });
});
