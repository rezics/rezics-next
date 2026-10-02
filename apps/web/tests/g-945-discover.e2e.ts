import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import { resourceHref } from '../features/address/path.ts';

interface BrowseFixture {
  /** Public Main Work with more than twenty non-global rating populations. */
  work: string;
  /** Name of a population on page two, plus a public community searchable by this exact name. */
  laterPopulation: string;
  submitCommunity: string;
  /** The fixture member's Studio Realms tab, with a published text eligible for submission. */
  studioPath: string;
  topic: string;
}
function fixture(): BrowseFixture {
  const path = process.env.G945_BROWSER_FIXTURE;
  if (!path)
    throw new Error(
      'G945_BROWSER_FIXTURE must name the manager-prepared browse fixture: work with >20 rating populations, laterPopulation, submitCommunity, studioPath and topic',
    );
  return JSON.parse(readFileSync(path, 'utf8')) as BrowseFixture;
}
/** The manager runs this against the shared branch after G-939 and its fixture are served. */
test('G-945 tabs, URL topics, a rating population past page one and a searched submission community', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const data = fixture();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en/discover');
  for (const [tab, label] of [
    ['works', 'Works'],
    ['communities', 'Communities'],
    ['sites', 'Sites'],
    ['people', 'People'],
    ['lists', 'Lists'],
    ['topics', 'Topics'],
  ] as const) {
    await page
      .getByRole('navigation', { name: 'Type' })
      .getByRole('link', { name: label, exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`[?&]tab=${tab}(?:&|$)`));
    await expect(
      page
        .getByRole('navigation', { name: 'Type' })
        .getByRole('link', { name: label, exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
  }
  await page.getByRole('combobox', { name: 'Topics', exact: true }).fill(data.topic);
  await page
    .getByRole('option', { name: new RegExp(data.topic) })
    .first()
    .click();
  await expect(page).toHaveURL(/[?&]ci=/);
  await page.getByRole('button', { name: `Exclude ${data.topic}`, exact: true }).click();
  await expect(page).toHaveURL(/[?&]ce=/);
  await expect(page).not.toHaveURL(/[?&]ci=/);
  await page.getByRole('button', { name: `Remove ${data.topic}`, exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]ce=/);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    .toBe(false);

  const credentialsPath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!credentialsPath)
    throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must name the manager-owned member fixture');
  const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8')) as {
    member: { email: string; password: string };
  };
  const workPath = `/en${resourceHref('/w/', data.work)}`;
  await signInAtAccounts(page, workPath, credentials.member);
  await page.getByRole('button', { name: 'Other communities…', exact: true }).first().click();
  const picker = page.getByRole('combobox', { name: 'Find a community', exact: true });
  await picker.click();
  await page.getByRole('button', { name: 'Show more', exact: true }).click();
  await page.getByRole('option', { name: new RegExp(data.laterPopulation) }).click();
  await expect(page).toHaveURL(/[?&]scope=realm&realm=/);

  await page.goto(data.studioPath);
  await page
    .getByRole('combobox', { name: 'Find a community', exact: true })
    .fill(data.submitCommunity);
  await page.getByRole('option', { name: data.submitCommunity, exact: true }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(
    page
      .locator('main')
      .getByRole('status')
      .filter({ hasText: new RegExp(data.submitCommunity) }),
  ).toBeVisible();
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
});
