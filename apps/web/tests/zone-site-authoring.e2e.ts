import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { Pool } from 'pg';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { spaceHref } from '../features/address/path.ts';
import { defaultPresentation } from '../features/zones/presentation.ts';
import { localizedPath } from '../i18n/locale.ts';
import { signInAtAccounts } from './account-sign-in.ts';

// An author writes a Realm-less Zone's home page, previews the saved draft, and publishes it.
// A dropped publish response is retried with the same key. A second tab that saves against the
// moved head is told so and keeps its text. Anonymous readers see only the published revision.

const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 900 };
const morning = 'Morning edition of the harbor';
const evening = 'Evening edition of the harbor';
const otherNote = 'A note from the other tab';
const baselinePresentation = defaultPresentation({
  picks: 'Staff picks', latest: 'Latest', newChapters: 'New chapters', newlyAdded: 'Newly added',
  recentlyCompleted: 'Recently completed', rankings: 'Top reads', quotes: 'Reader quotes',
  rising: 'On the rise', decisions: 'Decisions',
});
baselinePresentation.modules = [];

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
    await grantFixtureAuthority(client, { scope, requireDispatch: true,
      representations: [{ principalId, actor: actingSubject, action, lifetime: '8 hours' }],
      grant: { actor: actingSubject, action, lifetime: '8 hours' } });
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
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} at ${label}px`).toBe(true);
    // The shell's search field is also a textbox. The writing area is the one in the page.
    const writing = await page.evaluate(() => {
      const main = document.getElementById('main-content') ?? document.body;
      const boxes = [...main.querySelectorAll<HTMLElement>('[role="textbox"], textarea, input:not([type="hidden"])')];
      const home = boxes.find(element => element.getAttribute('aria-label') === 'Home page');
      const box = home ?? boxes[0];
      if (!box) return true;
      const top = box.getBoundingClientRect().top;
      return top >= 0 && top < innerHeight;
    });
    expect(writing, `${name} writing area at ${label}px`).toBe(true);
    const path = info.outputPath(`${name}-${label}.png`);
    await page.screenshot({ path, fullPage: true });
    console.log(`[zone-site-authoring] ${label}px ${name}: ${path}`);
  }
  await page.setViewportSize(desktop);
}

async function createCollection(page: Page, collection: string, name: string, actingSubject: string) {
  const key = randomUUID();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await page.request.post('/api/main/v1/collections', {
      headers: { 'idempotency-key': key },
      data: { collection, name, language: 'en', disclosure: 'public', actingSubject },
    });
    if (response.status() === 200 || response.status() === 201) return;
    if (response.status() !== 202) throw new Error(`Collection create failed (${response.status()}): ${(await response.text()).slice(0, 400)}`);
    await page.waitForTimeout(500);
  }
  throw new Error(`Collection ${name} was not created`);
}

type AuthorFixture = {
  member: { email: string; password: string };
  principalId: string;
  actingSubject: string;
};
type SiteFixture = {
  name: string;
  space: string;
  zone: string;
  zoneId: string;
  editorPath: string;
  previewHref: string;
  siteHref: string;
  realm: string | null;
};
type SpaceCreateResult = { space?: string; zone?: string; realm?: string };

async function setAuthorAgentActive(actingSubject: string, active: boolean) {
  const url = process.env.ACCESS_DATABASE_URL;
  if (!url) throw new Error('ACCESS_DATABASE_URL must name the isolated QA access database');
  const pool = new Pool({ connectionString: url });
  try {
    const result = await pool.query(`UPDATE access.authority_subject SET active = $2
      WHERE id = $1 AND kind = 'agent'`, [actingSubject, active]);
    if (!active) expect(result.rowCount ?? 0).toBeGreaterThan(0);
  } finally {
    await pool.end();
  }
}

async function startAuthor(page: Page): Promise<AuthorFixture> {
  const actor = fixture<AuthorFixture>('REZICS_WEB_AUTH_PRIVATE_PATH');
  // A prior interrupted QA run may have left the shared isolated fixture disabled.
  await setAuthorAgentActive(actor.actingSubject, true);
  await signInAtAccounts(page, '/en/manage', actor.member);
  await page.setViewportSize(desktop);
  await grant('space:create:root', 'space.create', actor.principalId, actor.actingSubject);
  return actor;
}

async function createSpace(page: Page, data: Record<string, unknown>, ready: (body: SpaceCreateResult) => boolean) {
  const key = randomUUID();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await page.request.post('/api/main/v1/spaces', { headers: { 'idempotency-key': key }, data });
    const body = await response.json() as SpaceCreateResult;
    if ((response.status() === 200 || response.status() === 201) && ready(body)) return body;
    if (response.status() !== 202) throw new Error(`Space create failed (${response.status()}): ${JSON.stringify(body).slice(0, 400)}`);
    await page.waitForTimeout(500);
  }
  throw new Error('Space was not created');
}

async function zoneConfiguration(page: Page, zoneId: string, actingSubject: string) {
  const response = await page.request.get(`/api/main/v1/zones/${zoneId}/configuration?actingSubject=${encodeURIComponent(actingSubject)}`);
  expect(response.ok(), `Zone configuration read failed (${response.status()}): ${await response.text()}`).toBe(true);
  return await response.json() as {
    revision: string;
    configuration: { defaultRealm: string | null; presentation?: unknown };
  };
}

async function waitForZoneEditor(page: Page, zoneId: string, actingSubject: string) {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/main/v1/zones/${zoneId}/showcase-editor?actingSubject=${encodeURIComponent(actingSubject)}`);
    return response.status();
  }, { timeout: 30_000 }).toBe(200);
}

/** New Zones have no presentation baseline; theme editing deliberately refuses to invent one. */
async function ensurePresentationBaseline(page: Page, zoneId: string, actingSubject: string,
  defaultRealm?: string | null, installPresentation = true) {
  const current = await zoneConfiguration(page, zoneId, actingSubject);
  const patch: { presentation?: typeof baselinePresentation; defaultRealm?: string | null } = {};
  if (installPresentation && !current.configuration.presentation) patch.presentation = baselinePresentation;
  if (defaultRealm !== undefined && current.configuration.defaultRealm !== defaultRealm) patch.defaultRealm = defaultRealm;
  if (!Object.keys(patch).length) return current;
  const response = await page.request.put(`/api/main/v1/zones/${zoneId}/configuration`, {
    headers: { 'idempotency-key': randomUUID() },
    data: { expectedHead: current.revision, actingSubject, ...patch },
  });
  expect([200, 202]).toContain(response.status());
  await expect.poll(async () => {
    const latest = await zoneConfiguration(page, zoneId, actingSubject);
    return (!installPresentation || Boolean(latest.configuration.presentation))
      && (defaultRealm === undefined || latest.configuration.defaultRealm === defaultRealm);
  }, { timeout: 30_000 }).toBe(true);
  return await zoneConfiguration(page, zoneId, actingSubject);
}

async function createZoneFixture(page: Page, actor: AuthorFixture, name: string, withRealm = false,
  withPresentation = true): Promise<SiteFixture> {
  const created = await createSpace(page, {
    profile: 'space-zone-v1', name, language: 'en', capabilities: ['zone'],
    visibility: 'public', listing: 'listed', actingSubject: actor.actingSubject,
  }, body => !!body.space && !!body.zone);
  const space = created.space!;
  const zone = created.zone!;
  const zoneId = uuidOf(zone);
  const address = spaceHref(space, 'site').slice('/z/'.length);
  const editorPath = localizedPath('/manage/z/' + address, 'en');
  await grant('zone:edit:' + zone, 'zone.edit', actor.principalId, actor.actingSubject);

  let realm: string | null = null;
  if (withRealm) {
    const handle = 'realm' + randomUUID().replaceAll('-', '').slice(0, 8);
    const createdRealm = await createSpace(page, {
      profile: 'space-realm-v2', name: name + ' community', language: 'en',
      capabilities: ['realm'], handle, actingSubject: actor.actingSubject,
      initialSettings: { visibility: 'public', reviewRequired: false, reviewMode: 'open',
        whoMaySubmit: 'members', selfJoin: true, rules: [] },
    }, body => !!body.space && !!body.realm);
    realm = createdRealm.realm!;
    await grant('governance:realm:' + realm, 'realm.owner', actor.principalId, actor.actingSubject);
  }

  const configuration = await ensurePresentationBaseline(page, zoneId, actor.actingSubject, realm ?? undefined, withPresentation);
  expect(configuration.configuration.defaultRealm ?? null).toBe(realm);

  await waitForZoneEditor(page, zoneId, actor.actingSubject);
  await page.goto(editorPath);
  await expect(page.getByRole('textbox', { name: 'Home page' })).toBeVisible({ timeout: 90_000 });
  const siteHref = await page.getByRole('link', { name: 'View site' }).getAttribute('href');
  expect(siteHref).toMatch(/^\/en\/z\//);
  return { name, space, zone, zoneId, editorPath, previewHref: editorPath + '/preview', siteHref: siteHref!, realm };
}

async function saveThemeDraft(page: Page, site: SiteFixture, density: 'compact' | 'comfortable',
  surface: 'flat' | 'cards') {
  await page.goto(site.editorPath + '/theme');
  await selectRadio(page, density === 'compact' ? /Compact/ : /Comfortable/);
  await selectRadio(page, surface === 'cards' ? 'In cards' : 'On the page');
  await page.getByRole('button', { name: 'Save layout' }).click();
  await expect(page.getByText('Layout saved.')).toBeVisible({ timeout: 30_000 });
}

/** Ark's radio has a focusable hidden input under its visible label; use the keyboard path. */
async function selectRadio(page: Page, name: string | RegExp) {
  const radio = page.getByRole('radio', { name });
  await radio.press('Space');
  await expect(radio).toBeChecked();
}

async function saveNavigationDraft(page: Page, actor: AuthorFixture, site: SiteFixture) {
  const charts = 'https://rezics.com/id/' + randomUUID();
  const tides = 'https://rezics.com/id/' + randomUUID();
  await grant('collection:edit:' + charts, 'collection.edit', actor.principalId, actor.actingSubject);
  await grant('semantic:read:' + charts, 'semantic.read', actor.principalId, actor.actingSubject);
  await grant('collection:edit:' + tides, 'collection.edit', actor.principalId, actor.actingSubject);
  await grant('semantic:read:' + tides, 'semantic.read', actor.principalId, actor.actingSubject);
  await createCollection(page, charts, 'Harbor charts', actor.actingSubject);
  await createCollection(page, tides, 'Harbor tides', actor.actingSubject);
  const typeahead = (url: URL) => url.pathname.includes('/v1/search/typeahead');
  const suggestions = async (route: import('@playwright/test').Route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ profile: 'public-work-typeahead-v1',
      items: [pageSuggestion(charts, 'Harbor charts'), pageSuggestion(tides, 'Harbor tides')],
      hasMore: false, sourcePosition: { dataEpoch: '00000000-0000-4000-8000-000000000901', sequence: '1' } }),
  });
  await page.route(typeahead, suggestions);
  await page.goto(site.editorPath + '/navigation');
  await addNavigationLink(page, 'Harbor charts');
  await addNavigationLink(page, 'Harbor tides');
  await page.getByRole('button', { name: 'Move up Harbor tides' }).click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible({ timeout: 30_000 });
  await page.unroute(typeahead, suggestions);
  return { charts, tides };
}

async function saveSiteDraft(page: Page, actor: AuthorFixture, site: SiteFixture) {
  await page.goto(site.editorPath);
  await writeHome(page, morning);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible({ timeout: 30_000 });
  await saveNavigationDraft(page, actor, site);
  await saveThemeDraft(page, site, 'compact', 'cards');
}

async function publishSavedSite(page: Page, site: SiteFixture) {
  await page.goto(site.editorPath);
  await expect(page.getByRole('textbox', { name: 'Home page' })).toContainText(morning);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText(/^Published\./)).toBeVisible({ timeout: 30_000 });
}

async function saveLaterDrafts(page: Page, site: SiteFixture) {
  await page.goto(site.editorPath);
  await writeHome(page, evening);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible({ timeout: 30_000 });
  await page.goto(site.editorPath + '/navigation');
  await page.getByRole('button', { name: 'Remove Harbor charts' }).click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible({ timeout: 30_000 });
  await saveThemeDraft(page, site, 'comfortable', 'flat');
}

async function expectSiteCuts(page: Page, home: string, navigation: readonly string[],
  surface: 'flat' | 'cards', density: 'compact' | 'comfortable', preview = false) {
  await expect(page.getByText(home)).toBeVisible();
  await expect(page.locator('[data-zone-site-navigation]').getByRole('link')).toHaveText(navigation);
  const surfaceSelector = preview ? '[data-zone-preview-page-surface]' : '[data-zone-site-home-surface]';
  const surfaceAttribute = preview ? 'data-zone-preview-page-surface' : 'data-zone-site-home-surface';
  await expect(page.locator(surfaceSelector)).toHaveAttribute(surfaceAttribute, surface);
  const theme = await page.locator('[data-zone]').evaluate(element => {
    const style = getComputedStyle(element);
    return { tiles: style.getPropertyValue('--zone-tiles').trim(), panel: style.getPropertyValue('--zone-panel').trim() };
  });
  expect(theme.tiles).toBe(density === 'compact' ? '6' : '5');
  if (surface === 'cards') expect(theme.panel).not.toBe('transparent');
  else expect(theme.panel).toBe('transparent');
  const visual = await page.locator(surfaceSelector).evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, padding: parseFloat(style.paddingLeft) };
  });
  if (surface === 'cards') {
    expect(visual.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(visual.padding).toBeGreaterThan(0);
  } else {
    expect(visual.background).toBe('rgba(0, 0, 0, 0)');
    expect(visual.padding).toBe(0);
  }
}

async function revokeZoneEdit(zone: string, actingSubject: string) {
  const url = process.env.ACCESS_DATABASE_URL;
  if (!url) throw new Error('ACCESS_DATABASE_URL must name the isolated QA access database');
  const pool = new Pool({ connectionString: url });
  try {
    const result = await pool.query(`UPDATE access.permission_grant
      SET active = false, generation = generation + 1
      WHERE scope_id = $1 AND recipient_subject = $2 AND action = 'zone.edit' AND active`,
    ['zone:edit:' + zone, actingSubject]);
    expect(result.rowCount ?? 0).toBeGreaterThan(0);
  } finally {
    await pool.end();
  }
}

function pageSuggestion(work: string, title: string) {
  return {
    work, mainVersion: work,
    title: { value: title, language: 'en', direction: 'ltr', basis: 'requested' },
    cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'collection', resourceType: 'collection' },
    types: [], authors: [], matchedField: 'title', matchedText: title, matchedLanguage: 'en',
  };
}

async function addNavigationLink(page: Page, name: string) {
  const finder = page.getByRole('textbox', { name: 'Page' });
  await finder.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Harbor');
  await page.getByRole('option', { name }).click();
  await page.getByRole('button', { name: 'Add link' }).click();
  await expect(page.getByRole('list', { name: 'Links' }).getByText(name)).toBeVisible();
}

const showcaseDefinition = 'https://rezics.com/definition/showcase-block-v1';
const showcaseFallback = 'A Showcase fallback is not the rendered stage';

function showcaseHome(title: string): DocumentSnapshot {
  const document = fromPlainText(morning, 'blocks');
  document.doc.content!.push({ type: 'extensionBlock', attrs: {
    id: 'harbor-showcase', definition: showcaseDefinition, version: '2', fallback: showcaseFallback,
    payload: {
      'rv:module': [{ id: 'harbor-showcase', type: 'hero-carousel', title: 'Harbor showcase',
        source: { kind: 'query-block', block: 'new-adoptions' } }],
      'rv:slides': [{ id: 'harbor-exhibition', title, href: '/harbor-exhibition' }],
      'rv:titleEffect': ['plain'],
    },
  } });
  return document;
}

async function saveShowcaseHome(page: Page, site: SiteFixture, actingSubject: string, title: string) {
  const current = await page.request.get(`/api/main/v1/zones/${site.zoneId}/showcase-editor?actingSubject=${encodeURIComponent(actingSubject)}`);
  expect(current.ok()).toBe(true);
  const { draft } = await current.json() as { draft: {
    variantId: string; revisionId: string | null; language: { kind: 'tag'; tag: string; originalTag: string };
    direction: 'ltr' | 'rtl' | 'none';
  } };
  const saved = await page.request.post('/api/main/v1/content-drafts', {
    headers: { 'idempotency-key': randomUUID() },
    data: { profile: 'content-text-v1', resourceId: site.zone, variantId: draft.variantId,
      expectedHead: draft.revisionId, language: draft.language, direction: draft.direction,
      document: showcaseHome(title), actingSubject },
  });
  expect([200, 201]).toContain(saved.status());
}

async function savePresentationLinks(page: Page, site: SiteFixture, actingSubject: string, label: string) {
  const current = await zoneConfiguration(page, site.zoneId, actingSubject);
  const presentation = { ...baselinePresentation, navigation: [{ label, href: '/harbor-guide' }],
    modules: [{ id: 'harbor-notice', type: 'announcement', title: 'The harbor is open',
      source: { kind: 'query-block', block: 'new-adoptions' } }] };
  const saved = await page.request.put(`/api/main/v1/zones/${site.zoneId}/configuration`, {
    headers: { 'idempotency-key': randomUUID() },
    data: { expectedHead: current.revision, actingSubject, presentation },
  });
  expect([200, 202]).toContain(saved.status());
  await expect.poll(async () => (await zoneConfiguration(page, site.zoneId, actingSubject)).configuration.presentation,
    { timeout: 30_000 }).toEqual(presentation);
}

async function expectShowcaseHome(page: Page, title: string) {
  await expect(page.locator('.showcase-slide')).toHaveCount(1);
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await expect(page.locator('.rezics-document')).toContainText(morning);
  await expect(page.locator('.rezics-document')).not.toContainText(showcaseFallback);
  await expect(page.locator(`.rezics-document [data-document-component="${showcaseDefinition}"]`)).toHaveCount(0);
}

test.use({ actionTimeout: 15_000 });

for (const withRealm of [false, true]) {
  test(`Zone home rendering: a ${withRealm ? 'Realm-backed' : 'Realm-less'} Zone previews a new Showcase and publishes modules with saved presentation navigation`,
    async ({ page, context }, info) => {
      test.setTimeout(600_000);
      const actor = await startAuthor(page);
      const label = withRealm ? 'realm-backed' : 'realm-less';
      const site = await createZoneFixture(page, actor, 'Harbor exhibition', withRealm, false);
      expect((await zoneConfiguration(page, site.zoneId, actor.actingSubject)).configuration.presentation).toBeUndefined();
      await page.goto(site.previewHref);
      await expect(page.getByRole('heading', { name: 'Draft preview' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'No draft yet' })).toBeVisible();

      await saveShowcaseHome(page, site, actor.actingSubject, 'The morning exhibition');
      await page.goto(site.previewHref);
      await expectShowcaseHome(page, 'The morning exhibition');
      expect((await zoneConfiguration(page, site.zoneId, actor.actingSubject)).configuration.presentation).toBeUndefined();
      await shoot(page, `zone-new-${label}-showcase-preview`, info);

      await savePresentationLinks(page, site, actor.actingSubject, 'Visitor guide');
      await page.goto(site.previewHref);
      await expectShowcaseHome(page, 'The morning exhibition');
      await expect(page.getByText('The harbor is open', { exact: true })).toBeVisible();
      await expect(page.locator('[data-zone-site-navigation]').getByRole('link')).toHaveText(['Home', 'Visitor guide']);

      const anonymous = await context.browser()!.newContext();
      const reader = await anonymous.newPage();
      try {
        await reader.goto(site.siteHref);
        await expect(reader.locator('.showcase-slide')).toHaveCount(0);
        await expect(reader.locator('[data-zone-site-navigation]').getByRole('link')).toHaveText(['Home']);
        await publishSavedSite(page, site);
        await expect(async () => {
          await reader.goto(site.siteHref);
          await expectShowcaseHome(reader, 'The morning exhibition');
          await expect(reader.getByText('The harbor is open', { exact: true })).toBeVisible();
          await expect(reader.locator('[data-zone-site-navigation]').getByRole('link')).toHaveText(['Home', 'Visitor guide']);
        }).toPass({ timeout: 90_000 });
        await shoot(reader, `zone-${label}-published-showcase`, info);

        await savePresentationLinks(page, site, actor.actingSubject, 'Saved visitor guide');
        await saveShowcaseHome(page, site, actor.actingSubject, 'The evening exhibition');
        await page.goto(site.previewHref);
        await expectShowcaseHome(page, 'The evening exhibition');
        await expect(page.locator('[data-zone-site-navigation]').getByRole('link')).toHaveText(['Home', 'Saved visitor guide']);
        await shoot(page, `zone-saved-${label}-navigation-preview`, info);
        await reader.goto(site.siteHref);
        await expectShowcaseHome(reader, 'The morning exhibition');
        await expect(reader.getByText('The evening exhibition', { exact: true })).toHaveCount(0);
        await expect(reader.locator('[data-zone-site-navigation]').getByRole('link')).toHaveText(['Home', 'Visitor guide']);
      } finally { await anonymous.close(); }
    });
}

test('Navigation and theme: a Realm-less Zone publishes the saved home, navigation, and layout as one site', async ({ page, context }, info) => {
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
  const address = spaceHref(space, 'site').slice('/z/'.length);
  await grant(`zone:edit:${zone}`, 'zone.edit', principalId, actingSubject);
  await ensurePresentationBaseline(page, uuidOf(zone), actingSubject);
  const initialPresentation = await page.request.get('/api/main/v1/zones/' + uuidOf(zone) + '/presentation');
  expect(initialPresentation.ok()).toBe(true);
  expect((await initialPresentation.json() as { realm: string | null }).realm).toBeNull();

  const editorPath = localizedPath('/manage/z/' + address, 'en');
  await expect(async () => {
    await page.goto(localizedPath(spaceHref(space, 'site'), 'en'));
    await expect(page.getByRole('link', { name: 'Edit site' })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
  // The public site links with the Zone's address (short id and name), not the raw id.
  const editHref = await page.getByRole('link', { name: 'Edit site' }).getAttribute('href');
  expect(editHref).toMatch(/^\/en\/manage\/z\/[^/?#]+$/);
  expect(editHref?.split('/').at(-1)?.startsWith(address)).toBe(true);
  await page.getByRole('link', { name: 'Edit site' }).click();
  await expect(page).toHaveURL(/\/manage\/z\/[^/?#]+$/);
  await expect(async () => {
    await page.goto(editorPath);
    await expect(page.getByRole('heading', { level: 1, name: 'Harbor notes' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('textbox', { name: 'Home page' })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });

  await writeHome(page, morning);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Only you can see this draft.')).toBeVisible();
  const siteHref = await page.getByRole('link', { name: 'View site' }).getAttribute('href');
  const previewHref = await page.getByRole('link', { name: 'Preview', exact: true }).getAttribute('href');
  expect(siteHref).toMatch(/^\/en\/z\//);
  expect(previewHref).toMatch(/^\/en\/manage\/z\//);

  const charts = `https://rezics.com/id/${randomUUID()}`;
  const tides = `https://rezics.com/id/${randomUUID()}`;
  await grant(`collection:edit:${charts}`, 'collection.edit', principalId, actingSubject);
  await grant(`semantic:read:${charts}`, 'semantic.read', principalId, actingSubject);
  await grant(`collection:edit:${tides}`, 'collection.edit', principalId, actingSubject);
  await grant(`semantic:read:${tides}`, 'semantic.read', principalId, actingSubject);
  await createCollection(page, charts, 'Harbor charts', actingSubject);
  await createCollection(page, tides, 'Harbor tides', actingSubject);
  const typeahead = (url: URL) => url.pathname.includes('/v1/search/typeahead');
  const suggestions = async (route: import('@playwright/test').Route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      profile: 'public-work-typeahead-v1',
      items: [pageSuggestion(charts, 'Harbor charts'), pageSuggestion(tides, 'Harbor tides')],
      hasMore: false, sourcePosition: { dataEpoch: '00000000-0000-4000-8000-000000000901', sequence: '1' },
    }),
  });
  await page.route(typeahead, suggestions);
  await page.getByRole('link', { name: 'Navigation', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Navigation' })).toBeVisible();
  await addNavigationLink(page, 'Harbor charts');
  await addNavigationLink(page, 'Harbor tides');
  await page.getByRole('button', { name: 'Move up Harbor tides' }).click();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible({ timeout: 30_000 });
  await page.unroute(typeahead, suggestions);

  await page.getByRole('link', { name: 'Theme', exact: true }).click();
  await selectRadio(page, /Compact/);
  await selectRadio(page, 'In cards');
  await page.getByRole('button', { name: 'Save layout' }).click();
  await expect(page.getByText('Layout saved.')).toBeVisible({ timeout: 30_000 });
  await page.goto(editorPath);
  await expect(page.getByRole('textbox', { name: 'Home page' })).toContainText(morning);
  await page.getByRole('link', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Draft preview' })).toBeVisible();
  await expect(page.getByText(morning)).toBeVisible();
  await expect(page.getByText('Only people who can edit this Zone can open this preview.')).toBeVisible();
  await expect(page.locator('[data-zone-site-navigation]').getByRole('link')).toHaveText(
    ['Home', 'Harbor tides', 'Harbor charts']);
  await expect(page.locator('[data-zone-preview-page-surface]')).toHaveAttribute('data-zone-preview-page-surface', 'cards');
  const previewTheme = await page.locator('[data-zone]').evaluate(element => {
    const style = getComputedStyle(element);
    return { tiles: style.getPropertyValue('--zone-tiles').trim(), panel: style.getPropertyValue('--zone-panel').trim() };
  });
  expect(previewTheme.tiles).toBe('6');
  expect(previewTheme.panel).not.toBe('transparent');
  const previewSurface = await page.locator('[data-zone-preview-page-surface]').evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, padding: style.paddingLeft };
  });
  expect(previewSurface.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(parseFloat(previewSurface.padding)).toBeGreaterThan(0);
  await shoot(page, 'zone-draft-preview-realm-less', info);
  await page.getByRole('link', { name: 'Back to the editor' }).click();
  await expect(page).toHaveURL(editorPath);
  await expect(page.getByRole('textbox', { name: 'Home page' })).toContainText(morning, { timeout: 30_000 });
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
    const publishBodies: string[] = [];
    let committedReceipt: string | undefined;
    let replayedReceipt: string | undefined;
    let replayedResponse = false;
    let dropPublish = true;
    await page.route('**/v1/zones/*/site-publications', async (route) => {
      publishKeys.push(route.request().headers()['idempotency-key'] ?? '');
      publishBodies.push(route.request().postData() ?? '');
      if (dropPublish) {
        dropPublish = false;
        const upstream = await route.fetch();
        expect([200, 201]).toContain(upstream.status());
        const body = await upstream.text();
        const result = JSON.parse(body) as { receipt?: string; replayed?: boolean };
        committedReceipt = result.receipt;
        await route.abort('failed');
        return;
      }
      const upstream = await route.fetch();
      const body = await upstream.text();
      const result = JSON.parse(body) as { receipt?: string; replayed?: boolean };
      replayedReceipt = result.receipt;
      replayedResponse = result.replayed === true;
      await route.fulfill({ status: upstream.status(), contentType: 'application/json', body });
    });
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText(/^Published\./)).toBeVisible({ timeout: 30_000 });
    expect(publishKeys.slice(0, 2)).toEqual([publishKeys[0], publishKeys[0]]);
    expect(publishKeys[0]).toMatch(/^[A-Za-z0-9:_./-]{1,128}$/);
    expect(publishBodies[0]).toBeTruthy();
    expect(publishBodies[1]).toBe(publishBodies[0]);
    expect(committedReceipt).toBeTruthy();
    expect(replayedReceipt).toBe(committedReceipt);
    expect(replayedResponse).toBe(true);
    await page.unroute('**/v1/zones/*/site-publications');

    await expect(async () => {
      await reader.goto(siteHref!);
      await expect(reader.locator('.rezics-document')).toHaveCount(1, { timeout: 5_000 });
      await expect(reader.locator('.rezics-document')).toContainText(morning);
      await expect(reader.locator('[data-zone-site-navigation]').getByRole('link')).toHaveText(
        ['Home', 'Harbor tides', 'Harbor charts']);
    }).toPass({ timeout: 90_000 });
    await expect(reader.locator('[data-zone-site-home-surface]')).toHaveAttribute('data-zone-site-home-surface', 'cards');
    const publishedTheme = await reader.locator('[data-zone]').evaluate(element => {
      const style = getComputedStyle(element);
      return { tiles: style.getPropertyValue('--zone-tiles').trim(), panel: style.getPropertyValue('--zone-panel').trim() };
    });
    expect(publishedTheme.tiles).toBe('6');
    expect(publishedTheme.panel).not.toBe('transparent');
    await shoot(reader, 'zone-home-published', info);

    const second = await context.newPage();
    await second.setViewportSize(desktop);
    await second.goto(editorPath);
    await expect(second.getByRole('textbox', { name: 'Home page' })).toContainText(morning);
    await writeHome(page, evening);
    await expect(page.getByRole('textbox', { name: 'Home page' })).not.toContainText(morning);
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Draft saved.')).toBeVisible({ timeout: 30_000 });
    await writeHome(second, otherNote);
    await expect(second.getByRole('textbox', { name: 'Home page' })).not.toContainText(morning);
    await second.getByRole('button', { name: 'Save draft' }).click();
    await expect(second.getByRole('alert')).toContainText('This page was saved somewhere else', { timeout: 30_000 });
    await expect(second.getByRole('textbox', { name: 'Home page' })).toContainText(otherNote);
    await shoot(second, 'zone-home-stale', info);
    await reader.goto(siteHref!);
    await expect(reader.locator('.rezics-document')).toContainText(morning);
    await expect(reader.locator('.rezics-document')).not.toContainText(evening);
    await expect(reader.locator('.rezics-document')).not.toContainText(otherNote);

    await page.getByRole('link', { name: 'Navigation', exact: true }).click();
    await page.getByRole('button', { name: 'Remove Harbor charts' }).click();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Draft saved.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('link', { name: 'Theme', exact: true }).click();
    await selectRadio(page, /Comfortable/);
    await selectRadio(page, 'On the page');
    await page.getByRole('button', { name: 'Save layout' }).click();
    await expect(page.getByText('Layout saved.')).toBeVisible({ timeout: 30_000 });
    await page.goto(previewHref!);
    await expect(page.getByText(evening)).toBeVisible();
    await expect(page.locator('[data-zone-site-navigation]').getByRole('link')).toHaveText(['Home', 'Harbor tides']);
    await expect(page.locator('[data-zone-preview-page-surface]')).toHaveAttribute('data-zone-preview-page-surface', 'flat');
    const laterPreviewTheme = await page.locator('[data-zone]').evaluate(element => {
      const style = getComputedStyle(element);
      return { tiles: style.getPropertyValue('--zone-tiles').trim(), panel: style.getPropertyValue('--zone-panel').trim() };
    });
    expect(laterPreviewTheme).toEqual({ tiles: '5', panel: 'transparent' });
    await shoot(page, 'zone-later-drafts-preview', info);
    await reader.goto(siteHref!);
    await expect(reader.locator('.rezics-document')).toContainText(morning);
    await expect(reader.locator('.rezics-document')).not.toContainText(evening);
    await expect(reader.locator('[data-zone-site-navigation]').getByRole('link')).toHaveText(
      ['Home', 'Harbor tides', 'Harbor charts']);
    await expect(reader.locator('[data-zone-site-home-surface]')).toHaveAttribute('data-zone-site-home-surface', 'cards');
    await expect(reader.locator('[data-zone]')).toHaveCSS('--zone-tiles', '6');
    await shoot(reader, 'zone-published-cuts-after-later-drafts', info);
    await second.close();
  } finally {
    await anonymous.close();
  }
});

test('Navigation and theme: a Realm-backed Zone previews and publishes the same saved site cuts', async ({ page, context }, info) => {
  test.setTimeout(600_000);
  const actor = await startAuthor(page);
  const site = await createZoneFixture(page, actor, 'Harbor readers', true);
  await saveSiteDraft(page, actor, site);

  await page.goto(site.previewHref);
  await expect(page.getByRole('heading', { name: 'Draft preview' })).toBeVisible();
  await expectSiteCuts(page, morning, ['Home', 'Harbor tides', 'Harbor charts'], 'cards', 'compact', true);
  await shoot(page, 'zone-realm-draft-preview', info);

  const anonymous = await context.browser()!.newContext();
  const reader = await anonymous.newPage();
  try {
    await reader.goto(site.siteHref);
    await expect(reader.getByText(morning)).toHaveCount(0);

    await publishSavedSite(page, site);
    await expect(async () => {
      await reader.goto(site.siteHref);
      await expectSiteCuts(reader, morning, ['Home', 'Harbor tides', 'Harbor charts'], 'cards', 'compact');
    }).toPass({ timeout: 90_000 });
    await shoot(reader, 'zone-realm-published-site', info);

    await saveLaterDrafts(page, site);
    await page.goto(site.previewHref);
    await expectSiteCuts(page, evening, ['Home', 'Harbor tides'], 'flat', 'comfortable', true);
    await shoot(page, 'zone-realm-later-drafts-preview', info);

    await reader.goto(site.siteHref);
    await expectSiteCuts(reader, morning, ['Home', 'Harbor tides', 'Harbor charts'], 'cards', 'compact');
  } finally {
    await anonymous.close();
  }
});

test('Zone lifecycle: a populated site retires and recovers the same published cuts through the editor', async ({ page, context }, info) => {
  test.setTimeout(600_000);
  const actor = await startAuthor(page);
  const site = await createZoneFixture(page, actor, 'Harbor archive');
  await saveSiteDraft(page, actor, site);
  await publishSavedSite(page, site);

  const anonymous = await context.browser()!.newContext();
  const reader = await anonymous.newPage();
  const competingEditor = await context.newPage();
  try {
    await reader.goto(site.siteHref);
    await expectSiteCuts(reader, morning, ['Home', 'Harbor tides', 'Harbor charts'], 'cards', 'compact');
    await shoot(reader, 'zone-lifecycle-before-retirement', info);

    await page.goto(site.editorPath + '/lifecycle');
    await expect(page.getByRole('heading', { level: 2, name: 'Site status' })).toBeVisible();
    await competingEditor.goto(site.editorPath + '/theme');
    await page.getByRole('button', { name: 'Retire site' }).click();
    await expect(page.getByText('Before you retire this site', { exact: true })).toBeVisible();
    await saveThemeDraft(competingEditor, site, 'comfortable', 'cards');

    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('The site changed before this action');
    await expect(page.getByText('Before you retire this site', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Review current status' }).click();
    await expect(page.getByText(/The current status is loaded\. Your selected action is still here/)).toBeVisible();
    await expect(page.getByText('Before you retire this site', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled();
    await shoot(page, 'zone-lifecycle-stale-review', info);

    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText('This site is retired and unavailable to readers.', { exact: true }))
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Recover site' })).toBeVisible();
    await reader.goto(site.siteHref);
    await expect(reader.locator('[data-zone-site-home-surface]')).toHaveCount(0);
    await expect(reader.getByText(morning)).toHaveCount(0);
    await shoot(reader, 'zone-retired-public-site', info);

    await page.getByRole('button', { name: 'Recover site' }).click();
    await expect(page.getByText('Recover this site?', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Home page' })).toBeVisible({ timeout: 30_000 });

    await page.goto(site.editorPath + '/lifecycle');
    await expect(page.getByText('This site is active and its published pages are available to readers.', { exact: true }))
      .toBeVisible();
    await expect(async () => {
      await reader.goto(site.siteHref);
      await expectSiteCuts(reader, morning, ['Home', 'Harbor tides', 'Harbor charts'], 'cards', 'compact');
    }).toPass({ timeout: 90_000 });
    await shoot(reader, 'zone-recovered-published-site', info);
  } finally {
    await competingEditor.close();
    await anonymous.close();
  }
});

test('Zone publication: a revoked editor keeps saved work, cannot publish, and cannot reopen preview', async ({ page, context }, info) => {
  test.setTimeout(600_000);
  const actor = await startAuthor(page);
  const site = await createZoneFixture(page, actor, 'Harbor desk');
  await saveSiteDraft(page, actor, site);
  await publishSavedSite(page, site);

  const anonymous = await context.browser()!.newContext();
  const reader = await anonymous.newPage();
  const reopenedPreview = await context.newPage();
  try {
    await reader.goto(site.siteHref);
    await expectSiteCuts(reader, morning, ['Home', 'Harbor tides', 'Harbor charts'], 'cards', 'compact');

    await saveLaterDrafts(page, site);
    await page.goto(site.editorPath);
    await expect(page.getByRole('textbox', { name: 'Home page' })).toContainText(evening);
    await revokeZoneEdit(site.zone, actor.actingSubject);
    // The owner's Zone baseline follows this active Agent; the open page retains its draft.
    await setAuthorAgentActive(actor.actingSubject, false);
    const publicationResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/site-publications'));
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    expect((await publicationResponse).status()).toBe(403);
    await expect(page.getByRole('alert')).toContainText('You can’t edit this Zone', { timeout: 30_000 });
    await expect(page.getByRole('textbox', { name: 'Home page' })).toContainText(evening);
    await shoot(page, 'zone-revoked-publish-editor', info);

    await reopenedPreview.goto(site.previewHref);
    await expect(reopenedPreview.getByRole('alert')).toContainText(/can no longer use/);
    await expect(reopenedPreview.getByRole('heading', { name: 'Draft preview' })).toHaveCount(0);
    await shoot(reopenedPreview, 'zone-revoked-preview', info);

    await reader.goto(site.siteHref);
    await expectSiteCuts(reader, morning, ['Home', 'Harbor tides', 'Harbor charts'], 'cards', 'compact');
  } finally {
    await reopenedPreview.close();
    await anonymous.close();
    await setAuthorAgentActive(actor.actingSubject, true);
  }
});
