import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import {
  BANGUMI_APPLY,
  BANGUMI_FORMAT,
  BANGUMI_PAGE,
  type BangumiImportPort,
  type BangumiPage,
  type BangumiReview,
  type BangumiRow,
  type BangumiScoreReview,
  type BangumiScoreSelection,
} from '../src/library/personal-bangumi-import/contract';
import { bangumiCallTotal, expectedBangumiCalls } from '../src/library/personal-bangumi-import/cost';
import { createBangumiJourney } from '../src/library/personal-bangumi-import/controller';
import { scoreSelectionFromDraft } from '../src/library/personal-bangumi-import/score';
import { libraryNavigation } from '../src/library/navigation';
import type { BangumiVisit } from '../src/library/personal-bangumi-import/visit';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/import-bangumi' });
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
const { BangumiImportPortContext } = await import('../src/library/personal-bangumi-import/port');
const { PersonalBangumiImportPage } = await import('../src/library/personal-bangumi-import/page');

const id = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const subject = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const secondSubject = '0192f3a0-6c1e-7b2a-9d4e-00000000dddd';
const token = '0192f3a0-6c1e-7b2a-9d4e-00000000cccc';
const questionId = '0192f3a0-6c1e-7b2a-9d4e-00000000eeee';
let nextVisitIdentity = 0;

const visit = (viewer = 'alice', csrf = 'csrf-1'): BangumiVisit => {
  const controller = new AbortController();
  let retired = false;
  return {
    identity: ++nextVisitIdentity,
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
  };
};

function envelope(rows: number): string {
  return JSON.stringify({
    format: BANGUMI_FORMAT,
    collections: Array.from({ length: rows }, (_, index) => ({
      subject_id: index + 1,
      subject_type: 2,
      type: 3,
      rate: index === 0 ? 0 : 8,
      ep_status: 0,
      vol_status: 0,
      comment: 'private',
      extra_unknown: 'keep',
      subject: { name: `Show ${index + 1}` },
    })),
  });
}

function evidence(index: number) {
  return {
    source: {
      subject_id: index + 1,
      subject_type: 2,
      type: 3,
      rate: index === 0 ? 0 : 8,
      ep_status: 0,
      extra_unknown: 'keep',
      subject: { name: `Show ${index + 1}` },
    },
    fields: [
      {
        field: 'subject_id',
        value: index + 1,
        meaning: 'known' as const,
        reason: 'Bangumi provider identifier; never a title match',
      },
      {
        field: 'rate',
        value: index === 0 ? 0 : 8,
        meaning: 'known' as const,
        reason: 'Bangumi 1–10 scale; no native vote or aggregate',
      },
      { field: 'ep_status', value: 0, meaning: 'known' as const, reason: 'episodes; no historical session inferred' },
      {
        field: 'extra_unknown',
        value: 'keep',
        meaning: 'unknown' as const,
        reason: 'No native field mapping; retained privately',
      },
    ],
    medium: 'anime',
    stateRole: 'active',
  };
}

function row(index: number, extra: Partial<BangumiRow> = {}): BangumiRow {
  return {
    ordinal: index,
    evidence: evidence(index),
    review: extra.review ?? null,
    outcome: extra.outcome ?? null,
    ...extra,
  };
}

function reviewed(index: number, changes: Partial<BangumiReview> = {}): BangumiReview {
  return {
    token,
    match: 'unmatched',
    candidates: [],
    target: null,
    guard: null,
    proposedState: 'active',
    current: null,
    conflict: false,
    score: scoreReview({ action: 'preserve' }, index),
    ...changes,
  };
}

function scoreReview(selection: BangumiScoreSelection = { action: 'preserve' }, index = 0): BangumiScoreReview {
  return {
    source: {
      state: index === 0 ? 'unrated' : 'score',
      value: index === 0 ? 0 : 8,
      scale: { minimum: 1, maximum: 10 },
      reason: index === 0 ? 'Bangumi rate 0 means unrated' : 'Bangumi source score on its original scale',
    },
    native: {
      questionId,
      question: {
        id: questionId,
        revision: 7,
        meaning: 'Community rating',
        label: 'Quality',
        grain: 'work',
        lifecycleState: 'active',
        scale: { minimum: 0, maximum: 20, step: 2 },
      },
      currentVote: { state: 'set', units: 0, revision: 3, at: '2026-10-10T12:00:00Z' },
      selection,
      admission: { status: 'reviewed', reason: 'native_review_observed' },
    },
  };
}

function pageOf(rows: BangumiRow[], extra: Partial<BangumiPage> = {}): BangumiPage {
  return { uploadId: id, cancelled: false, rows, next: null, ...extra };
}

function recordingPort(
  total: number,
  options: { failApplyOnce?: boolean; replace?: boolean } = {},
): {
  port: BangumiImportPort;
  previews: string[];
  applies: unknown[];
  reviews: unknown[];
  inspections: unknown[];
  deletions: unknown[];
} {
  const previews: string[] = [];
  const applies: unknown[] = [];
  const reviews: unknown[] = [];
  const inspections: unknown[] = [];
  const deletions: unknown[] = [];
  const tokens = new Map<number, string>();
  let applyAttempts = 0;
  const stored = Array.from({ length: total }, (_, index) => row(index));
  const port: BangumiImportPort = {
    async preview(command) {
      previews.push(command.upload);
      return { kind: 'previewed', uploadId: id, count: total };
    },
    async page(command) {
      const start = command.after + 1;
      const slice = stored.slice(start, start + BANGUMI_PAGE);
      return {
        kind: 'page',
        page: pageOf(slice, { next: start + slice.length < total ? start + slice.length - 1 : null }),
      };
    },
    async review(command) {
      reviews.push(JSON.parse(JSON.stringify(command)));
      const current = stored[command.ordinal]!;
      const review = reviewed(command.ordinal, {
        token: `${token.slice(0, -1)}${(reviews.length - 1) % 10}`,
        match: command.target ? 'chosen' : 'unmatched',
        target: command.target ?? null,
        current: options.replace ? { state: 'planned', revision: 4 } : null,
        conflict: !!options.replace,
        proposedState: 'active',
        score: scoreReview(command.score ?? { action: 'preserve' }, command.ordinal),
      });
      tokens.set(command.ordinal, review.token);
      stored[command.ordinal] = { ...current, review };
      return { kind: 'reviewed', ordinal: command.ordinal, review };
    },
    async apply(command) {
      applies.push(JSON.parse(JSON.stringify(command)));
      applyAttempts += 1;
      if (options.failApplyOnce && applyAttempts === 1) return { kind: 'unknown', command };
      return {
        kind: 'applied',
        result: {
          uploadId: id,
          remaining: [],
          outcomes: command.body.rows.map((item, index) => ({
            ordinal: item.ordinal,
            status: index === command.body.rows.length - 1 && command.body.rows.length > 1 ? 'failed' : 'applied',
            applied: item.skip ? [] : ['type'],
            retained: ['rate', 'ep_status', 'extra_unknown', 'comment'],
            score:
              item.score?.action === 'set' || item.score?.action === 'clear'
                ? { action: item.score.action, status: 'unavailable', reason: 'conditional_admission_unavailable' }
                : { action: 'preserve', status: 'skipped' },
          })),
        },
      };
    },
    async admitSource() {
      return { kind: 'admitted' as const };
    },
    async inspect(command) {
      inspections.push(JSON.parse(JSON.stringify(command)));
      return {
        entry: { status: 'present', state: 'active', revision: 8 },
        vote: command.questionId
          ? {
              status: 'current',
              vote: { state: 'set', units: 0, revision: 4, at: '2026-10-11T12:00:00Z' },
            }
          : null,
      };
    },
    async cancel() {
      return { kind: 'cancelled', uploadId: id };
    },
    async delete() {
      deletions.push(id);
      return { kind: 'deleted' };
    },
    async tags(command) {
      return {
        kind: 'tags',
        page: { ordinal: command.ordinal, rowRevision: token, evidence: 'missing', tags: [], next: null, labels: null },
        custody: command.custody ?? { viewer: 'alice', csrfToken: 'csrf-1', credential: 'encrypted' },
      };
    },
    async searchLabels() {
      return { kind: 'label-options', labels: [] };
    },
    async reviewLabels(command) {
      return {
        kind: 'labels-reviewed',
        ordinal: command.ordinal,
        labels: {
          review: { token, rowRevision: command.rowRevision, subject: null, evidence: 'missing', items: [] },
          confirmed: false,
          outcomes: [],
        },
      };
    },
    async applyLabels(command) {
      return {
        kind: 'labels-applied',
        result: { uploadId: command.uploadId, ordinal: command.ordinal, outcomes: [], remaining: [] },
      };
    },
    async readAssignments(subjectId) {
      return { kind: 'assignments', subjectId, assignments: [] };
    },
  };
  return { port, previews, applies, reviews, inspections, deletions };
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

async function mount(port: BangumiImportPort, current = visit()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <BangumiImportPortContext.Provider value={port}>
          <PersonalBangumiImportPage visit={current} />
        </BangumiImportPortContext.Provider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ['/en/library/import-bangumi'] }),
  });
  await router.load();
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  await settle();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test('navigation, unrated score and unknown fields stay distinct from applied state', () => {
  expect(libraryNavigation.some((entry) => entry.id === 'library.import-bangumi')).toBe(true);
  expect(libraryNavigation.some((entry) => entry.id === 'library.import-mal')).toBe(true);
  const review = scoreReview();
  expect(scoreSelectionFromDraft({ action: 'set', units: '' }, review)).toBeNull();
  expect(scoreSelectionFromDraft({ action: 'set', units: '0' }, review)).toEqual({ action: 'set', units: 0 });
  expect(scoreSelectionFromDraft({ action: 'set', units: '8' }, review, false)).toBeNull();
});

test('preview does not apply, explicit target replacement and exact uncertain retry keep operands', async () => {
  const { port, previews, applies, reviews } = recordingPort(1, { failApplyOnce: true, replace: true });
  await mount(port);
  expect(host.textContent).toContain(m.library_bangumi_intro());
  expect(host.textContent).toContain(m.library_bangumi_not_official());
  const file = new File([envelope(1)], 'collection.json', { type: 'application/json' });
  Object.defineProperty(host.querySelector('input[type="file"]') as HTMLInputElement, 'files', {
    configurable: true,
    value: [file],
  });
  await click(m.library_bangumi_upload());
  expect(previews).toHaveLength(1);
  expect(JSON.parse(previews[0]!).format).toBe(BANGUMI_FORMAT);
  expect(applies).toHaveLength(0);
  expect(host.textContent).toContain('Show 1');
  expect(host.textContent).toContain(m.library_bangumi_rate_none());
  expect(host.textContent).toContain(m.library_bangumi_unknown_summary());
  const target = host.querySelector('[data-bangumi-target]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(target, subject);
    target.dispatchEvent(new window.Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  await click(m.library_bangumi_save_review());
  expect(reviews[0]).toMatchObject({ ordinal: 0, target: subject });
  expect(host.textContent).toContain(
    m.library_bangumi_score_current_set({ units: 0, revision: 3, at: '2026-10-10T12:00:00Z' }),
  );
  expect(host.textContent).toContain('native_review_observed');
  const replacement = host.querySelector('[data-bangumi-target]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(replacement, secondSubject);
    replacement.dispatchEvent(new window.Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  expect(host.textContent).not.toContain('native_review_observed');
  await click(m.library_bangumi_save_review());
  expect(reviews[1]).toMatchObject({ ordinal: 0, target: secondSubject, score: { action: 'preserve' } });
  expect(host.textContent).toContain('native_review_observed');
  await clickLabel(m.library_bangumi_score_set());
  const units = host.querySelector('input[type="number"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(units, '8');
    units.dispatchEvent(new window.Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  await click(m.library_bangumi_save_review());
  expect(reviews[2]).toMatchObject({ ordinal: 0, target: secondSubject, score: { action: 'set', units: 8 } });
  const replace = [...host.querySelectorAll('label')].find((item) => item.textContent === m.library_bangumi_replace());
  expect(replace).toBeDefined();
  await act(async () => {
    replace!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await click(m.library_bangumi_continue_confirm());
  expect(host.textContent).toContain(secondSubject);
  expect(host.textContent).toContain(
    m.library_bangumi_score_confirm_set({ units: 8, question: questionId, revision: 7 }),
  );
  await clickLabel(m.library_import_source_privacy_confirm());
  await clickLabel(m.library_import_source_timestamps_confirm());
  await click(m.library_bangumi_confirm());
  expect(applies).toHaveLength(0);
  await clickLabel(m.library_bangumi_score_consent_set({ units: 8, question: questionId }));
  await click(m.library_bangumi_confirm());
  expect(host.textContent).toContain(m.library_bangumi_uncertain());
  await click(m.library_bangumi_retry_command());
  expect(applies).toHaveLength(2);
  expect(applies[0]).toEqual(applies[1]);
  expect(applies[1]).toMatchObject({
    body: { rows: [{ ordinal: 0, state: 'replace', skip: false, score: { action: 'set', units: 8, consent: true } }] },
  });
  expect(host.textContent).toContain(m.library_bangumi_result_applied());
  expect(host.textContent).toContain('type');
  expect(host.textContent).toContain('extra_unknown');
});

test('score set and clear require row consent, retry exact choices, and keep point reads separate', async () => {
  const { port, applies, reviews, inspections } = recordingPort(2, { failApplyOnce: true });
  const journey = createBangumiJourney({ port, visit: visit() });
  await journey.preview(envelope(2));
  let snap = await journey.review(0, subject, { action: 'set', units: 8 });
  snap = await journey.review(1, secondSubject, { action: 'clear' });
  expect(reviews[0]).toMatchObject({
    target: subject,
    score: { action: 'set', units: 8 },
  });
  expect(reviews[1]).toMatchObject({ target: secondSubject, score: { action: 'clear' } });
  expect(snap.meta[0]?.scoreReview?.source).toMatchObject({
    state: 'unrated',
    value: 0,
    scale: { minimum: 1, maximum: 10 },
  });
  expect(snap.meta[0]?.scoreReview?.native.currentVote).toMatchObject({ state: 'set', units: 0 });

  journey.openConfirm();
  journey.confirmSource({ privacy: true, timestamps: true });
  snap = await journey.confirm();
  expect(snap.stage).toBe('confirm');
  expect(applies).toHaveLength(0);
  journey.confirmScore(0, true);
  journey.backToReview();
  snap = await journey.review(0, secondSubject, { action: 'set', units: 8 });
  expect(snap.meta[0]?.target).toBe(secondSubject);
  expect(snap.meta[0]?.scoreConsent).toBe(false);
  journey.openConfirm();
  journey.confirmSource({ privacy: true, timestamps: true });
  snap = await journey.confirm();
  expect(snap.stage).toBe('confirm');
  expect(applies).toHaveLength(0);
  journey.confirmScore(0, true);
  journey.confirmScore(1, true);
  snap = await journey.confirm();
  expect(snap.notice?.kind).toBe('unknown');
  expect(applies).toHaveLength(1);
  const expected = {
    body: {
      rows: [
        {
          ordinal: 0,
          reviewToken: `${token.slice(0, -1)}2`,
          state: 'preserve',
          skip: false,
          score: { action: 'set', units: 8, consent: true },
        },
        {
          ordinal: 1,
          reviewToken: `${token.slice(0, -1)}1`,
          state: 'preserve',
          skip: false,
          score: { action: 'clear', consent: true },
        },
      ],
    },
  };
  expect(applies[0]).toMatchObject(expected);
  await journey.review(0, secondSubject, { action: 'set', units: 10 });
  expect(applies).toHaveLength(1);
  expect(journey.snapshot().notice?.kind).toBe('unknown');
  await journey.retryUnknown();
  expect(applies[0]).toEqual(applies[1]);
  snap = journey.snapshot();
  expect(snap.stage).toBe('results');
  expect(snap.outcomes[0]?.status).toBe('applied');
  expect(snap.outcomes[0]?.score).toMatchObject({
    action: 'set',
    status: 'unavailable',
    reason: 'conditional_admission_unavailable',
  });
  expect(snap.outcomes[1]).toMatchObject({ status: 'failed', score: { action: 'clear', status: 'unavailable' } });
  expect(inspections).toHaveLength(0);
  snap = await journey.inspectCurrent(0);
  expect(inspections).toEqual([{ subjectId: secondSubject, questionId }]);
  expect(snap.meta[0]?.entryReadback).toMatchObject({ status: 'present', state: 'active', revision: 8 });
  expect(snap.meta[0]?.voteReadback).toMatchObject({ status: 'current', vote: { state: 'set', units: 0 } });
  expect(snap.cost.calls['entry-read']).toBe(1);
  expect(snap.cost.calls['vote-read']).toBe(1);
  await journey.inspectCurrent(0);
  expect(inspections).toHaveLength(2);
  expect(bangumiCallTotal(journey.snapshot().cost)).toBe(
    expectedBangumiCalls({
      pages: 1,
      reviews: 3,
      applyBatches: 1,
      lifecycle: 0,
      retries: 1,
      entryReads: 2,
      voteReads: 2,
    }),
  );
});

test('refused replacement withdraws the old score consent even when a page retains its token', async () => {
  const { port, applies } = recordingPort(1);
  const journey = createBangumiJourney({ port, visit: visit() });
  await journey.preview(envelope(1));
  const original = await journey.review(0, subject, { action: 'set', units: 0 });
  const retained = structuredClone(original.page);
  const originalToken = original.meta[0]?.reviewToken;
  journey.openConfirm();
  journey.confirmScore(0, true);
  journey.backToReview();
  const review = port.review;
  port.review = async () => ({ kind: 'conflict' });
  await journey.review(0, subject, { action: 'clear' });
  port.page = async () => ({ kind: 'page', page: pageOf(structuredClone(retained)) });
  const refreshed = await journey.refresh();
  expect(refreshed.meta[0]).toMatchObject({ reviewToken: null, scoreReview: null, scoreConsent: false });
  expect(journey.openConfirm().stage).toBe('review');
  expect(applies).toHaveLength(0);
  port.review = review;
  const replacement = await journey.review(0, subject, { action: 'clear' });
  expect(replacement.meta[0]?.reviewToken).not.toBe(originalToken);
  expect(replacement.meta[0]?.scoreConsent).toBe(false);
});

test('current inspection reads the exact reviewed vote again after an acknowledged apply', async () => {
  const base = recordingPort(1);
  const inspections: { subjectId: string; questionId: string | null }[] = [];
  const port: BangumiImportPort = {
    ...base.port,
    async apply(command) {
      base.applies.push(JSON.parse(JSON.stringify(command)));
      return {
        kind: 'applied',
        result: {
          uploadId: id,
          remaining: [],
          outcomes: [
            {
              ordinal: 0,
              status: 'applied',
              applied: ['type'],
              retained: ['rate'],
              score: {
                action: 'set',
                status: 'applied',
                vote: { units: 8, revision: 9, at: '2026-10-11T12:00:00Z' },
              },
            },
          ],
        },
      };
    },
    async inspect(command) {
      inspections.push(command);
      return {
        entry: { status: 'present', state: 'active', revision: 9 },
        vote: { status: 'current', vote: { state: 'set', units: 0, revision: 10, at: '2026-10-12T12:00:00Z' } },
      };
    },
  };
  const journey = createBangumiJourney({ port, visit: visit() });
  await journey.preview(envelope(1));
  await journey.review(0, subject, { action: 'set', units: 8 });
  journey.openConfirm();
  journey.confirmScore(0, true);
  const applied = await journey.confirm();
  expect(applied.outcomes[0]?.score?.status).toBe('applied');
  const inspected = await journey.inspectCurrent(0);
  expect(inspections).toEqual([{ subjectId: subject, questionId }]);
  expect(inspected.meta[0]?.entryReadback).toMatchObject({ status: 'present', revision: 9 });
  expect(inspected.meta[0]?.voteReadback).toMatchObject({
    status: 'current',
    vote: { state: 'set', units: 0, revision: 10 },
  });
  expect(inspected.cost.calls['entry-read']).toBe(1);
  expect(inspected.cost.calls['vote-read']).toBe(1);
  expect(inspected.outcomes[0]?.score?.vote?.units).toBe(8);
});

test('expired evidence retires score controls before a replacement upload', async () => {
  const base = recordingPort(1);
  let pages = 0;
  let previews = 0;
  const replacement = '0192f3a0-6c1e-7b2a-9d4e-00000000ffff';
  const port: BangumiImportPort = {
    ...base.port,
    async preview(command) {
      previews += 1;
      base.previews.push(command.upload);
      return { kind: 'previewed', uploadId: previews === 1 ? id : replacement, count: 1 };
    },
    async page(command) {
      pages += 1;
      if (pages === 2) return { kind: 'not-found' };
      if (command.uploadId === replacement)
        return {
          kind: 'page',
          page: pageOf([
            row(0, { evidence: { ...evidence(0), source: { subject_id: 1, subject: { name: 'Replacement' } } } }),
          ]),
        };
      return base.port.page(command);
    },
  };
  const journey = createBangumiJourney({ port, visit: visit() });
  await journey.preview(envelope(1));
  await journey.review(0, subject, { action: 'set', units: 8 });
  const removed = await journey.refresh();
  expect(removed.stage).toBe('removed');
  expect(removed.page).toEqual([]);
  expect(removed.meta).toEqual([]);
  const next = await journey.preview(envelope(1));
  expect(base.deletions).toEqual([]);
  expect(next.meta[0]?.title).toBe('Replacement');
  expect(next.meta[0]?.scoreReview).toBeNull();
});

test('replacement upload deletes the previous live native document', async () => {
  const { port, deletions } = recordingPort(1);
  const journey = createBangumiJourney({ port, visit: visit() });
  await journey.preview(envelope(1));
  await journey.preview(envelope(1));
  expect(deletions).toEqual([id]);
  expect(journey.snapshot().stage).toBe('review');
});

test('a changed account retires the upload and former-account callbacks', async () => {
  let pages = 0;
  const { port } = recordingPort(1);
  const wrapped: BangumiImportPort = {
    ...port,
    async page(command) {
      pages += 1;
      return port.page(command);
    },
  };
  await mount(wrapped, visit('alice', 'csrf-a'));
  const file = new File([envelope(1)], 'a.json', { type: 'application/json' });
  Object.defineProperty(host.querySelector('input[type="file"]') as HTMLInputElement, 'files', {
    configurable: true,
    value: [file],
  });
  await click(m.library_bangumi_upload());
  expect(host.textContent).toContain('Show 1');
  const seen = pages;
  await mount(wrapped, visit('bob', 'csrf-b'));
  expect(host.textContent).not.toContain('Show 1');
  expect(host.textContent).toContain(m.library_bangumi_upload());
  expect(pages).toBe(seen);
});

test('growth at 10, 50 and 100 rows stays within native page, apply and retained bounds', async () => {
  for (const total of [10, 50, 100]) {
    const { port, applies } = recordingPort(total);
    const journey = createBangumiJourney({ port, visit: visit() });
    await journey.preview(envelope(total));
    let snap = journey.snapshot();
    while (snap.next !== null) snap = await journey.nextPage();
    for (let ordinal = 0; ordinal < total; ordinal += 1) {
      snap = await journey.review(ordinal, ordinal === 0 ? subject : undefined);
      journey.choose(ordinal, { state: 'preserve', skip: false });
    }
    journey.openConfirm();
    snap = await journey.confirm();
    expect(snap.page.length).toBeLessThanOrEqual(BANGUMI_PAGE);
    expect(snap.meta.length).toBe(total);
    const cost = snap.cost;
    const pages = Math.ceil(total / BANGUMI_PAGE);
    const batches = Math.ceil(total / BANGUMI_APPLY);
    expect(cost.maxPageRows).toBeLessThanOrEqual(BANGUMI_PAGE);
    expect(cost.maxApplyRows).toBeLessThanOrEqual(BANGUMI_APPLY);
    expect(cost.pagesVisited).toBe(pages);
    expect(cost.reviewed).toBe(total);
    expect(cost.applyBatches).toBe(batches);
    expect(cost.calls.preview).toBe(1);
    expect(cost.uploadBytes).toBe(0);
    expect(cost.pageBytes).toBeGreaterThan(0);
    expect(bangumiCallTotal(cost)).toBe(
      expectedBangumiCalls({
        pages: cost.pagesVisited,
        reviews: cost.reviewed,
        applyBatches: cost.applyBatches,
        lifecycle: cost.calls.cancel + cost.calls.delete,
        retries: cost.retries,
      }),
    );
    expect(
      applies.every((command) => (command as { body: { rows: unknown[] } }).body.rows.length <= BANGUMI_APPLY),
    ).toBe(true);
    const discarded = await journey.discard();
    expect(discarded.stage).toBe('removed');
    expect(discarded.page).toEqual([]);
  }
});
