import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import type { UiLocale } from '../i18n/define.ts';
import { credentials } from './g-855-library.ts';
import { signInAtAccounts } from './account-sign-in.ts';

export const bookTitle = 'Berättelser vid älven';
const paragraph = 'Vid älven läser en resenär berättelser om vänskap, minnen och vägen hem. Orden behåller sitt svenska språk även när läsarens menyer visas på ett annat språk. ';
export const bookSynopsis = paragraph.repeat(18) + 'Till sist hittar resenären hem till biblioteket vid älven.';

/** Only authority is fixture data; Books and owned copies enter through the running Main API. */
async function grantBookAuthority(scope: string, action: string) {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  const connectionString = process.env.ACCESS_DATABASE_URL;
  if (!path || !connectionString || !process.env.REZICS_QA_RUN_ID) {
    throw new Error('Books browser fixtures require an isolated QA stack');
  }
  const reader = JSON.parse(readFileSync(path, 'utf8')) as { principalId: string; actingSubject: string };
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await grantFixtureAuthority(client, { scope, requireDispatch: true,
      representations: [{ principalId: reader.principalId, actor: reader.actingSubject, action, lifetime: '8 hours' }],
      grant: { actor: reader.actingSubject, action, lifetime: '8 hours' } });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

/** Retry reconciliation with the same intent key; report the exact failing API step. */
export async function bookCommand<T>(page: Page, method: 'POST' | 'PUT', path: string, data: object): Promise<T> {
  let key = crypto.randomUUID();
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await page.request.fetch(`/api/main${path}`, {
      method, headers: { 'idempotency-key': key }, data,
    });
    const body = await response.json() as { code?: string; retry?: { afterMs?: number } };
    if (response.status() === 202) {
      await page.waitForTimeout(body.retry?.afterMs ?? 500);
      continue;
    }
    if (response.status() === 409 && body.code === 'read_basis_changed') {
      key = crypto.randomUUID();
      await page.waitForTimeout(500);
      continue;
    }
    expect(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(body)}; request ${JSON.stringify(data)}`).toBe(true);
    return body as T;
  }
  throw new Error(`${method} ${path} did not finish reconciliation; request ${JSON.stringify(data)}`);
}

export async function prepareBook(page: Page, locale: UiLocale) {
  const reader = credentials();
  await signInAtAccounts(page, localizedPath('/library', locale), reader.member);
  await grantBookAuthority('work:create:root', 'work.create');
  const book = await bookCommand<{ work: string; mainVersion: string }>(page, 'POST', '/v1/works', {
    profile: 'metadata-only-v1', authoring: 'own-work', semanticTypes: ['https://schema.org/Book'],
    title: bookTitle, language: 'sv',
    actingSubject: reader.actingSubject,
  });
  await grantBookAuthority(`work:read:${book.work}`, 'work.read');
  await grantBookAuthority(`work:edit:${book.work}`, 'work.edit');
  // The launch language capability reads the corrected metadata synopsis,
  // which is a separate component from the Work's initial creation facts.
  await bookCommand(page, 'PUT', `/v1/works/${book.work.slice(-36)}/metadata`, {
    profile: 'work-metadata-details-v1', expectedHead: null, actingSubject: reader.actingSubject,
    state: { kind: 'header', originalTitle: { value: bookTitle, language: 'sv' },
      localized: [{ language: 'sv', title: null, description: bookSynopsis, mainVersionLabel: null }] },
  });
  // A stable read basis keeps the first export's snapshot from racing the catalogue's outbox.
  let last = '';
  let still = 0;
  await expect(async () => {
    const response = await page.request.get(`/api/main/v1/works/${book.work.slice(-36)}?actingSubject=${encodeURIComponent(reader.actingSubject)}`);
    expect(response.ok(), await response.text()).toBe(true);
    const header = await response.json() as { sourcePosition: unknown; types: string[];
      description: { value: string; language: string } | null };
    expect(header.types).toContain('https://schema.org/Book');
    expect(header.description).toMatchObject({ value: bookSynopsis, language: 'sv' });
    const position = JSON.stringify(header.sourcePosition);
    still = position === last ? still + 1 : 0;
    last = position;
    expect(still).toBeGreaterThanOrEqual(4);
  }).toPass({ timeout: 90_000, intervals: [500] });
  return { ...book, actingSubject: reader.actingSubject,
    href: localizedPath(resourceHref('/w/', book.work.slice(-36)), locale) };
}

export async function prepareBookCopies(page: Page, book: Awaited<ReturnType<typeof prepareBook>>) {
  const release = `https://rezics.com/id/${crypto.randomUUID()}`;
  await bookCommand(page, 'PUT', `/v1/works/${book.work.slice(-36)}/releases/${release.slice(-36)}`, {
    profile: 'release-v1', expectedHead: null, actingSubject: book.actingSubject, id: release,
    kind: 'formal', status: 'official', title: { value: bookTitle, language: 'sv' },
    contentLanguages: ['sv'], isTranslation: false, originalLanguages: [], titleLanguage: 'sv',
    tracklistLanguage: null, editionStatement: null, publisher: 'Älvens bibliotek', publicationYear: 2026,
    isbn13: null, originalUrl: null, fixedRelease: null, coverage: null, evidence: null,
  });
  const copies: { id: string; work: string; release: string; format: string }[] = [];
  // More than one real export page, all linked to an identified Book and its exact edition.
  for (let index = 0; index < 25; index++) {
    copies.push(await bookCommand(page, 'POST', '/v1/me/library-copies', {
      actingSubject: book.actingSubject, expectedVersion: 0, release, format: `paperback ${index + 1}`,
      acquiredFrom: { kind: 'name', name: 'Älvens bibliotek' },
    }));
  }
  return { release, copies };
}
