import { expect, test } from 'bun:test';
import { article, calls, lists, open, reset } from './library-copies.browser';

const timeout = 300_000;

test(
  'copies render with their details in list rows and a 390px row keeps the text between cover and actions',
  async () => {
    reset();
    const { page } = await open('/en/library/copies', { width: 390, height: 844 });
    try {
      const row = article(page, 'First copy');
      expect(await row.count()).toBe(1);
      expect(await row.getAttribute('data-slot')).toBe('list-row');
      expect(await row.locator('[data-slot="cover"]').count()).toBe(1);
      expect(await row.locator('[data-slot="list-row-link"]').count()).toBe(1);
      expect(await row.locator('[data-slot="list-row-control"] button').count()).toBe(1);
      expect(await row.innerText()).toContain('Owned');
      expect(await row.innerText()).toContain('Book');
      expect(await row.innerText()).toContain('Jan 1, 2030');
      expect(await row.innerText()).toContain('Study');
      expect(await row.innerText()).toContain('Bookshop');
      expect(await row.innerText()).toContain('First copy');
      const text = row.locator('.min-w-0.flex-1');
      const box = await text.boundingBox();
      const rowBox = await row.boundingBox();
      expect(box && rowBox && box.width).toBeGreaterThan(rowBox!.width / 2);
      expect(await row.getByRole('button', { name: 'Edit copy' }).count()).toBe(0);
      expect(await lists()).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the row menu opens the existing edit form and saving updates the copy',
  async () => {
    reset();
    const { page, access } = await open('/en/library/copies');
    try {
      const row = article(page, 'First copy');
      await row.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Edit copy' }).click();
      const form = page.getByRole('dialog');
      await form.waitFor();
      await form.getByRole('button', { name: 'More' }).click();
      expect(await form.getByLabel('Location').inputValue()).toBe('Study');
      await form.getByLabel('Location').fill('Hall');
      await form.getByRole('button', { name: 'Save' }).click();
      await form.waitFor({ state: 'detached' });
      expect(await article(page, 'First copy').innerText()).toContain('Hall');
      expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
      expect(calls.find((call) => call.method === 'PATCH')?.authorization).toBe(`Bearer ${access}`);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the row primary link opens its subject',
  async () => {
    reset();
    const { page } = await open('/en/library/copies');
    try {
      await article(page, 'First copy').locator('[data-slot="list-row-link"]').click();
      await page.waitForURL((url) => url.pathname.includes('/subjects/'));
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
