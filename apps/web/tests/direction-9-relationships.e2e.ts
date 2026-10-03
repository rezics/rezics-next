import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  expect,
  test as base,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { uuidToSid } from '@rezics/model/address';
import { canonicalHref, spaceHref } from '../features/address/path.ts';
import type { ResolvedAddress } from '../features/address/client.ts';
import { messages as authMessages } from '../features/auth/messages.ts';
import { messages } from '../features/relationships/messages.ts';
import type {
  Follow,
  FollowState,
  JoinPolicy,
  Level,
  Membership,
} from '../features/relationships/types.ts';
import { messages as shellEnglish } from '../features/shell/messages.ts';
import shellChinese from '../features/shell/messages/zh-Hant.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import {
  credentials,
  directionFixture,
  fixtureStore,
  phase,
  PublicCommands,
  selectedSessionAgent,
  setupCredentials,
  short,
  type DirectionFixture,
  type SpaceRecord,
} from './direction-9-fixture.ts';

// One Playwright project owns all four combinations, as in direction-9.e2e.ts.
const locales = ['en', 'zh-Hant'] as const;
const views = [
  { name: 'desktop', viewport: { width: 1280, height: 860 } },
  { name: 'phone', viewport: { width: 390, height: 844 } },
] as const;
type Locale = (typeof locales)[number];
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
type Inventory<T> = { items: T[]; nextCursor: string | null; complete: boolean };
const run = process.env.REZICS_QA_RUN_ID ?? `g-1000-${Date.now()}`;
const browserHealth = new WeakMap<
  Page,
  {
    errors: string[];
    console: { level: string; text: string }[];
    responses: { path: string; status: number; navigation: boolean }[];
  }
>();
let memberState: StorageState | undefined;
let fixture: DirectionFixture;
let setupContext: BrowserContext;
let setupApi: PublicCommands;
let setupActor: string;

function authStatePath(origin: string, member: { email: string }) {
  const key = createHash('sha256').update(`${origin}:${member.email}`).digest('hex');
  const directory = resolve('.temp/direction-9/auth');
  mkdirSync(directory, { recursive: true });
  return resolve(directory, `${key}.json`);
}

async function authenticate(page: Page, member: { email: string; password: string }) {
  const next = '/en/settings';
  page.setDefaultTimeout(30_000);
  await page.goto(next, { waitUntil: 'domcontentloaded' });
  const sessionActor = async () =>
    selectedSessionAgent(
      { get: (path, options) => page.request.get(path, { ...options, timeout: 10_000 }) },
      await page.context().cookies(),
    );
  try {
    await sessionActor();
  } catch {
    await signInAtAccounts(page, next, member);
  }
  await expect(page).toHaveURL(next);
  const actor = await sessionActor();
  writeFileSync(
    authStatePath(String(process.env.REZICS_WEB_E2E_BASE_URL), member),
    JSON.stringify(await page.context().storageState()),
    { mode: 0o600 },
  );
  return actor;
}

async function evidence(page: Page, info: TestInfo, step: string) {
  const directory = resolve(
    '.temp/direction-9',
    run,
    info.titlePath.join('-').replace(/[^\p{L}\p{N}-]+/gu, '-'),
  );
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `${step}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(step, { path, contentType: 'image/png' });
  await info.attach(`${step}-dom`, {
    body: await page.locator('body').ariaSnapshot(),
    contentType: 'text/plain',
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    `${step}: fits the viewport`,
  ).toBe(false);
}

async function followState(api: PublicCommands, space: SpaceRecord) {
  return await api.read<FollowState>(
    `/me/follow-state?${new URLSearchParams({
      actingSubject: fixture.actor,
      target: space.space,
      kind: 'space',
    })}`,
  );
}

async function hydrated(page: Page, locale: Locale) {
  await expect(
    page
      .getByRole('button', { name: authMessages[locale].accountMenu, exact: true })
      .filter({ visible: true }),
  ).toHaveAttribute('data-hydrated', 'true');
}

async function policy(api: PublicCommands, space: SpaceRecord) {
  return await api.read<JoinPolicy>(
    `/realms/${short(space.realm)}/joining?${new URLSearchParams({ actingSubject: fixture.actor })}`,
  );
}

async function relationshipInventory<T>(
  api: PublicCommands,
  route: 'follows' | 'memberships',
  space: SpaceRecord,
) {
  // Search the public cursor-paged inventory; never assume the fixture is in
  // the first unfiltered page of this shared Account's relationships.
  const items: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const query = new URLSearchParams({ actingSubject: fixture.actor, q: space.name, limit: '20' });
    if (cursor) query.set('cursor', cursor);
    const page = await api.read<Inventory<T>>(`/me/${route}?${query}`);
    items.push(...page.items);
    if (page.complete) return items;
    expect(page.nextCursor, `${route}: incomplete inventories have continuation`).toBeTruthy();
    expect(seen.has(page.nextCursor!), `${route}: continuation advances`).toBe(false);
    seen.add(page.nextCursor!);
    cursor = page.nextCursor;
  } while (cursor);
  throw new Error(`${route}: inventory ended without completeness`);
}

async function checkSidebar(
  page: Page,
  locale: Locale,
  phone: boolean,
  space: SpaceRecord,
  followed: boolean,
  pinned: boolean,
) {
  const t = messages[locale];
  const shell = locale === 'en' ? shellEnglish : shellChinese;
  let nav: Locator;
  if (phone) {
    await page.getByRole('button', { name: shell.openNavigation, exact: true }).click();
    nav = page.getByRole('dialog', { name: shell.menu, exact: true });
  } else nav = page.locator('#side-navigation');
  await expect(nav).toBeVisible();
  for (const [title, count] of [
    [t.communities, Number(followed)],
    [t.pinned, Number(pinned)],
  ] as const) {
    const section = nav.getByRole('region', { name: title, exact: true });
    await expect(section).toBeVisible();
    const expand = section.getByRole('button', { name: t.showAll, exact: true });
    if (await expand.isVisible()) await expand.click();
    const search = section.getByRole('searchbox', { name: t.search, exact: true });
    if (await search.isVisible()) await search.fill(space.name);
    const links = section.getByRole('link').filter({ hasText: space.name });
    // Keep walking after a stale rail/drawer so the same run can expose a
    // separate Join failure. The soft assertion still fails the journey.
    await expect.soft(links, `${title}: one row per Space`).toHaveCount(count);
    if ((await links.count()) !== count)
      await evidence(page, base.info(), `sidebar-${title}-${followed}-${pinned}`);
  }
  if (phone) {
    if (followed && pinned) await evidence(page, base.info(), 'phone-sidebar-pinned');
    await nav.getByRole('button', { name: shell.close, exact: true }).click();
    await expect(nav).toBeHidden();
  }
}

async function checkManager(
  page: Page,
  locale: Locale,
  space: SpaceRecord,
  followed: boolean,
  joined: boolean,
  level: Level,
  pinned: boolean,
) {
  const t = messages[locale];
  await page.goto(`/${locale}/following`);
  await expect(page.getByRole('heading', { name: t.followingTitle, exact: true })).toBeVisible();
  await hydrated(page, locale);
  const main = page.getByRole('main');
  const search = main.getByRole('searchbox', { name: t.search, exact: true });
  const searched = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/main/v1/me/follows' &&
      url.searchParams.get('q') === space.name &&
      response.status() === 200
    );
  });
  await search.fill(space.name);
  await searched;
  const row = main.locator(`[data-follow="${space.space}"]`);
  await expect(row).toHaveCount(Number(followed));
  if (followed) {
    await expect(
      row.getByRole('button', { name: `${t.notifications}: ${t[level]}`, exact: true }),
    ).toBeVisible();
    const position = row.getByRole('spinbutton', {
      name: `${t.pinOrder} · ${space.name}`,
      exact: true,
    });
    if (pinned) await expect(position).toHaveValue('1');
    else await expect(position).toHaveCount(0);
  }
  const memberships = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/main/v1/me/memberships' &&
      url.searchParams.get('q') === space.name &&
      response.status() === 200
    );
  });
  await main.getByRole('button', { name: t.memberships, exact: true }).click();
  await memberships;
  const membership = main
    .locator('li')
    .filter({ has: page.getByRole('link', { name: space.name, exact: true }) });
  await expect(membership).toHaveCount(Number(joined));
  if (joined)
    await expect(membership.getByText(`${t.joined} · ${t[level]}`, { exact: true })).toBeVisible();
}

const test = base.extend({
  storageState: async ({}, use) => {
    await use(memberState);
  },
});

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  const start = performance.now();
  const administrator = setupCredentials();
  expect(
    administrator,
    'Zone-only setup requires the dedicated dataset administrator',
  ).toBeTruthy();
  const auth = credentials();
  const contexts: BrowserContext[] = [];
  async function signedIn(member: { email: string; password: string }) {
    const path = authStatePath(String(info.project.use.baseURL), member);
    const context = await browser.newContext({
      baseURL: info.project.use.baseURL,
      // Exercise the imported Accounts helper once with a fresh reader session;
      // administrator setup may reuse its independently refreshed cache.
      ...(member.email !== auth.member.email && existsSync(path) ? { storageState: path } : {}),
    });
    contexts.push(context);
    const page = await context.newPage();
    const actor = await phase(`G-1000 Account context ${contexts.length}`, () =>
      authenticate(page, member),
    );
    return { context, actor, api: new PublicCommands(context.request) };
  }
  try {
    const member = await signedIn(auth.member);
    const admin = await signedIn(administrator!);
    setupContext = admin.context;
    setupApi = admin.api;
    setupActor = admin.actor;
    const store = fixtureStore(String(info.project.use.baseURL), member.actor);
    const manager = store.load() ? admin : await signedIn(auth.operator);
    fixture = await directionFixture(member.api, member.actor, manager.api, store, {
      api: admin.api,
      actor: admin.actor,
    });
    // Ordinary fixture communities default to invitation admission. This
    // journey needs four self-joinable communities, configured by their owner.
    for (const space of fixture.spaces.slice(7, 11)) {
      const route = `/spaces/${short(space.space)}/settings`;
      const current = await setupApi.read<{
        generation: string;
        settings: {
          visibility: string;
          listing: string;
          admission: string;
          history: string;
        };
      }>(`${route}?actingSubject=${encodeURIComponent(fixture.owner)}`);
      if (current.settings.admission !== 'open')
        await setupApi.write(
          route,
          {
            actingSubject: fixture.owner,
            expectedGeneration: current.generation,
            reason: 'G-1000 self-join acceptance fixture',
            settings: { ...current.settings, admission: 'open' },
          },
          'PUT',
        );
      await member.api.until<JoinPolicy>(
        `/realms/${short(space.realm)}/joining?${new URLSearchParams({ actingSubject: member.actor })}`,
        (value) => value.open && value.selfJoin,
      );
    }
    memberState = await member.context.storageState();
    expect(performance.now() - start, 'fixture setup completes within two minutes').toBeLessThan(
      120_000,
    );
  } catch (error) {
    for (const [index, context] of contexts.entries()) {
      const page = context.pages()[0];
      if (page && !page.isClosed()) {
        console.log(`[G-1000 setup] context ${index}: ${new URL(page.url()).pathname}`);
        await evidence(page, info, `setup-${index}`).catch(() => {});
      }
    }
    throw error;
  } finally {
    await Promise.allSettled(
      contexts.filter((context) => context !== setupContext).map((context) => context.close()),
    );
  }
});

test.afterAll(async () => {
  if (setupContext) await setupContext.close();
});

for (const [localeIndex, locale] of locales.entries())
  for (const [viewIndex, view] of views.entries()) {
    test.describe(`Direction 9 relationships ${locale} ${view.name}`, () => {
      test.use({ viewport: view.viewport });
      test.beforeEach(async ({ page }) => {
        test.setTimeout(180_000);
        page.setDefaultTimeout(30_000);
        const health = {
          errors: [] as string[],
          console: [] as { level: string; text: string }[],
          responses: [] as { path: string; status: number; navigation: boolean }[],
        };
        browserHealth.set(page, health);
        page.on('pageerror', (error) => health.errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error' || message.type() === 'warning')
            health.console.push({ level: message.type(), text: message.text() });
        });
        page.on('response', (response) => {
          const navigation = response.request().isNavigationRequest();
          if (navigation || response.status() >= 400)
            health.responses.push({
              path: new URL(response.url()).pathname,
              status: response.status(),
              navigation,
            });
        });
        // The full matrix can outlive an access token. Navigate/refresh this
        // context before its first public setup read, as the main suite does.
        expect(
          await authenticate(page, credentials().member),
          'the refreshed session retains the fixture Agent',
        ).toBe(fixture.actor);
      });
      test.afterEach(async ({ page }, info) => {
        await info.attach('browser-health', {
          body: JSON.stringify({ url: page.url(), ...browserHealth.get(page) }),
          contentType: 'application/json',
        });
        if (info.status !== info.expectedStatus) await evidence(page, info, 'failure');
      });

      test('follow → All/Highlights/Off → pin → one-command Join → Leave → Unfollow', async ({
        page,
      }, info) => {
        // G-999 uses the named/private Spaces. These four public communities
        // isolate this journey's relationships from that concurrently run suite.
        const space = fixture.spaces[7 + localeIndex * views.length + viewIndex]!;
        const t = messages[locale];
        const api = new PublicCommands(page.request);
        const href = `/${locale}${spaceHref(space.space, 'community')}`;
        const control = page.locator(`[data-relationship="${space.realm}"]`);
        async function community() {
          const response = await page.goto(href);
          expect(response?.status(), `${locale}: canonical community renders`).toBe(200);
          await expect(
            page.getByRole('heading', { level: 1, name: space.name, exact: true }),
          ).toBeVisible();
          await hydrated(page, locale);
          await expect(
            control,
            'relationship controls have attached their handlers',
          ).toHaveAttribute('data-hydrated', 'true');
        }
        const mutations: string[] = [];
        const mutationIntents: {
          path: string;
          target?: string;
          actingSubject?: string;
          following?: boolean;
        }[] = [];
        page.on('request', (request) => {
          const path = new URL(request.url()).pathname;
          if (
            request.method() === 'POST' &&
            /^\/api\/main\/v1\/(?:follows$|me\/follows\/batch$|realms\/[^/]+\/join$|access\/membership-changes$)/.test(
              path,
            )
          ) {
            mutations.push(path);
            const body = request.postDataJSON() as {
              target?: string;
              actingSubject?: string;
              following?: boolean;
            };
            mutationIntents.push({
              path,
              target: body.target,
              actingSubject: body.actingSubject,
              following: body.following,
            });
          }
        });
        // Reruns may start after a prior failed step. Reset only this target
        // through its public commands; no global fixture or Account cleanup.
        const initialPolicy = await policy(api, space);
        if (initialPolicy.state === 'joined')
          await api.write('/access/membership-changes', {
            profile: 'access-membership-change-v1',
            kind: 'realm',
            ownerSubject: space.realm,
            memberSubject: fixture.actor,
            action: 'leave',
            expectedGeneration: initialPolicy.membershipGeneration,
            expectedPolicyRevision: initialPolicy.policyRevision,
          });
        const initialFollow = await followState(api, space);
        if (initialFollow.following)
          await api.write('/follows', {
            profile: 'follow-command-v1',
            actingSubject: fixture.actor,
            target: space.space,
            following: false,
            expectedRevision: initialFollow.revision,
          });
        await community();
        await expect(page).toHaveTitle(/REZICS/);
        await checkSidebar(page, locale, view.name === 'phone', space, false, false);

        await test.step('Follow without joining', async () => {
          expect(
            await selectedSessionAgent(page.request, await page.context().cookies()),
            'the UI and assertions use the same selected Agent',
          ).toBe(fixture.actor);
          const start = mutationIntents.length;
          await control
            .getByRole('button', { name: `${t.options} · ${space.name}`, exact: true })
            .click();
          await page.getByRole('menuitem', { name: t.explicitFollow, exact: true }).click();
          try {
            await expect
              .poll(() => followState(api, space))
              .toMatchObject({ following: true, source: 'explicit', pinPosition: null });
          } finally {
            await info.attach('follow-intents', {
              body: JSON.stringify(mutationIntents.slice(start)),
              contentType: 'application/json',
            });
          }
          expect(
            mutationIntents.slice(start),
            'Follow sends the selected Agent and an explicit positive intent once',
          ).toEqual([
            {
              path: '/api/main/v1/follows',
              target: space.realm,
              actingSubject: fixture.actor,
              following: true,
            },
          ]);
          // Main retains a person's previous notification choice on refollow.
          // A failed earlier run may have left that choice Off.
          const followed = await followState(api, space);
          expect(['all', 'highlights', 'off']).toContain(followed.level);
          expect((await policy(api, space)).state).not.toBe('joined');
          await checkSidebar(page, locale, view.name === 'phone', space, true, false);
          await evidence(page, info, 'followed');
          await checkManager(page, locale, space, true, false, followed.level!, false);
          await community();
        });

        for (const level of ['all', 'highlights', 'off'] as const)
          await test.step(`Bell: ${level}`, async () => {
            await control.getByRole('button', { name: new RegExp(`^${t.notifications}:`) }).click();
            await page.getByRole('menuitemradio', { name: t[level], exact: true }).click();
            await expect(
              control.getByRole('button', { name: `${t.notifications}: ${t[level]}`, exact: true }),
            ).toBeVisible();
            await expect
              .poll(() => followState(api, space))
              .toMatchObject({ following: true, source: 'explicit', level, pinPosition: null });
            await checkSidebar(page, locale, view.name === 'phone', space, true, false);
            await checkManager(page, locale, space, true, false, level, false);
            await community();
          });

        await test.step('Pin one Space', async () => {
          await control
            .getByRole('button', { name: `${t.options} · ${space.name}`, exact: true })
            .click();
          await page.getByRole('menuitem', { name: t.pin, exact: true }).click();
          await expect
            .poll(() => followState(api, space))
            .toMatchObject({ level: 'off', source: 'explicit', pinPosition: 0 });
          await checkSidebar(page, locale, view.name === 'phone', space, true, true);
          await evidence(page, info, 'pinned');
          await checkManager(page, locale, space, true, false, 'off', true);
          await community();
        });

        await test.step('Join sends one command and keeps the same follow', async () => {
          await info.attach('joining-policy', {
            body: JSON.stringify(await policy(api, space)),
            contentType: 'application/json',
          });
          await control
            .getByRole('button', { name: `${t.join} · ${space.name}`, exact: true })
            .click();
          const dialog = page.getByRole('dialog');
          await expect(dialog).toBeVisible();
          const start = mutations.length;
          const joining = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname ===
                `/api/main/v1/realms/${short(space.realm)}/join` &&
              response.request().method() === 'POST',
          );
          await dialog.getByRole('button', { name: t.join, exact: true }).click();
          const receipt = await joining;
          // Chromium may not retain a failed response body. Diagnostics must
          // not replace the HTTP-status and public-state assertions.
          const body = (await receipt.json().catch(() => null)) as unknown;
          await info.attach('join-receipt', {
            body: JSON.stringify({ status: receipt.status(), body }),
            contentType: 'application/json',
          });
          expect(receipt.status(), 'self-join succeeds on the displayed open policy').toBe(200);
          await expect(dialog).toBeHidden({ timeout: 30_000 });
          await expect(
            control.getByRole('button', {
              name: `${t.joined} · ${space.name} · ${t.leave}`,
              exact: true,
            }),
          ).toBeVisible();
          expect(mutations.slice(start), 'Join does not issue a separate Follow command').toEqual([
            `/api/main/v1/realms/${short(space.realm)}/join`,
          ]);
          await expect
            .poll(() => followState(api, space))
            .toMatchObject({ following: true, source: 'explicit', level: 'off', pinPosition: 0 });
          expect(
            (await relationshipInventory<Follow>(api, 'follows', space)).filter(
              (item) => item.id === space.space,
            ),
          ).toHaveLength(1);
          expect(
            (await relationshipInventory<Membership>(api, 'memberships', space)).filter(
              (item) => item.realm === space.realm,
            ),
          ).toHaveLength(1);
          await checkSidebar(page, locale, view.name === 'phone', space, true, true);
          await evidence(page, info, 'joined');
          await checkManager(page, locale, space, true, true, 'off', true);
          await community();
        });

        await test.step('Leave retains the explicit follow, bell and pin', async () => {
          page.once('dialog', (dialog) => {
            expect(dialog.message()).toContain(t.confirmLeave);
            void dialog.accept();
          });
          await control
            .getByRole('button', { name: `${t.joined} · ${space.name} · ${t.leave}`, exact: true })
            .click();
          await expect.poll(async () => (await policy(api, space)).state).toBe('left');
          await expect
            .poll(() => followState(api, space))
            .toMatchObject({ following: true, source: 'explicit', level: 'off', pinPosition: 0 });
          await expect(
            control.getByRole('button', { name: `${t.join} · ${space.name}`, exact: true }),
          ).toBeVisible();
          await checkSidebar(page, locale, view.name === 'phone', space, true, true);
          await checkManager(page, locale, space, true, false, 'off', true);
          await community();
        });

        await test.step('Unfollow removes the Space from both sidebar sections and the manager', async () => {
          await control
            .getByRole('button', { name: `${t.options} · ${space.name}`, exact: true })
            .click();
          await page.getByRole('menuitem', { name: t.unfollow, exact: true }).click();
          await expect.poll(() => followState(api, space)).toMatchObject({ following: false });
          await checkSidebar(page, locale, view.name === 'phone', space, false, false);
          await expect(
            control.getByRole('button', { name: new RegExp(`^${t.notifications}:`) }),
          ).toHaveCount(0);
          await evidence(page, info, 'unfollowed');
          await checkManager(page, locale, space, false, false, 'off', false);
        });
        expect(
          browserHealth.get(page)?.errors,
          'relationship journey has no browser runtime errors',
        ).toEqual([]);
      });

      test('standalone site: public Zone-only creation, one-hop site aliases and no community surface', async ({
        page,
      }, info) => {
        expect(
          await authenticate(setupContext.pages()[0]!, setupCredentials()!),
          'the setup session retains the Space owner',
        ).toBe(setupActor);
        const created = await setupApi
          .reusable(`g-1000:${fixture.actor}:${locale}:${view.name}`)
          .write<{ space: string; zone: string; capabilities: string[] }>('/spaces', {
            profile: 'space-zone-v1',
            name: `Direction 9 standalone ${locale} ${view.name}`,
            language: 'en',
            capabilities: ['zone'],
            visibility: 'public',
            listing: 'listed',
            actingSubject: setupActor,
          });
        expect(created.capabilities).toEqual(['zone']);
        const response = await page.request.get(
          `/api/main/v1/addresses/resolve?${new URLSearchParams({
            scope: 'space',
            key: short(created.space),
            actingSubject: fixture.actor,
          })}`,
          { headers: { 'accept-language': locale, 'x-rezics-display-languages': locale } },
        );
        expect(response.status()).toBe(200);
        const address = (await response.json()) as ResolvedAddress;
        expect(address.holder).toBe(created.space);
        expect(address.capabilities?.zone).toBe(created.zone);
        expect(address.capabilities?.realm).toBeUndefined();
        const canonical = canonicalHref(address.canonical, locale, address.canonical.slugSource, {
          surface: 'site',
        });
        expect(canonical).toMatch(new RegExp(`^/${locale}/z/`));
        const root = await page.goto(canonical);
        expect(root?.status(), 'canonical standalone site renders').toBe(200);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
          'href',
          new URL(canonical, page.url()).href,
        );
        await evidence(page, info, 'standalone-canonical');
        const sid = uuidToSid(short(created.space));
        const forms = new Set([
          `/${locale}/z/${sid}`,
          `/${locale}/z/${sid}-stale-title`,
          `/${locale}/z/${short(created.space)}`,
          `/${locale}/z/${short(created.space).toUpperCase()}`,
          `/${locale}/z/${short(created.zone)}`,
          `/${locale}/z/${uuidToSid(short(created.zone))}`,
          `/${locale}/r/${short(created.zone)}`,
          `/${locale}/r/${sid}`,
        ]);
        for (const form of forms)
          await test.step(`One permanent redirect: ${form}`, async () => {
            const legacy = await page.request.get(`${form}?direction9=preserved`, {
              maxRedirects: 0,
            });
            expect(legacy.status()).toBe(301);
            const destination = new URL(legacy.headers().location!, page.url());
            expect(destination.pathname).toBe(canonical);
            expect(destination.search).toBe('?direction9=preserved');
            expect((await page.request.get(destination.href, { maxRedirects: 0 })).status()).toBe(
              200,
            );
            await page.goto(`${form}?direction9=preserved#direction9`);
            await expect(page).toHaveURL(
              `${new URL(canonical, page.url()).href}?direction9=preserved#direction9`,
            );
          });
        // A Realm-free /r home is a legacy site alias. Community subroutes still
        // require a Realm capability and cannot become site pages.
        const communityResponses: { path: string; status: number; location: string | null }[] = [];
        for (const form of [`/${locale}/r/${sid}/members`, `/${locale}/r/${sid}/rules`]) {
          const read = await page.request.get(form, { maxRedirects: 0 });
          communityResponses.push({
            path: form,
            status: read.status(),
            location: read.headers().location ?? null,
          });
          expect.soft(read.status(), `${form}: no Realm capability`).toBe(404);
        }
        await info.attach('community-capability-responses', {
          body: JSON.stringify(communityResponses),
          contentType: 'application/json',
        });
        await evidence(page, info, 'standalone-aliases');
        expect(
          browserHealth.get(page)?.errors,
          'standalone site has no browser runtime errors',
        ).toEqual([]);
      });
    });
  }
