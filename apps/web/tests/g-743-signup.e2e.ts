import { expect, type Page, test } from '@playwright/test';
import { checkScreen, composeCjk, expectClean, type Findings, keyboardReach, locales, motionRunning, pressByKeyboard } from './g-743-matrix.ts';
import { visitor } from './g-743-stack.ts';

// Launch journey `sign-up-with-policies`: someone joins from Home, on the Accounts site the web app hands them to
// (G-736's sign-up, `apps/accounts/tests/first-party-signup.e2e.ts`), declares a birth month, and accepts the Terms
// and the Privacy Policy. The matrix of `g-743-matrix.ts` on the form, on the refusal that names the policies, and
// on the "Check your email" screen; the form filled by keyboard alone under reduced motion; the same form in
// Japanese with the name composed by an input method. Email verification is the Accounts journey's own.
test.use({ actionTimeout: 15_000 });

/** Home's "Join REZICS" link, reached and followed by keyboard, then the Accounts site's sign-up page. */
async function openSignUp(page: Page, locale: string, found: Findings) {
  await page.goto(`/${locale}/`);
  const join = page.locator('a[href*="/auth/start"], a[href*="sign-up"]').first();
  await expect(join).toBeVisible();
  await pressByKeyboard(page, join, found, 'Join REZICS');
  await page.waitForURL(url => /^\/sign-(in|up)$/.test(url.pathname), { timeout: 60_000 });
  await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
  if (new URL(page.url()).pathname === '/sign-in') {
    // Joining is the link below the sign-in step on Accounts.
    await pressByKeyboard(page, page.locator('a[href^="/sign-up"]').first(), found, 'Create an account link');
    await page.waitForURL(url => url.pathname === '/sign-up', { timeout: 60_000 });
    await page.locator('html[data-hydrated]').waitFor({ timeout: 60_000 });
  }
}

test('sign-up-with-policies: the form is filled by keyboard alone under reduced motion, and the refusal names the policies', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const found: Findings = [];
  const page = await visitor(browser, info, { reducedMotion: true });
  await openSignUp(page, locales.latin, found);
  await expect(page.getByRole('heading', { name: 'Create your REZICS Account' })).toBeVisible();
  await checkScreen(page, 'signup-form', found, info);

  const id = Date.now().toString(36);
  const type = async (label: string, value: string, exact = false) => {
    const field = page.getByLabel(label, { exact });
    await keyboardReach(page, field, found, label);
    await page.keyboard.type(value);
  };
  await type('Name', `Keyboard ${id}`, true);
  await type('Email', `a11y-${id}@example.test`, true);
  await type('Password', `pass phrase ${id}`, true);
  await type('Confirm', `pass phrase ${id}`);
  for (const [name, value] of [['Month', '05'], ['Year', '1990']] as const) {
    const select = page.getByRole('combobox', { name });
    await keyboardReach(page, select, found, name);
    await select.selectOption(value);
  }

  // Sent without accepting the policies: refused, naming them, and nothing is created.
  await pressByKeyboard(page, page.getByRole('button', { name: 'Next' }), found, 'Next (policies not accepted)');
  await expect(page.getByText('Accept the Terms and the Privacy Policy to create an account')).toBeVisible();
  await checkScreen(page, 'signup-policies-required', found, info);

  // Accept with Space, read the policies' links by keyboard, and send.
  const accept = page.getByRole('checkbox', { name: /I have read and accept/ });
  await pressByKeyboard(page, accept, found, 'Accept the policies', 'Space');
  await expect(accept).toBeChecked();
  await keyboardReach(page, page.getByRole('link', { name: 'Privacy Policy' }), found, 'Privacy Policy link');
  await pressByKeyboard(page, page.getByRole('button', { name: 'Next' }), found, 'Next');
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible({ timeout: 60_000 });
  await checkScreen(page, 'signup-check-email', found, info);
  expect(await motionRunning(page), 'running animations under reduced motion').toEqual([]);
  await page.context().close();
  expectClean(found);
});

test('sign-up-with-policies: the form in the CJK locale, the name composed with an input method', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const found: Findings = [];
  const page = await visitor(browser, info);
  await openSignUp(page, locales.cjk, found);
  await expect(page.locator('html')).toHaveAttribute('lang', locales.cjk);
  const name = page.getByRole('textbox').first();
  await keyboardReach(page, name, found, 'Name (ja)');
  const composed = await composeCjk(page, name, '山田 太郎');
  expect(composed.value).toBe('山田 太郎');
  expect(composed.submitted, 'an Enter that belongs to the composition does not send the form').toBe(false);
  await checkScreen(page, 'signup-form-ja', found, info);
  await pressByKeyboard(page, page.getByRole('button').filter({ hasText: /./ }).last(), found, 'send (ja)');
  await checkScreen(page, 'signup-refused-ja', found, info);
  await page.context().close();
  expectClean(found);
});
