import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, type Browser, type Page, test, type TestInfo } from '@playwright/test';
import { Pool } from 'pg';
import { spaceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { grantPlatformUse, platformAdministratorSession } from '../../../tests/qa/fixtures/platform-grant.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import { newPostProgress, type PostProgress } from '../features/post-composer/api.ts';

const reason = 'Repeated posts disrupted the community discussion.';
const liftedReason = 'The member can take part again.';

interface ModeratorFixture {
  member: { email: string; password: string };
  operator: { email: string; password: string };
  principalId: string;
  actingSubject: string;
}

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

async function grant(scope: string, action: string, principalId: string, actingSubject: string) {
  const url = process.env.ACCESS_DATABASE_URL;
  if (!url) throw new Error('ACCESS_DATABASE_URL must name the isolated QA access database');
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    const gate = await client.query<{ open: boolean; dispatch_open: boolean }>(
      'SELECT open, dispatch_open FROM access.scope_gate WHERE id = $1', [scope]);
    if (gate.rows[0]?.open !== true || gate.rows[0]?.dispatch_open !== true) throw new Error(`${scope} is closed`);
    await client.query(
      "INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent') ON CONFLICT DO NOTHING", [actingSubject]);
    const represented = await client.query(`SELECT id FROM access.representation
      WHERE principal_id = $1 AND subject_id = $2 AND action = $3 AND active AND valid_until > now()`,
    [principalId, actingSubject, action]);
    if (!represented.rowCount) await client.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, $4, now() + interval '8 hours')`, [randomUUID(), principalId, actingSubject, action]);
    const allowed = await client.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active AND valid_until > now()`,
    [actingSubject, scope, action]);
    if (!allowed.rowCount) await client.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, $4, now() + interval '8 hours')`, [randomUUID(), actingSubject, scope, action]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function principalFor(actingSubject: string): Promise<string> {
  const url = process.env.ACCESS_DATABASE_URL;
  if (!url) throw new Error('ACCESS_DATABASE_URL must name the isolated QA access database');
  const pool = new Pool({ connectionString: url });
  try {
    const row = await pool.query<{ principal_id: string }>(`SELECT principal_id FROM access.representation
      WHERE subject_id = $1 AND action = 'agent.control' AND active AND valid_until > now() LIMIT 1`, [actingSubject]);
    const principalId = row.rows[0]?.principal_id;
    if (!principalId) throw new Error('The member has no principal');
    return principalId;
  } finally {
    await pool.end();
  }
}

const interactive = (page: Page) => page.locator('button[aria-label="Account menu"][data-hydrated="true"]')
  .first().waitFor({ timeout: 30_000 });

async function enrollMember(browser: Browser, info: TestInfo, credentials: ModeratorFixture['operator'], suffix: string): Promise<{
  page: Page; email: string; publicName: string; actingSubject: string; principalId: string; close: () => Promise<void>;
}> {
  const publicName = `Moderation Reader ${suffix}`;
  const context = await browser.newContext({ baseURL: info.project.use.baseURL });
  const page = await context.newPage();
  await signInAtAccounts(page, '/en', credentials, true);
  const key = (await context.cookies()).find(cookie => cookie.name === 'rezics_session_key')?.value;
  expect(key).toBeTruthy();
  await expect(page).toHaveURL(/\/en\/onboarding(?:\?|$)/);
  const created = await page.request.post('/api/main/v1/me/onboarding', {
    headers: { 'x-session-key': key!, 'idempotency-key': randomUUID() },
    data: { profile: 'person-onboarding-v1', displayName: publicName },
  });
  const createdText = await created.text();
  expect([200, 201], createdText).toContain(created.status());
  const person = JSON.parse(createdText) as { agent: string };
  expect(person.agent).toMatch(/^https:\/\/rezics\.com\/id\//);
  const session = await page.request.get('/api/main/v1/me/session-agent', { headers: { 'x-session-key': key! } });
  expect(session.status()).toBe(200);
  const state = await session.json() as { sessionAgent: { actingSubject?: string | null; eligible?: boolean; revision?: string | null } };
  const selected = await page.request.post('/identity/select', {
    maxRedirects: 0,
    form: { agent: person.agent, next: '/en', locale: 'en', sessionRevision: state.sessionAgent.revision ?? '' },
  });
  expect(selected.status(), await selected.text()).toBe(303);
  await page.goto('/en');
  const selectedState = await page.request.get('/api/main/v1/me/session-agent', { headers: { 'x-session-key': key! } });
  expect(selectedState.status()).toBe(200);
  const selectedAgent = (await selectedState.json() as { sessionAgent: { actingSubject?: string | null; eligible?: boolean } }).sessionAgent;
  expect(selectedAgent.eligible).toBe(true);
  const actingSubject = selectedAgent.actingSubject ?? '';
  expect(actingSubject).toMatch(/^https:\/\/rezics\.com\/id\//);
  expect(actingSubject).toBe(person.agent);
  return { page, email: credentials.email, publicName, actingSubject,
    principalId: await principalFor(actingSubject), close: () => context.close() };
}

async function prepareComposerProgress(page: Page, actingSubject: string, progress: PostProgress): Promise<void> {
  const key = `rezics:post-draft:${actingSubject}`;
  await page.evaluate(({ draftKey, nextProgress }) => {
    const saved = localStorage.getItem(draftKey);
    if (!saved) throw new Error('The composer draft is not saved');
    const draft = JSON.parse(saved) as { progress?: unknown };
    draft.progress = nextProgress;
    localStorage.setItem(draftKey, JSON.stringify(draft));
  }, { draftKey: key, nextProgress: progress });
  await page.reload();
  await interactive(page);
}

function seedPostableWork(title: string): string {
  const result = spawnSync('bun', ['apps/web/tests/library-import-seed.ts', JSON.stringify([[title, 'Moderation Test Author']])], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 120_000,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`Post work seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  const seeded = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { works?: string[] };
  const work = seeded.works?.[0];
  if (!work) throw new Error('The public API seed did not return a postable Work');
  return work;
}

test('a moderator bans a member through Manage and restores their posting access', async ({ page, browser }, info) => {
  test.setTimeout(600_000);
  const suffix = randomBytes(4).toString('hex');
  const community = `Moderation Harbor ${suffix}`;
  const workTitle = `Moderation Topic ${suffix}`;
  const work = seedPostableWork(workTitle);
  const moderator = fixture<ModeratorFixture>('REZICS_WEB_AUTH_PRIVATE_PATH');
  const administrator = await platformAdministratorSession();
  await grantPlatformUse(administrator, moderator.principalId, 'realm-appeals');
  await signInAtAccounts(page, '/en/manage', moderator.member);
  await grant('space:create:root', 'space.create', moderator.principalId, moderator.actingSubject);

  const createKey = randomUUID();
  let realm = '';
  for (let attempt = 0; attempt < 8 && !realm; attempt += 1) {
    const created = await page.request.post('/api/main/v1/spaces', {
      headers: { 'idempotency-key': createKey },
      data: { profile: 'space-realm-v1', name: community, capabilities: ['realm'], actingSubject: moderator.actingSubject,
        initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open', whoMaySubmit: 'members',
          selfJoin: true, rules: [] } },
    });
    const body = await created.text();
    if (created.status() === 200 || created.status() === 201) {
      realm = (JSON.parse(body) as { realm?: string }).realm ?? '';
      break;
    }
    if (created.status() !== 202) throw new Error(`Realm create failed (${created.status()}): ${body.slice(0, 400)}`);
    await page.waitForTimeout(500);
  }
  expect(realm).toMatch(/^https:\/\/rezics\.com\/id\//);
  const realmId = realm.slice(-36);
  await grant(`governance:realm:${realm}`, 'realm.members.manage', moderator.principalId, moderator.actingSubject);
  await grant(`governance:realm:${realm}`, 'governance.moderate', moderator.principalId, moderator.actingSubject);

  const member = await enrollMember(browser, info, moderator.operator, suffix);
  const composerResponses: string[] = [];
  member.page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (!/^\/api\/main\/v1\/(main-versions|member-reply-drafts|realm-replies|member-replies|realm-reply-placements)/.test(path)) return;
    void response.text().then(body => composerResponses.push(`${response.status()} ${path}: ${body.slice(0, 500)}`))
      .catch(error => composerResponses.push(`${response.status()} ${path}: ${String(error)}`));
  });
  await grantPlatformUse(administrator, member.principalId, 'realm-appeals');
  await grant(`work:read:${work}`, 'work.read', member.principalId, member.actingSubject);
  await grant(`reply:create:${work}`, 'reply.create', member.principalId, member.actingSubject);
  await grant(`reply:place:${realm}`, 'reply.place', member.principalId, member.actingSubject);
  const bannedPostProgress = newPostProgress();
  const restoredPostProgress = newPostProgress();
  await grant(`content:draft:${bannedPostProgress.reply}`, 'content.draft', member.principalId, member.actingSubject);
  await grant(`content:draft:${restoredPostProgress.reply}`, 'content.draft', member.principalId, member.actingSubject);
  try {
    const home = localizedPath(spaceHref(realmId, 'community'), 'en');
    await member.page.goto(home);
    await expect(member.page.getByRole('heading', { level: 1, name: community })).toBeVisible();
    await interactive(member.page);
    const joiningPolicy = await member.page.request.get(`/api/main/v1/realms/${realmId}/joining?actingSubject=${encodeURIComponent(member.actingSubject)}`);
    expect(joiningPolicy.status()).toBe(200);
    expect(await joiningPolicy.json()).toMatchObject({ open: true, selfJoin: true });
    const joinButton = member.page.getByRole('button', { name: /^Join\b/ }).first();
    await expect(joinButton).toBeVisible({ timeout: 30_000 });
    await joinButton.click();
    const joining = member.page.getByRole('dialog', { name: `Join ${community}` });
    await joining.getByRole('checkbox', { name: 'Show me on the public member list' }).check();
    await joining.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(member.page.getByRole('button', { name: /^Joined\b/ })).toBeVisible({ timeout: 30_000 });

    const submit = localizedPath(spaceHref(realmId, 'community', ['submit']), 'en');
    const postTitle = `A member’s first moderation-safe post ${suffix}`;
    await member.page.goto(submit);
    await interactive(member.page);
    await expect(member.page.getByText('This community has not published rules yet.', { exact: true }))
      .toBeVisible({ timeout: 30_000 });
    const workSearch = member.page.getByRole('searchbox', { name: 'Search for a Work' });
    await workSearch.fill(workTitle);
    await expect(workSearch).toHaveValue(workTitle);
    const workOption = member.page.getByRole('button', { name: workTitle, exact: true });
    await expect(workOption).toBeVisible({ timeout: 60_000 });
    await workOption.click();
    await member.page.getByRole('textbox', { name: 'Title' }).fill(postTitle);
    await member.page.getByRole('textbox', { name: 'Your post' }).fill('A post made while the sanction is active.');
    await prepareComposerProgress(member.page, member.actingSubject, bannedPostProgress);
    const post = member.page.getByRole('button', { name: 'Post', exact: true });
    await expect(post).toBeEnabled({ timeout: 30_000 });

    await page.goto('/en/manage');
    const realmCard = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: community, exact: true }) });
    await expect(realmCard).toBeVisible({ timeout: 30_000 });
    await realmCard.getByRole('link').click();
    await page.getByRole('link', { name: 'Members', exact: true }).click();
    const search = page.getByRole('search', { name: 'Search members' });
    await search.getByRole('searchbox', { name: 'Search members' }).fill(member.publicName);
    await search.getByRole('button', { name: 'Search', exact: true }).click();
    const row = page.getByRole('list', { name: 'Members' }).getByRole('listitem').filter({ hasText: member.publicName });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole('button', { name: `Actions for ${member.publicName}` }).click();
    await page.getByRole('menuitem', { name: 'Ban…' }).click();
    const banning = page.getByRole('dialog', { name: `Ban ${member.publicName}` });
    await banning.getByRole('combobox', { name: 'For how long' }).click();
    await page.getByRole('option', { name: '1 day', exact: true }).click();
    await banning.getByRole('textbox', { name: 'Reason' }).fill(reason);
    await banning.getByRole('button', { name: 'Ban', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: `${member.publicName} is banned.` })).toBeVisible();
    await expect(row).toContainText('Banned until');

    const noticePage = await member.page.context().newPage();
    await noticePage.goto(home);
    const notice = noticePage.getByRole('region', { name: 'Your ban' });
    await expect(notice.getByRole('heading', { name: 'You are banned from this community' })).toBeVisible();
    await expect(notice.getByText(reason, { exact: true })).toBeVisible();
    await expect(notice.getByText(/This ban ends on/)).toBeVisible();

    composerResponses.length = 0;
    const composerUrl = member.page.url();
    await post.click();
    const postAlert = member.page.getByRole('alert');
    await expect(postAlert).toBeVisible({ timeout: 60_000 });
    await expect(postAlert).toHaveText('You are banned from this community and cannot post. Your draft is still here.');
    const bannedScreenshot = info.outputPath('banned-composer.png');
    await member.page.screenshot({ path: bannedScreenshot, fullPage: true });
    await info.attach('banned-composer', { path: bannedScreenshot, contentType: 'image/png' });
    await expect.poll(() => composerResponses.some(response =>
      response.startsWith('403 /api/main/v1/member-reply-drafts:')), { timeout: 10_000 }).toBe(true);
    await expect(member.page).toHaveURL(composerUrl);

    await row.getByRole('button', { name: `Actions for ${member.publicName}` }).click();
    await page.getByRole('menuitem', { name: 'Unban…' }).click();
    const unbanning = page.getByRole('dialog', { name: `Unban ${member.publicName}?` });
    await unbanning.getByRole('textbox', { name: 'Reason' }).fill(liftedReason);
    await unbanning.getByRole('button', { name: 'Unban', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: `${member.publicName} is unbanned.` })).toBeVisible();
    await expect(row).not.toContainText('Banned until');

    await member.page.reload();
    await interactive(member.page);
    await prepareComposerProgress(member.page, member.actingSubject, restoredPostProgress);
    await expect(member.page.getByRole('button', { name: 'Post', exact: true })).toBeEnabled({ timeout: 30_000 });
    composerResponses.length = 0;
    await member.page.getByRole('button', { name: 'Post', exact: true }).click();
    try {
      await expect(member.page).toHaveURL(/\/discussions\//, { timeout: 60_000 });
    } catch (error) {
      await member.page.waitForTimeout(100);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nComposer API responses:\n${composerResponses.join('\n')}`);
    }
    await expect(member.page.getByRole('heading', { name: postTitle, exact: true })).toBeVisible({ timeout: 60_000 });
    const restoredScreenshot = info.outputPath('restored-post.png');
    await member.page.screenshot({ path: restoredScreenshot, fullPage: true });
    await info.attach('restored-post', { path: restoredScreenshot, contentType: 'image/png' });
  } finally {
    await member.close();
  }
});
