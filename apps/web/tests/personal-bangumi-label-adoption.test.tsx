import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type {
  BangumiCommand,
  BangumiImportPort,
  BangumiLabelPanelState,
  BangumiLabelReviewResult,
  BangumiLabelState,
  BangumiPage,
  BangumiReview,
  BangumiRow,
  BangumiTagPageResult,
} from '../src/library/personal-bangumi-import/contract';
import { BangumiLabelAdoption } from '../src/library/personal-bangumi-import/labels';
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
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { m } = await import('../src/paraglide/messages.js');
const { BangumiImportPortContext } = await import('../src/library/personal-bangumi-import/port');
const { PersonalBangumiImportPage } = await import('../src/library/personal-bangumi-import/page');
const uploadId = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const rowRevision = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const labelId = '0192f3a0-6c1e-7b2a-9d4e-00000000cccc';
const reviewToken = '0192f3a0-6c1e-7b2a-9d4e-00000000dddd';
const assignmentId = '0192f3a0-6c1e-7b2a-9d4e-00000000eeee';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-00000000ffff';
const custody = { viewer: 'alice', csrfToken: 'csrf-a', credential: 'encrypted-custody' };

function visit(): BangumiVisit {
  const controller = new AbortController();
  let retired = false;
  return {
    identity: 1,
    subject: 'alice',
    csrfToken: 'csrf-a',
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
}

function page(
  ordinal: number,
  evidence: 'missing' | 'empty' | 'known' | 'invalid' | 'unknown',
  after = -1,
): NonNullable<Extract<BangumiTagPageResult, { kind: 'tags' }>['page']> {
  const all = Array.from({ length: 33 }, (_, index) => ({
    index,
    value: index === 0 ? 'cafe\u0301' : `tag-${index}`,
    status: evidence === 'known' ? ('supported' as const) : ('invalid' as const),
    proposedName: evidence === 'known' ? (index === 0 ? 'café' : `tag-${index}`) : null,
  }));
  const start = after + 1;
  const tags =
    ordinal === 0 && evidence === 'known' ? all.slice(start, start + 32) : evidence === 'invalid' ? [all[0]!] : [];
  return {
    ordinal,
    rowRevision,
    evidence,
    tags,
    next: ordinal === 0 && evidence === 'known' && start + tags.length < all.length ? start + tags.length - 1 : null,
    labels: null,
  };
}

function createPort(
  options: { evidence?: 'missing' | 'empty' | 'known' | 'invalid' | 'unknown'; uncertainApply?: boolean } = {},
) {
  const tagCommands: Extract<BangumiCommand, { kind: 'tags' }>[] = [];
  const reviewCommands: Extract<BangumiCommand, { kind: 'review-labels' }>[] = [];
  const applyCommands: Extract<BangumiCommand, { kind: 'apply-labels' }>[] = [];
  const assignments: string[] = [];
  let firstApply = options.uncertainApply === true;
  let savedLabels: BangumiLabelState | null = null;
  const port: BangumiImportPort = {
    async preview() {
      return { kind: 'unavailable' };
    },
    async page() {
      return { kind: 'unavailable' };
    },
    async review() {
      return { kind: 'unavailable' };
    },
    async apply() {
      return { kind: 'unavailable' };
    },
    async admitSource() {
      return { kind: 'admitted' };
    },
    async cancel() {
      return { kind: 'cancelled', uploadId };
    },
    async delete() {
      return { kind: 'deleted' };
    },
    async tags(command) {
      tagCommands.push(command);
      return {
        kind: 'tags',
        page: { ...page(command.ordinal, options.evidence ?? 'known', command.after), labels: savedLabels },
        custody: command.custody ?? custody,
      };
    },
    async searchLabels() {
      return { kind: 'label-options', labels: [{ id: labelId, name: 'café', revision: 3 }] };
    },
    async reviewLabels(command): Promise<BangumiLabelReviewResult> {
      reviewCommands.push(command);
      const seen = new Set<number>();
      savedLabels = {
        review: {
          token: reviewToken,
          rowRevision: command.rowRevision,
          subject: {
            subjectId,
            identityEpoch: '8',
            acceptingType: 'ex:Game',
            releaseDigest: 'a'.repeat(64),
          },
          evidence: 'known',
          items: command.mappings.map((mapping) => {
            const duplicate = seen.has(mapping.index);
            seen.add(mapping.index);
            const tag = page(command.ordinal, 'known').tags.find((item) => item.index === mapping.index)!;
            return {
              index: mapping.index,
              source: tag.value,
              status: duplicate ? ('duplicate' as const) : ('ready' as const),
              duplicateOf: null,
              target: 'labelId' in mapping.target ? { labelId: mapping.target.labelId, revision: 3 } : mapping.target,
            };
          }),
        },
        confirmed: false,
        outcomes: [],
      };
      return {
        kind: 'labels-reviewed',
        ordinal: command.ordinal,
        labels: savedLabels,
      };
    },
    async applyLabels(command) {
      applyCommands.push(command);
      if (firstApply) {
        firstApply = false;
        return { kind: 'unknown', command };
      }
      savedLabels = {
        ...savedLabels!,
        confirmed: true,
        outcomes: [
          {
            index: 0,
            status: 'assigned',
            label: { id: labelId, revision: 4 },
            assignment: { id: assignmentId, revision: 2 },
            created: false,
          },
        ],
      };
      return {
        kind: 'labels-applied',
        result: {
          uploadId,
          ordinal: command.ordinal,
          outcomes: [
            {
              index: 0,
              status: 'assigned',
              label: { id: labelId, revision: 4 },
              assignment: { id: assignmentId, revision: 2 },
              created: false,
            },
          ],
          remaining: [],
        },
      };
    },
    async readAssignments(subjectId) {
      assignments.push(subjectId);
      return {
        kind: 'assignments',
        subjectId,
        assignments: [{ id: assignmentId, labelId, name: 'café', revision: 2 }],
      };
    },
  };
  return { port, tagCommands, reviewCommands, applyCommands, assignments };
}

function createProductionJourneyPort() {
  const fixture = createPort();
  let subjectReview: BangumiReview | null = null;
  const sourceRow: BangumiRow = {
    ordinal: 0,
    evidence: {
      source: { subject_id: 7, subject_type: 4, tags: ['cafe\u0301'] },
      fields: [{ field: 'tags', value: ['cafe\u0301'], meaning: 'known', reason: 'Retained source field' }],
      medium: 'game',
      stateRole: null,
    },
    review: null,
    outcome: null,
  };
  const port: BangumiImportPort = {
    ...fixture.port,
    async preview() {
      return { kind: 'previewed', uploadId, count: 1 };
    },
    async page(): Promise<{ kind: 'page'; page: BangumiPage }> {
      return {
        kind: 'page',
        page: { uploadId, cancelled: false, rows: [{ ...sourceRow, review: subjectReview }], next: null },
      };
    },
    async review(command) {
      subjectReview = {
        token: rowRevision,
        match: 'chosen',
        candidates: [subjectId],
        target: command.target ?? subjectId,
        guard: null,
        proposedState: null,
        current: null,
        conflict: false,
      };
      return { kind: 'reviewed', ordinal: command.ordinal, review: subjectReview };
    },
  };
  return { ...fixture, port };
}

function Example({ port, ordinal = 0 }: { port: BangumiImportPort; ordinal?: number }) {
  const [panel, setPanel] = useState<BangumiLabelPanelState>();
  return (
    <BangumiLabelAdoption
      uploadId={uploadId}
      ordinal={ordinal}
      rowRevision={rowRevision}
      port={port}
      visit={visitInstance}
      panel={panel}
      onChange={(update) => setPanel((previous) => update(previous))}
      disabled={false}
    />
  );
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let visitInstance: BangumiVisit;

async function mount(port: BangumiImportPort, ordinal = 0) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  visitInstance = visit();
  await act(async () => root.render(<Example port={port} ordinal={ordinal} />));
  const disclosure = host.querySelector('details');
  if (disclosure) disclosure.open = true;
}

async function mountProductionPage(port: BangumiImportPort, width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  window.dispatchEvent(new window.Event('resize'));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const app = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <BangumiImportPortContext.Provider value={port}>
          <Outlet />
        </BangumiImportPortContext.Provider>
      </QueryClientProvider>
    ),
  });
  const importRoute = createRoute({
    getParentRoute: () => app,
    path: '/en/library/import-bangumi',
    component: () => <PersonalBangumiImportPage visit={visitInstance} />,
  });
  const libraryRoute = createRoute({ getParentRoute: () => app, path: '/en/library', component: () => <p>Library</p> });
  const router = createRouter({
    routeTree: app.addChildren([importRoute, libraryRoute]),
    history: createMemoryHistory({ initialEntries: ['/en/library/import-bangumi'] }),
  });
  visitInstance = visit();
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  await settle();
  return router;
}

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
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

async function clickDialog(label: string) {
  const target = [...document.body.querySelectorAll('button')].find((item) => item.textContent === label);
  expect(target).toBeDefined();
  await act(async () => {
    target!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

test('pages retained tags, resolves a live-name collision by explicit ID, retries exact custody and reads current assignments', async () => {
  const fixture = createPort({ uncertainApply: true });
  await mount(fixture.port);
  await click(m.library_bangumi_label_load_tags());
  expect(host.textContent).toContain(m.library_bangumi_label_evidence_known());
  await click(m.library_bangumi_label_next_page());
  expect(fixture.tagCommands.map((command) => command.after)).toEqual([-1, 31]);
  expect(host.textContent).toContain(m.library_bangumi_label_tag_index({ index: 32 }));
  await click(m.library_bangumi_label_previous_page());
  const query = host.querySelector<HTMLInputElement>('#bangumi-label-query-0-0')!;
  expect(query.value).toBe('café');
  await click(m.library_bangumi_label_search_owned());
  await click(m.library_bangumi_label_use_existing({ name: 'café', revision: 3 }));
  await click(m.library_bangumi_label_review_mapping());
  expect(fixture.reviewCommands[0]).toMatchObject({
    ordinal: 0,
    rowRevision,
    mappings: [{ index: 0, target: { labelId } }],
    custody,
  });
  expect(host.textContent).toContain(m.library_bangumi_label_review_existing({ id: labelId, revision: 3 }));
  expect(host.textContent).toContain('cafe\u0301');
  await click(m.library_bangumi_label_confirm_exact());
  expect(host.textContent).toContain(m.library_bangumi_label_retry_original());
  await click(m.library_bangumi_label_retry_original());
  expect(fixture.applyCommands).toHaveLength(2);
  expect(fixture.applyCommands[0]).toEqual(fixture.applyCommands[1]);
  expect(fixture.applyCommands[0]).toMatchObject({ reviewToken, custody });
  expect(fixture.assignments).toEqual([subjectId]);
  expect(host.textContent).toContain(m.library_bangumi_label_outcome_assigned());
  expect(host.textContent).toContain(m.library_bangumi_label_identity({ id: labelId, revision: 4 }));
  expect(host.textContent).toContain(m.library_bangumi_label_assignment_identity({ id: assignmentId, revision: 2 }));
  expect(host.textContent).toContain('café');
});

test('distinguishes missing, empty and mixed-invalid evidence without adopting a string subset', async () => {
  for (const [ordinal, evidence, expected] of [
    [0, 'missing', m.library_bangumi_label_evidence_missing()],
    [1, 'empty', m.library_bangumi_label_evidence_empty()],
    [2, 'invalid', m.library_bangumi_label_evidence_invalid()],
  ] as const) {
    const fixture = createPort({ evidence });
    await mount(fixture.port, ordinal);
    await click(m.library_bangumi_label_load_tags());
    expect(host.textContent).toContain(expected);
    if (evidence === 'invalid') {
      expect(host.textContent).toContain(m.library_bangumi_label_tag_invalid());
      expect(button(m.library_bangumi_label_search_owned())).toBeUndefined();
    }
    await act(async () => root.unmount());
    host.remove();
  }
});

test('the mounted importer keeps review, native result, assignments and departure usable at 390px and 1280px', async () => {
  for (const width of [390, 1280]) {
    const fixture = createProductionJourneyPort();
    const router = await mountProductionPage(fixture.port, width);
    expect(host.querySelector('main')?.className).toContain('max-w-3xl');
    expect(host.querySelector('[data-bangumi-stage="review"]')).toBeNull();
    const file = new File(['retained upload'], 'collection.json', { type: 'application/json' });
    Object.defineProperty(host.querySelector('input[type="file"]') as HTMLInputElement, 'files', {
      configurable: true,
      value: [file],
    });
    await click(m.library_bangumi_upload());
    expect(host.querySelector('[data-bangumi-stage="review"]')).not.toBeNull();

    const target = host.querySelector<HTMLInputElement>('[data-bangumi-target]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(target, subjectId);
      target.dispatchEvent(new window.Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await click(m.library_bangumi_save_review());
    expect(button(m.library_bangumi_label_load_tags())).toBeDefined();
    const panel = host.querySelector<HTMLDetailsElement>('[data-bangumi-labels]')!;
    panel.open = true;
    await click(m.library_bangumi_label_load_tags());
    expect(host.textContent).toContain('cafe\u0301');
    await click(m.library_bangumi_label_use_new_name({ name: 'café' }));
    await click(m.library_bangumi_label_review_mapping());
    expect(host.textContent).toContain(m.library_bangumi_label_exact_review());
    await click(m.library_bangumi_label_confirm_exact());
    expect(host.textContent).toContain(m.library_bangumi_label_outcome_assigned());
    expect(host.textContent).toContain(m.library_bangumi_label_identity({ id: labelId, revision: 4 }));
    expect(host.textContent).toContain(m.library_bangumi_label_assignment_identity({ id: assignmentId, revision: 2 }));
    expect(host.textContent).toContain('café');
    expect(fixture.assignments).toEqual([subjectId]);

    await act(async () => {
      void router.navigate({ to: '/en/library' });
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    await settle();
    expect(document.body.textContent).toContain(m.library_bangumi_leave_title());
    expect(document.body.textContent).toContain(m.library_bangumi_leave_help());
    await clickDialog(m.library_bangumi_stay());
    expect(host.querySelector('[data-bangumi-stage="review"]')).not.toBeNull();

    await act(async () => root.unmount());
    host.remove();
  }
});
