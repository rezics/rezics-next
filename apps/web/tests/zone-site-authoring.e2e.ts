import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { Pool } from 'pg';
import { signInAtAccounts } from './account-sign-in.ts';

// An author writes a Realm-less Zone's home page, previews the saved draft, and publishes it.
// A dropped publish response is retried with the same key. A second tab that saves against the
// moved head is told so and keeps its text. Anonymous readers see only the published revision.

const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 900 };
const morning = 'Morning edition of the harbor';
const evening = 'Evening edition of the harbor';
const otherNote = 'A note from the other tab';

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** The signed-in author needs these grants; the web fixture starts with work creation only. */
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

async function writeHome(page: Page, text: string) {
  const editor = page.getByRole('textbox', { name: 'Home page' });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  await expect(editor).toContainText(text);
}

async function shoot(page: Page, name: string, info: TestInfo) {
  for (const [label, viewport] of [['1280', desktop], ['390', phone]] as const) {
    await page.setViewportSize(viewport);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} at ${label}px`).toBe(true);
    const path = info.outputPath(`${name}-${label}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`[zone-site-authoring] ${label}px ${name}: ${path}`);
  }
  await page.setViewportSize(desktop);
}

test.use({ actionTimeout: 15_000 });

test('an author writes, previews and publishes a zone home page, and a second tab keeps a stale draft', async ({ page, context }, info) => {
  test.setTimeout(600_000);
  const { member, principalId, actingSubject } = fixture<{
    member: { email: string; password: string }; principalId: string; actingSubject: string;
  }>('REZICS_WEB_AUTH_PRIVATE_PATH');
  await signInAtAccounts(page, '/en/manage', member);
  await page.setViewportSize(desktop);
  await grant('space:create:root', 'space.create', principalId, actingSubject);

  const key = randomUUID();
  let space = '';
  let zone = '';
  for (let attempt = 0; attempt < 8 && !space; attempt += 1) {
    const response = await page.request.post('/api/main/v1/spaces', {
      headers: { 'idempotency-key': key },
      data: {
        profile: 'space-zone-v1', name: 'Harbor notes', language: 'en', capabilities: ['zone'],
        visibility: 'public', listing: 'listed', actingSubject,
      },
    });
    const body = await response.json() as { space?: string; zone?: string };
    if (response.status() === 200 || response.status() === 201) {
      space = body.space ?? '';
      zone = body.zone ?? '';
      break;
    }
    if (response.status() !== 202) throw new Error(`Zone create failed (${response.status()}): ${JSON.stringify(body).slice(0, 400)}`);
    await page.waitForTimeout(500);
  }
  expect(space, 'the Zone space was created').toMatch(/^https:\/\/rezics\.com\/id\//);
  const spaceId = uuidOf(space);
  await grant(`zone:edit:${zone}`, 'zone.edit', principalId, actingSubject);

  const editorPath = `/en/manage/z/${spaceId}`;
  await expect(async () => {
    await page.goto(editorPath);
    await expect(page.getByRole('heading', { level: 1, name: 'Harbor notes' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('textbox', { name: 'Home page' })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });

  await writeHome(page, morning);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await expect(page.getByText('Only you can see this draft.')).toBeVisible();
  const siteHref = await page.getByRole('link', { name: 'View site' }).getAttribute('href');
  const previewHref = await page.getByRole('link', { name: 'Preview', exact: true }).getAttribute('href');
  expect(siteHref).toMatch(/^\/en\/z\//);
  expect(previewHref).toMatch(/^\/en\/manage\/z\//);

  await page.getByRole('link', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Draft preview' })).toBeVisible();
  await expect(page.getByText(morning)).toBeVisible();
  await expect(page.getByText('Only people who can edit this Zone can open this preview.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to the editor' }).click();
  await expect(page.getByRole('textbox', { name: 'Home page' })).toContainText(morning);
  await shoot(page, 'zone-home-editor', info);

  const anonymous = await context.browser()!.newContext();
  const reader = await anonymous.newPage();
  try {
    await reader.setViewportSize(desktop);
    await reader.goto(siteHref!);
    await expect(reader.getByRole('heading', { level: 1, name: 'Harbor notes' })).toBeVisible();
    await expect(reader.locator('.rezics-document')).toHaveCount(0);
    await expect(reader.getByText(morning)).toHaveCount(0);
    await reader.goto(previewHref!);
    await expect(reader).toHaveURL(/\/sign-in/, { timeout: 60_000 });

    const publishKeys: string[] = [];
    let dropPublish = true;
    await page.route('**/v1/zones/*/site-publications', async (route) => {
      publishKeys.push(route.request().headers()['idempotency-key'] ?? '');
      if (dropPublish) {
        dropPublish = false;
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText(/^Published\./)).toBeVisible({ timeout: 30_000 });
    expect(publishKeys.slice(0, 2)).toEqual([publishKeys[0], publishKeys[0]]);
    expect(publishKeys[0]).toMatch(/^[A-Za-z0-9:_./-]{1,128}$/);

    await expect(async () => {
      await reader.goto(siteHref!);
      await expect(reader.locator('.rezics-document')).toHaveCount(1, { timeout: 5_000 });
      await expect(reader.locator('.rezics-document')).toContainText(morning);
    }).toPass({ timeout: 90_000 });
    await shoot(reader, 'zone-home-published', info);

    const second = await context.newPage();
    await second.setViewportSize(desktop);
    await second.goto(editorPath);
    await expect(second.getByRole('textbox', { name: 'Home page' })).toContainText(morning);
    await writeHome(page, evening);
    await expect(page.getByRole('textbox', { name: 'Home page' })).not.toContainText(morning);
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Draft saved.')).toBeVisible();
    await writeHome(second, otherNote);
    await expect(second.getByRole('textbox', { name: 'Home page' })).not.toContainText(morning);
    await second.getByRole('button', { name: 'Save draft' }).click();
    await expect(second.getByRole('alert')).toContainText('This page was saved somewhere else');
    await expect(second.getByRole('textbox', { name: 'Home page' })).toContainText(otherNote);
    await shoot(second, 'zone-home-stale', info);
    await reader.goto(siteHref!);
    await expect(reader.locator('.rezics-document')).toContainText(morning);
    await expect(reader.locator('.rezics-document')).not.toContainText(evening);
    await expect(reader.locator('.rezics-document')).not.toContainText(otherNote);

    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Published. Readers see this page.')).toBeVisible();
    await expect(async () => {
      await reader.goto(siteHref!);
      await expect(reader.locator('.rezics-document')).toContainText(evening, { timeout: 5_000 });
      await expect(reader.locator('.rezics-document')).not.toContainText(otherNote);
    }).toPass({ timeout: 90_000 });
    await shoot(reader, 'zone-home-republished', info);
    await second.close();
  } finally {
    await anonymous.close();
  }
});
