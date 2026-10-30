import { expect, mock, test } from 'bun:test';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient, type KernelClient } from '@rezics/client';
import { copyStatusChange, loadCopiesPage, loadCopyDetail, saveCopy, type CopyItem } from '../src/library/copies-read';
import { nativeCopyPresentation, nativeCopyPresentationQuery, type NativeCopy } from '../src/library/copies-server';
import { m } from '../src/paraglide/messages.js';

mock.module('../src/library/copies-actions', () => ({
  createCopy() {},
  updateCopy() {},
  deleteCopy() {},
  readCopySubject() {},
  readCopyDetail() {},
  undoCopy() {},
}));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': 'csrf' }) }));
mock.module('../src/kernel/exposure', () => ({
  Exposure: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
}));
mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => createElement('a', null, children),
  notFound: () => new Error('not found'),
}));
const { CopyForm, CopiesPage } = await import('../src/library/copies-page');
const id = '01a17a3b-7065-7048-8c7f-f4ccfae1f400';
const key = '10203040-5060-4070-8090-102030405060';
const subjectId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
const native = {
  id,
  subjectId,
  kind: 'print',
  status: 'shelf',
  revision: 8,
  location: 'Study',
  source: 'Bookshop',
  acquiredOn: '2020-02-29',
  disposedOn: null,
  note: 'First copy',
} satisfies NativeCopy;
const copy = (extra: Partial<CopyItem> = {}): CopyItem => ({
  ...native,
  subject: null,
  idempotencyKey: key,
  ...extra,
});
const request = () =>
  new Request('https://site.test/en/library/copies', {
    headers: { authorization: 'Bearer current-viewer' },
  });
function transport(respond: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      calls.push(req.clone());
      return respond(req);
    }) as typeof fetch,
  });
  return { client, calls };
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const form = (value: CopyItem, extra: object = {}) =>
  renderToStaticMarkup(
    createElement(CopyForm, {
      copy: value,
      subjectId,
      addKey: key,
      inline: true,
      onClose() {},
      onCreated() {},
      onSaved() {},
      onRemoved() {},
      onKey() {},
      ...extra,
    }),
  );

test('raw list keeps two same-edition identities and original facts, with no point-detail requests', async () => {
  const second = { ...native, id: '01a17a3b-7065-7048-8c7f-f4ccfae1f401', kind: 'digital', note: 'Second copy' };
  const { client, calls } = transport(() => json({ copies: [native, second], next: null }));
  const page = await loadCopiesPage(client, request(), {}, {});
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe('/v1/copies');
  expect(page.copies.map((item) => item.id)).toEqual([native.id, second.id]);
  for (const [index, original] of [native, second].entries()) {
    const { subjectId: _subject, ...fields } = original;
    expect(page.copies[index]).toMatchObject(fields);
    expect(page.copies[index]?.kindLabel).toBeUndefined();
    expect(page.copies[index]?.statusLabel).toBeUndefined();
  }
  const html = renderToStaticMarkup(createElement(CopiesPage, { page }));
  expect(html).toContain('digital');
  expect(html).not.toContain('physical');
  expect(html.match(/data-slot="list-row"/g)).toHaveLength(2);
  expect(calls).toHaveLength(1);
});

test('one explicit inspection reads the actual credential-bound point DTO once and preserves its observed revision', async () => {
  const { client, calls } = transport(() => json({ copy: { ...native, revision: 12 } }));
  const result = await loadCopyDetail(client, request(), {}, { id });
  expect(result).toMatchObject({ ok: true, copy: { id, revision: 12, kind: 'print', status: 'shelf' } });
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/copies/${id}`);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer current-viewer');
  expect(new URL(calls[0]!.url).searchParams.get('view')).toBe('FULL');
  // This base's closed generated schema has no presentation query. No fabricated positive binding.
  expect(nativeCopyPresentationQuery()).toBeUndefined();
  expect(result.ok && result.copy.meaning).toBe('unavailable');
});

test('undeclared presentation additions cannot manufacture accepted meaning or current editing support', () => {
  const untyped = {
    ...native,
    presentation: {
      meaning: 'known',
      kindLabel: 'Invented',
      statusEditing: { state: 'supported', statuses: [{ id: 'grant', label: 'Access' }] },
    },
  };
  expect(nativeCopyPresentation(untyped)).toEqual({ meaning: 'unavailable', statusEditing: { state: 'unavailable' } });
});

test('denied or concealed point reads clear detail authority without treating them as deletion', async () => {
  for (const status of [401, 403, 404]) {
    const { client, calls } = transport(() => json({ code: 'forbidden' }, status));
    expect(await loadCopyDetail(client, request(), {}, { id })).toEqual({ ok: false, reason: 'forbidden' });
    expect(calls).toHaveLength(1);
  }
  const html = form(copy(), { detailState: 'forbidden' });
  expect(html).toContain(m.library_copy_detail_forbidden());
  for (const privateValue of ['Study', 'Bookshop', 'First copy', 'shelf']) expect(html).not.toContain(privateValue);
  expect(html).not.toContain('name="status"');
});

test('transient failure leaves the prior raw list and its holding facts intact', async () => {
  for (const failure of ['response', 'transport']) {
    const { client, calls } = transport(() => {
      if (failure === 'transport') throw new Error('temporary network failure');
      return json({ code: 'unavailable' }, 503);
    });
    const before = copy();
    expect(await loadCopyDetail(client, request(), {}, { id })).toEqual({ ok: false, reason: 'unavailable' });
    const html = form(before, { detailState: 'unavailable' });
    expect(html).toContain('shelf');
    expect(html).toContain(m.library_copy_detail_unavailable());
    expect(html).not.toContain(m.library_copy_empty());
    expect(html).not.toContain(m.library_copy_status_unsupported());
    expect(before.revision).toBe(8);
    expect(calls).toHaveLength(1);
  }
});

test('bounded accepted-meaning view preserves old labels despite renamed current choices and a retired pair', () => {
  const historical = copy({
    meaning: 'known',
    kindLabel: 'Original print label',
    kindLabelLanguage: 'en',
    statusLabel: 'Original shelf label',
    statusLabelLanguage: 'en',
    statusEditing: { state: 'unsupported' },
  });
  const html = form(historical, {
    profile: { kinds: [{ id: 'print', label: 'Renamed today', statuses: [{ id: 'shelf', label: 'Changed today' }] }] },
  });
  expect(html).toContain('Original print label');
  expect(html).toContain('Original shelf label');
  expect(html).not.toContain('Renamed today');
  expect(html).not.toContain('Changed today');
  expect(html).not.toContain('<select');
  expect(html).not.toContain('name="kind"');
  expect(html).toContain(m.library_copy_status_unsupported());
  expect(html).toContain(m.library_copy_save());
  expect(html).toContain(m.library_copy_delete());
});

test('unknown historic and missing-release meaning remain distinct while exposing raw identifiers', () => {
  for (const meaning of ['unknown', 'unavailable'] as const) {
    const html = form(
      copy({ kind: 'legacy-unspecified', status: 'owned', meaning, statusEditing: { state: 'unavailable' } }),
    );
    expect(html).toContain('legacy-unspecified');
    expect(html).toContain('owned');
    expect(html).toContain(meaning === 'unknown' ? m.library_copy_meaning_unknown() : m.library_history_unavailable());
    expect(html).not.toContain('physical');
    expect(html).not.toContain('digital');
    expect(html).toContain(m.library_copy_save());
    expect(html).toContain(m.library_copy_delete());
  }
});

test('only captured native status choices can change a status, with no immutable kind editor', () => {
  const observed = copy({
    meaning: 'known',
    statusLabel: 'Old shelf',
    statusEditing: {
      state: 'supported',
      statuses: [{ id: 'loan', label: 'Currently on loan', labelLanguage: 'en' }],
    },
  });
  expect(copyStatusChange(observed, 'shelf')).toEqual({});
  expect(copyStatusChange(observed, 'loan')).toEqual({ status: 'loan' });
  expect(copyStatusChange(observed, 'available')).toBeUndefined();
  expect(copyStatusChange(copy({ statusEditing: { state: 'unsupported' } }), 'loan')).toBeUndefined();
  const html = form(observed);
  expect(html).toContain('Old shelf');
  expect(html).toContain('Currently on loan');
  expect(html).not.toContain('name="kind"');
});

test('metadata-only PATCH uses actual declared native wire and omits the unsupported old status and private meaning', async () => {
  const { client, calls } = transport(async (req) => {
    const body = await req.json();
    return json({ copy: { ...native, ...body, revision: 9 } });
  });
  const result = await saveCopy(
    client,
    request(),
    {},
    {
      id,
      revision: native.revision,
      idempotencyKey: key,
      location: native.location,
      source: native.source,
      acquiredOn: native.acquiredOn,
      disposedOn: null,
      note: 'Updated note',
    },
  );
  expect(result).toMatchObject({
    ok: true,
    copy: { id, status: 'shelf', kind: 'print', revision: 9, note: 'Updated note' },
  });
  expect(calls).toHaveLength(1);
  const body: NonNullable<Parameters<ReturnType<KernelClient['copies']>['patch']>[0]> = await calls[0]!.json();
  expect(body).toEqual({
    revision: 8,
    location: 'Study',
    source: 'Bookshop',
    acquiredOn: '2020-02-29',
    disposedOn: null,
    note: 'Updated note',
  });
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer current-viewer');
  expect(calls[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(key));
});

test('a captured status submit uses its exact observed revision and key, with native validation still decisive', async () => {
  const observed = copy({
    revision: 12,
    statusEditing: { state: 'supported', statuses: [{ id: 'loan', label: 'On loan' }] },
  });
  const { client, calls } = transport(() => json({ code: 'unsupported_library_profile' }, 422));
  expect(
    await saveCopy(
      client,
      request(),
      {},
      { ...native, id, revision: observed.revision, idempotencyKey: key, ...copyStatusChange(observed, 'loan') },
    ),
  ).toEqual({ ok: false, reason: 'unsupported' });
  expect(calls).toHaveLength(1);
  expect(await calls[0]!.json()).toMatchObject({ revision: 12, status: 'loan' });
  expect(observed.status).toBe('shelf');
});
