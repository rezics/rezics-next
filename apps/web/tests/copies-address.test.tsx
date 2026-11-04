import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import { copiesAddress, copiesQuery, sameCopiesAddress } from '../src/library/copies-query';
import { CopiesAddressRecovery } from '../src/library/copies-address-recovery';

const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
let credentials = 0;
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  WEBSITE_SCOPES: 'openid',
  SITE_ORIGINS: 'https://site.test',
  SESSIONS: {
    idFromName: (value: string) => value,
    get: () => ({
      credential: async () => {
        credentials++;
        return { status: 'active', subject: 'owner', accessToken: 'owner-credential', csrfToken: null };
      },
    }),
  },
};
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () =>
    new Request('https://site.test/en/library/copies', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    }),
  setResponseHeader: () => {},
}));
const actions = await import('../src/library/copies-actions');
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window();

// Replaces the obsolete owner-local browser assertion that malformed selectors show all copies.
test('malformed saved selectors and page positions retain their operands and perform no broadened read, without CSRF', async () => {
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('No native read admitted');
  });
  try {
    for (const query of [
      ...['not-a-uuid', '<script>alert(1)</script>', `${subjectId}/extra`, 'x'.repeat(129), 42, null, [subjectId]].map(
        (subjectId) => ({ subjectId }),
      ),
      ...['', 'Print', 'print/other', 'print\n', 'x'.repeat(65), 42, null, ['print']].map((kind) => ({
        subjectId,
        kind,
      })),
      ...['', 'On-shelf', 'shelf/other', 'shelf\n', 'x'.repeat(65), 42, null, ['shelf']].map((status) => ({
        subjectId,
        status,
      })),
      { subjectId, cursor: 'x'.repeat(2049) },
      { subjectId, cursor: 123 },
      { cursor: {} },
    ]) {
      const requested = copiesAddress(query, 'en');
      expect(copiesQuery(query)).toEqual(query);
      expect(requested.issue).toBeDefined();
      const before = credentials;
      const read = await actions.readCopiesCurrent({ data: query });
      expect(read).toMatchObject({
        sessionSubject: 'owner',
        requested,
        page: { signedIn: true, copies: [], next: null },
      });
      expect(credentials - before).toBe(1);
      expect(read.page.csrfToken).toBeUndefined();
      expect((await actions.readCopiesPage({ data: query })).copies).toEqual([]);
      expect((await actions.readCopyDetailCurrent({ data: { ...query, id: subjectId } })).result.ok).toBe(false);
      expect((await actions.readCopySubjectCurrent({ data: { ...query, id: subjectId } })).result.state).toBe(
        'unavailable',
      );
    }
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
  }
});

test('empty Subject and cursor mean the first all-copies page; filters and opaque cursors keep exact identity', () => {
  expect(copiesAddress({ subjectId: '', cursor: '' }, 'en')).toEqual({
    subjectId: null,
    kind: null,
    status: null,
    cursor: null,
    locale: 'en',
  });
  expect(copiesAddress({ kind: '', status: '' }, 'en')).toMatchObject({ kind: '', status: '', issue: 'kind' });
  const opaque = 'not/decoded+%?='.repeat(100).padEnd(2048, 'x');
  const address = copiesAddress({ subjectId, kind: 'print', status: 'shelf', cursor: opaque }, 'ja');
  expect(address).toEqual({ subjectId, kind: 'print', status: 'shelf', cursor: opaque, locale: 'ja' });
  expect(sameCopiesAddress(address, copiesAddress({ subjectId, kind: 'print', status: 'shelf', cursor: opaque }, 'ja'))).toBe(true);
  expect(sameCopiesAddress(address, { ...address, locale: 'en' })).toBe(false);
  expect(sameCopiesAddress(address, { ...address, subjectId: null })).toBe(false);
  expect(sameCopiesAddress(address, { ...address, kind: 'ebook' })).toBe(false);
  expect(sameCopiesAddress(address, { ...address, status: 'loan' })).toBe(false);
  expect(sameCopiesAddress(address, { ...address, cursor: null })).toBe(false);
});

test('correction is GET navigation; predicate corrections restart cursors and retain the other selected filters', () => {
  for (const locale of ['en', 'zh-Hant']) {
    for (const query of [
      { subjectId: 'bad-selector', cursor: 'old' },
      { subjectId, kind: 'Print', status: 'shelf', cursor: 'old' },
      { subjectId, kind: 'print', status: 'On-shelf', cursor: 'old' },
      { subjectId, kind: 'print', status: 'shelf', cursor: 'x'.repeat(2049) },
    ]) {
      const address = copiesAddress(query, locale);
      const document = window.document;
      document.body.innerHTML = renderToStaticMarkup(<CopiesAddressRecovery address={address} current={() => true} />);
      expect(document.querySelector('[role="alert"]')?.textContent).toBeTruthy();
      const form = document.querySelector('form')!;
      expect(form.getAttribute('method')).toBe('get');
      expect(form.getAttribute('action')).toBe(`/${locale}/library/copies`);
      expect(form.querySelector('[name="csrf_token"]')).toBeNull();
      const link = document.querySelector('nav a')!.getAttribute('href')!;
      const target = new URL(link, 'https://site.test');
      expect(target.searchParams.has('cursor')).toBe(false);
      if (address.issue === 'subject') {
        expect(form.querySelector('[name="subjectId"]')?.getAttribute('value')).toBe('bad-selector');
        expect(form.querySelector('[name="cursor"]')).toBeNull();
        expect(target.searchParams.has('subjectId')).toBe(false);
        expect(target.searchParams.get('kind')).toBeNull();
      } else {
        expect(form.querySelector('[name="subjectId"]')?.getAttribute('value')).toBe(subjectId);
        if (address.issue === 'kind') {
          expect(form.querySelector('[name="kind"]')?.getAttribute('maxlength')).toBe('64');
          expect(form.querySelector('[name="status"]')?.getAttribute('value')).toBe('shelf');
          expect(target.searchParams.get('status')).toBe('shelf');
        } else if (address.issue === 'status') {
          expect(form.querySelector('[name="status"]')?.getAttribute('maxlength')).toBe('64');
          expect(form.querySelector('[name="kind"]')?.getAttribute('value')).toBe('print');
          expect(target.searchParams.get('kind')).toBe('print');
        } else {
          expect(form.querySelector('[name="cursor"]')?.getAttribute('maxlength')).toBe('2048');
          expect(target.searchParams.get('subjectId')).toBe(subjectId);
          expect(target.searchParams.get('kind')).toBe('print');
          expect(target.searchParams.get('status')).toBe('shelf');
        }
      }
    }
  }
});
