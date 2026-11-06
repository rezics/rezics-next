import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import type { KernelClient } from '@rezics/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type {
  MalApplyPage,
  MalCommand,
  MalDeliveryCustody,
  MalImportPort,
  MalPage,
  MalPreviewRow,
  MalQuestion,
  MalReviewInput,
  MalScoreReview,
} from '../src/library/personal-mal-import/contract';
import { kernelMalPort } from '../src/library/personal-mal-import/native';
import type { SessionEnv } from '../src/session/client';
import { SESSION_COOKIE } from '../src/session/cookies';
import { libraryNavigation } from '../src/library/navigation';
import type { MalVisit } from '../src/library/personal-mal-import/visit';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/import-mal' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  MouseEvent: window.MouseEvent,
  Event: window.Event,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: window.scrollTo.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
type Root = ReturnType<typeof createRoot>;
const { m } = await import('../src/paraglide/messages.js');
const { MalImportPortContext } = await import('../src/library/personal-mal-import/port');
const { PersonalMalImportPage } = await import('../src/library/personal-mal-import/page');
const { sessionQuery } = await import('../src/session/query');
const { malOriginalScoreLabel, malScoreLabel, malValueLabel } =
  await import('../src/library/personal-mal-import/meaning');

const id = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const subject = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const secondSubject = '0192f3a0-6c1e-7b2a-9d4e-00000000cccc';
const thirdSubject = '0192f3a0-6c1e-7b2a-9d4e-00000000eeee';
const questionId = '0192f3a0-6c1e-7b2a-9d4e-00000000dddd';
const deliveries = new Map<string, MalDeliveryCustody>();
const custodyKey = (viewer: string) => viewer;
const visit = (viewer = 'alice', csrf = 'csrf-1'): MalVisit => {
  const controller = new AbortController();
  let retired = false;
  return {
    subject: viewer,
    csrfToken: csrf,
    locale: 'en',
    controller,
    retire() {
      retired = true;
      controller.abort();
    },
    current() {
      return !retired;
    },
    delivery() {
      const value = deliveries.get(custodyKey(viewer));
      return value ? structuredClone(value) : null;
    },
    retainDelivery(value) {
      deliveries.set(custodyKey(viewer), structuredClone(value));
    },
    resolveDelivery(command) {
      const value = deliveries.get(custodyKey(viewer));
      if (value && JSON.stringify(value.command) === JSON.stringify(command)) deliveries.delete(custodyKey(viewer));
    },
  };
};

const question: MalQuestion = {
  id: questionId,
  realmId: null,
  meaning: 'A personal score for this work.',
  revision: 7,
  lifecycle: { state: 'active', revision: 7 },
  label: 'Personal score',
  canonicalLabel: 'Personal score',
  labelRevision: 1,
  grain: 'work',
  scale: { min: 0, max: 20, displayStep: 1 },
};

function value(
  kind: MalPreviewRow['status']['kind'],
  extra: Partial<MalPreviewRow['status']> = {},
): MalPreviewRow['status'] {
  return { kind, ...extra };
}

function row(changes: Partial<MalPreviewRow> = {}): MalPreviewRow {
  return {
    index: 0,
    kind: 'manga',
    title: 'Private manga',
    identifier: { namespace: 'https://myanimelist.net/manga', source: 'mal_manga', value: '7' },
    status: value('value', { raw: 'Reading', value: 'Reading' }),
    role: 'active',
    score: value('zero', { value: 0, scale: { min: 1, max: 10, step: 1 } }),
    progress: { my_read_chapters: value('value', { value: 12 }), my_read_volumes: value('value', { value: 2 }) },
    dates: {
      started: value('value', { value: '2024', precision: 'year' }),
      finished: value('unknown', { raw: '0000-00-00' }),
    },
    notes: value('value', { value: 'secret note' }),
    tags: value('value', { value: 'a,b' }),
    repeats: value('value', { value: 3 }),
    privacy: value('value', { value: '1' }),
    timestamps: { my_last_updated: value('value', { value: '123' }) },
    fields: { manga_title: 'Private manga', my_comments: 'secret note', my_score: '0' },
    retained: [
      { field: 'my_comments', reason: 'private-note-only' },
      { field: 'my_score', reason: 'no-native-vote-admission' },
    ],
    target: null,
    candidates: [],
    match: 'unmatched',
    state: 'active',
    current: null,
    binding: null,
    source: { release: 'r1', epoch: '1', acceptingType: 'ex:Child' },
    review: null,
    outcome: null,
    ...changes,
  };
}

function reviewedScore(
  targetId: string,
  source: MalPreviewRow['score'],
  input: NonNullable<MalReviewInput['score']>,
): MalScoreReview {
  return {
    action: input.action,
    source,
    sourceSupport: {
      status: 'owner-selection-required',
      reason: 'native-units-require-explicit-selection',
    },
    conversion: 'owner-selected-not-exact',
    question: {
      id: questionId,
      revision: question.revision,
      label: question.label,
      meaning: question.meaning,
      grain: question.grain,
      lifecycleState: 'active',
      scale: { minimumUnits: 0, maximumUnits: 20, stepUnits: 1 },
    },
    units: input.action === 'adopt' ? input.units : null,
    replaceCurrent: input.action === 'adopt' && input.replaceCurrent === true,
    support: { status: 'supported', reason: null },
    baseline: { state: 'present', units: 0, revision: 3, at: '2026-10-01T12:00:00.000Z' },
    admission: { status: 'conditional', reason: null },
    guard: {
      version: 1,
      question: { revision: question.revision, lifecycleRevision: question.lifecycle.revision },
      subject: { canonicalId: targetId, epochs: [] },
      ownVote: { state: 'present', observation: 'vote-revision-3' },
    },
  };
}

function reviewedRow(current: MalPreviewRow, command: Parameters<MalImportPort['review']>[0]): MalPreviewRow {
  const input = command.input;
  const score = input.score ? reviewedScore(input.target ?? '', current.score, input.score) : undefined;
  return {
    ...current,
    target: input.target,
    match: input.target ? 'matched' : current.match,
    review: {
      version: command.key,
      target: input.target,
      skip: input.skip,
      replace: input.replace,
      state: 'active',
      current: null,
      binding: null,
      source: current.source,
      conflict: false,
      unsupported: null,
      ...(score ? { score } : {}),
    },
    scoreReviewState: score ? 'observations-match' : null,
    currentScoreVote: score ? { units: 0, revision: 3, at: '2026-10-01T12:00:00.000Z' } : current.currentScoreVote,
  };
}

function pageOf(rows: MalPreviewRow[], extra: Partial<MalPage> = {}): MalPage {
  return {
    id,
    canceled: false,
    total: rows.length,
    rows,
    sourcePath: `/v1/libraryImports/mal/${id}/source`,
    next: null,
    limits: { bytes: 2_097_152, rows: 500, page: 20 },
    ...extra,
  };
}

let host: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string) {
  return [...host.querySelectorAll('button')].find((item) => item.textContent === label);
}

async function click(label: string) {
  const target = button(label);
  expect(target).toBeDefined();
  await act(async () => {
    target!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

async function clickLabel(label: string) {
  const target = [...host.querySelectorAll('label')].find((item) => item.textContent === label);
  expect(target).toBeDefined();
  await act(async () => {
    target!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

async function clickWithin(container: Element, label: string) {
  const target = [...container.querySelectorAll('label,button')].find((item) => item.textContent === label);
  expect(target).toBeDefined();
  await act(async () => {
    target!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

async function clickControlWithin(container: Element, labelText: string) {
  const label = [...container.querySelectorAll('label')].find((item) => item.textContent?.trim() === labelText);
  expect(label).toBeDefined();
  const control = label!.querySelector('input') ?? document.getElementById(label!.htmlFor);
  expect(control).toBeDefined();
  await act(async () => {
    (control as HTMLElement).click();
    await Promise.resolve();
  });
  await settle();
}

function malRow(index: number): HTMLElement {
  const found = host.querySelector(`[data-mal-row="${index}"]`);
  expect(found).not.toBeNull();
  return found as HTMLElement;
}

async function uploadXml(xml = '<myanimelist/>') {
  const file = new File([xml], 'list.xml', { type: 'text/xml' });
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await click(m.library_mal_upload());
}

async function setInputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function setSelectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

async function mount(port: MalImportPort, current = visit()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <MalImportPortContext.Provider value={port}>
          <PersonalMalImportPage visit={current} />
        </MalImportPortContext.Provider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ['/en/library/import-mal'] }),
  });
  await router.load();
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  await settle();
}

async function mountObserved(port: MalImportPort, viewer: string, csrf: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: viewer, csrfToken: csrf });
  const tree = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <MalImportPortContext.Provider value={port}>
          <PersonalMalImportPage />
        </MalImportPortContext.Provider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ['/en/library/import-mal'] }),
  });
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  await settle();
  return client;
}

beforeEach(() => {
  deliveries.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test('zero scores, unknown dates and independent chapter/volume measures stay distinct', () => {
  expect(malScoreLabel(value('zero', { value: 0, scale: { min: 1, max: 10, step: 1 } }))).toBe(
    m.library_mal_score_none(),
  );
  expect(malValueLabel(value('unknown', { raw: '0000-00-00' }))).toBe(m.library_mal_unknown());
  expect(malValueLabel(value('missing'))).toBe(m.library_mal_missing());
  expect(malValueLabel(value('value', { value: '2024', precision: 'year' }))).toBe(
    m.library_mal_precision_year({ value: '2024' }),
  );
  expect(libraryNavigation.some((entry) => entry.id === 'library.import-mal')).toBe(true);
  expect(libraryNavigation.some((entry) => entry.id === 'library.discover-collections')).toBe(true);
  expect(libraryNavigation.some((entry) => entry.id === 'library.create-collection')).toBe(true);
});

test('an account round trip in one React batch discards private import evidence even with unchanged credentials', async () => {
  const port = {
    async preview() {
      return { kind: 'previewed', id };
    },
    async page() {
      return { kind: 'page', page: pageOf([row()]) };
    },
  } as MalImportPort;
  const client = await mountObserved(port, 'round-trip-owner', 'same-csrf');
  await uploadXml();
  expect(host.querySelector('[data-mal-row="0"]')).not.toBeNull();
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: 'another-member',
      csrfToken: 'other-csrf',
    });
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: 'round-trip-owner',
      csrfToken: 'same-csrf',
    });
  });
  await settle();
  expect(host.querySelector('[data-mal-row]')).toBeNull();
  expect(button(m.library_mal_upload())).toBeDefined();
});

test('explicit unmatched target, status selection, confirmation and partial results keep original retry', async () => {
  const previewXml: string[] = [];
  const reviews: unknown[] = [];
  const applies: unknown[] = [];
  let current = row();
  const port: MalImportPort = {
    async readQuestion() {
      return { kind: 'unavailable' };
    },
    async readVote() {
      return { kind: 'vote', value: { kind: 'unavailable' } };
    },
    async preview(command) {
      previewXml.push(command.xml);
      return { kind: 'previewed', id };
    },
    async page() {
      return { kind: 'page', page: pageOf([current]) };
    },
    async review(command) {
      reviews.push(command);
      current = {
        ...current,
        target: command.input.target,
        match: command.input.target ? 'matched' : current.match,
        review: {
          version: command.key,
          target: command.input.target,
          skip: command.input.skip,
          replace: command.input.replace,
          state: 'active',
          current: null,
          binding: null,
          source: current.source,
          conflict: false,
          unsupported: null,
        },
      };
      return { kind: 'reviewed', id };
    },
    async apply(command) {
      applies.push(JSON.parse(JSON.stringify(command)));
      if (applies.length === 1) return { kind: 'unknown', command };
      return {
        kind: 'applied',
        result: {
          id,
          stopped: true,
          remaining: [1],
          outcomes: [
            { row: 0, status: 'applied', applied: ['status'], retained: ['my_comments', 'my_score'], reason: null },
            {
              row: 2,
              status: 'failed',
              applied: [],
              retained: ['manga_title'],
              reason: 'native-command-unavailable-retry-original',
            },
          ],
        },
      };
    },
    async admitSource() {
      return { kind: 'admitted' as const };
    },
    async cancel() {
      return { kind: 'done', id };
    },
    async delete() {
      return { kind: 'done', id };
    },
  };
  await mount(port);
  expect(host.textContent).toContain(m.library_mal_intro());
  const file = new File(['<myanimelist><manga/></myanimelist>'], 'list.xml', { type: 'text/xml' });
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await click(m.library_mal_upload());
  expect(previewXml[0]).toContain('myanimelist');
  expect(host.textContent).toContain('Private manga');
  expect(host.textContent).toContain(m.library_mal_score_zero_source({ value: '0' }));
  expect(host.textContent).toContain(m.library_mal_chapters());
  expect(host.textContent).toContain(m.library_mal_volumes());
  expect(host.textContent).toContain(m.library_mal_not_vote());
  expect(host.querySelector('[data-mal-kind="manga"]')).not.toBeNull();
  const target = host.querySelector('[data-mal-target]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(target, subject);
    target.dispatchEvent(new window.Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  await click(m.library_mal_save_review());
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toMatchObject({ input: { row: 0, target: subject, skip: false, replace: false } });
  await click(m.library_mal_continue_confirm());
  expect(host.textContent).toContain(subject);
  await clickLabel(m.library_import_source_privacy_confirm());
  await clickLabel(m.library_import_source_timestamps_confirm());
  await click(m.library_mal_confirm());
  expect(host.textContent).toContain(m.library_mal_uncertain());
  await click(m.library_mal_retry_command());
  expect(applies).toHaveLength(2);
  expect(applies[0]).toEqual(applies[1]);
  expect(host.textContent).toContain(m.library_mal_result_applied());
  expect(host.textContent).toContain(m.library_mal_result_failed());
  expect(host.textContent).toContain(m.library_mal_result_unattempted());
  expect(host.querySelector('[data-mal-outcome="unattempted"]')).not.toBeNull();
  await click(m.library_mal_return_review());
  expect(button(m.library_mal_label_results())).toBeDefined();
  await click(m.library_mal_label_results());
  expect(host.querySelector('[data-mal-outcome="unattempted"]')).not.toBeNull();
});

test('cancel refreshes native state and discard deletes the retained upload', async () => {
  const cancelCommands: Extract<MalCommand, { kind: 'cancel' }>[] = [];
  const deleted: string[] = [];
  let pageReads = 0;
  const port: MalImportPort = {
    async readQuestion() {
      return { kind: 'unavailable' };
    },
    async readVote() {
      return { kind: 'vote', value: { kind: 'unavailable' } };
    },
    async preview() {
      return { kind: 'previewed', id };
    },
    async page() {
      pageReads += 1;
      return { kind: 'page', page: pageOf([row()], { canceled: pageReads > 1 }) };
    },
    async review() {
      return { kind: 'unavailable' };
    },
    async apply() {
      return { kind: 'unavailable' };
    },
    async admitSource() {
      return { kind: 'unavailable' };
    },
    async cancel(command) {
      cancelCommands.push(command);
      return { kind: 'done', id };
    },
    async delete(command) {
      deleted.push(command.id);
      return { kind: 'done', id };
    },
  };
  await mount(port);
  await uploadXml();
  await click(m.library_mal_label_cancel());
  expect(cancelCommands).toHaveLength(1);
  expect(pageReads).toBe(2);
  expect(host.textContent).toContain(m.library_mal_canceled());
  await click(m.library_mal_discard());
  expect(deleted).toEqual([id]);
  expect(host.textContent).toContain(m.library_mal_intro());
});

test('keep stays the default and separates MAL zero from a real native zero through fresh readback', async () => {
  const readVotes: { targetId: string; questionId: string }[] = [];
  const applied: Extract<MalCommand, { kind: 'apply' }>[] = [];
  let current = row({
    match: 'matched',
    target: subject,
    score: value('zero', { raw: '0', value: 0, scale: { min: 1, max: 10, step: 1 } }),
    currentScoreVote: { units: 0, revision: 3, at: '2026-10-01T12:00:00.000Z' },
    sourceAdmission: { status: 'admitted' },
  });
  let questionReads = 0;
  const port: MalImportPort = {
    async readQuestion() {
      questionReads += 1;
      return { kind: 'question', question };
    },
    async readVote(input) {
      readVotes.push(input);
      current = {
        ...current,
        currentScoreVote: { units: 0, revision: 4, at: '2026-11-05T12:00:00.000Z' },
      };
      return { kind: 'vote', value: { kind: 'current', units: 0, revision: 4, at: '2026-11-05T12:00:00.000Z' } };
    },
    async preview() {
      return { kind: 'previewed', id };
    },
    async page() {
      return { kind: 'page', page: pageOf([current]) };
    },
    async review(command) {
      current = reviewedRow(current, command);
      return { kind: 'reviewed', id };
    },
    async apply(command) {
      applied.push(structuredClone(command));
      return {
        kind: 'applied',
        result: {
          id,
          stopped: false,
          remaining: [],
          outcomes: [{ row: 0, status: 'applied', applied: ['status'], retained: ['my_score'], reason: null }],
        },
      };
    },
    async admitSource() {
      return { kind: 'admitted' };
    },
    async cancel() {
      return { kind: 'done', id };
    },
    async delete() {
      return { kind: 'done', id };
    },
  };
  await mount(port);
  await uploadXml('<myanimelist><manga/></myanimelist>');
  await click(m.library_mal_read_question());
  expect(questionReads).toBe(1);
  expect(host.textContent).toContain(m.library_mal_question_loaded({ label: question.label, revision: 7 }));
  const reviewRow = malRow(0);
  expect(reviewRow.textContent).toContain(m.library_mal_score_zero_source({ value: '0' }));
  expect(reviewRow.textContent).toContain(m.library_mal_score_source_scale({ min: 1, max: 10, step: 1 }));
  expect((reviewRow.querySelector('input[type="radio"]') as HTMLInputElement).checked).toBe(true);
  expect((reviewRow.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement).disabled).toBe(true);
  expect(reviewRow.textContent).toContain(
    m.library_mal_current_vote_label({
      value: m.library_mal_vote_present({ units: 0, revision: 3, at: '2026-10-01T12:00:00.000Z' }),
    }),
  );
  await clickWithin(reviewRow, m.library_mal_read_current_vote());
  expect(readVotes).toEqual([{ targetId: subject, questionId }]);
  expect(host.textContent).toContain(
    m.library_mal_vote_present({ units: 0, revision: 4, at: '2026-11-05T12:00:00.000Z' }),
  );
  await clickWithin(malRow(0), m.library_mal_save_review());
  await click(m.library_mal_continue_confirm());
  expect(host.textContent).toContain(
    m.library_mal_question_details({
      label: question.label,
      revision: question.revision,
      grain: question.grain,
      meaning: question.meaning!,
      min: question.scale.min,
      max: question.scale.max,
      step: question.scale.displayStep,
    }),
  );
  expect(host.textContent).toContain(
    m.library_mal_current_vote_label({
      value: m.library_mal_vote_present({ units: 0, revision: 4, at: '2026-11-05T12:00:00.000Z' }),
    }),
  );
  await clickLabel(m.library_import_source_privacy_confirm());
  await clickLabel(m.library_import_source_timestamps_confirm());
  await click(m.library_mal_confirm());
  expect(applied).toHaveLength(1);
  expect(applied[0]!.body.rows).toEqual([{ row: 0, version: current.review!.version, fields: ['status'] }]);
  expect(applied[0]!.body.rows[0]!.fields).not.toContain('score');
  expect(host.textContent).toContain(m.library_mal_score_effect_none());
  expect(host.textContent).toContain(m.library_mal_vote_unavailable());
  await clickWithin(malRow(0), m.library_mal_read_current_vote());
  expect(readVotes).toHaveLength(2);
  expect(host.textContent).toContain(
    m.library_mal_vote_present({ units: 0, revision: 4, at: '2026-11-05T12:00:00.000Z' }),
  );
});

test('adopt and clear use separate consent, exact retry, guarded partial results and real A/B/A replacement', async () => {
  const reviewInputs: MalReviewInput[] = [];
  const applyCommands: Extract<MalCommand, { kind: 'apply' }>[] = [];
  const sourceCommands: Extract<MalCommand, { kind: 'admit-source' }>[] = [];
  const voteReads: { targetId: string; questionId: string }[] = [];
  let rows = [
    row({
      index: 0,
      title: 'Private manga',
      match: 'ambiguous',
      target: subject,
      score: value('value', { raw: '8', value: 8, scale: { min: 1, max: 10, step: 1 } }),
      currentScoreVote: { units: 0, revision: 3, at: '2026-10-01T12:00:00.000Z' },
    }),
    row({
      index: 1,
      kind: 'anime',
      title: 'Private anime',
      identifier: { namespace: 'https://myanimelist.net/anime', source: 'mal_anime', value: '8' },
      match: 'matched',
      target: secondSubject,
      score: value('value', { raw: '6', value: 6, scale: { min: 1, max: 10, step: 1 } }),
      currentScoreVote: { units: 0, revision: 5, at: '2026-10-02T12:00:00.000Z' },
    }),
  ];
  let questionReads = 0;
  let pageReads = 0;
  const result: MalApplyPage = {
    id,
    stopped: false,
    remaining: [],
    outcomes: [
      {
        row: 0,
        status: 'applied',
        applied: ['status', 'score'],
        retained: ['my_comments'],
        reason: null,
        score: {
          action: 'adopt',
          status: 'applied',
          vote: { units: 16, revision: 8, at: '2026-11-05T12:01:00.000Z' },
          reason: null,
        },
      },
      {
        row: 1,
        status: 'applied',
        applied: ['status'],
        retained: ['my_score'],
        reason: null,
        score: { action: 'clear', status: 'unavailable', reason: 'atomic_guard_unavailable' },
      },
    ],
  };
  const port: MalImportPort = {
    async readQuestion() {
      questionReads += 1;
      return { kind: 'question', question };
    },
    async readVote(input) {
      voteReads.push(input);
      return {
        kind: 'vote',
        value: {
          kind: 'current',
          units: 0,
          revision: 3,
          at: '2026-10-01T12:00:00.000Z',
        },
      };
    },
    async preview() {
      return { kind: 'previewed', id };
    },
    async page() {
      pageReads += 1;
      return { kind: 'page', page: pageOf(rows) };
    },
    async review(command) {
      reviewInputs.push(command.input);
      const reviewed = reviewedRow(
        rows.find((item) => item.index === command.input.row)!,
        command,
      );
      rows = rows.map((item) =>
        item.index === command.input.row
          ? reviewInputs.length === 1
            ? { ...reviewed, scoreReviewState: 'stale' }
            : reviewed
          : item,
      );
      return { kind: 'reviewed', id };
    },
    async apply(command) {
      applyCommands.push(structuredClone(command));
      if (applyCommands.length === 1) return { kind: 'unknown', command };
      rows = rows.map((item) =>
        item.index === 0
          ? { ...item, currentScoreVote: { units: 16, revision: 8, at: '2026-11-05T12:01:00.000Z' } }
          : { ...item, currentScoreVote: null },
      );
      return { kind: 'applied', result };
    },
    async admitSource(command) {
      sourceCommands.push(structuredClone(command));
      return { kind: 'admitted' };
    },
    async cancel() {
      return { kind: 'done', id };
    },
    async delete() {
      return { kind: 'done', id };
    },
  };
  const client = await mountObserved(port, 'mal-score-owner', 'mal-score-csrf');
  await uploadXml('<myanimelist><manga/><anime/></myanimelist>');
  await click(m.library_mal_read_question());
  expect(questionReads).toBe(1);
  expect(pageReads).toBe(1);
  await clickWithin(malRow(0), m.library_mal_read_current_vote());
  expect(voteReads).toEqual([{ targetId: subject, questionId }]);
  await clickControlWithin(malRow(0), m.library_mal_score_adopt());
  await setSelectValue(malRow(0).querySelector('select') as HTMLSelectElement, '16');
  await clickControlWithin(malRow(0), m.library_mal_score_replace());
  await clickWithin(malRow(0), m.library_mal_save_review());
  expect(host.textContent).toContain(m.library_mal_score_review_stale());
  await setInputValue(malRow(0).querySelector('[data-mal-target]') as HTMLInputElement, thirdSubject);
  expect((malRow(0).querySelector('input[type="radio"]') as HTMLInputElement).checked).toBe(true);
  expect(malRow(0).textContent).toContain(m.library_mal_vote_unavailable());
  await clickWithin(malRow(0), m.library_mal_read_current_vote());
  expect(voteReads[1]).toEqual({ targetId: thirdSubject, questionId });
  await clickControlWithin(malRow(0), m.library_mal_score_adopt());
  await setSelectValue(malRow(0).querySelector('select') as HTMLSelectElement, '16');
  await clickControlWithin(malRow(0), m.library_mal_score_replace());
  await clickWithin(malRow(0), m.library_mal_save_review());
  await clickControlWithin(malRow(1), m.library_mal_score_clear());
  await clickWithin(malRow(1), m.library_mal_save_review());
  expect(reviewInputs[0]!.score).toMatchObject({ action: 'adopt', units: 16, replaceCurrent: true });
  expect(reviewInputs[1]!.score).toMatchObject({ action: 'adopt', units: 16, replaceCurrent: true });
  expect(reviewInputs[2]!.score).toMatchObject({ action: 'clear', questionId, questionRevision: 7 });
  expect(reviewInputs[0]!.target).toBe(subject);
  expect(reviewInputs[1]!.target).toBe(thirdSubject);
  expect(rows.map((item) => item.identifier.namespace)).toEqual([
    'https://myanimelist.net/manga',
    'https://myanimelist.net/anime',
  ]);

  await click(m.library_mal_continue_confirm());
  const confirm = button(m.library_mal_confirm());
  expect(confirm?.disabled).toBe(true);
  await clickLabel(m.library_import_source_privacy_confirm());
  await clickLabel(m.library_import_source_timestamps_confirm());
  expect(button(m.library_mal_confirm())?.disabled).toBe(true);
  const consents = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  expect(consents).toHaveLength(4);
  await act(async () => consents[0]!.click());
  await settle();
  expect(button(m.library_mal_confirm())?.disabled).toBe(true);
  await act(async () => consents[1]!.click());
  await settle();
  expect(button(m.library_mal_confirm())?.disabled).toBe(false);
  await click(m.library_mal_confirm());
  expect(applyCommands).toHaveLength(1);
  expect(applyCommands[0]!.body.rows).toEqual([
    { row: 0, version: rows[0]!.review!.version, fields: ['status', 'score'] },
    { row: 1, version: rows[1]!.review!.version, fields: ['status', 'score'] },
  ]);
  expect(host.textContent).toContain(m.library_mal_retry_original_help());

  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: 'mal-score-other',
      csrfToken: 'mal-score-other-csrf',
    });
  });
  await settle();
  expect(host.textContent).not.toContain('Private manga');
  expect(host.textContent).not.toContain('Private anime');
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: 'mal-score-owner',
      csrfToken: 'mal-score-csrf-refreshed',
    });
  });
  await settle();
  expect(host.textContent).not.toContain('Private manga');
  expect(button(m.library_mal_retry_command())).toBeDefined();
  await click(m.library_mal_retry_command());
  expect(applyCommands).toHaveLength(2);
  expect(applyCommands[0]).toEqual(applyCommands[1]);
  expect(sourceCommands.map((command) => command.subjectId)).toEqual([thirdSubject, secondSubject]);
  expect(host.querySelectorAll('[data-mal-outcome="applied"]')).toHaveLength(2);
  expect(host.textContent).toContain(
    m.library_mal_score_receipt({
      action: m.library_mal_score_adopt_units({ units: 16 }),
      status: m.library_mal_result_applied(),
    }),
  );
  expect(host.textContent).toContain(
    m.library_mal_score_receipt({ action: m.library_mal_score_clear(), status: m.library_mal_score_unavailable() }),
  );
  expect(host.textContent).toContain('atomic_guard_unavailable');
  expect(host.textContent).toContain(m.library_mal_state_effect({ effect: m.library_mal_result_applied() }));
  expect(host.textContent).toContain(
    m.library_mal_vote_present({ units: 16, revision: 8, at: '2026-11-05T12:01:00.000Z' }),
  );
  expect(host.textContent).toContain(m.library_mal_source_evidence_label());
  expect(host.textContent).toContain(m.library_import_source_admitted());
});

test('native adapter preserves the score guard and replays an uncertain apply with its original authority', async () => {
  const activeSession = { accessToken: 'sender-a', csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA' };
  const sessionEnv = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'library',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'mal-import-test-key',
    SITE_ORIGINS: 'https://site.test',
    SESSIONS: {
      idFromName: () => 'session',
      get: () => ({
        credential: async () => ({
          status: 'active',
          accessToken: activeSession.accessToken,
          subject,
          csrfToken: activeSession.csrfToken,
        }),
      }),
    },
  } as unknown as Partial<SessionEnv>;
  const reviewCommand: Extract<MalCommand, { kind: 'review' }> = {
    kind: 'review',
    id,
    key: 'review-key',
    input: {
      row: 0,
      target: subject,
      skip: false,
      replace: false,
      score: { action: 'adopt', questionId, questionRevision: 7, units: 16, replaceCurrent: true },
    },
  };
  const nativeRow = reviewedRow(
    row({
      match: 'matched',
      target: subject,
      score: value('value', { raw: '8', value: 8, scale: { min: 1, max: 10, step: 1 } }),
    }),
    reviewCommand,
  );
  const nativePage = pageOf([nativeRow]);
  const applyResult: MalApplyPage = {
    id,
    stopped: false,
    remaining: [],
    outcomes: [
      {
        row: 0,
        status: 'applied',
        applied: ['status', 'score'],
        retained: ['my_score'],
        reason: null,
        score: {
          action: 'adopt',
          status: 'applied',
          vote: { units: 16, revision: 9, at: '2026-11-05T13:00:00.000Z' },
          reason: null,
        },
      },
    ],
  };
  const reviewCalls: { body: unknown; headers?: Record<string, string> }[] = [];
  const applyCalls: { body: unknown; authorization?: string }[] = [];
  let applyError: TypeError | null = null;
  const mal = Object.assign(
    () => ({
      get: async () => ({ data: nativePage, status: 200 }),
      review: {
        post: async (body: unknown, options: { headers?: Record<string, string> }) => {
          reviewCalls.push({ body: structuredClone(body), headers: options.headers });
          return { data: { id }, status: 200 };
        },
      },
      apply: {
        post: async (body: unknown, options: { headers?: Record<string, string> }) => {
          applyCalls.push({ body: structuredClone(body), authorization: options.headers?.authorization });
          if (applyError) throw applyError;
          return applyCalls.length === 1
            ? { error: { value: { detail: 'delivery uncertain' } }, status: 500 }
            : { data: applyResult, status: 200 };
        },
      },
    }),
    { $preview: { post: async () => ({ data: { id }, status: 200 }) } },
  );
  const client = { libraryImports: { mal } } as unknown as KernelClient;
  const request = (csrfToken: string) =>
    new Request('https://site.test/api/mal-import', {
      method: 'POST',
      headers: {
        origin: 'https://site.test',
        cookie: `${SESSION_COOKIE}=${'s'.repeat(43)}`,
        'x-csrf-token': csrfToken,
      },
    });
  const command: Extract<MalCommand, { kind: 'apply' }> = {
    kind: 'apply',
    id,
    body: { confirm: true, rows: [{ row: 0, version: reviewCommand.key, fields: ['status', 'score'] }] },
  };
  const firstPort = kernelMalPort(client, request(activeSession.csrfToken), sessionEnv, true);
  const reviewed = await firstPort.review(reviewCommand);
  expect(reviewed).toEqual({ kind: 'reviewed', id });
  expect(reviewCalls[0]!.body).toEqual(reviewCommand.input);
  expect(reviewCalls[0]!.headers).toMatchObject({
    authorization: 'Bearer sender-a',
    'idempotency-key': reviewCommand.key,
  });
  const lost = await firstPort.apply(command);
  expect(lost.kind).toBe('unknown');
  if (lost.kind !== 'unknown') throw new Error('Expected uncertain apply delivery');
  expect(lost.command).toMatchObject({
    ...command,
    custody: { viewer: subject, csrfToken: activeSession.csrfToken },
  });
  expect(lost.command.custody?.credential).toMatch(/^[A-Za-z0-9_-]{1,6400}$/);
  expect(applyCalls[0]!.authorization).toBe('Bearer sender-a');

  activeSession.accessToken = 'sender-b';
  activeSession.csrfToken = 'BBBBBBBBBBBBBBBBBBBBBB';
  const retryPort = kernelMalPort(client, request(activeSession.csrfToken), sessionEnv, true);
  const applied = await retryPort.apply(lost.command);
  expect(applyCalls[1]!.authorization).toBe('Bearer sender-a');
  expect(applyCalls[1]!.body).toEqual(applyCalls[0]!.body);
  expect(applied).toMatchObject({
    kind: 'applied',
    result: { outcomes: [{ score: { status: 'applied', vote: { units: 16, revision: 9 } } }] },
  });

  const pageResult = await retryPort.page({ kind: 'page', id, after: 0 });
  expect(pageResult).toMatchObject({
    kind: 'page',
    page: {
      rows: [
        {
          scoreReviewState: 'observations-match',
          currentScoreVote: { units: 0, revision: 3 },
          review: { score: { guard: nativeRow.review?.score?.guard } },
        },
      ],
    },
  });

  applyError = new TypeError('internal adapter defect');
  await expect(retryPort.apply(command)).rejects.toThrow('internal adapter defect');
  applyError = new TypeError('fetch failed');
  expect(await retryPort.apply(command)).toMatchObject({ kind: 'unknown', command });
});

test('retained upload reopens private native evidence and results without a second upload', async () => {
  const opened: string[] = [];
  const unavailable = async () => ({ kind: 'unavailable' as const });
  const current = row({
    outcome: {
      row: 0,
      status: 'applied',
      applied: ['tags'],
      retained: [],
      reason: null,
      labels: [{ value: 0, status: 'accepted', labelId: id, assignment: { id: subject, revision: 1 }, reason: null }],
    },
  });
  await mount({
    preview: async () => {
      throw new Error('Must not upload');
    },
    review: unavailable,
    apply: unavailable,
    admitSource: unavailable,
    cancel: unavailable,
    delete: unavailable,
    page: async (command) => {
      opened.push(command.id);
      return { kind: 'page', page: pageOf([current]) };
    },
    source: async () => ({ kind: 'source', xml: '<myanimelist><my_tags>A &amp; B</my_tags></myanimelist>' }),
  });
  const input = host.querySelector('input[autocomplete=off]') as HTMLInputElement;
  input.value = id;
  await act(() => input.form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  await settle();
  expect(opened).toEqual([id]);
  await click(m.library_mal_label_results());
  expect(host.textContent).toContain('accepted');
  expect(host.textContent).toContain(subject);
});
