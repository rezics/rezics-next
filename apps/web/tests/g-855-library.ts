import { readFileSync } from 'node:fs';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { canonicalJson } from '../../../services/main/src/modules/connected-apps/json.ts';
import { axeViolations, formatViolations } from './a11y-axe.ts';

// Shared by the G-855 e2e files: the QA web member, a bounded sign-in, and a library of 1,200 records
// written through the same import API the Library page uses (so nothing is seeded behind Main's back).

export function credentials() {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return JSON.parse(readFileSync(path, 'utf8')) as { actingSubject: string; member: { email: string; password: string } };
}

/** The sign-in journey, bounded and retried: on a loaded host the Accounts site is sometimes slow to answer. */
export async function signIn(page: Page, next: string, member: { email: string; password: string }): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`/auth/start?next=${encodeURIComponent(next)}`);
      await page.waitForURL(url => url.pathname === '/sign-in', { timeout: 40_000 });
      await page.locator('html[data-hydrated]').waitFor({ timeout: 40_000 });
      await page.getByRole('textbox', { name: 'Email' }).fill(member.email);
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByLabel('Enter your password').fill(member.password);
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(page).toHaveURL(next, { timeout: 40_000 });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

export type Row = Record<string, unknown>;
export interface ExportPage { rows: Row[]; snapshot: string; nextCursor: string | null }

/** Main's API as the browser reaches it: the session cookie through the BFF, a fresh Idempotency-Key per call. */
export function mainApi(page: Page) {
  return async <T>(method: 'get' | 'post', path: string, data?: object): Promise<T> => {
    const response = await page.request[method](`/api/main${path}`, { headers: { 'idempotency-key': `g855-${crypto.randomUUID()}` }, ...data ? { data } : {} });
    expect(response.status(), await response.text()).toBeLessThan(300);
    return await response.json() as T;
  };
}

/** 1,200 retained source records, beyond every page bound, imported and applied for the signed-in member. */
export async function writeLibrary(page: Page, actingSubject: string): Promise<void> {
  const api = mainApi(page);
  const retained = Array.from({ length: 1_200 }, (_, index) => ({ kind: 'retained', sourceId: `unmatched-${index}`, title: `Private title ${index}`,
    creators: [], work: null, target: null, identifiers: [], status: null, startedOn: null, finishedOn: null, score: null, review: null,
    shelves: [], readCount: null, progress: null, session: null, raw: { progress: `c${index}`, extra: `private-${index}` } }));
  const created = await api<{ id: string }>('post', '/v1/me/library-imports',
    { actingSubject, format: 'rezics', file: JSON.stringify({ profile: 'rezics-library-export-v1', rows: retained }) });
  for (let cursor: number | null = -1; cursor !== null;) {
    cursor = (await api<{ nextCursor: number | null }>('get', `/v1/me/library-imports/${created.id}/rows?actingSubject=${encodeURIComponent(actingSubject)}${cursor >= 0 ? `&cursor=${cursor}` : ''}`)).nextCursor;
  }
  for (let progress = { pending: true }; progress.pending;) {
    progress = await api('post', `/v1/me/library-imports/${created.id}/apply`, { actingSubject, context: null, language: 'und' });
  }
}

/** The whole export, page by page under one snapshot, as the Library page's download does. */
export async function exportRows(page: Page, actingSubject: string): Promise<Row[]> {
  const api = mainApi(page);
  const rows: Row[] = [];
  let snapshot: string | undefined, cursor: string | null = null;
  do {
    const query: string = `actingSubject=${encodeURIComponent(actingSubject)}${cursor ? `&cursor=${encodeURIComponent(cursor)}&snapshot=${encodeURIComponent(snapshot!)}` : ''}`;
    const next: ExportPage = await api<ExportPage>('get', `/v1/me/library-export?${query}`);
    snapshot ??= next.snapshot; rows.push(...next.rows); cursor = next.nextCursor;
  } while (cursor);
  return rows;
}

/** What a library holds that the account cannot recompute: the retained records' own fields. */
export const retainedFields = (rows: readonly Row[]) => rows.filter(row => row.kind === 'retained').map(row => canonicalJson(row.raw)).sort();

export const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

/** The page as it stands: no horizontal overflow, no axe violations (WCAG 2.2 A and AA), and a screenshot to review. */
export async function clean(page: Page, info: TestInfo, name: string) {
  expect(await overflows(page), `${name} overflows`).toBe(false);
  const violations = await axeViolations(page);
  expect(violations, formatViolations(violations)).toEqual([]);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}
