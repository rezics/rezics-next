import { expect, mock, test } from 'bun:test';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import { createKernelClient, type KernelClient } from '@rezics/client';
import { copyStatusChange, loadCopiesPage, loadCopyDetail, saveCopy, type CopyItem } from '../src/library/copies-read';
import {
  nativeCopyPresentation,
  nativeCopyPresentationQuery,
  type CopyDetailQuery,
  type NativeCopy,
  type NativeCopyPresentation,
} from '../src/library/copies-server';
import { m } from '../src/paraglide/messages.js';
import { CopyConflictReview } from '../src/library/copy-conflict-review';

mock.module('cloudflare:workers', () => ({ env: { WEBSITE_CLIENT_KEY: '{}' } }));
mock.module('@tanstack/react-start', () => ({
  ...start,
  createIsomorphicFn: () => ({
    server: (handler: (...args: never[]) => unknown) => ({ client: () => handler }),
  }),
}));
mock.module('@tanstack/react-start/server', () => start);
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': 'csrf' }) }));
mock.module('../src/kernel/exposure', () => ({
  Exposure: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
  operationIsAdmitted: (operation: string, admitted?: readonly string[]) => {
    if (operation === 'library_entry.delete' || operation === 'library_entry.restore')
      return admitted?.includes(operation) ?? false;
    const groups: Record<string, string> = {
      'copy.list': 'personal_library',
      'copy.create': 'personal_library',
      'copy.delete': 'personal_library',
      'copy.get': 'personal_library',
      'copy.update': 'personal_library',
    };
    return admitted?.includes(groups[operation] ?? operation) ?? false;
  },
  operationGroups: {
    'copy.list': 'personal_library',
    'copy.create': 'personal_library',
    'copy.delete': 'personal_library',
    'copy.get': 'personal_library',
    'copy.update': 'personal_library',
  },
  prepareExposure: () => undefined,
  useOperation: () => true,
  useOperationAdmission: () => 'available',
  readAdmitted: async () => [],
  readAdmittedResult: async () => ({ state: 'ready', admitted: [] }),
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
const conditions = {
  mediaCondition: { state: 'recorded', id: 'good', label: 'Good' },
  packagingCondition: { state: 'cleared' },
  conditionEditing: {
    state: 'supported',
    currentness: 'current',
    choices: [
      { id: 'unknown', label: 'Unknown', description: 'Assessed without a known grade.' },
      { id: 'mint', label: 'Mint', description: 'No observable wear or defects.' },
      { id: 'near_mint', label: 'Near mint', description: 'Almost no observable wear.' },
      { id: 'very_good_plus', label: 'Very good plus', description: 'Minor observable wear.' },
      { id: 'very_good', label: 'Very good', description: 'Noticeable wear, still fully usable.' },
      { id: 'good', label: 'Good', description: 'Substantial wear, still usable.' },
      { id: 'fair', label: 'Fair', description: 'Damage limits ordinary use.' },
      { id: 'poor', label: 'Poor', description: 'Severe damage prevents ordinary use.' },
    ],
  },
} satisfies Pick<NativeCopyPresentation, 'mediaCondition' | 'packagingCondition' | 'conditionEditing'>;
const presentation = {
  ...conditions,
  meaning: 'known',
  kindLabel: 'Original print label',
  kindLabelLanguage: 'en',
  statusLabel: 'Separately accepted shelf label',
  statusLabelLanguage: 'en',
  statusEditing: {
    state: 'supported',
    statuses: [{ id: 'loan', label: 'Currently on loan', labelLanguage: 'en' }],
  },
} satisfies NativeCopyPresentation;
const copy = (extra: Partial<CopyItem> = {}): CopyItem => ({
  ...native,
  subject: null,
  idempotencyKey: key,
  ...extra,
});
const request = () =>
  new Request('https://site.test/en/library/copies', {
    headers: { authorization: 'Bearer current-viewer', 'accept-language': 'ja,en;q=0.8' },
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
const pageMarkup = (page: Parameters<typeof CopiesPage>[0]['page']) => {
  const rootRoute = createRootRoute();
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/library/copies' }),
      createRoute({ getParentRoute: () => rootRoute, path: '/library/loans' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/library/copies'] }),
  });
  return renderToStaticMarkup(createElement(RouterContextProvider, { router }, createElement(CopiesPage, { page })));
};

test('copy editor dates are locale calendar controls rather than native date inputs', async () => {
  const html = form(copy());
  expect(html).not.toContain('type="date"');
  expect(html).toContain(m.library_copy_acquired());
  expect(html).toContain('aria-haspopup="dialog"');
  const calendar = await Bun.file(new URL('../src/library/calendar-day-field.tsx', import.meta.url)).text();
  expect(calendar).not.toMatch(/react-day-picker|date-fns/);
});

test('raw list keeps two same-edition identities and original facts, with no point-detail requests', async () => {
  const second = { ...native, id: '01a17a3b-7065-7048-8c7f-f4ccfae1f401', kind: 'digital', note: 'Second copy' };
  const options = {
    kinds: { state: 'available' as const, choices: [{ id: 'print', label: 'Print', meaning: 'available' as const }] },
    statuses: { state: 'unavailable' as const, choices: [] },
  };
  const { client, calls } = transport(() => json({ copies: [native, second], next: null, filterOptions: options }));
  const page = await loadCopiesPage(client, request(), {}, {});
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe('/v1/copies');
  expect(page.filterOptions).toEqual(options);
  expect(page.copies.map((item) => item.id)).toEqual([native.id, second.id]);
  for (const [index, original] of [native, second].entries()) {
    const { subjectId: _subject, ...fields } = original;
    expect(page.copies[index]).toMatchObject(fields);
    expect(page.copies[index]?.kindLabel).toBeUndefined();
    expect(page.copies[index]?.statusLabel).toBeUndefined();
  }
  const html = pageMarkup(page);
  expect(html).toContain('digital');
  expect(html).not.toContain('physical');
  expect(html.match(/data-slot="list-row"/g)).toHaveLength(2);
  expect(calls).toHaveLength(1);
});

test('one explicit inspection reads the actual credential-bound point DTO once and preserves its observed revision', async () => {
  const { client, calls } = transport(() => json({ copy: { ...native, revision: 12, presentation } }));
  const result = await loadCopyDetail(client, request(), {}, { id });
  expect(result).toMatchObject({ ok: true, copy: { id, revision: 12, kind: 'print', status: 'shelf' } });
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/copies/${id}`);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer current-viewer');
  expect(calls[0]!.headers.get('accept-language')).toBe('ja,en;q=0.8');
  expect(new URL(calls[0]!.url).searchParams.get('view')).toBe('FULL');
  expect(new URL(calls[0]!.url).searchParams.get('presentation')).toBe('FULL');
  const query = { view: 'FULL', ...nativeCopyPresentationQuery() } satisfies CopyDetailQuery;
  expect(query).toEqual({ view: 'FULL', presentation: 'FULL' });
  expect(result.ok && result.copy).toMatchObject(presentation);
});

test('declared native presentation binds accepted kind and status labels separately from current choices', () => {
  const declared = { ...native, presentation } satisfies NativeCopy;
  expect(nativeCopyPresentation(declared)).toEqual(presentation);
  const html = form(
    { ...copy(), ...nativeCopyPresentation(declared) },
    {
      profile: {
        kinds: [{ id: 'print', label: 'Renamed today', statuses: [{ id: 'shelf', label: 'Changed today' }] }],
      },
    },
  );
  expect(html).toContain('Original print label');
  expect(html).toContain('Separately accepted shelf label');
  expect(html).toContain('Currently on loan');
  expect(html).not.toContain('Renamed today');
  expect(html).not.toContain('Changed today');
});

test('absent native presentation keeps raw detail available without accepted meaning or editing support', async () => {
  const { client, calls } = transport(() => json({ copy: native }));
  const result = await loadCopyDetail(client, request(), {}, { id });
  expect(result).toMatchObject({
    ok: true,
    copy: {
      id,
      kind: 'print',
      status: 'shelf',
      revision: 8,
      meaning: 'unavailable',
      statusEditing: { state: 'unavailable' },
    },
  });
  expect(result.ok && result.copy.kindLabel).toBeUndefined();
  expect(result.ok && result.copy.statusLabel).toBeUndefined();
  expect(calls).toHaveLength(1);
});

test('undeclared presentation additions cannot manufacture accepted meaning or current editing support', async () => {
  for (const undeclared of [
    { ...presentation, acceptingType: 'Book' },
    { ...presentation, kind_profile_pin: { releaseDigest: 'private' } },
    { ...presentation, statusEditing: { ...presentation.statusEditing, allow: true } },
    {
      ...presentation,
      statusEditing: {
        state: 'supported',
        statuses: [{ ...presentation.statusEditing.statuses[0], profileId: 'private' }],
      },
    },
  ]) {
    const { client, calls } = transport(() => json({ copy: { ...native, presentation: undeclared } }));
    const result = await loadCopyDetail(client, request(), {}, { id });
    expect(result.ok && result.copy).toMatchObject({ meaning: 'unavailable', statusEditing: { state: 'unavailable' } });
    expect(result.ok && result.copy.kindLabel).toBeUndefined();
    expect(result.ok && result.copy.statusLabel).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private');
    expect(calls).toHaveLength(1);
  }
});

test('malformed or wrong-shape native presentation is unavailable without inventing current meaning', async () => {
  const malformed: unknown[] = [
    null,
    [],
    'known',
    {},
    {
      meaning: 'known',
      kindLabel: 'Invented',
      statusEditing: { state: 'supported', statuses: [{ id: 'grant', label: 'Access' }] },
    },
    { ...presentation, meaning: 'physical' },
    { ...presentation, mediaCondition: { state: 'recorded', id: 'invented', label: 'Invented' } },
    { ...presentation, packagingCondition: { state: 'cleared', id: 'good' } },
    { ...presentation, conditionEditing: { state: 'supported', currentness: 'retired', choices: [] } },
    { ...presentation, kindLabel: 42 },
    { ...presentation, kindLabelLanguage: undefined },
    { ...presentation, statusLabelLanguage: 42 },
    { ...presentation, statusEditing: null },
    { ...presentation, statusEditing: { state: 'supported' } },
    { ...presentation, statusEditing: { state: 'supported', statuses: [] } },
    { ...presentation, statusEditing: { state: 'supported', statuses: 'loan' } },
    { ...presentation, statusEditing: { state: 'supported', statuses: [null] } },
    { ...presentation, conditionEditing: undefined },
    {
      ...presentation,
      statusEditing: { state: 'supported', statuses: [{ id: 'loan', label: 'On loan' }] },
    },
    { ...presentation, statusEditing: { state: 'unsupported', statuses: presentation.statusEditing.statuses } },
    { ...presentation, statusEditing: { state: 'allowed' } },
  ];
  for (const invalid of malformed) {
    const { client, calls } = transport(() => json({ copy: { ...native, presentation: invalid } }));
    const result = await loadCopyDetail(client, request(), {}, { id });
    expect(result.ok && result.copy).toMatchObject({
      id,
      kind: 'print',
      status: 'shelf',
      revision: 8,
      meaning: 'unavailable',
      statusEditing: { state: 'unavailable' },
    });
    expect(result.ok && result.copy.kindLabel).toBeUndefined();
    expect(result.ok && result.copy.statusLabel).toBeUndefined();
    expect(calls).toHaveLength(1);
  }
});

test('source-unavailable and retired current advice do not erase independently accepted labels', async () => {
  for (const state of ['unavailable', 'unsupported'] as const) {
    const detail = { ...native, presentation: { ...presentation, statusEditing: { state } } } satisfies NativeCopy;
    const { client, calls } = transport(() => json({ copy: detail }));
    const result = await loadCopyDetail(client, request(), {}, { id });
    expect(result.ok && result.copy).toMatchObject({
      meaning: 'known',
      kindLabel: presentation.kindLabel,
      statusLabel: presentation.statusLabel,
      statusEditing: { state },
    });
    expect(result.ok && copyStatusChange(result.copy, 'loan')).toBeUndefined();
    expect(calls).toHaveLength(1);
  }
});

test('native unknown historic kinds and missing releases retain raw facts without current profile inference', async () => {
  for (const meaning of ['unknown', 'unavailable'] as const) {
    const historic = {
      ...native,
      kind: 'legacy-unspecified',
      status: 'owned',
      presentation: { ...conditions, meaning, statusEditing: { state: 'unavailable' } },
    } satisfies NativeCopy;
    const { client, calls } = transport(() => json({ copy: historic }));
    const result = await loadCopyDetail(client, request(), {}, { id });
    expect(result.ok && result.copy).toMatchObject({ kind: 'legacy-unspecified', status: 'owned', meaning });
    expect(result.ok && result.copy.kindLabel).toBeUndefined();
    expect(result.ok && result.copy.statusLabel).toBeUndefined();
    const html =
      result.ok &&
      form(result.copy, {
        profile: { kinds: [{ id: 'physical', label: 'Physical', statuses: [{ id: 'owned', label: 'Owned today' }] }] },
      });
    expect(html).toContain('legacy-unspecified');
    expect(html).not.toContain('Physical');
    expect(html).not.toContain('Owned today');
    expect(calls).toHaveLength(1);
  }
});

test('unknown and unavailable presentation cannot supply labels or establish status-write support', () => {
  for (const meaning of ['unknown', 'unavailable'] as const) {
    const detail = { ...native, presentation: { ...presentation, meaning } } satisfies NativeCopy;
    expect(nativeCopyPresentation(detail)).toEqual({
      ...conditions,
      meaning,
      statusEditing: { state: 'unavailable' },
    });
  }
});

test('private native pins and source identities never enter serialized copy detail', async () => {
  const { client, calls } = transport(() =>
    json({
      copy: {
        ...native,
        presentation,
        kind_profile_pin: {
          releaseDigest: 'private-kind-digest',
          acceptingType: 'PrivateType',
          profileId: 'private-kind',
        },
        status_profile_pin: { releaseDigest: 'private-status-digest', profileId: 'private-status' },
        library_profile_pin: { releaseDigest: 'private-compatibility-digest' },
      },
    }),
  );
  const result = await loadCopyDetail(client, request(), {}, { id });
  expect(result.ok && result.copy).toMatchObject(presentation);
  const serialized = JSON.stringify(result);
  for (const privateValue of [
    'profile_pin',
    'releaseDigest',
    'acceptingType',
    'profileId',
    'PrivateType',
    'private-',
    subjectId,
  ]) {
    expect(serialized).not.toContain(privateValue);
  }
  expect(calls).toHaveLength(1);
});

test('unauthenticated and mismatched native point reads cannot provide detail authority', async () => {
  const { client, calls } = transport(() => json({ copy: { ...native, id: 'another-copy', presentation } }));
  expect(await loadCopyDetail(client, new Request('https://site.test/en/library/copies'), {}, { id })).toEqual({
    ok: false,
    reason: 'forbidden',
  });
  expect(calls).toHaveLength(0);
  expect(await loadCopyDetail(client, request(), {}, { id })).toEqual({ ok: false, reason: 'unavailable' });
  expect(calls).toHaveLength(1);
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

test('closed conflict readback cannot offer adoption of former Copy facts', () => {
  const html = renderToStaticMarkup(
    createElement(CopyConflictReview, {
      review: { state: 'closed' },
      disabled: false,
      onReview() {},
      onAccept() {},
    }),
  );
  expect(html).toContain(m.library_subject_closed());
  expect(html).not.toContain(m.library_copy_conflict_review_accept());
});
