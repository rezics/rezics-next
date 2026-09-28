import { randomBytes } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const accountsOrigin = process.env.ACCOUNT_ORIGIN ?? 'http://127.0.0.1:3004';
const signUpOrigin = process.env.REZICS_ACCOUNTS_SIGNUP_ORIGIN;
const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

async function captureVariants(page: Page, info: TestInfo, screen: 'onboarding' | 'settings') {
  const origin = process.env.REZICS_WEB_E2E_BASE_URL ?? 'http://127.0.0.1:3000';
  for (const locale of ['en', 'zh-Hans'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      await page.context().addCookies([{ name: 'rezics_theme', value: theme, url: origin }]);
      // Signed in, the Account's display mode (system for a new person) wins over the cookie.
      await page.emulateMedia({ colorScheme: theme });
      for (const [size, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]] as const) {
        await page.setViewportSize({ width, height });
        await page.goto(`/${locale}/${screen}${screen === 'onboarding' ? '?next=%2Fen' : ''}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.getByRole('combobox', { name: locale === 'en' ? 'Search works' : '搜索作品' }))
          .toBeVisible();
        await expect(page.getByRole('textbox', { name: locale === 'en' ? 'Your handle' : '您的用户名' }))
          .toHaveAttribute('data-hydrated', 'true', { timeout: 20_000 });
        // Settings has other status lines; the handle's is the one that names it.
        await expect(page.getByRole('main').getByRole('status').filter({ hasText: screen === 'onboarding'
          ? locale === 'en' ? 'This handle is available.' : '此用户名可用。'
          : locale === 'en' ? 'This is your current handle.' : '这是您当前的用户名。' })).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('html')).toHaveClass(new RegExp(`^(${theme})?$`));
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.screenshot({ path: info.outputPath(`${screen}-${locale}-${theme}-${size}.png`), fullPage: true });
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
  for (const locale of ['en', 'zh-Hans'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      await page.context().addCookies([{ name: 'rezics_theme', value: theme, url: origin }]);
      await page.emulateMedia({ colorScheme: theme });
      for (const [size, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]] as const) {
        await page.setViewportSize({ width, height });
        await page.goto(`/${locale}/welcome?next=${encodeURIComponent(`/${locale}`)}`);
        await expect(page.getByRole('heading', { level: 2, name: locale === 'en' ? 'Which languages do you read?'
          : '你读哪些语言？' })).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.screenshot({ path: info.outputPath(`welcome-${locale}-${theme}-${size}.png`), fullPage: true });
      }
    }
  }
  await page.context().addCookies([{ name: 'rezics_theme', value: 'light', url: origin }]);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en/welcome?next=%2Fen');
}

async function verificationLink(email: string): Promise<string> {
  let link = '';
  await expect.poll(async () => {
    const response = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages } = await response.json() as { messages: { ID: string; Subject: string }[] };
    const newest = messages.find(item => /^Verify your email address$/.test(item.Subject));
    if (!newest) return false;
    const { Text } = await (await fetch(`${mailpit}/api/v1/message/${newest.ID}`)).json() as { Text: string };
    link = /https?:\/\/\S+/.exec(Text)?.[0] ?? '';
    return Boolean(link);
  }, { timeout: 30_000 }).toBe(true);
  return link;
}

test('new person chooses a handle, sets up Home, returns home and keeps the acting profile after sign-in', async ({ page }, info) => {
  test.setTimeout(240_000);
  const suffix = randomBytes(6).toString('hex');
  const person = { name: `Reader ${suffix}`, email: `onboarding-${suffix}@example.test`,
    password: `pass phrase ${suffix}`, handle: `reader_${suffix}` };
  let currentHandle = person.handle;
  await page.goto('/auth/start?create=1&next=%2Fen');
  await expect(page).toHaveURL(url => url.origin === new URL(accountsOrigin).origin);
  if (signUpOrigin) {
    const signUp = new URL(page.url());
    await page.goto(`${signUpOrigin}${signUp.pathname}${signUp.search}`);
  }
  await expect(page.getByRole('heading', { name: 'Create your REZICS Account' })).toBeVisible();
  await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
  await page.getByRole('textbox', { name: 'Name' }).fill(person.name);
  await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await page.getByLabel('Confirm').fill(person.password);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const verify = new URL(await verificationLink(person.email));
  if (signUpOrigin) await page.goto(`${signUpOrigin}${verify.pathname}${verify.search}`);
  else await page.goto(verify.toString());
  // Verification signs the new person in and returns to REZICS; an older Accounts asks them to sign in again.
  const signIn = page.getByRole('link', { name: 'Sign in to continue' });
  await expect(signIn.or(page.getByRole('textbox', { name: 'Your handle' }))).toBeVisible({ timeout: 60_000 });
  if (await signIn.isVisible()) {
    await signIn.click();
    // A shared Accounts frontend older than this worktree still preserves
    // prompt=create after verification. Reauthorize to exercise the new person.
    if (!signUpOrigin && await page.getByRole('heading', { name: 'Create your REZICS Account' }).isVisible()) {
      await page.goto('/auth/start?next=%2Fen');
    }
    await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
    await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Enter your password').fill(person.password);
    await page.getByRole('button', { name: 'Next' }).click();
  }
  // G-431: after the handle comes Home's setup, then where the person was going.
  await expect(page).toHaveURL(`/en/onboarding?next=${encodeURIComponent('/en/welcome?next=%2Fen')}`,
    { timeout: 60_000 });
  const handleStep = page.url();
  await expect(page.getByRole('main').getByText(person.name)).toBeVisible();
  await captureVariants(page, info, 'onboarding');
  await page.goto(handleStep);
  await page.getByRole('textbox', { name: 'Your handle' }).fill(person.handle);
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'This handle is available.' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  // G-431: a first visit continues into Home's setup: languages, topics that become tabs, then communities.
  await expect(page).toHaveURL('/en/welcome?next=%2Fen');
  await captureSetup(page, info);
  const setup = page.getByRole('main');
  await expect(setup.getByRole('heading', { level: 2, name: 'Which languages do you read?' })).toBeVisible();
  await expect(setup.getByRole('region', { name: 'Your languages, first choice first' })).toContainText('English');
  await setup.getByRole('button', { name: 'Next' }).click();
  await expect(setup.getByRole('heading', { level: 2, name: 'Pick a few topics' })).toBeVisible();
  const topic = setup.locator('button[aria-pressed]').first();
  if (await topic.isVisible()) {
    await topic.click();
    await expect(topic).toHaveAttribute('aria-pressed', 'true');
    await setup.getByRole('button', { name: 'Next' }).click();
  } else await setup.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(setup.getByRole('heading', { level: 2, name: 'Follow a few communities' })).toBeVisible();
  await setup.getByRole('button', { name: /finish$|^Finish$/ }).click();
  await expect(page).toHaveURL('/en', { timeout: 30_000 });
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account menu' }))
    .toContainText(`@${person.handle}`);
  await page.reload();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account menu' }))
    .toContainText(`@${person.handle}`);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account menu' }))
    .toHaveAttribute('data-hydrated', 'true');
  await page.getByRole('banner').getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Profile settings' }).click();
  await expect(page).toHaveURL('/en/settings');
  await expect(page.getByRole('main').getByText(`@${person.handle}`)).toBeVisible();
  await page.getByRole('textbox', { name: 'Your handle' }).fill(`another_${suffix}`);
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'This handle is available.' })).toBeVisible();
  await page.getByRole('button', { name: 'Change handle' }).click();
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'You can change your handle again 30 days' }))
    .toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your handle' })).toHaveAttribute('data-hydrated', 'true');
  if (process.env.REZICS_AGE_HANDLE === '1') {
    const databaseUrl = process.env.ACCESS_DATABASE_URL;
    if (!databaseUrl) throw new Error('ACCESS_DATABASE_URL is required for the isolated rename fixture');
    const oldProfile = await (await fetch(`http://127.0.0.1:3001/v1/handles/${person.handle}`)).json() as
      { id: string; displayName: string };
    expect(oldProfile.displayName).toBe(person.name);
    const { Client } = await import('pg');
    const db = new Client({ connectionString: databaseUrl });
    try {
      await db.connect();
      const aged = await db.query(`UPDATE access.agent_handle
        SET claimed_at = clock_timestamp() - interval '31 days'
        WHERE handle = $1 AND agent_id = $2 AND state = 'current'`, [person.handle, oldProfile.id]);
      expect(aged.rowCount).toBe(1);
    } finally { await db.end(); }
    currentHandle = `another_${suffix}`;
    await page.getByRole('textbox', { name: 'Your handle' }).fill(currentHandle);
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'This handle is available.' })).toBeVisible();
    await page.getByRole('button', { name: 'Change handle' }).click();
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Your handle was changed.' })).toBeVisible();
    const oldAddress = await page.request.get(`http://127.0.0.1:3001/v1/handles/${person.handle}`);
    expect(oldAddress.status()).toBe(200);
    expect(await oldAddress.json()).toMatchObject({ resolution: {
      requestedHandle: person.handle, state: 'retired', redirect: true, canonical: `/@${currentHandle}` } });
  }
  const publicName = `Author ${suffix}`;
  await expect(page.locator('form[action="/en/settings/profile"]')).toHaveAttribute('data-hydrated', 'true');
  await page.getByRole('textbox', { name: 'Display name' }).fill(publicName);
  await page.getByRole('textbox', { name: 'Bio' }).fill('Reading and writing on REZICS.');
  await page.getByRole('button', { name: 'Save public profile' }).click();
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Your public profile was updated.' }))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue(publicName);
  await page.reload();
  const menu = page.getByRole('banner').getByRole('button', { name: 'Account menu' });
  await expect(menu).toHaveAttribute('data-hydrated', 'true');
  await menu.click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/en');
  await page.goto('/auth/start?next=%2Fen');
  if (new URL(page.url()).origin === new URL(accountsOrigin).origin) {
    await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
    await page.getByRole('textbox', { name: 'Email' }).fill(person.email);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Enter your password').fill(person.password);
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await expect(page).toHaveURL('/en');
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account menu' }))
    .toContainText(`@${currentHandle}`);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account menu' }))
    .toContainText(publicName);
  await page.goto('/en/settings');
  await expect(page.getByRole('textbox', { name: 'Bio' })).toHaveValue('Reading and writing on REZICS.');
  await captureVariants(page, info, 'settings');
  if (process.env.REZICS_VERIFY_AVATAR === '1') {
    await expect(page.locator('form[action="/en/settings/profile"]')).toHaveAttribute('data-hydrated', 'true');
    await page.getByLabel('Avatar').setInputFiles({ name: 'portrait.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO2N6xQAAAAASUVORK5CYII=', 'base64') });
    if (process.env.REZICS_EXPECT_AVATAR_FAILURE === '1') {
      await page.getByRole('textbox', { name: 'Bio' }).fill('Keep this text when avatar upload fails.');
    }
    await page.getByRole('button', { name: 'Save public profile' }).click();
    if (process.env.REZICS_EXPECT_AVATAR_FAILURE === '1') {
      await expect(page.getByRole('main').getByRole('status').filter({ hasText: /An avatar cannot be set|Avatar service is unavailable/ }))
        .toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('textbox', { name: 'Bio' }))
        .toHaveValue('Keep this text when avatar upload fails.');
      await expect(page.getByText('portrait.png')).toBeVisible();
    } else {
      await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Your public profile was updated.' }))
        .toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('main').locator('img')).toBeVisible();
    }
  }
});
