import { expect, type Page } from '@playwright/test';
import { desktop, device, member, phone, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';

// Query 6 of the catalogue acceptance fixtures, read through the web UI as the stack's web member. The page is
// compared with what Main answered for the same fixture (`answers`, recorded by `g-841-catalogue.ts`), so a
// page that disagrees with the API fails.

let data: Seeded;
test.use({ actionTimeout: 15_000 });
test.beforeAll(() => {
  test.setTimeout(540_000);
  data = seeded();
});


test('query 6: progress in the web Spider never completes the book; the offer needs explicit acceptance', async ({ browser }, info) => {
  test.setTimeout(420_000);
  const { actingSubject } = member();
  const { web, book } = data.spider;
  expect(data.answers.relations['D03.web']!.some(item => item.counterparts.includes(book))).toBe(true);
  const at = (locale: string, iri: string, rest = '') => `/${locale}/w/${uuid(iri)}${rest}`;
  // One reader on two devices: a desktop and a phone, each signed in on its own.
  const a = await device(browser, info, desktop, at('en', web, '/connections'));
  const b = await device(browser, info, phone, at('en', book));

  const finished = async (page: Page, iri: string) => {
    const response = await page.request.get(`/api/main/v1/me/sessions?actingSubject=${encodeURIComponent(actingSubject)}&target=${encodeURIComponent(iri)}`);
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json() as { items: { state: string; target: { resource: string } }[] }).items
      .some(item => item.state === 'finished' && item.target.resource === iri);
  };
  /** The reader's shelf status of a Work, as Main keeps it. */
  const shelf = async (page: Page, iri: string) => {
    const response = await page.request.get(`/api/main/v1/me/work-states?works=${encodeURIComponent(iri)}&actingSubject=${encodeURIComponent(actingSubject)}`);
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json() as { items: { status: { status: string | null } }[] }).items[0]?.status.status ?? null;
  };
  const shot = (page: Page, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });

  // Neither is started. The phone shows the book as something to read.
  expect(await shelf(a, web)).not.toBe('read');
  expect(await shelf(b, book)).not.toBe('read');
  await expect(b.getByRole('button', { name: 'Want to read' })).toBeVisible();
  await shot(b, 'q6-book-phone-before');

  // The desktop finishes the web serial; the offer to mark the book appears and marks nothing.
  await expect(a.getByRole('region', { name: 'Your progress' })).toHaveCount(0);
  await a.getByRole('button', { name: 'More shelves' }).click();
  await a.getByRole('menuitemradio', { name: 'Read', exact: true }).click();
  await expect(a.getByRole('button', { name: /^Read — Shelve/ })).toBeVisible();
  const offer = a.getByRole('region', { name: 'Your progress' });
  await expect(offer).toContainText('Nothing is marked until you choose');
  await shot(a, 'q6-offer-desktop-en');
  expect(await shelf(a, web)).toBe('read');
  expect(await shelf(a, book)).not.toBe('read');
  expect(await finished(a, book)).toBe(false);
  await b.reload();
  await expect(b.getByRole('button', { name: 'Want to read' })).toBeVisible();
  expect(await shelf(b, book)).not.toBe('read');

  // The same offer in Traditional Chinese, on both devices; the book is still unread.
  await a.goto(at('zh-Hant', web, '/connections'));
  const offerZh = a.getByRole('button', { name: /^同時將「.*」標為已讀$/ });
  await expect(offerZh).toBeVisible();
  await shot(a, 'q6-offer-desktop-zh-Hant');
  await b.goto(at('zh-Hant', book));
  await expect(b.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(b.locator('[aria-busy="true"]')).toHaveCount(0);
  expect(await b.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await shot(b, 'q6-book-phone-zh-Hant');
  expect(await shelf(b, book)).not.toBe('read');

  // Accepting is explicit: only then does the book count as read, on the phone too.
  await offerZh.click();
  await expect(a.getByText(/^已將「.*」標為已讀。$/)).toBeVisible();
  expect(await shelf(a, book) === 'read' || await finished(a, book)).toBe(true);
  await b.goto(at('en', book));
  await expect(b.getByRole('button', { name: /^Read — Shelve/ })).toBeVisible();
  await shot(b, 'q6-book-phone-after');
});
