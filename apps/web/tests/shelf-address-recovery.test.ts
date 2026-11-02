import { expect, mock, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InvalidShelfAddressError, readEntryPage } from '../src/library/entries-read';
import {
  ShelfAddressRecovery,
  ShelfStaleCursorRecovery,
  shelfPageResetCursor,
} from '../src/library/shelf-address-recovery';
import {
  SHELF_CURSOR_MAX_LENGTH,
  shelfAddressCorrectionHref,
  shelfAddressIssues,
  validateShelfSearch,
} from '../src/library/shelf-params';

const label = '0192f3a0-6c1e-7b2a-9d4e-000000000011';

test('invalid selectors need an explicit field correction while valid address choices survive', () => {
  const search = {
    label: 'not-a-label-id',
    type: 'schema:Book',
    state: 'planned',
    orderBy: 'finishedAt',
    direction: 'asc',
    layout: 'list',
    size: 'l',
  };
  expect(shelfAddressIssues(search)).toEqual(['label']);
  expect(shelfAddressIssues({ type: 'schema:Book\n', state: 'planned\n', label: `${label}\n` })).toEqual([
    'type',
    'state',
    'label',
  ]);
  expect(validateShelfSearch({ label, state: 'planned' }).label).toBe(label);
  const correction = renderToStaticMarkup(
    createElement(ShelfAddressRecovery, { locale: 'en', search, issues: ['label'] }),
  );
  expect(correction).toContain('role="alert"');
  expect(correction).toContain('Label');
  expect(correction).toContain('Clear this field');
  expect(correction).toContain('href="/en/library?type=schema%3ABook');
  const corrected = new URL(shelfAddressCorrectionHref('en', search, 'label'), 'https://site.test');
  expect(Object.fromEntries(corrected.searchParams)).toEqual({
    type: 'schema:Book',
    state: 'planned',
    orderBy: 'finishedAt',
    direction: 'asc',
    layout: 'list',
    size: 'l',
  });
});

test('opaque cursors are bounded and stale recovery removes only the page cursor', async () => {
  const cursor = 'opaque:+/next?x';
  expect(shelfAddressIssues({ type: 'schema:Book', state: 'planned', cursor })).toEqual([]);
  expect(validateShelfSearch({ type: 'schema:Book', state: 'planned', cursor }).cursor).toBe(cursor);
  expect(shelfAddressIssues({ cursor: 'x'.repeat(SHELF_CURSOR_MAX_LENGTH + 1) })).toEqual(['cursor']);
  expect(shelfPageResetCursor({ page: { cursorReset: true } })).toBe(true);

  const search = {
    type: 'schema:Book',
    state: 'planned',
    label,
    orderBy: 'createdAt',
    direction: 'desc',
    layout: 'table',
    size: 's',
    cursor,
  };
  const recovery = renderToStaticMarkup(createElement(ShelfStaleCursorRecovery, { locale: 'en', search }));
  expect(recovery).toContain('role="status"');
  expect(recovery).toContain('Use this first page');
  const firstPage = new URL(shelfAddressCorrectionHref('en', search, 'cursor'), 'https://site.test');
  expect(Object.fromEntries(firstPage.searchParams)).toEqual({
    type: 'schema:Book',
    state: 'planned',
    label,
    orderBy: 'createdAt',
    direction: 'desc',
    layout: 'table',
    size: 's',
  });

  const get = mock(() => {
    throw new Error('Native read must not start for an overlong cursor');
  });
  const client = { libraryEntries: { get } } as unknown as KernelClient;
  await expect(readEntryPage(client, 'Bearer owner', 'x'.repeat(SHELF_CURSOR_MAX_LENGTH + 1), undefined)).rejects.toBeInstanceOf(
    InvalidShelfAddressError,
  );
  await expect(readEntryPage(client, 'Bearer owner', undefined, undefined, undefined, undefined, 'schema:Book\n')).rejects.toBeInstanceOf(
    InvalidShelfAddressError,
  );
  expect(get).not.toHaveBeenCalled();
});
