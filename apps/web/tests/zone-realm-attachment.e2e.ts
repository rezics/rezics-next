import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test, type TestInfo } from '@playwright/test';
import { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { fromPlainText } from '@rezics/document';
import { addressPath, spaceHref, threadHref, zoneMemberHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import { axeViolations, formatViolations } from './a11y-axe.ts';
import { retainedAboutPost } from '../features/zones/about-discussion-intent.ts';
import { aboutDiscussionMessages } from '../features/zones/about-discussion-messages.ts';
import { expectClean, type Findings, keyboardReach, pressByKeyboard } from './g-743-matrix.ts';
import { reloadJourney, visitJourney } from './journey-navigation.ts';
import { grantPlatformUse, platformAdministratorSession } from '../../../tests/qa/fixtures/platform-grant.ts';

// An editor attaches a Realm from another Space and publishes a routable Work page.
// Two directly controlled Persons race first posts and recover retained browser intents.

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
    await grantFixtureAuthority(client, {
      scope,
      requireDispatch: true,
      representations: [{ principalId, actor: actingSubject, action, lifetime: '8 hours' }],
      grant: { actor: actingSubject, action, lifetime: '8 hours' },
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

const uuidOf = (iri: string) => {
  const id = iri.slice(-36);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`expected a resource id, received ${iri}`);
  return id;
};

async function fits(page: Page, label: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), label).toBe(true);
}

async function discussionAccessibility(page: Page) {
  const selector = await discussion(page).evaluate(element =>
    `section[aria-labelledby="${CSS.escape(element.getAttribute('aria-labelledby')!)}"]`);
  // Scope the engine itself: filtering its shortened diagnostics could miss
  // discussion failures after unrelated page nodes fill the diagnostic limit.
  const violations = await axeViolations(page, { include: [selector] });
  expect(violations, formatViolations(violations)).toEqual([]);
}

async function shoot(page: Page, name: string, info: TestInfo, checkDiscussion = false) {
  for (const [label, viewport] of [['390', phone], ['1280', desktop]] as const) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await fits(page, `${name} at ${label}px`);
    if (checkDiscussion) await discussionAccessibility(page);
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

/** Fixture setup uses the same real commands as Studio, with one retained key per command. */
async function command<T>(page: Page, path: string, data: Record<string, unknown>, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  const key = randomUUID();
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await page.request.fetch(`/api/main/v1/${path}`, { method, headers: { 'idempotency-key': key }, data });
    const body = await response.json();
    if (response.status() === 200 || response.status() === 201) return body as T;
    if (response.status() !== 202) throw new Error(`${method} /api/main/v1/${path}: ${response.status()} request=${JSON.stringify(data)} response=${JSON.stringify(body).slice(0, 800)}`);
    await page.waitForTimeout(300);
  }
  throw new Error(`${path} did not settle`);
}

async function publishedWorkPage(page: Page, zone: string, actor: string, principal: string) {
  const created = await command<{ work: string; mainVersion: string }>(page, 'works', {
    profile: 'metadata-only-v1', title: 'Harbor field guide', language: 'en', authoring: 'own-work', actingSubject: actor,
  });
  await grant(`work:read:${created.work}`, 'work.read', principal, actor);
  const text = await command<{ contribution: string; draftRevision: string }>(page, 'contributions', {
    profile: 'text-contribution-v1', work: created.work, language: 'en', body: 'A published guide to the harbor.', actingSubject: actor,
  });
  const publication = await command<{ publicationDecision: string }>(page, 'contribution-publications', {
    profile: 'text-publication-v1', contribution: text.contribution, expectedDraftHead: text.draftRevision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
  });
  await command(page, 'publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: created.mainVersion },
    work: created.work, contribution: text.contribution, publicationDecision: publication.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor,
  });
  const collection = `https://rezics.com/id/${randomUUID()}`;
  await grant(`collection:edit:${collection}`, 'collection.edit', principal, actor);
  await grant(`semantic:read:${collection}`, 'semantic.read', principal, actor);
  const curated = await command<{ structure: string; revision: string }>(page, 'collections', {
    collection, name: 'Harbor reading shelf', language: 'en', disclosure: 'public', actingSubject: actor,
  });
  await command(page, `collections/${uuidOf(collection)}/changes`, {
    expectedHead: curated.revision, actingSubject: actor,
    operations: [{ op: 'insert', parent: curated.structure, position: 'last', role: 'member', target: created.work,
      selection: { mode: 'follow-context' } }],
  });
  const zonePath = `zones/${uuidOf(zone)}`;
  const navigation = await page.request.get(`/api/main/v1/${zonePath}?actingSubject=${encodeURIComponent(actor)}`);
  expect(navigation.ok()).toBe(true);
  const head = await navigation.json() as { revision: string };
  const mounted = await command<{ revision: string }>(page, `${zonePath}/mounts`, {
    expectedHead: head.revision, target: collection, routeSegment: 'guide', disclosure: 'public', actingSubject: actor,
  });
  // Site publication names its allocated home Document, which is distinct from the Zone.
  const before = await page.request.get(`/api/main/v1/${zonePath}/configuration?actingSubject=${encodeURIComponent(actor)}`);
  expect(before.ok(), await before.text()).toBe(true);
  await command(page, `${zonePath}/configuration`, {
    expectedHead: (await before.json() as { revision: string }).revision, prepareHomeDocument: true, actingSubject: actor,
  }, 'PUT');
  const configuration = await page.request.get(`/api/main/v1/${zonePath}/configuration?actingSubject=${encodeURIComponent(actor)}`);
  expect(configuration.ok(), await configuration.text()).toBe(true);
  const configured = await configuration.json() as { revision: string; configuration: { homeDocument: string | null } };
  expect(configured.configuration.homeDocument).toBeTruthy();
  const homeDocument = configured.configuration.homeDocument!;
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await command<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(page, 'content-drafts', {
    profile: 'content-text-v1', resourceId: homeDocument, variantId, expectedHead: null,
    document: fromPlainText('Harbor annex home', 'blocks'),
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: actor,
  });
  await command(page, `${zonePath}/site-publications`, {
    expectedHead: configured.revision,
    routesRevision: mounted.revision, navigationRevision: mounted.revision, actingSubject: actor,
    pages: [{ page: homeDocument, variantId, revisionId: draft.revisionId, byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch }],
  });
  return created.work;
}

// A Work also has its own discussion summary. Identify the attached Realm's
// entry by its visible Realm link, including when checking removal afterward.
const discussion = (page: Page) => page.getByRole('region', { name: 'Discussion', exact: true })
  .filter({ has: page.getByRole('link', { name: 'North realm', exact: true }) });

// Unavailable Realm metadata omits its link, while the retained composer still exposes its message field.
const recoveryDiscussion = (page: Page) => page.getByRole('region', { name: 'Discussion', exact: true })
  .filter({ has: page.getByRole('textbox', { name: 'Your message', exact: true }) });

async function compose(page: Page, body: string, language: string, spoiler: boolean) {
  const area = discussion(page);
  await expect(area.getByText('No messages yet.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Account menu' }))
    .toHaveAttribute('data-hydrated', 'true', { timeout: 30_000 });
  const start = area.getByRole('button', { name: 'Start the discussion' });
  for (let stop = 0; stop < 100; stop++) {
    await page.keyboard.press('Tab');
    if (await start.evaluate(element => element === document.activeElement)) break;
  }
  await expect(start).toBeFocused();
  const input = area.getByRole('textbox', { name: 'Your message' });
  // The entry can render before its separately loaded client boundary is live.
  // Opening the form is local state only; wait for that state before typing.
  await expect(async () => {
    if (await input.isVisible()) return;
    await start.press('Enter');
    await expect(input).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await input.focus();
  await page.keyboard.type(body);
  await expect(input).toHaveValue(body);
  const languageButton = area.getByRole('button', { name: new RegExp(`^${aboutDiscussionMessages.en.language}:`) });
  await languageButton.press('Enter');
  const search = page.getByRole('searchbox', { name: 'Find a language', exact: true });
  await search.fill(language === 'ar' ? 'Arabic' : language === 'en' ? 'English' : 'Japanese');
  await search.press('Enter');
  await expect(search).toBeHidden();
  await expect(languageButton).toBeFocused();
  if (spoiler) {
    await area.getByRole('checkbox', { name: 'Contains spoilers' }).focus();
    await page.keyboard.press('Space');
    await expect(area.getByRole('checkbox', { name: 'Contains spoilers' })).toBeChecked();
  }
}

async function retained(page: Page) {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('rezics:about-post:'))
    .map(key => ({ storageKey: key, value: JSON.parse(localStorage.getItem(key)!) as Record<string, unknown> })));
}

async function recover(page: Page, body: string) {
  const area = recoveryDiscussion(page);
  for (let attempt = 0; attempt < 12; attempt++) {
    if (await area.getByRole('textbox', { name: 'Your message' }).count() === 0) break;
    await area.getByRole('button', { name: 'Try again', exact: true }).press('Enter');
    await expect(area.getByRole('button', { name: 'Posting…' })).toHaveCount(0, { timeout: 30_000 });
    if (await area.getByRole('textbox', { name: 'Your message' }).count() === 0) break;
    await expect(area.getByRole('textbox', { name: 'Your message' })).toHaveValue(body);
    await page.waitForTimeout(300);
  }
  await expect(area.getByRole('textbox', { name: 'Your message' })).toHaveCount(0, { timeout: 30_000 });
  expect(await retained(page)).toEqual([]);
}

test.use({ actionTimeout: 15_000 });

async function attachRealm(page: Page, info: TestInfo, throughEditor = true) {
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
    initialSettings: { visibility: 'public', reviewMode: 'open', reviewRequired: false, whoMaySubmit: 'granted', selfJoin: false, rules: [] },
  }, body => !!body.space && !!body.realm);
  await grant(`governance:realm:${realmSpace.realm}`, 'realm.owner', principalId, actingSubject);

  const editor = localizedPath(`/manage/z/${uuidOf(zoneSpace.space!)}/realm`, 'en');
  const zones = localizedPath(`/manage/r/${uuidOf(realmSpace.realm!)}/zones`, 'en');

  if (!throughEditor) {
    const path = `zones/${uuidOf(zoneSpace.zone!)}/configuration`;
    const read = await page.request.get(`/api/main/v1/${path}?actingSubject=${encodeURIComponent(actingSubject)}`);
    expect(read.ok(), await read.text()).toBe(true);
    await command(page, path, {
      expectedHead: (await read.json() as { revision: string }).revision, defaultRealm: realmSpace.realm, actingSubject,
    }, 'PUT');
    return { member, principalId, zoneSpace, realmSpace, actingSubject, zoneName, editor, zones };
  }

  await page.setViewportSize(phone);
  await expect(async () => {
    await page.goto(editor);
    await expect(page.getByRole('heading', { level: 2, name: 'Realm' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('No Realm is attached.')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Account menu' }))
    .toHaveAttribute('data-hydrated', 'true', { timeout: 30_000 });
  // SSR text can appear before this form's listener. Require the real change
  // handler to enable submission rather than leaving an early DOM-only value.
  await expect(async () => {
    await page.getByRole('textbox', { name: 'Realm handle' }).fill('');
    await page.getByRole('textbox', { name: 'Realm handle' }).fill(handle);
    await expect(page.getByRole('button', { name: 'Attach' })).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Attach' }).click();
  await expect(page.getByText('Attached. This Zone shows that Realm.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(realmName).or(page.getByText(handle))).toBeVisible();
  await shoot(page, 'zone-realm-attached', info);

  return { member, principalId, zoneSpace, realmSpace, actingSubject, zoneName, editor, zones };
}

async function settledZonePosts(page: Page, browser: Browser, info: TestInfo) {
  const { member, principalId, zoneSpace, realmSpace, actingSubject } = await attachRealm(page, info);
  const administrator = await platformAdministratorSession();
  await grantPlatformUse(administrator, principalId, 'realm-reply');

  const about = await publishedWorkPage(page, zoneSpace.zone!, actingSubject, principalId);
  const zoneUrl = localizedPath(zoneMemberHref(uuidOf(zoneSpace.space!), 'guide', about), 'en');
  const routePath = `/guide/${zoneUrl.split('/').at(-1)}`;
  const resolved = await page.request.get(`/api/main/v1/zones/${uuidOf(zoneSpace.zone!)}/routes?${new URLSearchParams({ path: routePath, actingSubject })}`);
  expect(resolved.ok()).toBe(true);
  expect(await resolved.json()).toMatchObject({ kind: 'detail', realm: realmSpace.realm, resource: { id: about } });
  const secondPerson = await command<{ agent: string }>(page, 'agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Harbor visitor',
  });
  expect(secondPerson.agent).not.toBe(actingSubject);
  const secondContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: phone });
  const other = await secondContext.newPage();
  try {
    await signInAtAccounts(other, '/en/manage', member);
    const sessionKey = (await secondContext.cookies()).find(cookie => cookie.name === 'rezics_session_key')?.value;
    const firstSessionKey = (await page.context().cookies()).find(cookie => cookie.name === 'rezics_session_key')?.value;
    expect(sessionKey).toBeTruthy();
    expect(sessionKey).not.toBe(firstSessionKey);
    const session = await other.request.get('/api/main/v1/me/session-agent', { headers: { 'x-session-key': sessionKey! } });
    expect(session.ok()).toBe(true);
    const selected = await other.request.put('/api/main/v1/me/session-agent', {
      headers: { 'x-session-key': sessionKey!, 'idempotency-key': randomUUID() },
      data: { actingSubject: secondPerson.agent, expectedRevision: (await session.json() as {
        sessionAgent: { revision: string | null } }).sessionAgent.revision },
    });
    expect(selected.ok()).toBe(true);
    // Both Persons use ordinary baseline posting authority; this fixture gives no reply grants.
    await Promise.all([page.goto(zoneUrl), other.goto(zoneUrl)]);
    await expect(page.getByRole('heading', { level: 1, name: 'Harbor field guide' })).toBeVisible({ timeout: 30_000 });
    // Main canonicalizes the mounted member's suffix before rendering. The
    // composer must bind that live page path, not the initial unsuffixed URL.
    const livePath = `/${addressPath(new URL(page.url()).pathname)!.tail.join('/')}`;
    expect(`/${addressPath(new URL(other.url()).pathname)!.tail.join('/')}`).toBe(livePath);
    const firstBody = 'هذه ملاحظة عن نهاية دليل الميناء.';
    const secondBody = '港の案内を読んで話し合いましょう。';
    await Promise.all([compose(page, firstBody, 'ar', true), compose(other, secondBody, 'ja', false)]);
    const attempts: Array<{ actor: string; key: string; body: Record<string, unknown>; status: number }> = [];
    const browserWrites: string[] = [];
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    for (const [tab, actor, delivery] of [[page, actingSubject, 'lost'], [other, secondPerson.agent, 'pending']] as const) {
      let first = true;
      tab.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/main/v1/') && ['POST', 'PUT', 'DELETE'].includes(request.method())) browserWrites.push(url.pathname);
      });
      await tab.route('**/v1/realms/*/about-posts', async route => {
        const request = route.request();
        expect(new URL(request.url()).pathname).toContain(`/realms/${uuidOf(realmSpace.realm!)}/about-posts`);
        const body = request.postDataJSON() as Record<string, unknown>;
        expect(body.actingSubject).toBe(actor);
        expect(body.about).toBe(about);
        expect(body.zone).toBe(zoneSpace.zone);
        expect(body.path).toBe(livePath);
        if (first) {
          arrivals++;
          if (arrivals === 2) release();
          await barrier;
        }
        // The real server handles both requests. Only delivery to the browser is faulted.
        const answer = await route.fetch();
        attempts.push({ actor, key: request.headers()['idempotency-key'] ?? '', body, status: answer.status() });
        // A resumed operation can hit a temporary owner/read fence. Deliver
        // that real 503 to the composer, which must retain the same intent;
        // below, every Person still has to reach a settled 200/201 receipt.
        expect(first ? [200, 201, 202] : [200, 201, 202, 503], await answer.text())
          .toContain(answer.status());
        if (first) {
          first = false;
          if (delivery === 'lost') await route.abort('failed');
          else if (answer.status() === 202) await route.fulfill({ response: answer });
          // When the owner already settled, model delayed receipt delivery with
          // the exact pending contract. This proves client retention, not an
          // invented second owner operation; the real same-key retry recovers it.
          else await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ operationId: randomUUID() }) });
        } else await route.fulfill({ response: answer });
      });
    }
    await Promise.all([
      discussion(page).getByRole('button', { name: 'Post message', exact: true }).press('Enter'),
      discussion(other).getByRole('button', { name: 'Post message', exact: true }).press('Enter'),
    ]);
    await expect(discussion(page).getByRole('status')).toContainText('Retry the same message', { timeout: 30_000 });
    await expect(discussion(other).getByRole('status')).toHaveText('Your message is still being processed.', { timeout: 30_000 });
    await expect(discussion(other).getByText('Your message was posted.')).toHaveCount(0);
    const firstRetained = await retained(page), secondRetained = await retained(other);
    expect(firstRetained).toHaveLength(1); expect(secondRetained).toHaveLength(1);
    for (const [tab, body, language, spoiler] of [[page, firstBody, 'ar', true], [other, secondBody, 'ja', false]] as const) {
      await expect(discussion(tab).getByRole('textbox', { name: 'Your message' })).toHaveValue(body);
      await expect(discussion(tab).getByRole('textbox', { name: 'Your message' })).toBeDisabled();
      expect((await retained(tab))[0]!.value).toMatchObject({ body, language, spoiler });
    }
    for (const [saved, actor] of [[firstRetained[0]!, actingSubject], [secondRetained[0]!, secondPerson.agent]] as const) {
      expect(retainedAboutPost(JSON.stringify(saved.value), actor, zoneSpace.zone!, livePath)).toEqual(saved.value);
    }
    await shoot(page, 'zone-discussion-response-lost', info, true);
    await shoot(other, 'zone-discussion-pending', info, true);
    await Promise.all([page.reload(), other.reload()]);
    // The server can already show the settled thread while the client boundary
    // is still loading; its effect restores the device intent before replay.
    await expect(recoveryDiscussion(page).getByRole('textbox', { name: 'Your message' })).toHaveValue(firstBody, { timeout: 30_000 });
    await expect(recoveryDiscussion(other).getByRole('textbox', { name: 'Your message' })).toHaveValue(secondBody, { timeout: 30_000 });
    expect(await retained(page)).toEqual(firstRetained); expect(await retained(other)).toEqual(secondRetained);
    await Promise.all([recover(page, firstBody), recover(other, secondBody)]);
    for (const actor of [actingSubject, secondPerson.agent]) {
      const actorAttempts = attempts.filter(attempt => attempt.actor === actor);
      expect(actorAttempts.length).toBeGreaterThanOrEqual(2);
      expect([200, 201]).toContain(actorAttempts.at(-1)!.status);
      const replay = await page.request.post(`/api/main/v1/realms/${uuidOf(realmSpace.realm!)}/about-posts`, {
        headers: { 'idempotency-key': actorAttempts[0]!.key }, data: actorAttempts[0]!.body,
      });
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toMatchObject({ author: actor, realm: realmSpace.realm, about });
      for (const attempt of actorAttempts) {
        expect(attempt.key).toBe(actorAttempts[0]!.key);
        expect(attempt.body).toEqual(actorAttempts[0]!.body);
      }
    }
    expect(browserWrites.every(path => path.endsWith('/about-posts'))).toBe(true);
    return { zoneUrl, zoneSpace, realmSpace, about, actingSubject, secondPerson, firstBody, secondBody };
  } finally {
    await secondContext.close();
  }
}

test('a Realm steward can attach, list, and withdraw a Zone', async ({ page }, info) => {
  test.setTimeout(600_000);
  const { zoneName, zones, editor } = await attachRealm(page, info);

  await page.setViewportSize(phone);
  await expect(async () => {
    await page.goto(zones);
    await expect(page.getByRole('heading', { name: 'Attached Zones' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(zoneName)).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Withdraw' })).toHaveAttribute('data-hydrated', 'true', { timeout: 30_000 });
  await shoot(page, 'realm-zone-list', info);

  await page.getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.getByText('Withdrawn. That Zone no longer shows this Realm.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(zoneName)).toHaveCount(0);
  await fits(page, 'withdrawn at 390px');
  await page.setViewportSize(desktop);
  await fits(page, 'withdrawn at 1280px');

  await page.goto(editor);
  await expect(page.getByText('No Realm is attached.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('This Zone shows this Realm.')).toHaveCount(0);
  await shoot(page, 'zone-realm-removed', info);
});

test('attached-realm-discussion: two Persons post concurrently and reopen the same thread after reload', async ({ page, browser }, info) => {
  test.setTimeout(600_000);
  const found: Findings = [];
  const { member, principalId, zoneSpace, realmSpace, actingSubject } = await attachRealm(page, info, false);
  await grantPlatformUse(await platformAdministratorSession(), principalId, 'realm-reply');
  const about = await publishedWorkPage(page, zoneSpace.zone!, actingSubject, principalId);
  const zoneUrl = localizedPath(zoneMemberHref(uuidOf(zoneSpace.space!), 'guide', about), 'en');
  const visitor = await command<{ agent: string }>(page, 'agents', {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Harbor visitor',
  });
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: phone, reducedMotion: 'reduce' });
  const other = await context.newPage();
  try {
    for (const tab of [page, other]) tab.on('requestfailed', request => {
      if (request.isNavigationRequest()) console.log(`[attached discussion document failed] ${request.url()}: ${request.failure()?.errorText}`);
    });
    await signInAtAccounts(other, '/en/manage', member);
    const sessionKey = (await context.cookies()).find(cookie => cookie.name === 'rezics_session_key')!.value;
    const session = await other.request.get('/api/main/v1/me/session-agent', { headers: { 'x-session-key': sessionKey } });
    expect(session.ok()).toBe(true);
    const selected = await other.request.put('/api/main/v1/me/session-agent', {
      headers: { 'x-session-key': sessionKey, 'idempotency-key': randomUUID() },
      data: { actingSubject: visitor.agent, expectedRevision: (await session.json() as {
        sessionAgent: { revision: string | null } }).sessionAgent.revision },
    });
    expect(selected.ok()).toBe(true);
    expect(visitor.agent).not.toBe(actingSubject);
    await Promise.all([page.waitForLoadState('networkidle'), other.waitForLoadState('networkidle')]);
    await Promise.all([visitJourney(page, zoneUrl), visitJourney(other, zoneUrl)]);
    const bodies = ['The harbor guide helped me find the pier.', '港の案内について話し合いましょう。'];
    try {
      for (const tab of [page, other]) {
        // New fixture publications can still be moving. Follow the real region's offered recovery.
        await expect(async () => {
          const retry = tab.getByRole('region', { name: aboutDiscussionMessages.en.title, exact: true })
            .getByRole('button', { name: aboutDiscussionMessages.en.retry, exact: true });
          if (await retry.isVisible()) await retry.press('Enter');
          const retryPage = tab.getByRole('alert').getByRole('link', { name: aboutDiscussionMessages.en.retry, exact: true });
          if (await retryPage.isVisible()) await retryPage.press('Enter');
          await expect(discussion(tab).getByText(aboutDiscussionMessages.en.empty)).toBeVisible({ timeout: 8_000 });
        }).toPass({ timeout: 90_000 });
      }
    } catch (error) {
      const path = `/${addressPath(new URL(page.url()).pathname)!.tail.join('/')}`;
      for (const endpoint of [
        `zones/${uuidOf(zoneSpace.zone!)}/routes?${new URLSearchParams({ path, actingSubject })}`,
        `resources/${uuidOf(about)}/page?${new URLSearchParams({ actingSubject })}`,
        `works/${uuidOf(about)}?${new URLSearchParams({ actingSubject })}`,
        `realms/${uuidOf(realmSpace.realm!)}/about-thread?${new URLSearchParams({ about, actingSubject })}`,
        `realms/${uuidOf(realmSpace.realm!)}?${new URLSearchParams({ actingSubject })}`,
        `realms/${uuidOf(realmSpace.realm!)}/joining?${new URLSearchParams({ actingSubject })}`,
      ]) {
        const answer = await page.request.get(`/api/main/v1/${endpoint}`);
        console.log(`[attached discussion diagnostic] GET /v1/${endpoint}: ${answer.status()} ${(await answer.text()).slice(0, 1500)}`);
      }
      throw error;
    }
    await Promise.all([compose(page, bodies[0]!, 'en', false), compose(other, bodies[1]!, 'ja', false)]);
    // Both real browser commands leave together; no route interception or invented receipt.
    const writes: Array<{ url: string; request: string; status: number; body: string }> = [];
    const answers: Promise<void>[] = [];
    for (const tab of [page, other]) tab.on('response', response => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/about-posts')) {
        const write = { url: response.url(), request: response.request().postData() ?? '', status: response.status(), body: '' };
        writes.push(write);
        answers.push(response.text().then(body => { write.body = body; }));
      }
    });
    await Promise.all([page, other].map(tab => keyboardReach(tab,
      discussion(tab).getByRole('button', { name: aboutDiscussionMessages.en.send, exact: true }), found, 'Post message')));
    await Promise.all([page.keyboard.press('Enter'), other.keyboard.press('Enter')]);
    for (const tab of [page, other]) {
      // A genuine 202 or lost response exposes recovery with the same retained intent.
      for (let attempt = 0; attempt < 12; attempt++) {
        const area = recoveryDiscussion(tab);
        if (await area.count() === 0) break;
        const retry = area.getByRole('button', { name: aboutDiscussionMessages.en.retry, exact: true });
        if (await retry.isVisible()) await pressByKeyboard(tab, retry, found, 'Retry retained message');
        await expect(discussion(tab).getByRole('button', { name: aboutDiscussionMessages.en.sending })).toHaveCount(0, { timeout: 30_000 });
        if ((await retained(tab)).length === 0) break;
        await tab.waitForTimeout(500);
      }
      await Promise.all(answers);
      expect(await retained(tab), JSON.stringify(writes)).toEqual([]);
    }
    await Promise.all([reloadJourney(page, zoneUrl), reloadJourney(other, zoneUrl)]);
    for (const actor of [actingSubject, visitor.agent]) {
      expect(writes.some(write => [200, 201].includes(write.status)
        && (JSON.parse(write.request) as { actingSubject: string }).actingSubject === actor), JSON.stringify(writes)).toBe(true);
    }
    for (const tab of [page, other]) {
      const area = discussion(tab);
      await expect(async () => {
        const retry = tab.getByRole('region', { name: aboutDiscussionMessages.en.title, exact: true })
          .getByRole('button', { name: aboutDiscussionMessages.en.retry, exact: true });
        if (await retry.isVisible()) await retry.press('Enter');
        const retryPage = tab.getByRole('alert').getByRole('link', { name: aboutDiscussionMessages.en.retry, exact: true });
        if (await retryPage.isVisible()) await retryPage.press('Enter');
        await expect(area.locator('article'), JSON.stringify(writes)).toHaveCount(2, { timeout: 8_000 });
      }).toPass({ timeout: 90_000 });
      for (const body of bodies) await expect(area.getByText(body, { exact: true })).toBeVisible();
    }
    const link = discussion(page).getByRole('link', { name: aboutDiscussionMessages.en.continueThread });
    const threadUrl = await link.getAttribute('href');
    expect(await discussion(other).getByRole('link', { name: aboutDiscussionMessages.en.continueThread }).getAttribute('href')).toBe(threadUrl);
    let interruptedNavigation = '';
    page.on('requestfailed', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        interruptedNavigation = request.failure()?.errorText ?? '';
        console.log(`[attached discussion navigation] ${request.url()}: ${interruptedNavigation}`);
      }
    });
    await pressByKeyboard(page, link, found, 'Open the full discussion');
    try { await expect(page).toHaveURL(/\/discussions\//, { timeout: 30_000 }); }
    catch (error) {
      if (!/net::ERR_NETWORK_CHANGED|net::ERR_ABORTED/.test(interruptedNavigation)) throw error;
      // Retry the activated destination only when Chromium reports a host transport interruption.
      await visitJourney(page, threadUrl!);
      await expect(page).toHaveURL(/\/discussions\//);
    }
    await reloadJourney(page, threadUrl!);
    for (const body of bodies) await expect(page.getByText(body, { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    // Interface locale changes preserve the attached Realm and canonical discussion.
    await visitJourney(other, localizedPath(new URL(other.url()).pathname, 'ja'));
    await expect(other.locator('html')).toHaveAttribute('lang', 'ja');
    const japanese = other.getByRole('region', { name: aboutDiscussionMessages.ja.title, exact: true })
      .filter({ has: other.getByRole('link', { name: 'North realm', exact: true }) });
    await expect(japanese.locator('article')).toHaveCount(2);
    for (const body of bodies) await expect(japanese.getByText(body, { exact: true })).toBeVisible();
    const reopen = japanese.getByRole('link', { name: aboutDiscussionMessages.ja.continueThread });
    await keyboardReach(other, reopen, found, 'Open discussion (ja)');
    expect(await reopen.getAttribute('href')).toBe(localizedPath(threadUrl!, 'ja'));
    await shoot(other, 'attached-realm-discussion-ja-reloaded', info);
    await shoot(page, 'attached-realm-thread-reloaded', info);
    expectClean(found);
  } finally {
    await context.close();
  }
});

// The Zone resource page's discussion lookup exhausts its per-request Fuseki budget.
test.fixme('two Persons recover and settle concurrent Zone-page discussion posts', async ({ page, browser }, info) => {
  test.setTimeout(600_000);
  await settledZonePosts(page, browser, info);
});

test('a Zone page reopens its discussion and keeps the thread after Realm withdrawal', async ({ page, browser }, info) => {
  test.setTimeout(600_000);
  const { zoneUrl, zoneSpace, realmSpace, about, actingSubject, secondPerson, firstBody, secondBody }
    = await settledZonePosts(page, browser, info);
  await page.goto(zoneUrl);
  const area = discussion(page);
  await expect(area.locator('article')).toHaveCount(2, { timeout: 30_000 });
  await expect(area.locator('article').filter({ hasText: secondBody })).toContainText('Harbor visitor');
  const firstArticle = area.locator('article').filter({ hasText: firstBody });
  await expect(firstArticle.locator('p').first()).not.toHaveText('');
  await expect(firstArticle.locator('details')).not.toHaveAttribute('open', '');
  await firstArticle.locator('summary').press('Enter');
  await expect(firstArticle.getByText(firstBody)).toBeVisible();
  await expect(firstArticle.locator('[lang="ar"][dir="rtl"]')).toBeVisible();
  await expect(area.locator('article').filter({ hasText: secondBody }).locator('[lang="ja"]')).toBeVisible();
  await shoot(page, 'zone-discussion-persisted', info, true);
  const threadLink = area.getByRole('link', { name: 'Open the full discussion' });
  const threadUrl = await threadLink.getAttribute('href');
  expect(threadUrl).toMatch(/\/r\/[^/]+\/discussions\//);
  await threadLink.press('Enter');
  await expect(page).toHaveURL(/\/r\/[^/]+\/discussions\//);
  await expect(page.getByText(secondBody, { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.goto(zoneUrl);
  await expect(discussion(page).locator('article')).toHaveCount(2, { timeout: 30_000 });
  const lookup = await page.request.get(`/api/main/v1/realms/${uuidOf(realmSpace.realm!)}/about-thread?${new URLSearchParams({ about, actingSubject })}`);
  expect(lookup.ok()).toBe(true);
  const thread = (await lookup.json() as { thread: { reply: string } | null }).thread;
  expect(thread?.reply).toBeTruthy();
  expect(threadUrl).toBe(localizedPath(threadHref(spaceHref(uuidOf(realmSpace.realm!), 'community'), thread!.reply), 'en'));
  const canonicalThread = await page.request.get(`/api/main/v1/realms/${uuidOf(realmSpace.realm!)}/threads/${uuidOf(thread!.reply)}?${new URLSearchParams({ actingSubject })}`);
  expect(canonicalThread.ok()).toBe(true);
  const items = (await canonicalThread.json() as { realm: string; items: Array<{ reply: string; parent: string | null; title: string | null; body: string; author: { id: string; name: string } | null }> }).items;
  expect(items).toHaveLength(2);
  expect(new Set(items.map(item => item.reply)).size).toBe(2);
  expect(items.filter(item => item.parent === null)).toHaveLength(1);
  const written = (item: typeof items[number]) => [item.title, item.body].filter(Boolean).join('\n');
  expect(items.map(written).sort()).toEqual([firstBody, secondBody].sort());
  expect(items.find(item => written(item) === firstBody)?.author?.id).toBe(actingSubject);
  expect(items.find(item => written(item) === secondBody)?.author?.id).toBe(secondPerson.agent);
  await expect(discussion(page).locator('article').filter({ hasText: firstBody })).toContainText(items.find(item => written(item) === firstBody)!.author!.name);
  // Return navigation is outside this slice: reopening the Zone URL restores its frame.

  await command(page, `zones/${uuidOf(zoneSpace.zone!)}/realm-attachment-withdrawals`, {
    realm: realmSpace.realm, actingSubject,
  });
  await page.goto(zoneUrl);
  await expect(discussion(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Open the full discussion' })).toHaveCount(0);
  await page.goto(threadUrl!);
  await expect(page.getByText(secondBody, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Harbor visitor', { exact: true }).first()).toBeVisible();
  await shoot(page, 'realm-discussion-survives-zone-withdrawal', info);
});
