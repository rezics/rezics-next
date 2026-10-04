import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  expect,
  test,
  type Browser,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { entityPickerMessages } from '../../../packages/ui/src/components/entity-picker-messages.ts';
import { uuidToSid } from '@rezics/model/address';
import { canonicalHref, spaceHref, type Surface } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import type { ResolvedAddress } from '../features/address/client.ts';
import { messages as authMessages } from '../features/auth/messages.ts';
import { browseMessages } from '../features/discover/browse-messages.ts';
import { accessMessages } from '../features/manage/settings-messages.ts';
import { messages as relationshipMessages } from '../features/relationships/messages.ts';
import { messages as studioMessages } from '../features/studio/messages.ts';
import studioChinese from '../features/studio/messages/zh-Hant.ts';
import { messages as shellEnglish } from '../features/shell/messages.ts';
import shellChinese from '../features/shell/messages/zh-Hant.ts';
import { copyOf as wikiCopy } from '../features/wiki/messages.ts';
import { localeNames } from '../i18n/define.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import {
  credentials,
  setupCredentials,
  PublicCommands,
  directionFixture,
  fixtureStore,
  seedRatingPopulations,
  ownRequests,
  phase,
  readyDirection,
  resetAdmission,
  resetSubmission,
  prepareSubmissionReview,
  short,
  selectedSessionAgent,
  seedWikiPosition,
  type DirectionFixture,
} from './direction-9-fixture.ts';

// Run the desktop-chrome project once: this file owns its four locale/viewport
// combinations. The manager supplies REZICS_WEB_E2E_BASE_URL and the auth path.
const views = [
  { name: 'desktop', viewport: { width: 1280, height: 860 } },
  { name: 'phone', viewport: { width: 390, height: 844 } },
] as const;
const locales = ['en', 'zh-Hant'] as const;
type Locale = (typeof locales)[number];
const run = process.env.REZICS_QA_RUN_ID ?? `shared-${Date.now()}`;
async function screenshot(page: Page, info: TestInfo, step: string) {
  const directory = resolve(
    '.temp/direction-9',
    run,
    info.project.name,
    info.titlePath.join('-').replace(/[^\p{L}\p{N}-]+/gu, '-'),
  );
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `${step}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(step, { path, contentType: 'image/png' });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    `${step}: the page fits the viewport`,
  ).toBe(false);
}

function discoverResource(page: Page, name: string) {
  // Resource cards include their type in the link's accessible name. The
  // resource heading identifies the result independently of that extra label.
  return page
    .getByRole('main')
    .getByRole('link')
    .filter({
      has: page.getByRole('heading', { name, exact: true }),
    });
}

async function selectActor(page: Page, actor: string, next: string) {
  const sessionKey = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'rezics_session_key',
  )?.value;
  expect(sessionKey).toBeTruthy();
  const state = await page.request.get('/api/main/v1/me/session-agent', {
    headers: { 'x-session-key': sessionKey! },
  });
  expect(state.status()).toBe(200);
  const current = (await state.json()) as { sessionAgent: { revision: string | null } };
  const response = await page.request.post('/identity/select', {
    maxRedirects: 0,
    form: {
      agent: actor,
      next,
      locale: next.split('/')[1]!,
      sessionRevision: current.sessionAgent.revision ?? '',
    },
  });
  expect(response.status()).toBe(303);
  expect(response.headers().location).not.toContain('error=');
  await page.goto(next);
}

/** Each context signs in independently: rotating refresh tokens cannot be copied. */
async function authenticate(
  page: Page,
  next: string,
  member: { email: string; password: string },
  onboard = false,
) {
  page.setDefaultTimeout(30_000);
  await signInAtAccounts(page, next, member, onboard);
  if (new URL(page.url()).pathname === '/en/onboarding') {
    const sessionKey = (await page.context().cookies()).find(
      (cookie) => cookie.name === 'rezics_session_key',
    )?.value;
    expect(sessionKey).toBeTruthy();
    const person = await new PublicCommands(page.request).write<{ agent: string }>(
      '/me/onboarding',
      {
        profile: 'person-onboarding-v1',
        displayName: 'Direction 9 fixture manager',
      },
      'POST',
      { 'x-session-key': sessionKey! },
    );
    await selectActor(page, person.agent, next);
  }
  await expect(page).toHaveURL(next);
}

/** The fixture's second Account may not have published a Main Person yet. */
async function signInManager(page: Page) {
  await authenticate(page, '/en/settings', credentials().operator, true);
}

async function setupCommands<T>(
  browser: Browser,
  info: TestInfo,
  action: (api: PublicCommands) => Promise<T>,
) {
  const administrator = setupCredentials() ?? credentials().operator;
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
  });
  try {
    const page = await context.newPage();
    await authenticate(page, '/en/settings', administrator, true);
    return await action(new PublicCommands(context.request));
  } finally {
    await context.close();
  }
}

async function address(page: Page, scope: string, holder: string, locale: Locale) {
  const actingSubject = await selectedSessionAgent(page.request, await page.context().cookies());
  expect(actingSubject, 'authenticated address reads carry the selected Agent').toBeTruthy();
  const response = await page.request.get(
    `/api/main/v1/addresses/resolve?${new URLSearchParams({
      scope,
      key: short(holder),
      actingSubject,
    })}`,
    {
      timeout: 30_000,
      headers: { 'accept-language': locale, 'x-rezics-display-languages': locale },
    },
  );
  expect(response.status(), `resolve ${scope}`).toBe(200);
  return (await response.json()) as ResolvedAddress;
}

async function walkAddress(
  page: Page,
  info: TestInfo,
  locale: Locale,
  read: ResolvedAddress,
  name: string,
  surface?: Surface,
) {
  const canonical = canonicalHref(read.canonical, locale, read.canonical.suffixSource, { surface });
  const response = await page.goto(canonical);
  expect(response?.status(), `${name} canonical response`).toBe(200);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    new URL(canonical, page.url()).href,
  );
  await screenshot(page, info, `${name}-canonical`);
  const prefix =
    // ast-grep-ignore: web-links-use-address -- Select raw legacy route families to verify redirect normalization independently.
    surface === 'community' ? '/r/' : surface === 'site' ? '/z/' : read.canonical.prefix;
  // ast-grep-ignore: web-links-use-address -- Named Agent routes must also be probed through their legacy identity family.
  const identityPrefix = prefix === '/@' ? '/a/' : prefix;
  const id = short(read.holder),
    sid = uuidToSid(id);
  const forms = new Set([
    `/${locale}${identityPrefix}${id}`,
    `/${locale}${identityPrefix}${id.toUpperCase()}`,
    `/${locale}${identityPrefix}${sid}`,
    `/${locale}${identityPrefix}${sid}-stale-title`,
    `/${locale}${prefix}${encodeURIComponent(read.canonical.key)}`,
  ]);
  // ast-grep-ignore: web-links-use-address -- Both former Agent handle forms are independent redirect inputs.
  if (prefix === '/@') {
    // ast-grep-ignore: web-links-use-address -- A UUID in the handle route deliberately exercises the legacy redirect.
    forms.add(`/${locale}/@${id}`);
    // ast-grep-ignore: web-links-use-address -- The former native Agent handle deliberately exercises the legacy redirect.
    forms.add(`/${locale}/@agent-${id}`);
  }
  const capability = surface && read.capabilities?.[surface === 'community' ? 'realm' : 'zone'];
  if (capability) forms.add(`/${locale}${identityPrefix}${short(capability)}`);
  for (const form of forms) {
    if (form === canonical) continue;
    const legacy = await page.request.get(`${form}?direction9=preserved`, {
      maxRedirects: 0,
      timeout: 30_000,
    });
    expect(legacy.status(), `${name}: ${form} is one permanent redirect`).toBe(301);
    const destination = new URL(legacy.headers().location!, page.url());
    expect(destination.pathname).toBe(canonical);
    expect(destination.search).toBe('?direction9=preserved');
    const terminal = await page.request.get(destination.href, { maxRedirects: 0, timeout: 30_000 });
    expect(terminal.status(), `${name}: ${form} reaches 200 without another redirect`).toBe(200);
    await page.goto(`${form}?direction9=preserved#direction9`);
    await expect(page).toHaveURL(
      `${new URL(canonical, page.url()).href}?direction9=preserved#direction9`,
    );
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await screenshot(page, info, `${name}-form-${[...forms].indexOf(form)}`);
  }
}

// Setup is API-only after real sign-in; no SQL, in-process app, seeded IDs or
// mocked routes can make a browser acceptance journey pass.
let fixture: DirectionFixture;
test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(120_000);
  const start = performance.now();
  const administrator = setupCredentials();
  const options = { baseURL: info.project.use.baseURL };
  const context = await browser.newContext(options);
  const managerContext = await browser.newContext(options);
  const setupContext = await browser.newContext(options);
  const api = new PublicCommands(context.request);
  const managerApi = new PublicCommands(managerContext.request);
  try {
    const page = await context.newPage();
    const managerPage = await managerContext.newPage();
    const setupPage = administrator ? await setupContext.newPage() : null;
    expect(
      credentials().operator.email,
      'requester and manager must be different Accounts',
    ).not.toBe(credentials().member.email);
    await phase('real Account sign-in', () =>
      // One at a time: parallel first sign-ins race the Accounts dev server's first compile.
      authenticate(page, '/en/settings', credentials().member).then(() =>
        signInManager(managerPage),
      ),
    );
    if (administrator && setupPage)
      await phase('administrator Account sign-in', () =>
        authenticate(setupPage, '/en/settings', administrator, true),
      );
    const sessionKey = (await context.cookies()).find(
      (cookie) => cookie.name === 'rezics_session_key',
    )?.value;
    expect(sessionKey).toBeTruthy();
    const session = await page.request.get('/api/main/v1/me/session-agent', {
      headers: { 'x-session-key': sessionKey! },
    });
    expect(session.status()).toBe(200);
    const { sessionAgent } = (await session.json()) as {
      sessionAgent: { actingSubject: string };
    };
    let setup: { api: PublicCommands; actor: string } | undefined;
    if (setupPage) {
      const setupKey = (await setupContext.cookies()).find(
        (cookie) => cookie.name === 'rezics_session_key',
      )?.value;
      expect(setupKey).toBeTruthy();
      const response = await setupPage.request.get('/api/main/v1/me/session-agent', {
        headers: { 'x-session-key': setupKey! },
      });
      expect(response.status()).toBe(200);
      const selected = (await response.json()) as { sessionAgent: { actingSubject: string } };
      setup = {
        api: new PublicCommands(setupContext.request),
        actor: selected.sessionAgent.actingSubject,
      };
    }
    fixture = await directionFixture(
      api,
      sessionAgent.actingSubject,
      managerApi,
      fixtureStore(String(info.project.use.baseURL), sessionAgent.actingSubject),
      setup,
    );
    const elapsedMs = Math.round(performance.now() - start);
    console.log(`[direction-9 setup] total: ${elapsedMs} ms`);
    await info.attach('fixture', {
      body: JSON.stringify(
        {
          elapsedMs,
          fixture,
          requests: [...api.timings, ...managerApi.timings, ...(setup?.api.timings ?? [])],
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    expect(elapsedMs, 'routine fixture preparation finishes in under two minutes').toBeLessThan(
      120_000,
    );
  } catch (error) {
    const directory = resolve('.temp/direction-9', run, 'setup');
    mkdirSync(directory, { recursive: true });
    await info.attach('setup-requests', {
      body: JSON.stringify([...api.timings, ...managerApi.timings], null, 2),
      contentType: 'application/json',
    });
    for (const [name, active] of [
      ['member', context],
      ['manager', managerContext],
      ['administrator', setupContext],
    ] as const) {
      const page = active.pages()[0];
      if (page && !page.isClosed()) {
        console.log(`[direction-9 setup] ${name} stopped at ${new URL(page.url()).pathname}`);
        const path = resolve(directory, `${name}-failure.png`);
        await page.screenshot({ path, fullPage: true });
        await info.attach(`setup-${name}-failure`, { path, contentType: 'image/png' });
      }
    }
    throw error;
  } finally {
    await Promise.allSettled([context.close(), managerContext.close(), setupContext.close()]);
  }
});

for (const locale of locales)
  for (const view of views) {
    test.describe(`Direction 9 ${locale} ${view.name}`, () => {
      test.use({ viewport: view.viewport });
      test.beforeEach(async ({ page }) => {
        test.setTimeout(180_000);
        page.setDefaultTimeout(30_000);
        page.setDefaultNavigationTimeout(30_000);
        await authenticate(page, `/${locale}/settings`, credentials().member);
      });
      test.afterEach(async ({ page }, info) => {
        if (info.status !== info.expectedStatus) await screenshot(page, info, 'failure');
      });

      // Each owner/surface has its own journey budget. The full matrix performs
      // dozens of successful document reads and used to exhaust one 180 s test
      // at the Work row, misreporting the current short read as a hung request.
      for (const [scope, holder, name, surface] of [
        ['agent', () => fixture.namedPerson, 'named-person', undefined],
        ['agent', () => fixture.unnamedPerson, 'unnamed-person', undefined],
        ['space', () => fixture.named.space, 'named-community', 'community'],
        ['space', () => fixture.named.space, 'named-site', 'site'],
        ['space', () => fixture.unnamed.space, 'unnamed-community', 'community'],
        ['work', () => fixture.work.work, 'work', undefined],
        ['concept', () => fixture.topic.concept, 'concept', undefined],
      ] as const) {
        test(`addresses: ${name}`, async ({ page }, info) => {
          await walkAddress(
            page,
            info,
            locale,
            await address(page, scope, holder(), locale),
            name,
            surface,
          );
        });
      }
      test('addresses: legacy site and Zone capability links', async ({ page }, info) => {
        // The fixture mounts this Work as the document at /story. Member
        // detail paths belong to Collection mounts, not this Work mount.
        // ast-grep-ignore: web-links-use-address -- The old community-prefixed site path is the redirect input under test.
        const old = `/${locale}/r/${fixture.named.handle}/story`;
        const expected = new URL(
          (
            await page.request.get(`${old}?position=all`, {
              maxRedirects: 0,
              timeout: 30_000,
            })
          ).headers().location!,
          page.url(),
        );
        expect(expected.pathname).toMatch(new RegExp(`^/${locale}/z/`));
        const response = await page.request.get(`${old}?position=all`, {
          maxRedirects: 0,
          timeout: 30_000,
        });
        expect(response.status()).toBe(301);
        expect(expected.search).toBe('?position=all');
        expect(
          (
            await page.request.get(expected.href, {
              maxRedirects: 0,
              timeout: 30_000,
            })
          ).status(),
        ).toBe(200);
        await page.goto(old);
        await expect(page).toHaveURL(new URL(expected.pathname, page.url()).href);
        await screenshot(page, info, 'legacy-r-site');
        // ast-grep-ignore: web-links-use-address -- A Zone capability UUID in the community family must redirect to its site.
        const legacyZone = await page.request.get(`/${locale}/r/${short(fixture.zone)}`, {
          maxRedirects: 0,
          timeout: 30_000,
        });
        expect(legacyZone.status(), 'a legacy Zone identity opens its site surface').toBe(301);
        const siteTarget = new URL(legacyZone.headers().location!, page.url());
        expect(siteTarget.pathname).toMatch(new RegExp(`^/${locale}/z/`));
        expect(
          (
            await page.request.get(siteTarget.href, {
              maxRedirects: 0,
              timeout: 30_000,
            })
          ).status(),
        ).toBe(200);
        // ast-grep-ignore: web-links-use-address -- Exercise the same legacy Zone capability input in the browser.
        await page.goto(`/${locale}/r/${short(fixture.zone)}`);
        await screenshot(page, info, 'legacy-zone-identity');
      });

      test('account menu: second-level Language and Appearance show their current values', async ({
        page,
      }, info) => {
        const preferences = await page.request.get('/api/preferences');
        expect(preferences.status()).toBe(200);
        const current = (await preferences.json()) as {
          revision: number;
          displayMode: string;
          showZoneThemes: boolean;
        };
        if (current.displayMode !== 'system') {
          const reset = await page.request.put('/api/preferences', {
            headers: { origin: new URL(page.url()).origin },
            data: {
              expectedRevision: current.revision,
              displayMode: 'system',
              showZoneThemes: current.showZoneThemes,
            },
          });
          expect(reset.status()).toBe(200);
        }
        await page
          .context()
          .addCookies([{ name: 'rezics_theme', value: 'system', url: new URL(page.url()).origin }]);
        await page.reload();
        const t = authMessages[locale];
        const shell = locale === 'en' ? shellEnglish : shellChinese;
        const phone = view.name === 'phone';
        const trigger = page
          .getByRole('button', { name: t.accountMenu, exact: true })
          .filter({ visible: true });
        await expect(trigger).toHaveAttribute('data-hydrated', 'true');
        await trigger.click();
        const root = phone
          ? page.getByRole('dialog', { name: t.accountMenu, exact: true })
          : page.getByRole('menu');
        const languageName = `${t.language}: ${localeNames[locale]}`;
        await expect(
          root.getByRole(phone ? 'button' : 'menuitem', { name: languageName, exact: true }),
        ).toBeVisible();
        await expect(
          root.getByRole(phone ? 'button' : 'menuitem', {
            name: `${t.appearance}: ${shell.themeSystem}`,
            exact: true,
          }),
        ).toBeVisible();
        await expect(root.getByRole(phone ? 'radio' : 'menuitemradio')).toHaveCount(0);
        await screenshot(page, info, 'account-root');
        await root
          .getByRole(phone ? 'button' : 'menuitem', { name: languageName, exact: true })
          .click();
        const language = phone ? page.getByRole('dialog', { name: t.language, exact: true }) : page;
        const currentLanguage = language.getByRole(phone ? 'radio' : 'menuitemradio', {
          name: localeNames[locale],
          exact: true,
        });
        await expect(currentLanguage).toBeChecked();
        await expect(language.getByRole(phone ? 'radio' : 'menuitemradio')).toHaveCount(8);
        await screenshot(page, info, 'account-language');
        if (phone) await language.getByRole('button', { name: t.back, exact: true }).click();
        else {
          await page.keyboard.press('Escape');
          await expect(page.getByRole('menu')).toHaveCount(0);
          await trigger.click();
        }
        await root
          .getByRole(phone ? 'button' : 'menuitem', {
            name: `${t.appearance}: ${shell.themeSystem}`,
            exact: true,
          })
          .click();
        const appearance = phone
          ? page.getByRole('dialog', { name: t.appearance, exact: true })
          : page;
        await expect(
          appearance.getByRole(phone ? 'radio' : 'menuitemradio', {
            name: shell.themeSystem,
            exact: true,
          }),
        ).toBeChecked();
        if (phone) {
          await appearance.getByText(shell.themeDark, { exact: true }).click();
          await expect(
            appearance.getByRole('radio', { name: shell.themeDark, exact: true }),
          ).toBeChecked();
        } else
          await appearance
            .getByRole('menuitemradio', { name: shell.themeDark, exact: true })
            .click();
        await expect(page.locator('html')).toHaveClass(/dark/);
        if (phone) await appearance.getByRole('button', { name: t.back, exact: true }).click();
        else await trigger.click();
        await expect(
          root.getByRole(phone ? 'button' : 'menuitem', {
            name: `${t.appearance}: ${shell.themeDark}`,
            exact: true,
          }),
        ).toBeVisible();
        await screenshot(page, info, 'account-dark-current');
        await root
          .getByRole(phone ? 'button' : 'menuitem', {
            name: `${t.appearance}: ${shell.themeDark}`,
            exact: true,
          })
          .click();
        const reset = phone ? page.getByRole('dialog', { name: t.appearance, exact: true }) : page;
        if (phone) {
          await reset.getByText(shell.themeSystem, { exact: true }).click();
          await expect(
            reset.getByRole('radio', { name: shell.themeSystem, exact: true }),
          ).toBeChecked();
        } else
          await reset.getByRole('menuitemradio', { name: shell.themeSystem, exact: true }).click();
      });

      test('Discover: type tabs, topic picker chips and Communities continuation', async ({
        page,
      }, info) => {
        await readyDirection(new PublicCommands(page.request), fixture, 'communities');
        const t = browseMessages[locale];
        const topicName = fixture.topic.names[locale];
        await page.goto(`/${locale}/discover`);
        for (const [tab, label] of [
          ['works', t.works],
          ['communities', t.communities],
          ['sites', t.sites],
          ['people', t.people],
          ['lists', t.lists],
          ['topics', t.topics],
        ] as const) {
          const link = page
            .getByRole('navigation', { name: t.type, exact: true })
            .getByRole('link', { name: label, exact: true });
          await link.click();
          await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe(tab);
          await expect(link).toHaveAttribute('aria-current', 'page');
          await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
          await screenshot(page, info, `discover-${tab}`);
        }
        await page.getByRole('combobox', { name: t.topics, exact: true }).fill(topicName);
        await page.getByRole('option', { name: new RegExp(topicName) }).click();
        await expect
          .poll(() => new URL(page.url()).searchParams.get('ci') ?? '')
          .toContain(short(fixture.topic.concept));
        await screenshot(page, info, 'topic-included');
        const picker = entityPickerMessages[locale];
        await page
          .getByRole('button', {
            name: picker.exclude.replace('{label}', topicName),
            exact: true,
          })
          .click();
        await expect
          .poll(() => new URL(page.url()).searchParams.get('ce') ?? '')
          .toContain(short(fixture.topic.concept));
        await expect.poll(() => new URL(page.url()).searchParams.has('ci')).toBe(false);
        await screenshot(page, info, 'topic-excluded');
        // EntityPicker localizes these actions independently of Discover.
        await page
          .getByRole('button', {
            name: picker.remove.replace('{label}', topicName),
            exact: true,
          })
          .click();
        await expect.poll(() => new URL(page.url()).searchParams.has('ce')).toBe(false);
        await page.goto(`/${locale}/discover?tab=communities`);
        const communityLinks = page
          .getByRole('main')
          .getByRole('region', { name: t.communities, exact: true })
          .getByRole('list')
          .getByRole('link');
        await expect(communityLinks.first()).toBeVisible();
        // Conditions has its own suggestion list that repeats on every page.
        // Resource destinations carry identity; different communities may share a name.
        const destinations = () =>
          communityLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href')));
        const firstLinks = await destinations();
        expect(firstLinks.every((href) => href !== null)).toBe(true);
        expect(new Set(firstLinks).size).toBe(firstLinks.length);
        await page.getByRole('link', { name: t.more, exact: true }).click();
        await expect.poll(() => new URL(page.url()).searchParams.get('cursor')).toBeTruthy();
        // The address can change before the streamed destination list arrives.
        await expect(async () => {
          const secondLinks = await destinations();
          expect(secondLinks.length).toBeGreaterThan(0);
          expect(secondLinks.every((href) => href !== null)).toBe(true);
          expect(new Set(secondLinks).size).toBe(secondLinks.length);
          expect(secondLinks.some((href) => firstLinks.includes(href))).toBe(false);
        }).toPass({ timeout: 30_000 });
        await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
        await expect(discoverResource(page, fixture.unlisted.name)).toHaveCount(0);
        await screenshot(page, info, 'communities-next-page');
      });

      test('Discover: choosing Communities after Works keeps the latest tab', async ({
        page,
      }, info) => {
        const t = browseMessages[locale];
        await page.goto(`/${locale}/discover`);
        const tabs = page.getByRole('navigation', { name: t.type, exact: true });
        // Do not wait for Works to commit before choosing the next destination.
        await tabs.getByRole('link', { name: t.works, exact: true }).click({ noWaitAfter: true });
        const communities = tabs.getByRole('link', { name: t.communities, exact: true });
        await communities.click();
        await expect(page).toHaveURL((url) => url.searchParams.get('tab') === 'communities', {
          timeout: 30_000,
        });
        await expect(communities).toHaveAttribute('aria-current', 'page');
        await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
        await expect(
          page
            .getByRole('main')
            .getByRole('region', { name: t.communities, exact: true })
            .getByRole('link')
            .first(),
        ).toBeVisible();
        await screenshot(page, info, 'discover-latest-community-tab');
      });

      test('rating scope: choose a population past page one', async ({ page, browser }, info) => {
        const administrator = setupCredentials() ?? credentials().operator;
        const setupContext = await browser.newContext({
          baseURL: info.project.use.baseURL,
        });
        try {
          const setupPage = await setupContext.newPage();
          await authenticate(setupPage, '/en/settings', administrator, true);
          await seedRatingPopulations(new PublicCommands(setupContext.request), fixture);
        } finally {
          await setupContext.close();
        }
        await readyDirection(new PublicCommands(page.request), fixture, 'ratings');
        const t = browseMessages[locale];
        const workAddress = await address(page, 'work', fixture.work.work, locale);
        const overview = canonicalHref(workAddress.canonical, locale);
        await page.goto(overview);
        await expect(page).toHaveURL(overview);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          workAddress.canonical.suffixSource,
        );
        await page.getByRole('button', { name: t.otherCommunities, exact: true }).first().click();
        await page.getByRole('combobox', { name: t.chooseCommunity, exact: true }).click();
        await expect(page.getByRole('option').first()).toBeVisible();
        const first = await page.getByRole('option').allTextContents();
        await screenshot(page, info, 'population-first-page');
        await page.getByRole('button', { name: t.more, exact: true }).click();
        await expect.poll(() => page.getByRole('option').count()).toBeGreaterThan(first.length);
        const options = await page.getByRole('option').allTextContents();
        const later = options.find((name) => !first.includes(name));
        expect(later, 'a population beyond the first page is selectable').toBeTruthy();
        await page.getByRole('option').nth(options.indexOf(later!)).click();
        await expect.poll(() => new URL(page.url()).searchParams.get('scope')).toBe('realm');
        await expect.poll(() => new URL(page.url()).searchParams.get('realm')).toBeTruthy();
        await screenshot(page, info, 'population-selected');
      });

      test('submission: find a Realm by search and submit a published text', async ({
        page,
        browser,
      }, info) => {
        const t = browseMessages[locale];
        const community =
          fixture.spaces[7 + locales.indexOf(locale) * views.length + views.indexOf(view)]!;
        await setupCommands(browser, info, (api) =>
          prepareSubmissionReview(api, fixture, community),
        );
        const submitted = { ...fixture, work: fixture.story };
        await selectActor(page, fixture.actor, `/${locale}/settings`);
        await phase(`reset submission ${locale} ${view.name}`, () =>
          resetSubmission(new PublicCommands(page.request), submitted, community),
        );
        await page.goto(
          `/${locale}/studio/@agent-${short(fixture.actor)}/works/${short(submitted.work.work)}?tab=realms`,
        );
        await page
          .getByRole('combobox', { name: t.chooseCommunity, exact: true })
          .fill(community.name);
        await page.getByRole('option', { name: community.name, exact: true }).click();
        await screenshot(page, info, 'submit-community-found');
        // Names come from the Studio catalog; keep the localized accessible action.
        await page
          .getByRole('button', {
            name: (locale === 'en' ? studioMessages : studioChinese).submit,
            exact: true,
          })
          .click();
        await expect(
          page.getByRole('main').getByRole('status').filter({ hasText: community.name }),
        ).toBeVisible();
        await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
        await screenshot(page, info, 'submission-confirmed');
      });

      test('wiki position: search for a chapter beyond the initial window', async ({
        page,
        browser,
      }, info) => {
        const positions = await setupCommands(browser, info, (api) =>
          seedWikiPosition(api, fixture),
        );
        // Probe as the reader too: administrative setup cannot prove disclosure.
        await new PublicCommands(page.request).until<{ items: { occurrence: string }[] }>(
          `/reading-positions/${short(positions.work)}?${new URLSearchParams({
            q: positions.laterChapter.name,
            actingSubject: fixture.actor,
          })}`,
          (result) =>
            result.items.some((item) => item.occurrence === positions.laterChapter.occurrence),
        );
        const t = browseMessages[locale],
          wiki = wikiCopy(locale);
        const read = await address(page, 'space', positions.space, locale);
        const response = await page.goto(
          canonicalHref(read.canonical, locale, read.canonical.suffixSource, {
            surface: 'site',
            tail: [positions.mount, uuidToSid(short(positions.work))],
            search: '?position=all',
          }),
        );
        expect(response?.status(), 'the mounted wiki story opens').toBe(200);
        const trigger = page
          .getByRole('region', { name: wiki.region, exact: true })
          .getByRole('button');
        await expect(trigger).toHaveAttribute('data-hydrated', 'true');
        await trigger.click();
        await expect(
          page.getByRole('link', { name: positions.laterChapter.name, exact: true }),
        ).toHaveCount(0);
        await page
          .getByRole('combobox', { name: t.searchChapters, exact: true })
          .fill(positions.laterChapter.name);
        const result = page.getByRole('option', { name: positions.laterChapter.name, exact: true });
        await expect(result).toBeVisible();
        const searchedPath = new URL(page.url()).pathname;
        const obsoleteSearches: string[] = [];
        page.on('request', (request) => {
          // G1059: clearing the combobox on selection launched a second server
          // action at position=all and superseded the chosen chapter navigation.
          if (request.method() === 'POST' && new URL(request.url()).pathname === searchedPath)
            obsoleteSearches.push(request.url());
        });
        await result.click();
        await expect
          .poll(() => new URL(page.url()).searchParams.get('position'))
          .toBe(short(positions.laterChapter.occurrence));
        await expect(trigger).toContainText(positions.laterChapter.name);
        expect(obsoleteSearches, 'selecting a chapter starts no obsolete chooser server action').toEqual([]);
        await screenshot(page, info, 'wiki-later-chapter-selected');
      });

      test('visibility: outsider requests, manager approves, requester reloads the result', async ({
        page,
        browser,
      }, info) => {
        const t = accessMessages[locale];
        const privateSpace =
          fixture.privateSpaces[locales.indexOf(locale) * views.length + views.indexOf(view)]!;
        const path = localizedPath(spaceHref(privateSpace.handle ?? privateSpace.space, 'community', ['discussions']), locale);
        await selectActor(page, fixture.actor, `/${locale}/settings`);
        const previous = await phase(`reset admission ${locale} ${view.name}`, () =>
          resetAdmission(new PublicCommands(page.request), fixture, privateSpace),
        );
        const anonymous = await browser.newContext({
          baseURL: info.project.use.baseURL,
          viewport: view.viewport,
        });
        const managerContext = await browser.newContext({
          baseURL: info.project.use.baseURL,
          viewport: view.viewport,
        });
        try {
          const outsider = await anonymous.newPage();
          await outsider.goto(path);
          await expect(
            outsider.getByRole('heading', { level: 1, name: privateSpace.name }),
          ).toBeVisible();
          await expect(outsider.locator('meta[name="robots"]')).toHaveCount(1);
          await expect(outsider.locator('meta[name="robots"]')).toHaveAttribute(
            'content',
            /(?:^|[,\s])noindex(?:[,\s]|$)/,
          );
          const signIn = outsider.getByRole('link', { name: t.signIn, exact: true });
          await expect(signIn).toBeVisible();
          const signInHref = await signIn.getAttribute('href');
          expect(new URL(signInHref!, outsider.url()).searchParams.get('next')).toBe(path);
          await screenshot(outsider, info, 'private-outsider-join-page');
          await page.goto(path);
          await page
            .getByRole('textbox', { name: t.joinReason, exact: true })
            .fill(`Direction 9 ${locale} ${view.name}: please admit me.`);
          await page.getByRole('button', { name: t.requestJoin, exact: true }).click();
          await expect(page.getByText(t.pending, { exact: true })).toBeVisible();
          await screenshot(page, info, 'private-request-pending');
          const manager = await managerContext.newPage();
          manager.setDefaultTimeout(30_000);
          await signInManager(manager);
          // Exercise access expiry without waiting five minutes. Only this
          // context owns the refresh token, so its first BFF read must rotate it.
          await managerContext.clearCookies({ name: 'rezics_access' });
          // Select the fixture's manager before loading its scoped requests.
          await phase(`${locale} ${view.name} manager selection`, () =>
            selectActor(
              manager,
              fixture.manager,
              `/${locale}/manage/r/${short(privateSpace.realm)}/requests`,
            ),
          );
          expect(
            (await managerContext.cookies()).some((cookie) => cookie.name === 'rezics_access'),
            'an independent manager session refreshes before Agent selection',
          ).toBe(true);
          await screenshot(manager, info, 'private-manager-before-decision');
          await phase(`${locale} ${view.name} manager approval`, async () => {
            await manager.getByRole('button', { name: t.approve, exact: true }).click();
            const dialog = manager.getByRole('dialog');
            await expect(dialog).toBeVisible();
            await dialog
              .getByRole('textbox', { name: t.reason, exact: true })
              .fill('Reviewed for Direction 9 acceptance.');
            await dialog.getByRole('button', { name: t.approve, exact: true }).click();
            await expect(manager.getByText(t.approved, { exact: true })).toBeVisible();
            await screenshot(manager, info, 'private-manager-approved');
          });
          await page.reload();
          const own = await ownRequests(new PublicCommands(page.request), fixture, privateSpace);
          expect(own.filter((item) => !previous.has(item.id)).map((item) => item.state)).toEqual([
            'accepted',
          ]);
          const relationship = relationshipMessages[locale];
          await expect(
            page.getByRole('button', {
              name: `${relationship.joined} · ${privateSpace.name} · ${relationship.leave}`,
              exact: true,
            }),
          ).toBeVisible();
          await expect(page.getByText(t.pending, { exact: true })).toHaveCount(0);
          await screenshot(page, info, 'private-requester-reloaded');
        } finally {
          await managerContext.close();
          await anonymous.close();
        }
      });

      test('visibility: unlisted Space opens by link with noindex and is excluded from Discover', async ({
        page,
        browser,
      }, info) => {
        // Unlisted is readable by anyone holding the link. Start outside the
        // signed-in shell so a stale settings/auth navigation cannot replace
        // this document read (or turn goto's response into a same-document null).
        const anonymous = await browser.newContext({
          baseURL: info.project.use.baseURL,
          viewport: view.viewport,
        });
        try {
          const directPage = await anonymous.newPage();
          const direct = await directPage.goto(localizedPath(spaceHref(fixture.unlisted.handle ?? fixture.unlisted.space, 'community'), locale), {
            timeout: 30_000,
          });
          expect(direct?.status()).toBe(200);
          expect(direct?.headers()['x-robots-tag']).toMatch(/(?:^|[,\s])noindex(?:[,\s]|$)/);
          await expect(
            directPage.getByRole('heading', { level: 1, name: fixture.unlisted.name }),
          ).toBeVisible();
          await expect(directPage.locator('meta[name="robots"]')).toHaveCount(1);
          await expect(directPage.locator('meta[name="robots"]')).toHaveAttribute(
            'content',
            /(?:^|[,\s])noindex(?:[,\s]|$)/,
          );
          await expect(
            directPage.getByText(accessMessages[locale].unlistedNotice, { exact: true }),
          ).toBeVisible();
          await screenshot(directPage, info, 'unlisted-direct-link');
        } finally {
          await anonymous.close();
        }
        const t = browseMessages[locale];
        await page.goto(
          `/${locale}/discover?tab=communities&q=${encodeURIComponent(fixture.unlisted.name)}`,
        );
        await expect(
          page.getByRole('banner').getByRole('searchbox', { name: t.search, exact: true }),
        ).toHaveValue(fixture.unlisted.name);
        await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
        await expect(discoverResource(page, fixture.unlisted.name)).toHaveCount(0);
        await expect(page.getByRole('main').getByText(t.empty, { exact: true })).toBeVisible();
        await screenshot(page, info, 'unlisted-discover-excluded');
        await page.goto(
          `/${locale}/discover?tab=communities&q=${encodeURIComponent(fixture.named.name)}`,
        );
        await expect(discoverResource(page, fixture.named.name)).toBeVisible();
        await screenshot(page, info, 'listed-discover-positive-control');
      });
    });
  }
