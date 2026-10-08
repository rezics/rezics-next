import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Browser, type Page, test, type TestInfo } from '@playwright/test';
import { Pool } from 'pg';
import { spaceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { grantPlatformUse, platformAdministratorSession } from '../../../tests/qa/fixtures/platform-grant.ts';
import { signInAtAccounts } from './account-sign-in.ts';

// A moderator bans a member. The member sees the ban and the reason, appeals
// once, and later sees the resolution. Someone who is not banned sees nothing.

const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 900 };
const reason = 'Posted the same chapter five times.';
const statement = 'I posted it once, from a bad connection.';
const rationale = 'The repeated posts broke the discussion rules.';

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

async function principalFor(actor: string): Promise<string> {
  const url = process.env.ACCESS_DATABASE_URL;
  if (!url) throw new Error('ACCESS_DATABASE_URL must name the isolated QA access database');
  const pool = new Pool({ connectionString: url });
  try {
    const row = await pool.query<{ principal_id: string }>(`SELECT principal_id FROM access.representation
      WHERE subject_id = $1 AND action = 'agent.control' AND active AND valid_until > now() LIMIT 1`, [actor]);
    const id = row.rows[0]?.principal_id;
    if (!id) throw new Error('the member has no principal');
    return id;
  } finally {
    await pool.end();
  }
}

async function realmGeneration(realm: string): Promise<string> {
  const url = process.env.ACCESS_DATABASE_URL;
  if (!url) throw new Error('ACCESS_DATABASE_URL must name the isolated QA access database');
  const pool = new Pool({ connectionString: url });
  try {
    const row = await pool.query<{ generation: string }>(
      `SELECT generation::text FROM access.realm_admin_revision WHERE realm = $1`, [realm]);
    return row.rows[0]?.generation ?? '0';
  } finally {
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

/** A second person, with an Agent the moderator can ban. */
async function enrollMember(browser: Browser, info: TestInfo): Promise<{
  page: Page; email: string; actingSubject: string; principalId: string; close: () => Promise<void>;
}> {
  const suffix = randomBytes(4).toString('hex');
  const person = {
    email: `realm-appeal-${suffix}@example.test`,
    password: `pass phrase ${suffix}`,
    publicName: `Appeal Reader ${suffix}`,
    handle: `appeal_${suffix}`,
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
  return {
    page, email: person.email, actingSubject, principalId: await principalFor(actingSubject),
    close: () => context.close(),
  };
}

async function shoot(page: Page, name: string, info: TestInfo) {
  const paths: string[] = [];
  for (const [label, viewport] of [['390', phone], ['1280', desktop]] as const) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.getByRole('region', { name: 'Your ban' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} at ${label}px`).toBe(true);
    const path = info.outputPath(`${name}-${label}.png`);
    await page.screenshot({ path, fullPage: true });
    paths.push(path);
    console.log(`[realm-appeal] ${label}px ${name}: ${path}`);
  }
  await page.setViewportSize(desktop);
  return paths;
}

test('a banned member sees the reason, appeals once, and sees the resolution', async ({ page, browser }, info) => {
  test.setTimeout(600_000);
  const { member, principalId, actingSubject } = fixture<{
    member: { email: string; password: string }; principalId: string; actingSubject: string;
  }>('REZICS_WEB_AUTH_PRIVATE_PATH');
  const administrator = await platformAdministratorSession();
  await grantPlatformUse(administrator, principalId, 'realm-appeals');
  await signInAtAccounts(page, '/en/r/new', member);
  await grant('space:create:root', 'space.create', principalId, actingSubject);

  const suffix = randomBytes(3).toString('hex');
  const community = `Appeal Harbor ${suffix}`;
  const createKey = randomUUID();
  let realm = '';
  for (let attempt = 0; attempt < 8 && !realm; attempt += 1) {
    const created = await page.request.post('/api/main/v1/spaces', {
      headers: { 'idempotency-key': createKey },
      data: { profile: 'space-realm-v1', name: community, capabilities: ['realm'], actingSubject },
    });
    const createdBody = await created.text();
    if (created.status() === 200 || created.status() === 201) {
      realm = (JSON.parse(createdBody) as { realm?: string }).realm ?? '';
      break;
    }
    if (created.status() !== 202) throw new Error(`Realm create failed (${created.status()}): ${createdBody.slice(0, 400)}`);
    await page.waitForTimeout(500);
  }
  expect(realm).toMatch(/^https:\/\/rezics\.com\/id\//);
  const realmId = realm.slice(-36);
  await grant(`governance:realm:${realm}`, 'realm.members.manage', principalId, actingSubject);
  await grant(`governance:realm:${realm}`, 'governance.moderate', principalId, actingSubject);

  const banned = await enrollMember(browser, info);
  try {
    await grantPlatformUse(administrator, banned.principalId, 'realm-appeals');
    const ban = await page.request.post(`/api/main/v1/realms/${realmId}/members`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        actingSubject, member: banned.actingSubject, expectedGeneration: await realmGeneration(realm),
        expectedMembershipGeneration: '0', reason, action: 'ban', consent: null, durationSeconds: null,
      },
    });
    const banBody = await ban.text();
    expect(ban.status(), banBody).toBe(201);
    const receiptId = (JSON.parse(banBody) as { receiptId: string }).receiptId;
    const home = localizedPath(spaceHref(realmId, 'community'), 'en');

    await banned.page.goto(home);
    await expect(banned.page.getByRole('heading', { level: 1, name: community })).toBeVisible();
    const notice = banned.page.getByRole('region', { name: 'Your ban' });
    await expect(notice.getByRole('heading', { name: 'You are banned from this community' })).toBeVisible();
    await expect(notice.getByText('This ban does not end.')).toBeVisible();
    await expect(notice.getByText(reason)).toBeVisible();
    await expect(notice.getByText(/Banned on/)).toBeVisible();
    const memberHtml = await banned.page.content();
    expect(memberHtml).not.toContain(actingSubject);
    expect(memberHtml).not.toContain(member.email);
    await shoot(banned.page, 'banned', info);

    await notice.getByRole('textbox', { name: 'Your statement' }).fill(statement);
    await notice.getByRole('button', { name: 'Send appeal' }).click();
    await expect(notice.getByRole('heading', { name: 'Appeal received' })).toBeVisible();
    await expect(notice.getByText(statement)).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Send appeal' })).toHaveCount(0);
    await shoot(banned.page, 'received', info);

    const appeal = await page.request.get(`/api/main/v1/realms/${realmId}/member-receipts/${receiptId}/appeal`);
    expect(appeal.status()).toBe(200);
    const caseId = (await appeal.json() as { appeal: { caseId: string } }).appeal.caseId;
    const decisionKey = randomUUID();
    const decision = await page.request.post('/api/main/v1/moderation/decisions', {
      headers: { 'idempotency-key': decisionKey },
      data: {
        profile: 'moderation-decision-v1', outcome: 'dismiss', caseId, expectedGeneration: '0',
        actingSubject, targets: [], rule: { ref: 'urn:rule:unused', revision: '1', digest: 'a'.repeat(64) },
        evidenceDigest: 'b'.repeat(64), reversesDecisionId: null, answersStepId: null,
        rationale, disclosure: 'parties', idempotencyKey: decisionKey,
        reasons: { facts: 'The statement was read.', scope: 'Realm membership', duration: 'The ban is unchanged.',
          automation: false, appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en' },
      },
    });
    expect(decision.status(), await decision.text()).toBe(200);

    await banned.page.reload();
    const resolved = banned.page.getByRole('region', { name: 'Your ban' });
    await expect(resolved.getByRole('heading', { name: /Moderators upheld the ban/ })).toBeVisible();
    await expect(resolved.getByText(rationale)).toBeVisible();
    await expect(resolved.getByRole('button', { name: 'Send appeal' })).toHaveCount(0);
    expect(await banned.page.content()).not.toContain(actingSubject);
    await shoot(banned.page, 'upheld', info);

    await page.goto(home);
    await expect(page.getByRole('heading', { level: 1, name: community })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Your ban' })).toHaveCount(0);

    const guest = await browser.newContext({ baseURL: info.project.use.baseURL });
    try {
      const quiet = await guest.newPage();
      await quiet.goto(home);
      await expect(quiet.getByRole('heading', { level: 1, name: community })).toBeVisible();
      await expect(quiet.getByRole('region', { name: 'Your ban' })).toHaveCount(0);
    } finally {
      await guest.close();
    }
  } finally {
    await banned.close();
  }
});
