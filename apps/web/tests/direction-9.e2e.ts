import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test as base, type Page, type TestInfo } from '@playwright/test';
import { entityPickerMessages } from '../../../packages/ui/src/components/entity-picker-messages.ts';
import { uuidToSid } from '@rezics/model/address';
import { materializeData } from 'native-i18n';
import { canonicalHref, type Surface } from '../features/address/path.ts';
import type { ResolvedAddress } from '../features/address/client.ts';
import { messages as authMessages } from '../features/auth/messages.ts';
import { browseMessages } from '../features/discover/browse-messages.ts';
import { accessMessages } from '../features/manage/settings-messages.ts';
import { messages as realmMessages } from '../features/realm/messages.ts';
import { messages as studioMessages } from '../features/studio/messages.ts';
import studioChinese from '../features/studio/messages/zh-Hant.ts';
import { messages as shellEnglish } from '../features/shell/messages.ts';
import shellChinese from '../features/shell/messages/zh-Hant.ts';
import { copyOf as wikiCopy } from '../features/wiki/messages.ts';
import { localeNames } from '../i18n/define.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import {
  credentials,
  PublicCommands,
  seedDirection,
  short,
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

async function selectActor(page: Page, actor: string, next: string) {
  const response = await page.request.post('/identity/select', {
    maxRedirects: 0,
    form: { agent: actor, next },
  });
  expect(response.status()).toBe(303);
  expect(response.headers().location).not.toContain('error=');
  await page.goto(next);
}

/** The fixture's second Account may not have published a Main Person yet. */
async function signInManager(page: Page) {
  const member = credentials().operator;
  await page.goto('/auth/start?next=%2Fen%2Fsettings');
  const accounts = new URL(process.env.ACCOUNT_ORIGIN ?? 'http://127.0.0.1:3004').origin;
  await page.waitForURL((url) => url.origin === accounts && url.pathname === '/sign-in');
  await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(member.email);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Enter your password').fill(member.password);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.waitForURL(
    (url) => url.pathname === '/en/settings' || url.pathname === '/en/onboarding',
    { timeout: 60_000 },
  );
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
    await selectActor(page, person.agent, '/en/settings');
  }
}

async function address(page: Page, scope: string, holder: string, locale: Locale) {
  const response = await page.request.get(
    `/api/main/v1/addresses/resolve?${new URLSearchParams({ scope, key: short(holder) })}`,
    {
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
  const canonical = canonicalHref(read.canonical, locale, read.canonical.slugSource, { surface });
  const response = await page.goto(canonical);
  expect(response?.status(), `${name} canonical response`).toBe(200);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    new URL(canonical, page.url()).href,
  );
  await screenshot(page, info, `${name}-canonical`);
  const prefix =
    surface === 'community' ? '/r/' : surface === 'site' ? '/z/' : read.canonical.prefix;
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
  if (prefix === '/@') {
    forms.add(`/${locale}/@${id}`);
    forms.add(`/${locale}/@agent-${id}`);
  }
  const capability = surface && read.capabilities?.[surface === 'community' ? 'realm' : 'zone'];
  if (capability) forms.add(`/${locale}${identityPrefix}${short(capability)}`);
  for (const form of forms) {
    if (form === canonical) continue;
    const legacy = await page.request.get(`${form}?direction9=preserved`, { maxRedirects: 0 });
    expect(legacy.status(), `${name}: ${form} is one permanent redirect`).toBe(301);
    const destination = new URL(legacy.headers().location!, page.url());
    expect(destination.pathname).toBe(canonical);
    expect(destination.search).toBe('?direction9=preserved');
    const terminal = await page.request.get(destination.href, { maxRedirects: 0 });
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
const test = base;
let fixture: DirectionFixture;
test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(600_000);
  const context = await browser.newContext({ baseURL: info.project.use.baseURL });
  const managerContext = await browser.newContext({ baseURL: info.project.use.baseURL });
  try {
    const page = await context.newPage();
    await signInAtAccounts(page, '/en/settings', credentials().member);
    const managerPage = await managerContext.newPage();
    expect(
      credentials().operator.email,
      'requester and manager must be different Accounts',
    ).not.toBe(credentials().member.email);
    await signInManager(managerPage);
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
    fixture = await seedDirection(
      new PublicCommands(page.request),
      sessionAgent.actingSubject,
      new PublicCommands(managerPage.request),
    );
  } finally {
    await context.close();
    await managerContext.close();
  }
});

for (const locale of locales)
  for (const view of views) {
    test.describe(`Direction 9 ${locale} ${view.name}`, () => {
      test.use({ viewport: view.viewport });
      test.beforeEach(async ({ page }) => {
        test.setTimeout(180_000);
        await signInAtAccounts(page, `/${locale}/settings`, credentials().member);
      });
      test.afterEach(async ({ page }, info) => {
        if (info.status !== info.expectedStatus) await screenshot(page, info, 'failure');
      });

      test('addresses: named and unnamed people, community, site, Work and Concept', async ({
        page,
      }, info) => {
        for (const [scope, holder, name, surface] of [
          ['agent', fixture.namedPerson, 'named-person', undefined],
          ['agent', fixture.unnamedPerson, 'unnamed-person', undefined],
          ['space', fixture.named.space, 'named-community', 'community'],
          ['space', fixture.named.space, 'named-site', 'site'],
          ['space', fixture.unnamed.space, 'unnamed-community', 'community'],
          ['work', fixture.work.work, 'work', undefined],
          ['concept', fixture.topic.concept, 'concept', undefined],
        ] as const) {
          await walkAddress(
            page,
            info,
            locale,
            await address(page, scope, holder, locale),
            name,
            surface,
          );
        }
        const old = `/${locale}/r/${fixture.named.handle}/story/w/${uuidToSid(short(fixture.story.work))}`;
        const expected = new URL(
          (await page.request.get(`${old}?position=all`, { maxRedirects: 0 })).headers().location!,
          page.url(),
        );
        expect(expected.pathname).toMatch(new RegExp(`^/${locale}/z/`));
        const response = await page.request.get(`${old}?position=all`, { maxRedirects: 0 });
        expect(response.status()).toBe(301);
        expect(expected.search).toBe('?position=all');
        expect((await page.request.get(expected.href, { maxRedirects: 0 })).status()).toBe(200);
        await page.goto(old);
        await expect(page).toHaveURL(new RegExp(`/${locale}/z/`));
        await screenshot(page, info, 'legacy-r-site');
        const legacyZone = await page.request.get(`/${locale}/r/${short(fixture.zone)}`, {
          maxRedirects: 0,
        });
        expect(legacyZone.status(), 'a legacy Zone identity opens its site surface').toBe(301);
        const siteTarget = new URL(legacyZone.headers().location!, page.url());
        expect(siteTarget.pathname).toMatch(new RegExp(`^/${locale}/z/`));
        expect((await page.request.get(siteTarget.href, { maxRedirects: 0 })).status()).toBe(200);
        await page.goto(`/${locale}/r/${short(fixture.zone)}`);
        await screenshot(page, info, 'legacy-zone-identity');
      });

      test.fixme('addresses: a standalone Zone has canonical site forms', async () => {
        // /v1/zones and zone/owner-create.ts require a live Realm capability.
        // Remove this fixme when public Space creation admits a Zone without a Realm.
      });

      test('account menu: second-level Language and Appearance show their current values', async ({
        page,
      }, info) => {
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
        await appearance
          .getByRole(phone ? 'radio' : 'menuitemradio', { name: shell.themeDark, exact: true })
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
        await reset
          .getByRole(phone ? 'radio' : 'menuitemradio', { name: shell.themeSystem, exact: true })
          .click();
      });

      test.fixme('relationships: follow → bell → pin → one-command join → leave → unfollow; sidebar updates without duplicate Spaces', async () => {
        // RealmMembership still uses separate join and follow commands; no Space
        // bell/pin control or Following manager is mounted on this branch.
        // Keep this entire journey pending instead of passing its old follow-only flow.
      });

      test('Discover: type tabs, topic picker chips and Communities continuation', async ({
        page,
      }, info) => {
        const t = browseMessages[locale];
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
          expect(new URL(page.url()).searchParams.get('tab')).toBe(tab);
          await expect(link).toHaveAttribute('aria-current', 'page');
          await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
          await screenshot(page, info, `discover-${tab}`);
        }
        await page.getByRole('combobox', { name: t.topics, exact: true }).fill(fixture.topic.name);
        await page.getByRole('option', { name: new RegExp(fixture.topic.name) }).click();
        expect(new URL(page.url()).searchParams.get('ci')).toContain(short(fixture.topic.concept));
        await screenshot(page, info, 'topic-included');
        const picker = entityPickerMessages[locale];
        await page
          .getByRole('button', {
            name: picker.exclude.replace('{label}', fixture.topic.name),
            exact: true,
          })
          .click();
        expect(new URL(page.url()).searchParams.get('ce')).toContain(short(fixture.topic.concept));
        expect(new URL(page.url()).searchParams.has('ci')).toBe(false);
        await screenshot(page, info, 'topic-excluded');
        // EntityPicker localizes these actions independently of Discover.
        await page
          .getByRole('button', {
            name: picker.remove.replace('{label}', fixture.topic.name),
            exact: true,
          })
          .click();
        expect(new URL(page.url()).searchParams.has('ce')).toBe(false);
        await page.goto(`/${locale}/discover?tab=communities`);
        const firstNames = await page
          .getByRole('main')
          .getByRole('list')
          .getByRole('link')
          .allTextContents();
        await page.getByRole('link', { name: t.more, exact: true }).click();
        expect(new URL(page.url()).searchParams.get('cursor')).toBeTruthy();
        const secondNames = await page
          .getByRole('main')
          .getByRole('list')
          .getByRole('link')
          .allTextContents();
        expect(secondNames.length).toBeGreaterThan(0);
        expect(secondNames.some((name) => firstNames.includes(name))).toBe(false);
        await expect(
          page.getByRole('main').getByRole('link', { name: fixture.unlisted.name, exact: true }),
        ).toHaveCount(0);
        await screenshot(page, info, 'communities-next-page');
      });

      test('rating scope: choose a population past page one', async ({ page }, info) => {
        const t = browseMessages[locale];
        const workAddress = await address(page, 'work', fixture.work.work, locale);
        await page.goto(canonicalHref(workAddress.canonical, locale));
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
        expect(new URL(page.url()).searchParams.get('scope')).toBe('realm');
        expect(new URL(page.url()).searchParams.get('realm')).toBeTruthy();
        await screenshot(page, info, 'population-selected');
      });

      test('submission: find a Realm by search and submit a published text', async ({
        page,
      }, info) => {
        const t = browseMessages[locale];
        const community =
          fixture.spaces[7 + locales.indexOf(locale) * views.length + views.indexOf(view)]!;
        await selectActor(page, fixture.actor, `/${locale}/settings`);
        await page.goto(
          `/${locale}/studio/@agent-${short(fixture.actor)}/works/${short(fixture.work.work)}?tab=realms`,
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
      }, info) => {
        const t = browseMessages[locale],
          wiki = wikiCopy(locale);
        const read = await address(page, 'space', fixture.named.space, locale);
        await page.goto(
          canonicalHref(read.canonical, locale, read.canonical.slugSource, {
            surface: 'site',
            tail: ['story', 'w', uuidToSid(short(fixture.story.work))],
            search: '?position=all',
          }),
        );
        const trigger = page
          .getByRole('region', { name: wiki.region, exact: true })
          .getByRole('button');
        await expect(trigger).toHaveAttribute('data-hydrated', 'true');
        await trigger.click();
        await expect(
          page.getByRole('link', { name: fixture.laterChapter.name, exact: true }),
        ).toHaveCount(0);
        await page
          .getByRole('combobox', { name: t.searchChapters, exact: true })
          .fill(fixture.laterChapter.name);
        await page.getByRole('option', { name: fixture.laterChapter.name, exact: true }).click();
        expect(new URL(page.url()).searchParams.get('position')).toBe(
          short(fixture.laterChapter.occurrence),
        );
        await expect(trigger).toContainText(fixture.laterChapter.name);
        await screenshot(page, info, 'wiki-later-chapter-selected');
      });

      test('visibility: outsider requests, manager approves, requester reloads the result', async ({
        page,
        browser,
      }, info) => {
        const t = accessMessages[locale];
        const privateSpace =
          fixture.privateSpaces[locales.indexOf(locale) * views.length + views.indexOf(view)]!;
        const path = `/${locale}/r/${privateSpace.handle}`;
        await selectActor(page, fixture.actor, `/${locale}/settings`);
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
          await expect(outsider.getByRole('link', { name: t.signIn, exact: true })).toBeVisible();
          await screenshot(outsider, info, 'private-outsider-join-page');
          await page.goto(path);
          await page
            .getByRole('textbox', { name: t.joinReason, exact: true })
            .fill(`Direction 9 ${locale} ${view.name}: please admit me.`);
          await page.getByRole('button', { name: t.requestJoin, exact: true }).click();
          await expect(page.getByText(t.pending, { exact: true })).toBeVisible();
          await screenshot(page, info, 'private-request-pending');
          const manager = await managerContext.newPage();
          await signInAtAccounts(manager, `/${locale}/manage`, credentials().operator);
          await selectActor(
            manager,
            fixture.manager,
            `/${locale}/manage/r/${short(privateSpace.realm)}/requests`,
          );
          await manager.getByRole('button', { name: t.approve, exact: true }).click();
          const dialog = manager.getByRole('dialog');
          await dialog
            .getByRole('textbox', { name: t.reason, exact: true })
            .fill('Reviewed for Direction 9 acceptance.');
          await dialog.getByRole('button', { name: t.approve, exact: true }).click();
          await expect(manager.getByText(t.approved, { exact: true })).toBeVisible();
          await screenshot(manager, info, 'private-manager-approved');
          await page.reload();
          const own = await new PublicCommands(page.request).read<{ items: { state: string }[] }>(
            `/realms/${short(privateSpace.realm)}/join-requests/mine?actingSubject=${encodeURIComponent(fixture.actor)}`,
          );
          expect(own.items.map((item) => item.state)).toEqual(['accepted']);
          const realm = materializeData(realmMessages[locale], { locale });
          await expect(page.getByRole('button', { name: realm.joined, exact: true })).toBeVisible();
          await expect(page.getByText(t.pending, { exact: true })).toHaveCount(0);
          await screenshot(page, info, 'private-requester-reloaded');
        } finally {
          await managerContext.close();
          await anonymous.close();
        }
      });

      test('visibility: unlisted Space opens by link with noindex and is excluded from Discover', async ({
        page,
      }, info) => {
        const direct = await page.goto(`/${locale}/r/${fixture.unlisted.handle}`);
        expect(direct?.status()).toBe(200);
        await expect(
          page.getByRole('heading', { level: 1, name: fixture.unlisted.name }),
        ).toBeVisible();
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
          'content',
          /(?:^|[,\s])noindex(?:[,\s]|$)/,
        );
        await expect(
          page.getByText(accessMessages[locale].unlistedNotice, { exact: true }),
        ).toBeVisible();
        await screenshot(page, info, 'unlisted-direct-link');
        const t = browseMessages[locale];
        await page.goto(
          `/${locale}/discover?tab=communities&q=${encodeURIComponent(fixture.unlisted.name)}`,
        );
        await expect(page.getByRole('searchbox', { name: t.search, exact: true })).toHaveValue(
          fixture.unlisted.name,
        );
        await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
        await expect(
          page.getByRole('main').getByRole('link', { name: fixture.unlisted.name, exact: true }),
        ).toHaveCount(0);
        await expect(page.getByRole('main').getByText(t.empty, { exact: true })).toBeVisible();
        await screenshot(page, info, 'unlisted-discover-excluded');
        await page.goto(
          `/${locale}/discover?tab=communities&q=${encodeURIComponent(fixture.named.name)}`,
        );
        await expect(
          page.getByRole('main').getByRole('link', { name: fixture.named.name, exact: true }),
        ).toBeVisible();
        await screenshot(page, info, 'listed-discover-positive-control');
      });
    });
  }
