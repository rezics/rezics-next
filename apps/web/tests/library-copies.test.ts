import { expect, test } from 'bun:test';
import {
  article,
  calls,
  copies,
  edition,
  hiddenSubjectId,
  id,
  lists,
  make,
  newSubject,
  observe,
  open,
  pageLimit,
  reset,
  setSerial,
  uuid,
  zebra,
} from './library-copies.browser';
import { slug } from '@rezics/definitions/slug';
import { browserSessionToken } from './session-token';
import type { Page } from 'playwright';

const timeout = 300_000;
function decodedKey(value: string | null): string {
  const decoded = JSON.parse(value ?? 'null') as string;
  expect(value).toBe(JSON.stringify(decoded));
  expect(decoded).toMatch(uuid);
  return decoded;
}

test(
  'an empty selected subject page resolves copy choices from the subject and sends the selected kind',
  async () => {
    reset();
    copies.length = 0;
    calls.length = 0;
    const { page } = await open(`/en/library/copies?subjectId=${encodeURIComponent(edition)}`);
    try {
      const subjectReads = calls.filter((call) => call.method === 'GET' && call.path === `/v1/subjects/${edition}`);
      expect(subjectReads).toHaveLength(1);
      expect(await page.locator('main').getByRole('button', { name: 'Add a copy' }).count()).toBe(1);

      await page.locator('main').getByRole('button', { name: 'Add a copy' }).click();
      const form = page.getByRole('dialog').getByRole('form', { name: 'Add a copy' });
      await form.getByLabel('Kind').selectOption('digital');
      await form.getByLabel('Status').selectOption('owned');
      await form.getByRole('button', { name: 'More' }).click();
      await form.getByLabel('Note').fill('Digital copy');
      await form.getByRole('button', { name: 'Add copy' }).click();
      await article(page, 'Digital copy').waitFor({ timeout: 15_000 });

      const create = calls.find((call) => call.method === 'POST' && call.path === '/v1/copies');
      expect(create?.body).toEqual({
        subjectId: edition,
        kind: 'digital',
        status: 'owned',
        location: null,
        source: null,
        acquiredOn: null,
        disposedOn: null,
        note: 'Digital copy',
      });
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a signed-in person lists their copies and adds one with its status, location, source, dates and note',
  async () => {
    reset();
    const { page, access, origin, response } = await open('/en/library/copies');
    try {
      expect(response?.status()).toBe(200);
      expect(response?.headers()['cache-control'] ?? '').toMatch(/\bno-store\b/);
      const main = page.locator('main');
      expect(await main.getByRole('heading', { level: 1 }).innerText()).toBe('Copies');
      const first = article(page, 'First copy');
      expect(await first.getByRole('link', { name: 'Zebra story' }).getAttribute('href')).toBe(
        `/en/subjects/${edition}/${slug('Zebra story')}`,
      );
      expect(await first.getAttribute('data-slot')).toBe('list-row');
      expect(await first.innerText()).toContain('Owned');
      expect(await first.innerText()).toContain('Jan 1, 2030');
      expect(await first.innerText()).toContain('Study');
      expect(await first.innerText()).toContain('First copy');
      expect(await first.locator('form').count()).toBe(0);
      expect(await first.locator('[data-slot=cover]').count()).toBe(1);
      expect(await page.locator('main input, main select').count()).toBe(0);
      const waiting = article(page, 'Waiting');
      expect(await waiting.innerText()).toContain('Unavailable');
      expect(await waiting.innerText()).toContain('Other');
      // A legacy/unknown kind has no matching release choice, so its editor is delete-only.
      await waiting.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
      const legacy = page.getByRole('dialog').getByRole('form', { name: 'Edit copy' });
      expect(await legacy.innerText()).toContain('This copy’s type is no longer offered for this item.');
      expect(await legacy.getByRole('button', { name: 'Save' }).count()).toBe(0);
      expect(await legacy.getByRole('button', { name: 'Delete', exact: true }).count()).toBe(1);
      await legacy.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(await main.innerHTML()).not.toContain(hiddenSubjectId);
      expect(await main.innerText()).not.toContain('Secret other copy');
      const reads = lists();
      expect(reads.length).toBeGreaterThan(0);
      expect(
        reads.every(
          (call) =>
            call.view === 'FULL' &&
            call.limit === pageLimit &&
            call.authorization === `Bearer ${access}` &&
            !new URLSearchParams(call.search).has('subjectId'),
        ),
      ).toBe(true);
      expect(calls.filter((call) => call.method === 'GET' && /^\/v1\/copies\/.+/.test(call.path))).toHaveLength(0);

      await main.getByRole('button', { name: 'Add a copy' }).click();
      const add = page.getByRole('dialog').getByRole('form', { name: 'Add a copy' });
      await add.getByLabel('Edition').fill(newSubject);
      await add.getByRole('button', { name: 'More' }).click();
      const html = await add.evaluate((element) => element.outerHTML);
      await add.getByLabel('Status').selectOption({ label: 'Disposed' });
      await add.getByLabel('Location').fill('Shelf');
      await add.getByLabel('Source').fill('Shop');
      await pickDate(page, 'Acquired', '2030-02-02');
      await pickDate(page, 'Disposed on', '2030-02-20');
      await add.getByLabel('Note').fill('Second shelf');
      const requests = observe(page);
      await add.getByRole('button', { name: 'Add copy' }).click();
      const created = article(page, 'Second shelf');
      await created.waitFor({ timeout: 15_000 });
      expect(requests).toHaveLength(1);
      const csrf = await browserSessionToken(page);
      expect(csrf).toBeTruthy();
      expect(requests[0]!.headers()['x-csrf-token']).toBe(csrf);
      expect(new URL(requests[0]!.url()).origin).toBe(origin);
      const posts = calls.filter((call) => call.method === 'POST' && call.path === '/v1/copies');
      expect(posts).toHaveLength(1);
      expect(html).toContain(decodedKey(posts[0]!.key));
      expect(posts[0]?.authorization).toBe(`Bearer ${access}`);
      expect(posts[0]?.body).toEqual({
        subjectId: newSubject,
        kind: 'physical',
        status: 'disposed',
        location: 'Shelf',
        source: 'Shop',
        acquiredOn: '2030-02-02',
        disposedOn: '2030-02-20',
        note: 'Second shelf',
      });
      expect(await created.innerText()).toContain('Unavailable');
      expect(await created.innerText()).toContain('Feb 2, 2030');
      expect(await created.innerText()).toContain('Feb 20, 2030');
      expect(await created.innerText()).not.toContain(newSubject);
      expect(await created.innerText()).toContain('Disposed');
      expect(await created.innerText()).toContain('Shelf');
      expect(await created.innerText()).toContain('Second shelf');

      await page.goto(`${origin}/en/library/copies?subjectId=${encodeURIComponent(edition)}`, {
        waitUntil: 'networkidle',
      });
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
      expect(await main.innerText()).toContain('First copy');
      expect(await main.innerText()).toContain('Zebra story');
      expect(await main.locator('[data-slot="list-row"]').count()).toBe(1);
      expect(await main.innerText()).not.toContain('Waiting');
      expect(await main.innerText()).not.toContain('Second shelf');
      await main.getByRole('button', { name: 'Add a copy' }).click();
      const filteredAdd = page.getByRole('dialog').getByRole('form', { name: 'Add a copy' });
      expect(await filteredAdd.locator('input[name="subjectId"]').inputValue()).toBe(edition);
      expect(await filteredAdd.getByLabel('Kind').inputValue()).toBe('physical');
      expect(await filteredAdd.getByLabel('Status').inputValue()).toBe('owned');
      expect(await filteredAdd.getByLabel('Edition').count()).toBe(0);
      const filtered = lists().at(-1);
      expect(filtered?.view).toBe('FULL');
      expect(filtered?.limit).toBe(pageLimit);
      expect(new URLSearchParams(filtered?.search ?? '').get('subjectId')).toBe(edition);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'two copies of one edition stay separate through edits and deletion',
  async () => {
    copies.length = 0;
    calls.length = 0;
    setSerial(200);
    const desk = make({
      accountId: 'alice',
      subjectId: edition,
      subject: zebra,
      kind: 'physical',
      status: 'owned',
      location: 'Desk',
      source: 'Shop',
      acquiredOn: '2030-03-03',
      disposedOn: null,
      note: 'Desk copy',
    });
    const spare = make({
      accountId: 'alice',
      subjectId: edition,
      subject: zebra,
      kind: 'physical',
      status: 'owned',
      location: 'Box',
      source: 'Gift',
      acquiredOn: null,
      disposedOn: null,
      note: 'Spare copy',
    });
    copies.push(desk, spare);
    const { page, access } = await open('/en/library/copies');
    try {
      expect(await page.locator('main').getByRole('link', { name: 'Zebra story' }).count()).toBe(2);
      const deskArticle = article(page, 'Desk copy');
      await deskArticle.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Edit copy' }).click();
      const dialog = page.getByRole('dialog');
      const form = dialog.getByRole('form', { name: 'Edit copy' });
      await form.getByRole('button', { name: 'More' }).click();
      const html = await form.evaluate((element) => element.outerHTML);
      await form.getByLabel('Status').selectOption({ label: 'Disposed' });
      await form.getByLabel('Location').fill('Friend');
      await form.getByLabel('Note').fill('Loan');
      const requests = observe(page);
      await form.getByRole('button', { name: 'Save' }).click();
      const edited = article(page, 'Loan');
      await edited.waitFor({ timeout: 15_000 });
      expect(await edited.innerText()).toContain('Disposed');
      expect(await edited.innerText()).toContain('Friend');
      expect(await edited.innerText()).toContain('Loan');
      await edited.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Edit copy' }).click();
      const editedDialog = page.getByRole('dialog');
      await editedDialog.getByRole('button', { name: 'More' }).click();
      expect(await editedDialog.getByLabel('Status').inputValue()).toBe('disposed');
      expect(await editedDialog.getByLabel('Location').inputValue()).toBe('Friend');
      expect(await editedDialog.getByLabel('Source').inputValue()).toBe('Shop');
      expect(await editedDialog.getByLabel('Acquired').innerText()).toContain('Mar 3, 2030');
      expect(await editedDialog.getByLabel('Note').inputValue()).toBe('Loan');
      await editedDialog.getByRole('button', { name: 'Cancel' }).click();
      const spareArticle = article(page, 'Spare copy');
      expect(await spareArticle.innerText()).toContain('Owned');
      expect(await spareArticle.innerText()).toContain('Box');
      expect(await spareArticle.innerText()).toContain('Spare copy');
      expect(requests).toHaveLength(1);
      const patches = calls.filter((call) => call.method === 'PATCH');
      expect(patches).toHaveLength(1);
      expect(patches[0]?.path).toBe(`/v1/copies/${desk.id}`);
      expect(html).toContain(decodedKey(patches[0]!.key));
      expect(patches[0]?.authorization).toBe(`Bearer ${access}`);
      expect(patches[0]?.body).toEqual({
        revision: 1,
        status: 'disposed',
        location: 'Friend',
        source: 'Shop',
        acquiredOn: '2030-03-03',
        disposedOn: null,
        note: 'Loan',
      });
      expect(copies.find((copy) => copy.id === desk.id)).toMatchObject({
        status: 'disposed',
        location: 'Friend',
        note: 'Loan',
        revision: 2,
      });
      expect(copies.find((copy) => copy.id === spare.id)).toMatchObject({
        status: 'owned',
        location: 'Box',
        note: 'Spare copy',
        revision: 1,
      });

      await spareArticle.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Edit copy' }).click();
      const spareDialog = page.getByRole('dialog');
      await spareDialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await spareDialog.getByRole('alertdialog').waitFor();
      expect(await spareDialog.innerText()).toContain('Delete this copy?');
      await spareDialog.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      await spareDialog.getByRole('alertdialog').waitFor({ state: 'detached' });
      await spareDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
      expect(await spareArticle.innerText()).toContain('Spare copy');

      await edited.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Edit copy' }).click();
      const deleteDialog = page.getByRole('dialog');
      const deleteHtml = await deleteDialog.evaluate((element) => element.outerHTML);
      const deleteRequests = observe(page);
      await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await deleteDialog.getByRole('button', { name: 'Delete this copy', exact: true }).click();
      await edited.waitFor({ state: 'detached', timeout: 15_000 });
      expect(await page.locator('main').getByRole('link', { name: 'Zebra story' }).count()).toBe(1);
      expect(await spareArticle.innerText()).toContain('Spare copy');
      expect(deleteRequests).toHaveLength(1);
      const deletions = calls.filter((call) => call.method === 'DELETE');
      expect(deletions).toHaveLength(1);
      expect(deletions[0]?.path).toBe(`/v1/copies/${desk.id}`);
      expect(deletions[0]?.revision).toBe('2');
      expect(deleteHtml).toContain(decodedKey(deletions[0]!.key));
      expect(deletions[0]?.authorization).toBe(`Bearer ${access}`);
      expect(copies.some((copy) => copy.id === desk.id)).toBe(false);
      expect(copies.find((copy) => copy.id === spare.id)?.note).toBe('Spare copy');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a stale revision keeps the edit and explains it',
  async () => {
    copies.length = 0;
    calls.length = 0;
    setSerial(300);
    const shelf = make({
      accountId: 'alice',
      subjectId: edition,
      subject: zebra,
      kind: 'physical',
      status: 'owned',
      location: 'Study',
      source: 'Bookshop',
      acquiredOn: '2030-04-04',
      disposedOn: null,
      note: 'Shelf note',
    });
    copies.push(shelf);
    const { page, access } = await open('/en/library/copies');
    try {
      const card = article(page, 'Shelf note');
      await card.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Edit copy' }).click();
      const conflictDialog = page.getByRole('dialog');
      const form = conflictDialog.getByRole('form', { name: 'Edit copy' });
      await form.getByRole('button', { name: 'More' }).click();
      const html = await form.evaluate((element) => element.outerHTML);
      shelf.revision = 5;
      await form.getByLabel('Location').fill('Hall');
      await form.getByLabel('Note').fill('Moved downstairs');
      await form.getByRole('button', { name: 'Save' }).click();
      const alert = conflictDialog.getByRole('alert');
      await alert.waitFor({ timeout: 15_000 });
      expect(await alert.innerText()).toContain(
        'This copy changed since you started editing, so this edit was not saved. Your changes are still here.',
      );
      expect(await form.getByLabel('Location').inputValue()).toBe('Hall');
      expect(await form.getByLabel('Note').inputValue()).toBe('Moved downstairs');
      expect(await form.getByLabel('Status').inputValue()).toBe('owned');
      expect(await form.getByLabel('Source').inputValue()).toBe('Bookshop');
      expect(await form.getByLabel('Acquired').innerText()).toContain('Apr 4, 2030');
      expect(await card.innerText()).toContain('Shelf note');
      expect(await card.innerText()).toContain('Study');
      const patches = calls.filter((call) => call.method === 'PATCH');
      expect(patches).toHaveLength(1);
      expect(patches[0]?.path).toBe(`/v1/copies/${shelf.id}`);
      expect(patches[0]?.authorization).toBe(`Bearer ${access}`);
      expect(html).toContain(decodedKey(patches[0]!.key));
      expect(patches[0]?.body).toEqual({
        revision: 1,
        status: 'owned',
        location: 'Hall',
        source: 'Bookshop',
        acquiredOn: '2030-04-04',
        disposedOn: null,
        note: 'Moved downstairs',
      });
      expect(shelf).toMatchObject({ revision: 5, location: 'Study', note: 'Shelf note' });
      expect(copies).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

async function pickDate(page: Page, label: string, iso: string) {
  const wanted = new Date(`${iso}T12:00:00Z`);
  await page.getByRole('button', { name: label }).click();
  const caption = page.locator('[data-slot=calendar] .rdp-month_caption');
  const target = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(wanted);
  for (let count = 0; count < 80 && !(await caption.innerText()).includes(target); count++)
    await page.locator('[data-slot=calendar] .rdp-button_next').click();
  await page
    .getByRole('button', { name: new Intl.DateTimeFormat('en', { dateStyle: 'full', timeZone: 'UTC' }).format(wanted) })
    .click();
}
