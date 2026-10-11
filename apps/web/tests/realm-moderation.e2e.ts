import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, type Browser, type Page, test, type TestInfo } from '@playwright/test';
import { Pool } from 'pg';
import { spaceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { signInAtAccounts } from './account-sign-in.ts';

const reason = 'Repeated posts disrupted the community discussion.';
const liftedReason = 'The member can take part again.';

interface ModeratorFixture {
  member: { email: string; password: string };
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

async function verificationLink(email: string): Promise<string> {
  const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
  let link = '';
  await expect.poll(async () => {
    const response = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages } = await response.json() as { messages: { ID: string; Subject: string }[] };
    const newest = messages.find(item => item.Subject === 'Verify your email address');
    if (!newest) return false;
    const { Text } = await (await fetch(`${mailpit}/api/v1/message/${newest.ID}`)).json() as { Text: string };
    link = /https?:\/\/\S+/.exec(Text)?.[0] ?? '';
    return Boolean(link);
  }, { timeout: 30_000 }).toBe(true);
  return link;
}

const interactive = (page: Page) => page.locator('button[aria-label="Account menu"][data-hydrated="true"]')
  .first().waitFor({ timeout: 30_000 });

async function enrollMember(browser: Browser, info: TestInfo): Promise<{
  page: Page; email: string; publicName: string; actingSubject: string; close: () => Promise<void>;
}> {
  const suffix = randomBytes(4).toString('hex');
  const person = {
    email: `realm-moderation-${suffix}@example.test`,
    password: `pass phrase ${suffix}`,
    publicName: `Moderation Reader ${suffix}`,
    handle: `mod_reader_${suffix}`,
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
  const verify = new URL(await verificationLink(person.email));
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
  const session = await page.request.get('/api/main/v1/me/session-agent', {
    headers: { 'x-session-key': sessionKey! },
  });
  expect(session.status()).toBe(200);
  const state = await session.json() as { sessionAgent: { actingSubject?: string; eligible?: boolean } };
  expect(state.sessionAgent.eligible).toBe(true);
  const actingSubject = state.sessionAgent.actingSubject ?? '';
  expect(actingSubject).toMatch(/^https:\/\/rezics\.com\/id\//);
  return { page, email: person.email, publicName: person.publicName, actingSubject, close: () => context.close() };
}

function seedPostableWork(title: string): void {
  const result = spawnSync('bun', ['apps/web/tests/library-import-seed.ts', JSON.stringify([[title, 'Moderation Test Author']])], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 120_000,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`Post work seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  const seeded = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { works?: string[] };
  const work = seeded.works?.[0];
  if (!work) throw new Error('The public API seed did not return a postable Work');
}

test('a moderator bans a member through Manage and restores their posting access', async ({ page, browser }, info) => {
  test.setTimeout(600_000);
  const suffix = randomBytes(4).toString('hex');
  const community = `Moderation Harbor ${suffix}`;
  const workTitle = `Moderation Topic ${suffix}`;
  seedPostableWork(workTitle);
  const moderator = fixture<ModeratorFixture>('REZICS_WEB_AUTH_PRIVATE_PATH');
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

  const member = await enrollMember(browser, info);
  try {
    const home = localizedPath(spaceHref(realmId, 'community'), 'en');
    await member.page.goto(home);
    await expect(member.page.getByRole('heading', { level: 1, name: community })).toBeVisible();
    await member.page.getByRole('button', { name: 'Join', exact: true }).click();
    const joining = member.page.getByRole('dialog', { name: `Join ${community}` });
    await joining.getByRole('checkbox', { name: 'Show me on the public member list' }).check();
    await joining.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(member.page.getByRole('button', { name: 'Joined', exact: true })).toBeVisible({ timeout: 30_000 });

    await page.goto('/en/manage');
    const realmCard = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: community, exact: true }) });
    await expect(realmCard).toBeVisible({ timeout: 30_000 });
    await realmCard.getByRole('link').click();
    await page.getByRole('link', { name: 'Members', exact: true }).click();
    const search = page.getByRole('search', { name: 'Search members' });
    await search.getByRole('textbox').fill(member.publicName);
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

    await member.page.goto(home);
    const notice = member.page.getByRole('region', { name: 'Your ban' });
    await expect(notice.getByRole('heading', { name: 'You are banned from this community' })).toBeVisible();
    await expect(notice.getByText(reason, { exact: true })).toBeVisible();
    await expect(notice.getByText(/This ban ends on/)).toBeVisible();

    const submit = localizedPath(spaceHref(realmId, 'community', ['submit']), 'en');
    const postTitle = `A member’s first moderation-safe post ${suffix}`;
    await member.page.goto(submit);
    const workSearch = member.page.getByRole('searchbox', { name: 'Search for a Work' });
    await workSearch.fill(workTitle);
    const workOption = member.page.getByRole('button', { name: workTitle, exact: true });
    await expect(workOption).toBeVisible({ timeout: 60_000 });
    await workOption.click();
    await member.page.getByRole('textbox', { name: 'Title' }).fill(postTitle);
    await member.page.getByRole('textbox', { name: 'Your post' }).fill('A post made while the sanction is active.');
    const post = member.page.getByRole('button', { name: 'Post', exact: true });
    await expect(post).toBeEnabled({ timeout: 30_000 });
    await post.click();
    await expect(member.page.getByRole('alert')).toContainText('did not accept the post', { timeout: 60_000 });

    await row.getByRole('button', { name: `Actions for ${member.publicName}` }).click();
    await page.getByRole('menuitem', { name: 'Unban…' }).click();
    const unbanning = page.getByRole('dialog', { name: `Unban ${member.publicName}?` });
    await unbanning.getByRole('textbox', { name: 'Reason' }).fill(liftedReason);
    await unbanning.getByRole('button', { name: 'Unban', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: `${member.publicName} is unbanned.` })).toBeVisible();
    await expect(row).not.toContainText('Banned until');

    await member.page.reload();
    await interactive(member.page);
    await expect(member.page.getByRole('button', { name: 'Post', exact: true })).toBeEnabled({ timeout: 30_000 });
    await member.page.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(member.page).toHaveURL(/\/discussions\//, { timeout: 60_000 });
    await expect(member.page.getByRole('heading', { name: postTitle, exact: true })).toBeVisible({ timeout: 60_000 });
  } finally {
    await member.close();
  }
});
