import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { realmHref as communityHref } from '../features/realm/route.ts';
import { postDocument, type PostIntent, type PostProgress } from '../features/post-composer/api.ts';
import { PublicCommands, selectedSessionAgent } from './direction-9-fixture.ts';
import { signInAtAccounts } from './account-sign-in.ts';

export const idOf = (iri: string) => iri.slice(-36);
const nativeId = () => `https://rezics.com/id/${randomUUID()}`;
const realmAdminScope = (realm: string) => `governance:realm:${realm}`;

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

async function principalFor(actor: string): Promise<string> {
  const url = process.env.ACCESS_DATABASE_URL;
  if (!url) throw new Error('ACCESS_DATABASE_URL must name the isolated QA access database');
  const pool = new Pool({ connectionString: url });
  try {
    const row = await pool.query<{ principal_id: string }>(`SELECT principal_id FROM access.representation
      WHERE subject_id = $1 AND action = 'agent.control' AND active AND valid_until > now() LIMIT 1`, [actor]);
    const principal = row.rows[0]?.principal_id;
    if (!principal) throw new Error('The signed-in person has no principal');
    return principal;
  } finally { await pool.end(); }
}

/** Test-only authorities are admitted in the isolated QA database; each journey still uses Main for its writes. */
export async function grant(scope: string, action: string, principalId: string, actor: string): Promise<void> {
  const url = process.env.ACCESS_DATABASE_URL;
  if (!url) throw new Error('ACCESS_DATABASE_URL must name the isolated QA access database');
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await grantFixtureAuthority(client, {
      scope,
      requireDispatch: true,
      representations: [{ principalId, actor, action, lifetime: '8 hours' }],
      grant: { actor, action, lifetime: '8 hours' },
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function enrollPerson(browser: Browser, info: TestInfo, purpose: string): Promise<{
  page: Page; actor: string; principalId: string; publicName: string; email: string; close: () => Promise<void>;
}> {
  const suffix = randomBytes(4).toString('hex');
  const person = {
    email: `realm-${purpose}-${suffix}@example.test`, password: `pass phrase ${suffix}`,
    publicName: `Realm ${purpose} ${suffix}`, handle: `realm_${purpose}_${suffix}`,
  };
  const context = await browser.newContext({ baseURL: info.project.use.baseURL });
  const page = await context.newPage();
  const accountsOrigin = process.env.ACCOUNT_ORIGIN ?? 'http://127.0.0.1:3004';
  const signUpOrigin = process.env.REZICS_ACCOUNTS_SIGNUP_ORIGIN;
  await page.goto('/auth/start?create=1&next=%2Fen');
  await expect(page).toHaveURL(url => url.origin === new URL(accountsOrigin).origin);
  if (signUpOrigin) {
    const signUp = new URL(page.url());
    await page.goto(`${signUpOrigin}${signUp.pathname}${signUp.search}`);
  }
  await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
  await page.getByRole('textbox', { name: 'Display name' }).fill(`Account ${suffix}`);
  await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await page.getByLabel('Confirm').fill(person.password);
  await page.getByText('I meet the minimum age in the Terms and have read and accept:').click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
  let verification = '';
  await expect.poll(async () => {
    const result = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${person.email}"`)}`);
    const { messages } = await result.json() as { messages: { ID: string; Subject: string }[] };
    const email = messages.find(item => item.Subject === 'Verify your email address');
    if (!email) return false;
    const { Text } = await (await fetch(`${mailpit}/api/v1/message/${email.ID}`)).json() as { Text: string };
    verification = /https?:\/\/\S+/.exec(Text)?.[0] ?? '';
    return Boolean(verification);
  }, { timeout: 30_000 }).toBe(true);
  const verify = new URL(verification);
  if (signUpOrigin) await page.goto(`${signUpOrigin}${verify.pathname}${verify.search}`);
  else await page.goto(verify.toString());
  await expect(page).toHaveURL(/\/en\/onboarding/, { timeout: 60_000 });
  const finished = await page.request.post('/en/onboarding/finish', {
    maxRedirects: 0,
    form: { displayName: person.publicName, handle: person.handle, next: '/en', key: randomUUID() },
  });
  expect(finished.status(), await finished.text()).toBe(303);
  const sessionKey = (await context.cookies()).find(cookie => cookie.name === 'rezics_session_key')?.value;
  expect(sessionKey).toBeTruthy();
  const session = await page.request.get('/api/main/v1/me/session-agent', { headers: { 'x-session-key': sessionKey! } });
  expect(session.status()).toBe(200);
  const state = await session.json() as { sessionAgent: { actingSubject?: string; eligible?: boolean } };
  expect(state.sessionAgent.eligible).toBe(true);
  const actor = state.sessionAgent.actingSubject ?? '';
  expect(actor).toMatch(/^https:\/\/rezics\.com\/id\//);
  return { page, actor, principalId: await principalFor(actor), publicName: person.publicName, email: person.email,
    close: () => context.close() };
}

type CommunityParticipant = Awaited<ReturnType<typeof enrollPerson>>;
let communityParticipant: CommunityParticipant | undefined;

export async function participantFor(browser: Browser, info: TestInfo): Promise<CommunityParticipant> {
  communityParticipant ??= await enrollPerson(browser, info, 'Community');
  return communityParticipant;
}

export async function closeParticipant() {
  await communityParticipant?.close();
  communityParticipant = undefined;
}

export async function managerSession(page: Page) {
  const member = fixture<{ member: { email: string; password: string } }>('REZICS_WEB_AUTH_PRIVATE_PATH').member;
  await signInAtAccounts(page, '/en', member);
  const actor = await selectedSessionAgent(page.request, await page.context().cookies());
  return { actor, principalId: await principalFor(actor), api: new PublicCommands(page.request) };
}

export async function choosePublicModerator(member: CommunityParticipant, realm: string, info: TestInfo) {
  const { operator } = fixture<{ operator: { id: string; email: string; password: string } }>(
    'REZICS_WEB_AUTH_PRIVATE_PATH');
  const account = process.env.ACCOUNT_BASE_URL;
  const accountDatabaseUrl = process.env.ACCOUNT_DATABASE_URL;
  const accountSecret = process.env.ACCOUNT_SECRET;
  const accessDatabaseUrl = process.env.ACCESS_DATABASE_URL;
  const main = process.env.MAIN_ORIGIN;
  const resource = process.env.ACCOUNT_MAIN_RESOURCE;
  const mailpit = process.env.MAILPIT_URL;
  if (!account || !accountDatabaseUrl || !accountSecret || !accessDatabaseUrl || !main || !resource || !mailpit) {
    throw new Error('The isolated QA Account and Main endpoints are required for the public moderator seed');
  }
  const cookies = await member.page.context().cookies(account);
  const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  if (!cookie) throw new Error('The enrolled member has no Account session cookie');
  const endpoints = {
    account,
    accountService: process.env.ACCOUNT_SERVICE_ORIGIN,
    main,
    mailpit,
    clientId: 'created-by-realm-profile-seed',
    redirectUri: new URL('/auth/callback', String(info.project.use.baseURL)).toString(),
    resource,
    scope: 'openid realm:profile realm:public-role',
  };
  const script = `
import { randomUUID } from 'node:crypto';
import { realmProfileClient } from './scripts/dev/seed/official-authority.ts';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const api = await realmProfileClient(input.operator);
const token = await api.token(input.cookie);
await api.put(input.path, input.body, token, randomUUID());
`;
  const result = spawnSync('bun', ['-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
    input: JSON.stringify({
      operator: {
        endpoints,
        credentials: { email: operator.email, password: operator.password },
        accountDatabaseUrl,
        accountSecret,
        accessDatabaseUrl,
        accountSubject: operator.id,
        ownerAccountSubject: operator.id,
        actingSubject: member.actor,
      },
      cookie,
      path: `/v1/realms/${idOf(realm)}/moderators/${idOf(member.actor)}/public-choice`,
      body: { profile: 'realm-public-moderator-choice-v1', expectedHead: null,
        public: true, actingSubject: member.actor },
    }),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(-1200);
    throw new Error(`Public moderator seed failed${result.status === null ? '' : ` (exit ${result.status})`}: ${detail}`);
  }
}

export async function createRealm(api: PublicCommands, actor: string, principalId: string, name: string) {
  await grant('space:create:root', 'space.create', principalId, actor);
  const created = await api.write<{ realm: string }>('/spaces', {
    profile: 'space-realm-v1', name, capabilities: ['realm'], actingSubject: actor,
    initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open',
      whoMaySubmit: 'members', selfJoin: true, rules: [] },
  });
  return { realm: created.realm, id: idOf(created.realm), name };
}

export async function grantRealmManager(realm: string, actor: string, principalId: string) {
  const scope = realmAdminScope(realm);
  for (const action of ['realm.owner', 'governance.moderate', 'realm.roles.manage', 'realm.members.manage'])
    await grant(scope, action, principalId, actor);
}

export async function joinRealm(page: Page, realm: string) {
  await page.goto(communityHref('en', realm, 'home'));
  const join = page.getByRole('button', { name: /^Join(?: · .+)?$/ });
  await expect(join).toBeVisible();
  await join.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /Join / })).toBeVisible();
  await dialog.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Joined(?: · .+)?$/ })).toBeVisible({ timeout: 30_000 });
}

export async function createPublicWork(api: PublicCommands, actor: string, principalId: string, title: string) {
  await grant('work:create:root', 'work.create', principalId, actor);
  const created = await api.write<{ work: string; mainVersion: string }>('/works', {
    profile: 'metadata-only-v1', authoring: 'own-work', language: 'en', title,
    semanticTypes: ['https://schema.org/Book'], actingSubject: actor,
  });
  await grant(`work:read:${created.work}`, 'work.read', principalId, actor);
  await grant(`work:edit:${created.work}`, 'work.edit', principalId, actor);
  await grant(`contribution:create:${created.work}`, 'contribution.create', principalId, actor);
  const draft = await api.write<{ contribution: string; draftRevision: string }>('/contributions', {
    profile: 'text-contribution-v1', work: created.work, language: 'en', body: `${title} is an original story.`,
    actingSubject: actor,
  });
  await grant(`contribution:read:${draft.contribution}`, 'contribution.read', principalId, actor);
  await grant(`contribution:publish:${draft.contribution}`, 'contribution.publish', principalId, actor);
  const publication = await api.write<{ publicationDecision: string }>('/contribution-publications', {
    profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
  });
  await grant(`publication:select:${created.mainVersion}`, 'publication.select', principalId, actor);
  const selected = await api.write<{ selectedDraft: string }>('/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: created.mainVersion },
    work: created.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor,
  });
  return { ...created, rootRevision: selected.selectedDraft, title };
}

export async function seedThread(api: PublicCommands, realm: string, work: { work: string; mainVersion: string; rootRevision: string },
  actor: string, principalId: string, title: string, body: string, concepts?: string[]) {
  await grant(`reply:create:${work.work}`, 'reply.create', principalId, actor);
  await grant(`reply:place:${realm}`, 'reply.place', principalId, actor);
  const progress: PostProgress = {
    key: randomUUID(), reply: nativeId(), variantId: `urn:rezics:variant:${randomUUID()}`,
  };
  const intent: PostIntent = { realm, work: work.work, mainVersion: work.mainVersion,
    title, body, spoiler: false, language: 'en', actingSubject: actor };
  const document = postDocument(intent, progress);
  await grant(`content:draft:${progress.reply}`, 'content.draft', principalId, actor);
  const draft = await api.write<{ revisionId: string; revisionDigest: string }>('/member-reply-drafts', {
    profile: 'member-reply-draft-v1', reply: progress.reply, variantId: progress.variantId,
    rootTarget: work.work, rootRevision: work.rootRevision, originRealm: realm, language: 'en', direction: 'ltr',
    spoiler: false, expectedHead: null, document, actingSubject: actor,
  });
  await api.write('/realm-replies', {
    profile: 'realm-reply-identity-v1', reply: progress.reply, variantId: progress.variantId,
    revisionId: draft.revisionId, author: actor, rootTarget: work.work, rootRevision: work.rootRevision,
    parentReply: null, parentRevision: null, contextRevision: null, spoiler: false,
  });
  await api.write('/realm-reply-placements', {
    profile: 'realm-reply-placement-v1', realm, reply: progress.reply, revisionId: draft.revisionId,
    revisionDigest: draft.revisionDigest, reviewDecisionId: null, expectedHead: null, actingSubject: actor,
    ...(concepts ? { concepts, primaryConcept: concepts[0] ?? null } : {}),
  });
  return progress.reply;
}

export async function waitForThreads(api: PublicCommands, realm: string, actor: string, titles: readonly string[], concept?: string) {
  const path = `/realms/${idOf(realm)}/threads?${new URLSearchParams({ sort: 'best', limit: '20',
    actingSubject: actor, ...(concept ? { concept } : {}) })}`;
  const deadline = Date.now() + 120_000;
  let lastStatus = 0;
  do {
    const result = await api.inspect(path);
    lastStatus = result.status;
    if (result.status === 200) {
      const items = (result.body as { items?: { title: string }[] } | null)?.items ?? [];
      if (titles.every(title => items.some(item => item.title === title))) return;
    } else {
      const code = result.body && typeof result.body === 'object' && 'code' in result.body
        ? String(result.body.code) : 'unknown';
      if (![409, 503].includes(result.status) || code === 'rate_limit_unclassified') {
        throw new Error(`Fixture projection ${path}: HTTP ${result.status} (${code})`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error(`Fixture projection ${path} was not ready within 120 seconds (last HTTP ${lastStatus})`);
}

export async function waitForWorkTypeahead(api: PublicCommands, work: { work: string; title: string }) {
  const path = `/search/typeahead?prefix=${encodeURIComponent(work.title)}`;
  const deadline = Date.now() + 120_000;
  let lastStatus = 0;
  let lastBody: unknown;
  do {
    const result = await api.inspect(path);
    lastStatus = result.status;
    lastBody = result.body;
    if (result.status === 200) {
      const items = (result.body as { items?: { work: string }[] } | null)?.items ?? [];
      if (items.some(item => item.work === work.work)) return;
    } else {
      const code = result.body && typeof result.body === 'object' && 'code' in result.body
        ? String(result.body.code) : 'unknown';
      if (![409, 503].includes(result.status) || code === 'rate_limit_unclassified') {
        throw new Error(`Fixture projection ${path}: HTTP ${result.status} (${code})`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  console.log(JSON.stringify({ event: 'realm-fixture-typeahead-incomplete', at: new Date().toISOString(),
    request: { method: 'GET', path: `/api/main/v1${path}` }, status: lastStatus, body: lastBody }));
  throw new Error(`Fixture projection ${path} was not ready within 120 seconds (last HTTP ${lastStatus})`);
}

export async function letMemberDraft(page: Page, actor: string, principalId: string) {
  const granted = new Set<string>();
  await page.route('**/api/main/v1/member-reply-drafts', async route => {
    const body = route.request().postDataJSON() as { reply?: string; actingSubject?: string };
    if (body.actingSubject === actor && body.reply && !granted.has(body.reply)) {
      granted.add(body.reply);
      await grant(`content:draft:${body.reply}`, 'content.draft', principalId, actor);
    }
    await route.continue();
  });
}

