import { profileHref } from '../features/profile/route.ts';
import { localizedPath } from '../i18n/locale.ts';
import { randomBytes } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const accountsOrigin = process.env.ACCOUNT_ORIGIN ?? 'http://127.0.0.1:3004';
const signUpOrigin = process.env.REZICS_ACCOUNTS_SIGNUP_ORIGIN;
const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

const localeText = {
  en: {
    search: 'Search works',
    name: 'Public name',
    handle: 'Your handle',
    available: 'This handle is available.',
    current: 'This is your current handle.',
  },
  'zh-Hant': {
    search: '搜尋作品',
    name: '公開名稱',
    handle: '您的使用者名稱',
    available: '此使用者名稱可以使用。',
    current: '這是您目前的使用者名稱。',
  },
} as const;

async function captureVariants(
  page: Page,
  info: TestInfo,
  screen: 'onboarding' | 'settings',
  person: { publicName: string; handle: string },
) {
  const origin = process.env.REZICS_WEB_E2E_BASE_URL ?? 'http://127.0.0.1:3000';
  for (const locale of ['en', 'zh-Hant'] as const) {
    const t = localeText[locale];
    for (const theme of ['light', 'dark'] as const) {
      await page.context().addCookies([{ name: 'rezics_theme', value: theme, url: origin }]);
      // Signed in, the Account's display mode (system for a new person) wins over the cookie.
      await page.emulateMedia({ colorScheme: theme });
      for (const [size, width, height] of [
        ['desktop', 1440, 900],
        ['phone', 390, 844],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.goto(`/${locale}/${screen}${screen === 'onboarding' ? '?next=%2Fen' : ''}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.getByRole('combobox', { name: t.search })).toBeVisible();
        await expect(page.getByRole('textbox', { name: t.handle })).toHaveAttribute(
          'data-hydrated',
          'true',
          { timeout: 20_000 },
        );
        if (screen === 'onboarding') {
          // First sign-in: the public name is empty and required, and nothing is suggested.
          const name = page.getByRole('textbox', { name: t.name });
          await expect(name).toHaveValue('');
          await expect(name).toHaveAttribute('required', '');
          await expect(page.getByRole('textbox', { name: t.handle })).toHaveValue('');
          await page.screenshot({
            path: info.outputPath(`${screen}-${locale}-${theme}-${size}-empty.png`),
            fullPage: true,
          });
          await name.fill(person.publicName);
          await page.getByRole('textbox', { name: t.handle }).fill(person.handle);
        }
        // Settings has other status lines; the handle's is the one that names it.
        await expect(
          page
            .getByRole('main')
            .getByRole('status')
            .filter({ hasText: screen === 'onboarding' ? t.available : t.current }),
        ).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('html')).toHaveClass(new RegExp(`^(${theme})?$`));
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await page.screenshot({
          path: info.outputPath(`${screen}-${locale}-${theme}-${size}.png`),
          fullPage: true,
        });
      }
    }
  }
  await page.context().addCookies([{ name: 'rezics_theme', value: 'light', url: origin }]);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/en/${screen}${screen === 'onboarding' ? '?next=%2Fen' : ''}`);
}

/** The setup's first step in both locales, themes and sizes; it fits a phone without sideways scrolling. */
async function captureSetup(page: Page, info: TestInfo) {
  const origin = process.env.REZICS_WEB_E2E_BASE_URL ?? 'http://127.0.0.1:3000';
  for (const locale of ['en', 'zh-Hant'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      await page.context().addCookies([{ name: 'rezics_theme', value: theme, url: origin }]);
      await page.emulateMedia({ colorScheme: theme });
      for (const [size, width, height] of [
        ['desktop', 1440, 900],
        ['phone', 390, 844],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.goto(`/${locale}/welcome?next=${encodeURIComponent(`/${locale}`)}`);
        await expect(
          page.getByRole('heading', {
            level: 2,
            name: locale === 'en' ? 'Which languages do you read?' : '你讀哪些語言？',
          }),
        ).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await page.screenshot({
          path: info.outputPath(`welcome-${locale}-${theme}-${size}.png`),
          fullPage: true,
        });
      }
    }
  }
  await page.context().addCookies([{ name: 'rezics_theme', value: 'light', url: origin }]);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en/welcome?next=%2Fen');
}

/** The Account's private name must reach no page: neither its text nor the data streamed with it. */
async function expectNoAccountData(page: Page, ...private_: string[]) {
  const html = await page.content();
  for (const value of private_) expect(html, `${value} on ${page.url()}`).not.toContain(value);
}

async function signInExisting(page: Page, person: { email: string; password: string }) {
  await page.goto('/auth/start?next=%2Fen');
  // /auth/start hands over to Accounts (or straight back when Accounts already knows the person).
  await page.waitForURL(
    (url) => url.origin === new URL(accountsOrigin).origin || url.pathname === '/en',
    { timeout: 60_000 },
  );
  if (new URL(page.url()).origin === new URL(accountsOrigin).origin) {
    await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
    await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Enter your password').fill(person.password);
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await expect(page).toHaveURL('/en', { timeout: 60_000 });
}

type Listed = {
  items: { actingSubject: string; kind: string | null; displayName: { value: string } | null }[];
};
async function listedAgents(page: Page): Promise<Listed> {
  const response = await page.request.get('/api/main/v1/me/agents');
  expect(response.status()).toBe(200);
  return (await response.json()) as Listed;
}

async function verificationLink(email: string): Promise<string> {
  let link = '';
  await expect
    .poll(
      async () => {
        const response = await fetch(
          `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
        );
        const { messages } = (await response.json()) as {
          messages: { ID: string; Subject: string }[];
        };
        const newest = messages.find((item) => /^Verify your email address$/.test(item.Subject));
        if (!newest) return false;
        const { Text } = (await (await fetch(`${mailpit}/api/v1/message/${newest.ID}`)).json()) as {
          Text: string;
        };
        link = /https?:\/\/\S+/.exec(Text)?.[0] ?? '';
        return Boolean(link);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return link;
}

test('new person picks a public name and handle, sets up Home, and the Account name stays private', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const suffix = randomBytes(6).toString('hex');
  // The Account's name is a private marker that must never become, or appear beside, the public name.
  const marker = `PRIVATE-MARKER-${suffix}`;
  const person = {
    name: marker,
    publicName: '林梅',
    email: `onboarding-${suffix}@example.test`,
    password: `pass phrase ${suffix}`,
    handle: `reader_${suffix}`,
  };
  let currentHandle = person.handle;
  await page.goto('/auth/start?create=1&next=%2Fen');
  await expect(page).toHaveURL((url) => url.origin === new URL(accountsOrigin).origin);
  if (signUpOrigin) {
    const signUp = new URL(page.url());
    await page.goto(`${signUpOrigin}${signUp.pathname}${signUp.search}`);
  }
  await expect(page.getByRole('heading', { name: 'Create your REZICS Account' })).toBeVisible();
  await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
  await page.getByRole('textbox', { name: 'Display name' }).fill(person.name);
  await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await page.getByLabel('Confirm').fill(person.password);
  await page.getByText('I meet the minimum age in the Terms and have read and accept:').click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const verify = new URL(await verificationLink(person.email));
  if (signUpOrigin) await page.goto(`${signUpOrigin}${verify.pathname}${verify.search}`);
  else await page.goto(verify.toString());
  // Verification signs the new person in and resumes the current REZICS request.
  // G-431: after the handle comes Home's setup, then where the person was going.
  await expect(page).toHaveURL(
    `/en/onboarding?next=${encodeURIComponent('/en/welcome?next=%2Fen')}`,
    { timeout: 60_000 },
  );
  const handleStep = page.url();
  // Nothing is filled in from the Account, and nothing public exists until the person submits.
  await expect(page.getByRole('textbox', { name: 'Public name' })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Public name' })).toHaveAttribute('required', '');
  await expect(page.getByRole('main')).toContainText('Shown on your profile and contributions.');
  await expectNoAccountData(page, marker, person.email);
  for (const handle of [person.handle, `private_marker_${suffix}`, `reader_${suffix}`]) {
    expect(
      (await page.request.get(localizedPath(profileHref(handle), 'en'))).status(),
      handle,
    ).toBe(404);
  }
  expect((await listedAgents(page)).items.filter((item) => item.kind === 'person')).toHaveLength(0);
  await captureVariants(page, info, 'onboarding', person);
  // Leaving and coming back resumes on the same empty screen: still no Person.
  await page.goto('/en');
  await expectNoAccountData(page, marker, person.email);
  await page.goto(handleStep);
  await expect(page.getByRole('textbox', { name: 'Public name' })).toHaveValue('');
  // The name is posted first: a handle Main rejects leaves exactly one Person, and the next visit resumes at the handle.
  const partial = await page.request.post('/en/onboarding/finish', {
    maxRedirects: 0,
    form: {
      displayName: person.publicName,
      handle: 'x',
      next: '/en/welcome?next=%2Fen',
      key: crypto.randomUUID(),
    },
  });
  expect(partial.status()).toBe(303);
  expect(partial.headers().location).toContain('error=invalid');
  for (let visit = 0; visit < 2; visit++) {
    const people = (await listedAgents(page)).items.filter((item) => item.kind === 'person');
    expect(people).toHaveLength(1);
    expect(people[0]!.displayName?.value).toBe(person.publicName);
    await page.goto(handleStep);
    await expect(page.getByRole('main').getByText(person.publicName)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Public name' })).toHaveCount(0);
    await expectNoAccountData(page, marker, person.email);
  }
  await expect(page.getByRole('textbox', { name: 'Your handle' })).toHaveAttribute(
    'data-hydrated',
    'true',
    { timeout: 20_000 },
  );
  await page.getByRole('textbox', { name: 'Your handle' }).fill(person.handle);
  await expect(
    page.getByRole('main').getByRole('status').filter({ hasText: 'This handle is available.' }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  // G-431: a first visit continues into Home's setup: languages, topics that become tabs, then communities.
  await expect(page).toHaveURL('/en/welcome?next=%2Fen');
  await captureSetup(page, info);
  const setup = page.getByRole('main');
  await expect(
    setup.getByRole('heading', { level: 2, name: 'Which languages do you read?' }),
  ).toBeVisible();
  await expect(
    setup.getByRole('region', { name: 'Your languages, first choice first' }),
  ).toContainText('English');
  // The step buttons are inert until the page hydrates; a click before that is retried.
  const topics = setup.getByRole('heading', { level: 2, name: 'Pick a few topics' });
  await expect(async () => {
    if (!(await topics.isVisible())) await setup.getByRole('button', { name: 'Next' }).click();
    await expect(topics).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const topic = setup.locator('button[aria-pressed]').first();
  if (await topic.isVisible()) {
    await topic.click();
    await expect(topic).toHaveAttribute('aria-pressed', 'true');
    await setup.getByRole('button', { name: 'Next' }).click();
  } else await setup.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    setup.getByRole('heading', { level: 2, name: 'Follow a few communities' }),
  ).toBeVisible();
  await setup.getByRole('button', { name: /finish$|^Finish$/ }).click();
  await expect(page).toHaveURL('/en', { timeout: 30_000 });
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Account menu' }),
  ).toContainText(`@${person.handle}`);
  await page.goto(localizedPath(profileHref(person.handle), 'en'));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(person.publicName);
  await expectNoAccountData(page, marker, person.email);
  // A second browser sees the same identity, and one Person.
  const second = await browser.newContext({ baseURL: info.project.use.baseURL });
  try {
    const other = await second.newPage();
    await signInExisting(other, person);
    await expect(
      other.getByRole('banner').getByRole('button', { name: 'Account menu' }),
    ).toContainText(`@${person.handle}`);
    const seen = await listedAgents(other);
    expect(seen.items.filter((item) => item.kind === 'person')).toHaveLength(1);
    expect(seen.items.map((item) => item.displayName?.value)).toEqual([person.publicName]);
    await expectNoAccountData(other, marker, person.email);
  } finally {
    await second.close();
  }
  await page.goto('/en');
  await page.reload();
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Account menu' }),
  ).toContainText(`@${person.handle}`);
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Account menu' }),
  ).toHaveAttribute('data-hydrated', 'true');
  await page.getByRole('banner').getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Profile settings' }).click();
  await expect(page).toHaveURL('/en/settings');
  await expect(page.getByRole('main').getByText(`@${person.handle}`)).toBeVisible();
  await page.getByRole('textbox', { name: 'Your handle' }).fill(`another_${suffix}`);
  await expect(
    page.getByRole('main').getByRole('status').filter({ hasText: 'This handle is available.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Change handle' }).click();
  await expect(
    page
      .getByRole('main')
      .getByRole('status')
      .filter({ hasText: 'You can change your handle again 30 days' }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your handle' })).toHaveAttribute(
    'data-hydrated',
    'true',
  );
  if (process.env.REZICS_AGE_HANDLE === '1') {
    const databaseUrl = process.env.ACCESS_DATABASE_URL;
    if (!databaseUrl)
      throw new Error('ACCESS_DATABASE_URL is required for the isolated rename fixture');
    const oldProfile = (await (
      await fetch(`http://127.0.0.1:3001/v1/handles/${person.handle}`)
    ).json()) as { id: string; displayName: string };
    expect(oldProfile.displayName).toBe(person.publicName);
    const { Client } = await import('pg');
    const db = new Client({ connectionString: databaseUrl });
    try {
      await db.connect();
      const aged = await db.query(
        `UPDATE access.alias_registry
        SET changed_at = clock_timestamp() - interval '31 days'
        WHERE scope = 'agent' AND key = $1 AND holder = $2 AND state = 'current'`,
        [person.handle, oldProfile.id],
      );
      expect(aged.rowCount).toBe(1);
    } finally {
      await db.end();
    }
    currentHandle = `another_${suffix}`;
    await page.getByRole('textbox', { name: 'Your handle' }).fill(currentHandle);
    await expect(
      page.getByRole('main').getByRole('status').filter({ hasText: 'This handle is available.' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Change handle' }).click();
    await expect(
      page.getByRole('main').getByRole('status').filter({ hasText: 'Your handle was changed.' }),
    ).toBeVisible();
    const oldAddress = await page.request.get(`http://127.0.0.1:3001/v1/handles/${person.handle}`);
    expect(oldAddress.status()).toBe(200);
    expect(await oldAddress.json()).toMatchObject({
      resolution: {
        requestedHandle: person.handle,
        state: 'retired',
        redirect: true,
        canonical: profileHref(currentHandle),
      },
    });
    // Retired handles stay with their owner: settings offers the old one back and the owner takes it.
    const aged2 = new Client({ connectionString: databaseUrl });
    try {
      await aged2.connect();
      expect(
        (
          await aged2.query(
            `UPDATE access.alias_registry
        SET changed_at = clock_timestamp() - interval '31 days'
        WHERE scope = 'agent' AND key = $1 AND holder = $2 AND state = 'current'`,
            [currentHandle, oldProfile.id],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      await aged2.end();
    }
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Your handle' })).toHaveAttribute(
      'data-hydrated',
      'true',
    );
    await page.getByRole('textbox', { name: 'Your handle' }).fill(person.handle);
    await expect(
      page.getByRole('main').getByRole('status').filter({ hasText: 'Kept for its previous owner' }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Change handle' }).click();
    await expect(
      page.getByRole('main').getByRole('status').filter({ hasText: 'Your handle was changed.' }),
    ).toBeVisible();
    currentHandle = person.handle;
  }
  const publicName = `Author ${suffix}`;
  await expect(page.locator('form[action="/en/settings/profile"]')).toHaveAttribute(
    'data-hydrated',
    'true',
  );
  await page.getByRole('textbox', { name: 'Display name' }).fill(publicName);
  await page.getByRole('textbox', { name: 'Bio' }).fill('Reading and writing on REZICS.');
  await page.getByRole('button', { name: 'Save public profile' }).click();
  await expect(
    page
      .getByRole('main')
      .getByRole('status')
      .filter({ hasText: 'Your public profile was updated.' }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue(publicName);
  await page.reload();
  const menu = page.getByRole('banner').getByRole('button', { name: 'Account menu' });
  await expect(menu).toHaveAttribute('data-hydrated', 'true');
  await menu.click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/en');
  await signInExisting(page, person);
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Account menu' }),
  ).toContainText(`@${currentHandle}`);
  await expect(
    page.getByRole('banner').getByRole('button', { name: 'Account menu' }),
  ).toContainText(publicName);
  await page.goto('/en/settings');
  await expect(page.getByRole('textbox', { name: 'Bio' })).toHaveValue(
    'Reading and writing on REZICS.',
  );
  await expectNoAccountData(page, marker, person.email);
  await captureVariants(page, info, 'settings', person);
  if (process.env.REZICS_VERIFY_AVATAR === '1') {
    await expect(page.locator('form[action="/en/settings/profile"]')).toHaveAttribute(
      'data-hydrated',
      'true',
    );
    await page.getByLabel('Avatar').setInputFiles({
      name: 'portrait.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO2N6xQAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    if (process.env.REZICS_EXPECT_AVATAR_FAILURE === '1') {
      await page
        .getByRole('textbox', { name: 'Bio' })
        .fill('Keep this text when avatar upload fails.');
    }
    await page.getByRole('button', { name: 'Save public profile' }).click();
    if (process.env.REZICS_EXPECT_AVATAR_FAILURE === '1') {
      await expect(
        page
          .getByRole('main')
          .getByRole('status')
          .filter({ hasText: /An avatar cannot be set|Avatar service is unavailable/ }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('textbox', { name: 'Bio' })).toHaveValue(
        'Keep this text when avatar upload fails.',
      );
      await expect(page.getByText('portrait.png')).toBeVisible();
    } else {
      await expect(
        page
          .getByRole('main')
          .getByRole('status')
          .filter({ hasText: 'Your public profile was updated.' }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('main').locator('img')).toBeVisible();
    }
  }
});
