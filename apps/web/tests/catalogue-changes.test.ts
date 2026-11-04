import { expect, test } from 'bun:test';
import { catalogueChangesFixture, changesCursor, changesLastCursor } from '../src/kernel/fake/catalogue-changes';
import {
  changesState,
  readSubjectChange,
  type ChangesState,
  type CurrentOperationsRead,
} from '../src/features/catalogue/subject-changes';

// Consumer outcomes through the generated list client and a deliberately bounded detail adapter.
test('a reader follows paginated native subject revisions to a safe change explanation and current reading without inventing historical payload or leaking concealed details', async () => {
  const fixture = catalogueChangesFixture();
  const first = await fixture.transport.list();
  expect(first.kind).toBe('ready');
  if (first.kind !== 'ready') throw new Error('Expected revisions');
  const second = await fixture.transport.list(first.page.next!, first.session);
  if (second.kind !== 'ready') throw new Error('Expected continuation');
  const last = await fixture.transport.list(second.page.next!, second.session);
  if (last.kind !== 'ready') throw new Error('Expected last page');
  const selected = last.page.revisions[0]!.revision;
  // The consumer supports metadata-only safe detail without inferring values or selection.
  const detail = await readSubjectChange(
    fixture.client,
    fixture.id,
    selected,
    { authorization: 'Bearer story', session: last.session },
    async (_client, input) => ({
      kind: 'ready',
      detail: {
        id: input.id,
        revision: input.revision,
        summary: { kind: 'limited' },
      },
    }),
  );
  expect(detail).toMatchObject({
    kind: 'ready',
    detail: { id: fixture.id, revision: 2, summary: { kind: 'limited' } },
    currentOperations: { state: 'available', operations: ['subject.propose', 'subject.terms'] },
  });
  expect(first.page.href).toContain(`/subjects/${fixture.id}/`);
  expect(first.page.revisions[0]).toEqual({ revision: 5, kind: 'propose' });
  expect(JSON.stringify(first.page)).not.toContain('record_revision');
  expect(JSON.stringify(detail)).not.toContain('statement');
  const listings = fixture.calls.filter((call) => call.path.endsWith('/revisions'));
  expect(listings.map((call) => call.cursor)).toEqual([null, changesCursor, changesLastCursor]);
  expect(listings[1]).toMatchObject({ authorization: 'Bearer story', session: 'changes-session' });
  expect(
    fixture.calls
      .filter((call) => call.path === `/v1/subjects/${fixture.id}`)
      .every((call) => call.authorization === null),
  ).toBe(true);
  const actionReads = fixture.calls.filter((call) => call.includeViewerActions);
  expect(actionReads).toHaveLength(4);
  expect(actionReads.every((call) => call.path === '/v1/viewerActions' && call.authorization === 'Bearer story')).toBe(
    true,
  );
  expect(actionReads[0]?.resources).toEqual([
    { type: 'semantic.context', id: '00000000-0000-8000-8000-000000000000' },
    { type: fixture.read.subject.type, id: fixture.id },
  ]);
  expect(await fixture.transport.detail(2)).toMatchObject({ kind: 'unavailable' });
});

test('current operation reads distinguish confirmed denial, unavailable hydration and preparing state without losing public history', async () => {
  const fixture = catalogueChangesFixture();
  const allowed = await fixture.transport.list();
  expect(allowed.kind === 'ready' && allowed.page.currentOperations).toEqual({
    state: 'available',
    operations: ['subject.propose', 'subject.terms'],
  });

  fixture.setActionOperations([]);
  const denied = await fixture.transport.list();
  expect(denied.kind === 'ready' && denied.page.currentOperations).toEqual({ state: 'available', operations: [] });

  fixture.setActionOutcome('unavailable');
  const unavailable = await fixture.transport.list();
  expect(unavailable.kind === 'ready' && unavailable.page.currentOperations).toEqual({ state: 'unavailable' });

  fixture.setActionOutcome('component-unavailable');
  const missingComponent = await fixture.transport.list();
  expect(missingComponent.kind === 'ready' && missingComponent.page.currentOperations).toEqual({ state: 'unavailable' });

  fixture.setActionOutcome('preparing');
  const preparing = await fixture.transport.list();
  expect(preparing.kind === 'ready' && preparing.page.currentOperations).toEqual({ state: 'preparing' });
  expect(preparing.kind === 'ready' && preparing.page.revisions).toHaveLength(2);
});

test('current correction handoffs use only the exact Subject and safe current field address', async () => {
  const { ChangeExplanation } = await import('../src/features/catalogue/subject-changes-page');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
    await import('@tanstack/react-router');
  const fixture = catalogueChangesFixture();
  const listing = await fixture.transport.list();
  if (listing.kind !== 'ready') throw new Error('Expected public history');
  const base = listing.page.href;
  const currentOperations: CurrentOperationsRead = {
    state: 'available',
    operations: ['subject.propose', 'subject.terms'],
  };
  const renderExplanation = (props: Parameters<typeof ChangeExplanation>[0]) => {
    const root = createRootRoute();
    const view = createRoute({
      getParentRoute: () => root,
      path: '/$locale/subjects/$id/$slug/$view',
      component: () => createElement(ChangeExplanation, props),
    });
    const router = createRouter({
      routeTree: root.addChildren([view]),
      history: createMemoryHistory({ initialEntries: [`${base}/changes`] }),
    });
    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  };
  const terms = renderExplanation({
      detail: { id: fixture.id, revision: 2, summary: { kind: 'terms', fields: [{ field: 'labels', languages: ['en'] }] } },
      revision: 2,
      locale: 'en',
      pageHref: base,
      currentOperations,
      onCorrectCurrent: () => true,
    });
  expect(terms).toContain(m.changes_correct_terms());
  expect(terms).toContain(`${base}/terms?returnTo=changes`);
  expect(terms).not.toContain('revision=2');

  const fact = renderExplanation({
      detail: {
        id: fixture.id,
        revision: 5,
        summary: {
          kind: 'candidate',
          candidate: crypto.randomUUID(),
          property: 'schema:url',
          context: fixture.read.subject.context,
        },
      },
      revision: 5,
      locale: 'en',
      pageHref: base,
      currentOperations,
      onCorrectCurrent: () => true,
    });
  expect(fact).toContain(m.changes_correct_current());
  expect(fact).toContain(`${base}/edit?property=schema%3Aurl&amp;returnTo=changes`);
  expect(fact).not.toContain('candidate=');
  expect(fact).not.toContain('revision=5');

  const actionStates: [CurrentOperationsRead, string][] = [
    [{ state: 'available', operations: [] }, m.changes_correction_denied()],
    [{ state: 'unavailable' }, m.changes_correction_unavailable()],
    [{ state: 'preparing' }, m.changes_correction_preparing()],
  ];
  for (const [operations, expected] of actionStates) {
    const html = renderExplanation({
        detail: { id: fixture.id, revision: 2, summary: { kind: 'terms', fields: [] } },
        revision: 2,
        locale: 'en',
        pageHref: base,
        currentOperations: operations,
        onCorrectCurrent: () => true,
      });
    expect(html).toContain(expected);
    expect(html).not.toContain(m.changes_correct_terms());
  }
});

test('an empty continuation with another opaque next keeps the earlier revisions and selection', async () => {
  const fixture = catalogueChangesFixture();
  const first = await fixture.transport.list();
  let state: ChangesState = changesState({}, { type: 'list', result: first, more: false });
  state = changesState(state, { type: 'detail-start', revision: 5 });
  state = changesState(state, { type: 'detail', result: { kind: 'unavailable' } });
  const second = await fixture.transport.list(state.page!.next!);
  state = changesState(state, { type: 'list', result: second, more: true });
  expect(state.page?.revisions.map((row) => row.revision)).toEqual([5, 4]);
  expect(state.page?.next).toBe(changesLastCursor);
  expect(state.selected).toBe(5);
  state = changesState(state, { type: 'list', result: { kind: 'unavailable' }, more: true });
  expect(state.page?.next).toBe(changesLastCursor);
  expect(state.failure?.kind).toBe('unavailable');
});

test('failed detail reads keep list and selection but discard prior detail; current subject concealment clears the page', async () => {
  const fixture = catalogueChangesFixture();
  const first = await fixture.transport.list();
  const initial = changesState({}, { type: 'list', result: first, more: false });
  for (const kind of ['denied', 'missing', 'invalid', 'conflict', 'unavailable'] as const) {
    let state = changesState(initial, { type: 'detail-start', revision: 5 });
    state = changesState(state, { type: 'detail', result: { kind } });
    expect(state.page).toBe(initial.page);
    expect(state.selected).toBe(5);
    expect(state.detail).toEqual({ kind });
    state = changesState(state, { type: 'detail-start', revision: 5 });
    expect(state.detail).toBeUndefined();
    expect(state.loading).toBe('detail');
  }
  fixture.conceal();
  const detail = await fixture.transport.detail(5);
  expect(detail).toEqual({ kind: 'missing', scope: 'subject' });
  // An independent explanation failure must not mask a current visibility refusal.
  expect(
    await readSubjectChange(fixture.client, fixture.id, 5, {}, async () => {
      throw new Error('Detail transport unavailable');
    }),
  ).toEqual({ kind: 'missing', scope: 'subject' });
  expect(changesState(initial, { type: 'detail', result: detail })).toEqual({
    failure: detail,
    currentOperations: { state: 'unavailable' },
  });
});

// Delivered native DTOs go through the generated endpoint and the production adapter.
import { mock } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeRevisionDetail } from '../src/features/catalogue/subject-changes';
import { readValueExplanation } from '../src/features/catalogue/value-explanation';
import release from '../src/kernel/recorded/definitions-release.json';
import { m } from '../src/paraglide/messages.js';
import { languageName } from '../src/subject/language';

mock.module('cloudflare:workers', () => ({ env: {} }));

function nativeDetailFixture() {
  let body: unknown;
  let status = 200;
  const fixture = catalogueChangesFixture('ready', 'en', undefined, () =>
    Response.json(body, { status, headers: { 'rezics-session-token': 'native-detail-session' } }),
  );
  const selected = fixture.read.subject.statements['schema:isbn']![0]!;
  selected.rezics.revision = 5;
  const dto: NativeRevisionDetail = {
    subject: fixture.id,
    revision: { revision: 5, kind: 'propose', release: selected.rezics.release },
    change: {
      kind: 'candidate',
      candidate: selected.id,
      property: 'schema:isbn',
      context: fixture.read.subject.context,
      reading: { decision: { head: 8, verdict: 'accept', revision: 6 }, selected: true, rank: 'preferred' },
    },
  };
  body = dto;
  return {
    ...fixture,
    dto,
    selected,
    respond: (next: unknown, code = 200) => {
      body = next;
      status = code;
    },
    value: () =>
      readValueExplanation(
        fixture.client,
        {
          id: fixture.id,
          statement: selected.id,
          property: 'schema:isbn',
          locale: 'en',
        },
        {
          authorization: 'Bearer value-viewer',
          definitions: async () => ({ digest: release.digest, ...release.release }),
        },
      ),
  };
}

test('actual native safe revision detail is rendered through the existing browser and selected-value explanation while concealed or unavailable detail stays truthful', async () => {
  const { SubjectChangesPage } = await import('../src/features/catalogue/subject-changes-page');
  const { ValueExplanationPage } = await import('../src/features/catalogue/value-explanation-page');
  const fixture = nativeDetailFixture();
  const list = await fixture.transport.list();
  const detail = await fixture.transport.detail(5, 'previous-session');
  expect(detail).toMatchObject({
    kind: 'ready',
    session: 'native-detail-session',
    detail: { id: fixture.id, revision: 5, metadata: fixture.dto.revision, summary: fixture.dto.change },
  });
  const state = changesState(
    changesState(changesState({}, { type: 'list', result: list, more: false }), {
      type: 'detail-start',
      revision: 5,
    }),
    { type: 'detail', result: detail },
  );
  const browser = renderToStaticMarkup(createElement(SubjectChangesPage, { state, locale: 'en' }));
  expect(browser).toContain(m.changes_proposal_detail());
  expect(browser).toContain(m.context_selected());
  expect(browser).toContain(m.candidate_rank_preferred());
  expect(browser).toContain('/subjects/');
  const nativeCall = fixture.calls.find((call) => call.path.endsWith('/revisions/5'))!;
  expect(nativeCall).toMatchObject({
    authorization: 'Bearer story',
    session: 'previous-session',
    cache: 'no-store',
    redirect: 'manual',
  });
  expect(
    fixture.calls
      .filter((call) => call.path === `/v1/subjects/${fixture.id}`)
      .every((call) => call.authorization === null),
  ).toBe(true);

  const value = await fixture.value();
  expect(value.kind === 'ready' && value.page.change).toMatchObject({ kind: 'ready' });
  const view = renderToStaticMarkup(createElement(ValueExplanationPage, { result: value, locale: 'en' }));
  expect(view).toContain('9780156012195');
  expect(view).toContain(m.changes_proposal_detail());
  expect(view).toContain(m.context_selected());

  fixture.respond({ code: 'not_found', private: 'CONCEALED DETAIL' }, 404);
  const concealed = await fixture.transport.detail(5);
  expect(concealed).toEqual({ kind: 'missing' });
  const failed = changesState(changesState(state, { type: 'detail-start', revision: 5 }), {
    type: 'detail',
    result: concealed,
  });
  expect(failed.page).toBe(state.page);
  expect(failed.selected).toBe(5);
  const hidden = renderToStaticMarkup(createElement(SubjectChangesPage, { state: failed, locale: 'en' }));
  expect(hidden).toContain(m.changes_missing());
  expect(hidden).not.toContain(m.changes_proposal_detail());
  expect(hidden).not.toContain('CONCEALED DETAIL');
  const hiddenValue = await fixture.value();
  const hiddenView = renderToStaticMarkup(createElement(ValueExplanationPage, { result: hiddenValue, locale: 'en' }));
  expect(hiddenView).toContain('9780156012195');
  expect(hiddenView).toContain(m.value_change_unavailable());
  expect(hiddenView).not.toContain(m.context_selected());
  fixture.conceal();
  expect(await fixture.transport.detail(5)).toEqual({ kind: 'missing', scope: 'subject' });
});

test('native record, abstention and recorded adoption keep their actual readings and positive heads', async () => {
  const { ChangeExplanation } = await import('../src/features/catalogue/subject-changes-page');
  const fixture = nativeDetailFixture();
  if (fixture.dto.change.kind !== 'candidate') throw new Error('Expected candidate fixture');
  const changes: NativeRevisionDetail['change'][] = [
    { kind: 'record' },
    {
      ...fixture.dto.change,
      kind: 'decision',
      head: 9,
      verdict: 'abstain',
      reading: {
        decision: { head: 10, verdict: 'reject', revision: 11 },
        selected: false,
        rank: 'deprecated',
      },
    },
    {
      kind: 'adoption',
      property: 'schema:isbn',
      context: fixture.read.subject.context,
      head: 12,
      mode: 'replace',
      selection: [{ candidate: fixture.selected.id, rank: 'preferred' }],
    },
  ];
  for (const change of changes) {
    fixture.respond({ ...fixture.dto, change });
    const result = await fixture.transport.detail(5);
    if (result.kind !== 'ready') throw new Error('Expected supported native detail');
    const html = renderToStaticMarkup(createElement(ChangeExplanation, { detail: result.detail, locale: 'en' }));
    if (change.kind === 'record') expect(html).toContain(m.changes_limited());
    if (change.kind === 'decision') {
      expect(result.detail.summary).toMatchObject({ head: 9, decision: 'abstain', reading: change.reading });
      expect(html).toContain(m.changes_abstained_detail());
      expect(html).toContain(m.candidate_rejected_state());
      expect(html).toContain(m.changes_rank_deprecated());
    }
    if (change.kind === 'adoption') {
      expect(result.detail.summary).toEqual(change);
      expect(html).toContain(m.changes_adopted_detail());
      expect(html).toContain(m.context_replace());
      expect(html).toContain(m.candidate_rank_preferred());
    }
    expect(html).not.toContain(m.context_selected());
  }
});

test('unsupported, malformed and mismatched native detail never becomes a guessed explanation or current selection', async () => {
  const fixture = nativeDetailFixture();
  const dto = fixture.dto;
  if (dto.change.kind !== 'candidate') throw new Error('Expected candidate fixture');
  const adoption: NativeRevisionDetail['change'] = {
    kind: 'adoption',
    property: 'schema:isbn',
    context: fixture.read.subject.context,
    head: 1,
    mode: 'replace',
    selection: Array.from({ length: 32 }, () => ({ candidate: fixture.selected.id, rank: 'normal' })),
  };
  fixture.respond({ ...dto, change: adoption });
  expect((await fixture.transport.detail(5)).kind).toBe('ready');
  for (const body of [
    { ...dto, subject: crypto.randomUUID() },
    { ...dto, revision: { ...dto.revision, revision: 6 } },
    { ...dto, change: { kind: 'unknown', fields: [{ field: 'labels', languages: ['en'] }] } },
    {
      ...dto,
      change: {
        ...dto.change,
        reading: { ...dto.change.reading, decision: { head: 0, verdict: 'accept', revision: 1 } },
      },
    },
    { ...dto, change: { ...adoption, selection: [...adoption.selection, adoption.selection[0]] } },
    { ...dto, actor: 'PRIVATE ACTOR' },
    { ...dto, change: { ...dto.change, payload: 'PRIVATE OLD TEXT' } },
  ]) {
    fixture.respond(body);
    expect(await fixture.transport.detail(5)).toEqual({ kind: 'unavailable' });
  }
  for (const [status, kind] of [
    [403, 'denied'],
    [404, 'missing'],
    [503, 'unavailable'],
    [302, 'unavailable'],
  ] as const) {
    fixture.respond({ private: 'PRIVATE OLD TEXT' }, status);
    expect(await fixture.transport.detail(5)).toEqual({ kind });
  }
  fixture.respond({ ...dto, change: { ...dto.change, context: crypto.randomUUID() } });
  const wrongContext = await fixture.value();
  expect(wrongContext.kind === 'ready' && wrongContext.page.change).toEqual({ kind: 'unavailable' });
  fixture.respond({ ...dto, change: { ...adoption, selection: [{ candidate: crypto.randomUUID(), rank: 'normal' }] } });
  const otherSelection = await fixture.value();
  expect(otherSelection.kind === 'ready' && otherSelection.page.change).toEqual({ kind: 'unavailable' });
});

test('The actual native terms revision explains each field and its own languages without historical values or actors', async () => {
  const { ChangeExplanation, SubjectChangesPage } = await import('../src/features/catalogue/subject-changes-page');
  const fixture = nativeDetailFixture();
  const changes: NativeRevisionDetail['change'][] = [
    { kind: 'terms', fields: [{ field: 'labels', languages: ['en'] }] },
    {
      kind: 'terms',
      fields: [
        { field: 'labels', languages: ['en', 'fr'] },
        { field: 'descriptions', languages: ['ja'] },
        { field: 'aliases', languages: ['de'] },
      ],
    },
  ];
  const list = await fixture.transport.list();
  for (const change of changes) {
    fixture.respond({ ...fixture.dto, revision: { ...fixture.dto.revision, kind: 'terms' }, change });
    const result = await fixture.transport.detail(5, 'prior-session');
    expect(result).toMatchObject({ kind: 'ready', detail: { summary: change }, session: 'native-detail-session' });
    if (result.kind !== 'ready' || change.kind !== 'terms') throw new Error('Expected native terms detail');
    const html = renderToStaticMarkup(createElement(ChangeExplanation, { detail: result.detail, locale: 'en' }));
    expect(html).toContain(m.changes_terms());
    const labels = { labels: m.changes_name(), descriptions: m.changes_description(), aliases: m.changes_aliases() };
    for (const entry of change.fields) {
      const languages = entry.languages.map((tag) => languageName(tag, 'en')).join(' · ');
      expect(html).toContain(`>${labels[entry.field]}</dt><dd>${languages}</dd>`);
    }
    const state = changesState(
      changesState(changesState({}, { type: 'list', result: list, more: false }), {
        type: 'detail-start',
        revision: 5,
      }),
      { type: 'detail', result },
    );
    expect(renderToStaticMarkup(createElement(SubjectChangesPage, { state, locale: 'en' }))).toContain(html);
    expect(html).not.toContain(m.changes_current());
    for (const privateText of [
      fixture.dto.revision.release,
      fixture.selected.id,
      '9780156012195',
      'Bearer story',
      'native-detail-session',
    ])
      expect(html).not.toContain(privateText);
    expect(Object.keys(result.detail.summary)).toEqual(['kind', 'fields']);
  }
  expect(fixture.calls.filter((call) => call.path.endsWith('/revisions/5'))).toHaveLength(2);
  fixture.respond({ code: 'not_found', actor: 'PRIVATE ACTOR', payload: 'PRIVATE OLD TEXT' }, 404);
  expect(await fixture.transport.detail(5)).toEqual({ kind: 'missing' });
  fixture.conceal();
  expect(await fixture.transport.detail(5)).toEqual({ kind: 'missing', scope: 'subject' });
});

test('native terms detail keeps the producer field bound and strict field/language shape without opening unknown schemas', async () => {
  const fixture = nativeDetailFixture();
  const field = { field: 'labels', languages: ['en'] };
  // The delivered schema permits empty metadata arrays and at most three field entries.
  for (const fields of [[], [field], [{ field: 'aliases', languages: [] }]]) {
    fixture.respond({ ...fixture.dto, change: { kind: 'terms', fields } });
    expect((await fixture.transport.detail(5)).kind).toBe('ready');
  }
  for (const change of [
    { kind: 'terms', fields: [field, field, field, field] },
    { kind: 'terms', fields: [{ field: 'label', languages: ['en'] }] },
    { kind: 'terms', fields: [{ field: 'labels', languages: 'en' }] },
    { kind: 'terms', fields: [{ field: 'labels', languages: [null] }] },
    { kind: 'terms', fields: [{ field: 'labels', languages: ['en'], actor: 'PRIVATE ACTOR' }] },
    { kind: 'terms', fields: [field], payload: 'PRIVATE OLD TEXT' },
    { kind: 'terms', fields: [field], languages: ['en'] },
  ]) {
    fixture.respond({ ...fixture.dto, change });
    expect(await fixture.transport.detail(5)).toEqual({ kind: 'unavailable' });
  }
});
