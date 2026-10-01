import { expect, type Page } from '@playwright/test';
import { acrossViews, desktop, device, linked, member, phone, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';

// Queries 4, 6 and 11 of the catalogue acceptance fixtures: the reboot and the spin-off with its author,
// progress on one device against the correspondence offered on another, and the source chain from anime to
// manga to novel with its unresolved link visible. Each page is compared with what Main answered.
let data: Seeded;
test.use({ actionTimeout: 15_000 });
test.beforeAll(() => {
  test.setTimeout(540_000);
  data = seeded();
});

const work = (key: string) => data.manifest.works[key]!.work;
const connections = (locale: string, key: string) => `/${locale}/w/${uuid(work(key))}/connections`;
const rowLinks = (page: Page) => linked(page.locator('[data-relation-row] a'));
/** The Works a Work's relations name in Main's answer: the rows the page must carry, in either direction. */
const counterparts = (key: string, role?: string) => [...new Set(data.answers.relations[key]!
  .filter(item => !role || item.viewingRole === role).flatMap(item => item.counterparts)
  .filter(iri => Object.values(data.manifest.works).some(item => item.work === iri)).map(uuid))];

test('query 4: Progressive shows Reboot; Alternative GGO shows SpinOff with Sigsawa as author', async ({ page }, info) => {
  test.setTimeout(420_000);
  expect(counterparts('sao.progressive', 'reboot')).toContain(uuid(work('sao.bunko')));
  expect(counterparts('sao.aggo', 'spin-off')).toContain(uuid(work('sao.bunko')));

  await acrossViews(page, info, 'q4-progressive', locale => connections(locale, 'sao.progressive'), '[data-relation-row]', async () => {
    expect(await rowLinks(page)).toEqual(expect.arrayContaining(counterparts('sao.progressive', 'reboot')));
  });
  await page.goto(connections('en', 'sao.progressive'));
  await expect(page.locator('[data-relation-row]').filter({ hasText: 'Reboot of' }).getByRole('link').first())
    .toHaveAttribute('href', new RegExp(`/en/w/${uuid(work('sao.bunko'))}$`));

  const sigsawa = data.answers.credits['sao.aggo']!.find(credit => credit.role === 'author' && credit.displayName === 'Keiichi Sigsawa');
  expect(sigsawa).toBeDefined();
  await acrossViews(page, info, 'q4-aggo', locale => connections(locale, 'sao.aggo'), '[data-relation-row]', async () => {
    expect(await rowLinks(page)).toEqual(expect.arrayContaining(counterparts('sao.aggo', 'spin-off')));
    // The author is the one Main credits, named in the Work's header.
    await expect(page.getByRole('link', { name: 'Keiichi Sigsawa' }).first()).toBeVisible();
  });
  await page.goto(connections('en', 'sao.aggo'));
  await expect(page.locator('[data-relation-row]').filter({ hasText: 'Spin-off of' }).getByRole('link').first())
    .toHaveAttribute('href', new RegExp(`/en/w/${uuid(work('sao.bunko'))}$`));
  // The bunko Work sees both from its side: what reboots it and what spins off from it.
  await page.goto(connections('en', 'sao.bunko'));
  await expect(page.locator('[data-relation-row]').filter({ hasText: 'Reboot' }).first()).toBeVisible();
  await expect(page.locator('[data-relation-row]').filter({ hasText: 'Spin-off' }).first()).toBeVisible();
  const bunko = await rowLinks(page);
  expect(bunko).toEqual(expect.arrayContaining([uuid(work('sao.progressive')), uuid(work('sao.aggo'))]));
});

test('query 11: anime to manga to novel source chains are traversable, with unresolved links visible', async ({ page }, info) => {
  test.setTimeout(420_000);
  const anime = data.answers.relations['index.railgun.anime']!.find(item => item.kind === 'derivation');
  expect(anime).toMatchObject({ unresolved: true });
  expect(anime?.counterparts.map(uuid)).toContain(uuid(work('index.railgun')));

  for (const key of ['index.railgun.anime', 'index.railgun', 'index.original'] as const) {
    await acrossViews(page, info, `q11-${key}`, locale => connections(locale, key), '[data-relation-row]', async () => {
      // Every Work Main names as related is a link on the page.
      expect(await rowLinks(page)).toEqual(expect.arrayContaining(counterparts(key)));
      // A source revision shows as unresolved exactly where Main says it is.
      const unresolved = page.locator('[data-relation-row] [data-slot="badge"]');
      await expect(unresolved).toHaveCount(data.answers.relations[key]!.filter(item => item.unresolved).length);
    });
  }
  // Traverse the chain by clicking: anime → manga → novel.
  await page.goto(connections('en', 'index.railgun.anime'));
  const adapted = page.locator('[data-relation-row]').filter({ hasText: 'Adapted from' });
  await expect(adapted.getByText('Source version unresolved')).toBeVisible();
  await adapted.getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`/en/w/${uuid(work('index.railgun'))}$`));
  await page.goto(connections('en', 'index.railgun'));
  await page.locator('[data-relation-row]').filter({ hasText: 'Spin-off of' }).getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`/en/w/${uuid(work('index.original'))}$`));
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
