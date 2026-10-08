import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { Pool } from 'pg';
import { localizedPath } from '../i18n/locale.ts';
import { signInAtAccounts } from './account-sign-in.ts';

// An editor who also stewards a Realm in another Space attaches it by handle.
// The steward's list shows that Zone; withdrawing it removes it from the editor.

const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 900 };

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

const uuidOf = (iri: string) => {
  const id = iri.slice(-36);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`expected a resource id, received ${iri}`);
  return id;
};

async function fits(page: Page, label: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), label).toBe(true);
}

async function shoot(page: Page, name: string, info: TestInfo) {
  for (const [label, viewport] of [['390', phone], ['1280', desktop]] as const) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await fits(page, `${name} at ${label}px`);
    const path = info.outputPath(`${name}-${label}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`[zone-realm-attachment] ${label}px ${name}: ${path}`);
  }
}

async function createSpace(page: Page, data: Record<string, unknown>, ready: (body: { space?: string; zone?: string; realm?: string }) => boolean) {
  const key = randomUUID();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await page.request.post('/api/main/v1/spaces', { headers: { 'idempotency-key': key }, data });
    const body = await response.json() as { space?: string; zone?: string; realm?: string };
    if ((response.status() === 200 || response.status() === 201) && ready(body)) return body;
    if (response.status() !== 202) throw new Error(`Space create failed (${response.status()}): ${JSON.stringify(body).slice(0, 400)}`);
    await page.waitForTimeout(500);
  }
  throw new Error('Space was not created');
}

test.use({ actionTimeout: 15_000 });

test('an editor attaches a Realm they steward, sees it on the steward list, and a withdrawal removes it', async ({ page }, info) => {
  test.setTimeout(600_000);
  const { member, principalId, actingSubject } = fixture<{
    member: { email: string; password: string }; principalId: string; actingSubject: string;
  }>('REZICS_WEB_AUTH_PRIVATE_PATH');
  await signInAtAccounts(page, '/en/manage', member);
  await page.setViewportSize(desktop);
  await grant('space:create:root', 'space.create', principalId, actingSubject);

  const zoneName = 'Harbor annex';
  const realmName = 'North realm';
  const handle = `north${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const zoneSpace = await createSpace(page, {
    profile: 'space-zone-v1', name: zoneName, language: 'en', capabilities: ['zone'],
    visibility: 'public', listing: 'listed', actingSubject,
  }, body => !!body.space && !!body.zone);
  await grant(`zone:edit:${zoneSpace.zone}`, 'zone.edit', principalId, actingSubject);
  const realmSpace = await createSpace(page, {
    profile: 'space-realm-v2', name: realmName, language: 'en', capabilities: ['realm'], handle, actingSubject,
  }, body => !!body.space && !!body.realm);
  await grant(`governance:realm:${realmSpace.realm}`, 'realm.owner', principalId, actingSubject);

  const editor = localizedPath(`/manage/z/${uuidOf(zoneSpace.space!)}/realm`, 'en');
  const zones = localizedPath(`/manage/r/${uuidOf(realmSpace.realm!)}/zones`, 'en');

  await page.setViewportSize(phone);
  await expect(async () => {
    await page.goto(editor);
    await expect(page.getByRole('heading', { level: 2, name: 'Realm' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('No Realm is attached.')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
  await page.getByRole('textbox', { name: 'Realm handle' }).fill(handle);
  await page.getByRole('button', { name: 'Attach' }).click();
  await expect(page.getByText('Attached. This Zone shows that Realm.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(realmName).or(page.getByText(handle))).toBeVisible();
  await shoot(page, 'zone-realm-attached', info);

  await page.setViewportSize(phone);
  await expect(async () => {
    await page.goto(zones);
    await expect(page.getByRole('heading', { name: 'Attached Zones' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(zoneName)).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Withdraw' })).toHaveAttribute('data-hydrated', 'true', { timeout: 30_000 });
  await shoot(page, 'realm-zone-list', info);

  await page.setViewportSize(phone);
  await page.getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.getByText('Withdrawn. That Zone no longer shows this Realm.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(zoneName)).toHaveCount(0);
  await fits(page, 'withdrawn at 390px');
  await page.setViewportSize(desktop);
  await fits(page, 'withdrawn at 1280px');

  await page.setViewportSize(desktop);
  await page.goto(editor);
  await expect(page.getByText('No Realm is attached.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('This Zone shows this Realm.')).toHaveCount(0);
  await shoot(page, 'zone-realm-removed', info);
});
