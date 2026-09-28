import { expect, type Page, test } from '@playwright/test';
import { people } from '../../../scripts/dev/seed/plan.ts';
import { signInAtAccounts } from './account-sign-in.ts';

// Against the seeded demo: Daniel follows Jane Austen (an Open Library author)
// and Lin Mei (a REZICS author) from their pages, finds both in Library, and
// leaves both unfollowed again.
const authors = [
  { path: '/en/authors/open-library/OL21594A', name: 'Jane Austen' },
  { path: '/en/@lin_mei', name: 'Lin Mei 林梅' },
];
const daniel = people.find(person => person.id === 'daniel')!;

// Follow acts once the page has hydrated; the account menu marks when it has.
const hydrated = (page: Page) => expect(page.getByRole('button', { name: 'Account menu' }))
  .toHaveAttribute('data-hydrated', 'true', { timeout: 30_000 });

/** Presses the author's follow button until it says `following`, and waits until Main has saved it. */
async function setFollowing(page: Page, name: string, following: boolean) {
  const on = page.getByRole('button', { name: `Following · Unfollow ${name}` });
  const off = page.getByRole('button', { name: `Follow · ${name}` });
  await expect(on.or(off)).toBeVisible();
  if (await (following ? off : on).isVisible()) await (following ? off : on).click();
  await expect(following ? on : off).toBeVisible();
  await expect(following ? on : off).not.toHaveAttribute('aria-disabled', 'true');
}

test('Daniel follows an Open Library and a REZICS author from their pages and finds both in Library', async ({ page }) => {
  // Sign-in and six page loads, each rendered on demand by a development server.
  test.setTimeout(240_000);
  // Signed out, Follow leads to the full-document sign-in and back to the author.
  await page.goto(authors[0]!.path);
  await expect(page.getByRole('link', { name: /^Follow/ }))
    .toHaveAttribute('href', `/auth/start?next=${encodeURIComponent(authors[0]!.path)}`);
  await expect(page.getByText(/\d[\d,]*\+? followers?$/)).toBeVisible();
  await signInAtAccounts(page, authors[0]!.path, daniel);
  try {
    for (const author of authors) {
      await page.goto(author.path);
      await hydrated(page);
      await setFollowing(page, author.name, true);
      // Saved in Main: a fresh read of the page still says so.
      await page.reload();
      await expect(page.getByRole('button', { name: `Following · Unfollow ${author.name}` })).toBeVisible();
    }
    await page.goto('/en/library');
    const followed = page.getByRole('region', { name: 'Authors you follow' });
    for (const author of authors) {
      const tile = followed.getByRole('listitem').filter({ has: page.getByRole('link', { name: author.name }) });
      await expect(tile.getByText('Newest work')).toBeVisible();
    }
  } finally {
    for (const author of authors) {
      await page.goto(author.path);
      await hydrated(page);
      await setFollowing(page, author.name, false);
    }
  }
  await page.goto('/en/library');
  for (const author of authors) {
    await expect(page.getByRole('region', { name: 'Authors you follow' }).getByRole('link', { name: author.name }))
      .toHaveCount(0);
  }
});
