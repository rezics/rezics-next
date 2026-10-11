import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Browser, type Locator, type Page, test, type TestInfo } from '@playwright/test';
import { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { localizedPath } from '../i18n/locale.ts';
import { realmHref as communityHref } from '../features/realm/route.ts';
import { realmHref as manageHref } from '../features/manage/routes.ts';
import { postDocument, type PostIntent, type PostProgress } from '../features/post-composer/api.ts';
import { PublicCommands, selectedSessionAgent } from './direction-9-fixture.ts';
import { signInAtAccounts } from './account-sign-in.ts';

const idOf = (iri: string) => iri.slice(-36);
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
async function grant(scope: string, action: string, principalId: string, actor: string): Promise<void> {
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

async function participantFor(browser: Browser, info: TestInfo): Promise<CommunityParticipant> {
  communityParticipant ??= await enrollPerson(browser, info, 'Community');
  return communityParticipant;
}

test.afterAll(async () => { await communityParticipant?.close(); });

async function managerSession(page: Page) {
  const member = fixture<{ member: { email: string; password: string } }>('REZICS_WEB_AUTH_PRIVATE_PATH').member;
  await signInAtAccounts(page, '/en', member);
  const actor = await selectedSessionAgent(page.request, await page.context().cookies());
  return { actor, principalId: await principalFor(actor), api: new PublicCommands(page.request) };
}

async function choosePublicModerator(member: CommunityParticipant, realm: string, info: TestInfo) {
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

async function createRealm(api: PublicCommands, actor: string, principalId: string, name: string) {
  await grant('space:create:root', 'space.create', principalId, actor);
  const created = await api.write<{ realm: string }>('/spaces', {
    profile: 'space-realm-v1', name, capabilities: ['realm'], actingSubject: actor,
    initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open',
      whoMaySubmit: 'members', selfJoin: true, rules: [] },
  });
  return { realm: created.realm, id: idOf(created.realm), name };
}

async function grantRealmManager(realm: string, actor: string, principalId: string) {
  const scope = realmAdminScope(realm);
  for (const action of ['realm.owner', 'governance.moderate', 'realm.roles.manage', 'realm.members.manage'])
    await grant(scope, action, principalId, actor);
}

async function joinRealm(page: Page, realm: string) {
  await page.goto(communityHref('en', realm, 'home'));
  const join = page.getByRole('button', { name: /^Join(?: · .+)?$/ });
  await expect(join).toBeVisible();
  await join.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /Join / })).toBeVisible();
  await dialog.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Joined(?: · .+)?$/ })).toBeVisible({ timeout: 30_000 });
}

async function createPublicWork(api: PublicCommands, actor: string, principalId: string, title: string) {
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

async function seedThread(api: PublicCommands, realm: string, work: { work: string; mainVersion: string; rootRevision: string },
  actor: string, principalId: string, title: string, body: string) {
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
  });
  return progress.reply;
}

async function waitForThreads(api: PublicCommands, realm: string, actor: string, titles: readonly string[]) {
  const path = `/realms/${idOf(realm)}/threads?sort=best&limit=20&actingSubject=${encodeURIComponent(actor)}`;
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

async function waitForWorkTypeahead(api: PublicCommands, work: { work: string; title: string }) {
  const path = `/search/typeahead?prefix=${encodeURIComponent(work.title)}`;
  const deadline = Date.now() + 120_000;
  let lastStatus = 0;
  do {
    const result = await api.inspect(path);
    lastStatus = result.status;
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
  throw new Error(`Fixture projection ${path} was not ready within 120 seconds (last HTTP ${lastStatus})`);
}

async function letMemberDraft(page: Page, actor: string, principalId: string) {
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

async function visibleThreadTitles(page: Page): Promise<string[]> {
  return page.getByRole('feed', { name: 'Discussions' }).getByRole('heading', { level: 3 }).allTextContents();
}

async function chooseSort(page: Page, current: 'Best' | 'New' | 'Top', next: 'Best' | 'New' | 'Top') {
  const trigger = page.getByRole('button', { name: `Sort: ${current}`, exact: true });
  await waitForReactHandler(trigger);
  await trigger.click();
  const choice = page.getByRole('menuitemradio', { name: new RegExp(`^${next}\\b`) });
  await waitForReactHandler(choice);
  await choice.click();
  await expect(page.getByRole('button', { name: `Sort: ${next}`, exact: true })).toBeVisible();
}

async function waitForReactHandler(control: Locator) {
  await expect.poll(() => control.evaluate(element => Object.keys(element)
    .some(key => key.startsWith('__reactProps$'))), { timeout: 15_000 }).toBe(true);
}

test('a manager creates a role, assigns it to a member, and sees the public team after reload', async ({ page, browser }, info) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const manager = await managerSession(page);
  const realm = await createRealm(manager.api, manager.actor, manager.principalId, `Role Circle ${randomUUID().slice(0, 8)}`);
  await grantRealmManager(realm.realm, manager.actor, manager.principalId);
  const member = await participantFor(browser, info);
  await joinRealm(member.page, realm.realm);
  const roleName = `Conversation guides ${randomUUID().slice(0, 6)}`;
  await grant(`realm:profile:${realm.realm}`, 'realm.profile.publish', manager.principalId, manager.actor);
  await grant(`realm:moderator-choice:${idOf(realm.realm)}:${idOf(member.actor)}`,
    'realm.moderator.choose', member.principalId, member.actor);
  await choosePublicModerator(member, realm.realm, info);
  await manager.api.write(`/realms/${idOf(realm.realm)}/profile`, {
    profile: 'realm-public-profile-v2', expectedHead: null, actingSubject: manager.actor,
    publication: {
      name: { original: 'en', labels: { en: realm.name, 'zh-Hans': realm.name, 'zh-Hant': realm.name, ja: realm.name } },
      description: { original: 'en', labels: { en: 'A circle for conversation.', 'zh-Hans': '交流读者的社区。',
        'zh-Hant': '交流讀者的社群。', ja: '読者の会話の場です。' } },
      iconSelection: null, bannerSelection: null, rules: [], count: { kind: 'unknown', value: null },
      moderators: [member.actor],
    },
  }, 'PUT');

  await page.goto(localizedPath(manageHref(realm.id, 'roles'), 'en'));
  await expect(page.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();
  const newRole = page.getByRole('button', { name: 'New role', exact: true });
  await waitForReactHandler(newRole);
  await newRole.click();
  const roleDialog = page.getByRole('dialog');
  await expect(roleDialog.getByRole('heading', { name: 'New role', exact: true })).toBeVisible();
  await roleDialog.getByRole('textbox', { name: 'Role name' }).fill(roleName);
  await roleDialog.getByRole('checkbox', { name: 'Moderate the queue' }).click();
  await roleDialog.getByRole('textbox', { name: 'Reason' }).fill('Share moderation with a trusted member.');
  await roleDialog.getByRole('button', { name: 'Create role', exact: true }).click();
  await expect(page.getByRole('heading', { name: roleName, exact: true })).toBeVisible();

  await page.goto(localizedPath(manageHref(realm.id, 'members'), 'en'));
  const memberSearch = page.getByRole('search', { name: 'Search members' });
  await memberSearch.getByRole('searchbox').fill(member.publicName);
  await memberSearch.getByRole('button', { name: 'Search', exact: true }).click();
  const members = page.getByRole('list', { name: 'Members' });
  const row = members.getByRole('listitem').filter({ hasText: member.publicName });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `Actions for ${member.publicName}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Give a role…', exact: true }).click();
  const assignDialog = page.getByRole('dialog');
  await expect(assignDialog.getByRole('heading', { name: `Give ${member.publicName} a role`, exact: true })).toBeVisible();
  await assignDialog.getByRole('combobox', { name: 'Role' }).click();
  await page.getByRole('option', { name: roleName, exact: true }).click();
  await assignDialog.getByRole('textbox', { name: 'Reason' }).fill('Assign the new moderation role.');
  await assignDialog.getByRole('button', { name: 'Give role', exact: true }).click();
  await expect(row.getByText(roleName, { exact: true })).toBeVisible();

  await page.reload();
  await memberSearch.getByRole('searchbox').fill(member.publicName);
  await memberSearch.getByRole('button', { name: 'Search', exact: true }).click();
  const afterReload = page.getByRole('list', { name: 'Members' }).getByRole('listitem').filter({ hasText: member.publicName });
  await expect(afterReload.getByText(roleName, { exact: true })).toBeVisible();

  await member.page.reload();
  await member.page.goto(communityHref('en', realm.realm, 'about'));
  const team = member.page.getByRole('region', { name: 'Moderators' });
  await expect(team.getByRole('link', { name: member.publicName, exact: true })).toBeVisible();
});

// Epoch-wide admission refuses the newly posted thread read with realm_replies_are_projecting.
test.fixme('a member opens a thread and nested replies that another person sees after reload', async ({ page, browser }, info) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const manager = await managerSession(page);
  const realm = await createRealm(manager.api, manager.actor, manager.principalId, `Thread Circle ${randomUUID().slice(0, 8)}`);
  const work = await createPublicWork(manager.api, manager.actor, manager.principalId, `Conversation Work ${randomUUID().slice(0, 8)}`);
  await waitForWorkTypeahead(manager.api, work);
  const writer = await participantFor(browser, info);
  await grant(`work:read:${work.work}`, 'work.read', writer.principalId, writer.actor);
  await grant(`reply:create:${work.work}`, 'reply.create', writer.principalId, writer.actor);
  await grant(`reply:place:${realm.realm}`, 'reply.place', writer.principalId, writer.actor);
  await letMemberDraft(writer.page, writer.actor, writer.principalId);
  await joinRealm(writer.page, realm.realm);
  await writer.page.goto(communityHref('en', realm.realm, 'discussions'));
  await writer.page.getByRole('link', { name: 'Create post', exact: true }).click();
  const workSearch = writer.page.getByRole('searchbox', { name: 'Search for a Work' });
  await waitForReactHandler(workSearch);
  await workSearch.fill(work.title);
  await expect(workSearch).toHaveValue(work.title);
  const workChoice = writer.page.getByRole('button', { name: work.title, exact: true });
  await expect(workChoice).toBeVisible();
  await workChoice.click();
  const title = `First conversation ${randomUUID().slice(0, 6)}`;
  const body = 'A member starts this discussion from the Realm.';
  await writer.page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  await writer.page.getByRole('textbox', { name: 'Your post', exact: true }).fill(body);
  await writer.page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(writer.page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible({ timeout: 60_000 });
  const threadUrl = writer.page.url();

  const firstReply = `A reader replies ${randomUUID().slice(0, 6)}.`;
  await writer.page.getByRole('textbox', { name: 'Add a comment' }).fill(firstReply);
  await writer.page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(writer.page.getByText(firstReply, { exact: true })).toBeVisible();
  const firstArticle = writer.page.getByRole('article').filter({ hasText: firstReply });
  await firstArticle.getByRole('button', { name: 'Reply', exact: true }).click();
  const nested = `A nested reply ${randomUUID().slice(0, 6)}.`;
  const nestedBox = firstArticle.getByRole('textbox', { name: `Reply to ${writer.publicName}`, exact: true });
  await nestedBox.fill(nested);
  await firstArticle.getByRole('button', { name: 'Reply', exact: true }).last().click();
  await expect(writer.page.getByText(nested, { exact: true })).toBeVisible();

  await page.goto(threadUrl);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  await expect(page.getByText(body, { exact: true })).toBeVisible();
  await expect(page.getByText(firstReply, { exact: true })).toBeVisible();
  await expect(page.getByText(nested, { exact: true })).toBeVisible();
});

// Epoch-wide admission refuses New with RealmRankingsIncomplete after a vote and leaves Best selected.
test.fixme('Best, Top and New reorder every Realm discussion after a reader votes', async ({ page, browser }, info) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const manager = await managerSession(page);
  const realm = await createRealm(manager.api, manager.actor, manager.principalId, `Ranking Circle ${randomUUID().slice(0, 8)}`);
  const work = await createPublicWork(manager.api, manager.actor, manager.principalId, `Ranking Work ${randomUUID().slice(0, 8)}`);
  const titles = {
    oldest: `Earlier post ${randomUUID().slice(0, 6)}`,
    voted: `Popular post ${randomUUID().slice(0, 6)}`,
    newest: `Latest post ${randomUUID().slice(0, 6)}`,
  };
  await seedThread(manager.api, realm.realm, work, manager.actor, manager.principalId, titles.oldest, 'An older API-seeded thread.');
  await new Promise(resolve => setTimeout(resolve, 120));
  await seedThread(manager.api, realm.realm, work, manager.actor, manager.principalId, titles.voted, 'This thread will receive a vote.');
  await new Promise(resolve => setTimeout(resolve, 120));
  await seedThread(manager.api, realm.realm, work, manager.actor, manager.principalId, titles.newest, 'A newer API-seeded thread.');
  await waitForThreads(manager.api, realm.realm, manager.actor, Object.values(titles));

  const voter = await participantFor(browser, info);
  await grant(`work:read:${work.work}`, 'work.read', voter.principalId, voter.actor);
  await voter.page.goto(communityHref('en', realm.realm, 'discussions'));
  const feed = voter.page.getByRole('feed', { name: 'Discussions' });
  await expect(feed).toBeVisible();
  const votedCard = feed.getByRole('article').filter({ has: voter.page.getByRole('heading', { name: titles.voted, exact: true }) });
  const upvote = votedCard.getByRole('button', { name: 'Upvote', exact: true });
  await expect(upvote).toBeVisible();
  await waitForReactHandler(upvote);
  const savedVote = voter.page.waitForResponse(response =>
    new URL(response.url()).pathname.endsWith(`/feed/${idOf(realm.realm)}/vote`)
    || new URL(response.url()).pathname.match(/\/api\/main\/v1\/feed\/[0-9a-f-]{36}\/vote$/) !== null);
  await upvote.click();
  await expect(upvote).toHaveAttribute('aria-pressed', 'true');
  expect((await savedVote).status()).toBe(200);
  await voter.page.reload();

  const best = [titles.voted, titles.newest, titles.oldest];
  const newerFirst = [titles.newest, titles.voted, titles.oldest];
  await expect.poll(() => visibleThreadTitles(voter.page)).toEqual(best);
  await chooseSort(voter.page, 'Best', 'New');
  await expect.poll(() => visibleThreadTitles(voter.page)).toEqual(newerFirst);
  await chooseSort(voter.page, 'New', 'Top');
  await expect.poll(() => visibleThreadTitles(voter.page)).toEqual(best);
  expect(await visibleThreadTitles(voter.page)).toEqual(best);
});
