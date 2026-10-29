import { expect, test } from 'bun:test';
import {
  article,
  calls,
  copies,
  edition,
  lists,
  make,
  open,
  refuseNextCopyWriteOnce,
  reset,
} from './library-copies.browser';

const timeout = 300_000;

test(
  'each copy appears once as a cover row with locale date and labels, with no form until requested',
  async () => {
    reset();
    const { page } = await open('/en/library/copies');
    try {
      const rows = page.locator('main [data-slot="list-row"]');
      expect(await rows.count()).toBe(2);
      const row = rows.filter({ hasText: 'Zebra story' });
      expect(await row.getByRole('link', { name: 'Zebra story' }).count()).toBe(1);
      expect(await row.locator('[data-slot="cover"]').count()).toBe(1);
      expect(await row.innerText()).toContain('Owned');
      expect(await row.innerText()).toContain('Book');
      expect(await row.innerText()).toContain('Jan 1, 2030');
      expect(await row.locator('form').count()).toBe(0);
      expect(await page.locator('main input, main select').count()).toBe(0);
      expect(await page.getByText('You have asked for this copy and do not have it yet.').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'add opens a responsive one-form surface and edit reuses it with the copy values',
  async () => {
    reset();
    const { page } = await open('/en/library/copies');
    try {
      const readCount = lists().length;
      await page.getByRole('button', { name: 'Add a copy' }).click();
      expect(await lists()).toHaveLength(readCount);
      const surface = page.getByRole('dialog');
      await surface.waitFor();
      const form = surface.getByRole('form', { name: 'Add a copy' });
      expect(await form.getByLabel('Edition').count()).toBe(1);
      expect(await form.getByLabel('Status').count()).toBe(1);
      expect(await form.getByLabel('Location').count()).toBe(0);
      await surface.getByRole('button', { name: 'More' }).click();
      expect(await form.getByLabel('Location').count()).toBe(1);
      await surface.getByRole('button', { name: 'Cancel' }).click();

      const row = article(page, 'First copy');
      await row.getByRole('button', { name: 'Edit copy' }).click();
      const edit = page.getByRole('dialog');
      await edit.waitFor();
      await edit.getByRole('button', { name: 'More' }).click();
      expect(await edit.getByLabel('Status').inputValue()).toBe('owned');
      expect(await edit.getByLabel('Location').inputValue()).toBe('Study');
      expect(await edit.getByLabel('Source').inputValue()).toBe('Bookshop');
      expect(await edit.getByLabel('Note').inputValue()).toBe('First copy');
    } finally {
      await page.context().close();
    }

    const phone = await open('/en/library/copies', { width: 390, height: 844 });
    try {
      await phone.page.getByRole('button', { name: 'Add a copy' }).click();
      const sheet = phone.page.getByRole('dialog');
      await sheet.waitFor();
      expect(await sheet.evaluate((element) => getComputedStyle(element).position)).toBe('fixed');
      expect(await sheet.evaluate((element) => element.getBoundingClientRect().bottom)).toBeGreaterThan(800);
    } finally {
      await phone.page.context().close();
    }
  },
  timeout,
);

test(
  'dates use the locale calendar picker and never a native date input',
  async () => {
    reset();
    const { page } = await open('/zh-Hans/library/copies');
    try {
      await page.getByRole('button', { name: '新增一份复本' }).click();
      const surface = page.getByRole('dialog');
      await surface.waitFor();
      await surface.getByRole('button', { name: '更多' }).click();
      expect(await page.locator('input[type=date]').count()).toBe(0);
      await surface.getByRole('button', { name: '取得日' }).click();
      expect(await page.getByRole('grid').count()).toBe(1);
      expect(await page.getByRole('grid').getAttribute('aria-label')).toContain('2026');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'saving, validation refusal and conflict preserve the existing write and error behaviour',
  async () => {
    reset();
    const { page, access } = await open('/en/library/copies');
    try {
      const row = article(page, 'First copy');
      await row.getByRole('button', { name: 'Edit copy' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'More' }).click();
      await dialog.getByLabel('Location').fill('Hall');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await dialog.waitFor({ state: 'detached' });
      expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
      expect(calls.find((call) => call.method === 'PATCH')?.authorization).toBe(`Bearer ${access}`);

      await page.getByRole('button', { name: 'Add a copy' }).click();
      const add = page.getByRole('dialog');
      refuseNextCopyWriteOnce();
      await add.getByLabel('Edition').fill(edition);
      await add.getByRole('button', { name: 'Add copy' }).click();
      expect(await add.getByRole('alert').innerText()).toContain('could not be saved');
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);

      await add.getByRole('button', { name: 'Cancel' }).click();
      const current = article(page, 'First copy');
      await current.getByRole('button', { name: 'Edit copy' }).click();
      const edit = page.getByRole('dialog');
      await edit.getByRole('button', { name: 'More' }).click();
      const subjectCopy = copies.find((copy) => copy.note === 'First copy')!;
      subjectCopy.revision += 1;
      await edit.getByLabel('Note').fill('Still here');
      await edit.getByRole('button', { name: 'Save' }).click();
      expect(await edit.getByRole('alert').innerText()).toContain('changed since you started editing');
      expect(await edit.getByLabel('Note').inputValue()).toBe('Still here');
      expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the page keeps the base kernel reads and opening the form adds no reads',
  async () => {
    reset();
    const { page } = await open('/en/library/copies');
    try {
      const initial = lists().map((call) => [call.method, call.path, call.view, call.limit, call.search]);
      expect(initial).toHaveLength(1);
      await page.getByRole('button', { name: 'Add a copy' }).click();
      expect(lists().map((call) => [call.method, call.path, call.view, call.limit, call.search])).toEqual(initial);
      expect(calls.filter((call) => call.method === 'GET' && /^\/v1\/copies\//.test(call.path))).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'copy rows have no resting card treatment and stretch the primary link above their independent controls',
  async () => {
    reset();
    const { page, origin } = await open('/en/library/copies');
    try {
      const row = article(page, 'First copy');
      expect(await row.evaluate((element) => element.tagName)).toBe('LI');
      expect(await row.getAttribute('data-slot')).toBe('list-row');
      expect(await row.locator('[data-slot="list-row-link"]').count()).toBe(1);
      expect(await row.locator('[data-slot="list-row-control"]').count()).toBe(1);
      expect(await row.locator('a').count()).toBe(1);
      const link = row.locator('[data-slot="list-row-link"]');
      const rowBox = await row.boundingBox();
      const linkBox = await link.boundingBox();
      expect(rowBox && linkBox && linkBox.width).toBeGreaterThanOrEqual(rowBox!.width - 12);
      await row.getByRole('button', { name: 'Edit copy' }).click();
      expect(page.url()).toStartWith(origin);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
      await page.mouse.click(rowBox!.x + 40, rowBox!.y + Math.min(rowBox!.height / 2, 50));
      await page.waitForURL((url) => url.pathname.includes(`/subjects/${edition}/`));
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
