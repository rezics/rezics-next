import { afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type {
  AniListImportPort,
  AniListRow,
  AniListLabelReview,
} from '../src/library/personal-anilist-import/contract';
import { createAniListJourney } from '../src/library/personal-anilist-import/controller';
import type { AniListVisit } from '../src/library/personal-anilist-import/visit';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/import-anilist' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  Event: window.Event,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: window.scrollTo.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { AniListLabelAdoption } = await import('../src/library/personal-anilist-import/labels');
const { m } = await import('../src/paraglide/messages.js');
const subject = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const id = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const reviewId = '0192f3a0-6c1e-7b2a-9d4e-00000000cccc';
const labelId = '0192f3a0-6c1e-7b2a-9d4e-00000000dddd';
function fixture(unknown = false) {
  const visit: AniListVisit = {
    subject: 'alice',
    csrfToken: 'csrf-1',
    controller: new AbortController(),
    current() {
      return !this.controller.signal.aborted;
    },
    retire() {
      this.controller.abort();
    },
  };
  const row: AniListRow = {
    ordinal: 0,
    source: {
      evidence: { title: 'Retained', customLists: { ' E\u0301  Private ': true, False: false } },
      group: { name: 'Existing', isCustomList: true },
      identifiers: [],
      fields: [],
    },
    match: { state: 'matched', candidates: [subject], fingerprint: 'match' },
    proposal: { subjectId: subject, epoch: '1', pin: null, states: [], current: null, proposedState: null },
    review: null,
    started: true,
    outcome: { ordinal: 0, status: 'applied', retained: ['score'] },
    labelEvidence: {
      membership: 'available',
      grouping: 'custom',
      values: [
        { key: 'customLists: E\u0301  Private ', value: ' E\u0301  Private ', member: true, origin: 'customLists' },
        { key: 'customLists:False', value: 'False', member: false, origin: 'customLists' },
        { key: 'group:name', value: 'Existing', member: true, origin: 'customContainer' },
      ],
      selectable: [
        { key: 'customLists: E\u0301  Private ', value: ' E\u0301  Private ', member: true, origin: 'customLists' },
        { key: 'group:name', value: 'Existing', member: true, origin: 'customContainer' },
      ],
      tagEvidence: { entry: 'unsupported', media: 'missing', membership: 'unavailable' },
      tags: 'unsupported',
      reason: 'Native retained evidence',
    },
  };
  const commands: unknown[] = [];
  let attempts = 0;
  const port: AniListImportPort = {
    async preview() {
      throw new Error('No second upload');
    },
    async review() {
      throw new Error('No state review');
    },
    async apply() {
      throw new Error('No state/score effect');
    },
    async admitSource() {
      throw new Error('No source effect');
    },
    async question() {
      return { kind: 'unavailable' };
    },
    async cancel() {
      return { kind: 'cancelled', removed: false };
    },
    async page() {
      return {
        kind: 'page',
        page: {
          importId: id,
          header: { count: 1, document: null, rawUpload: '', scoreFormat: null, cancelled: false },
          completeness: { wrapper: 'array', hasNextChunk: false, listedGroups: 1 },
          rows: [row],
          next: null,
        },
      };
    },
    async labelTargets() {
      return { kind: 'label-targets', labels: [{ id: labelId, name: 'Existing', revision: 1 }], next: null };
    },
    async reviewLabels(command) {
      commands.push(structuredClone(command));
      const review: AniListLabelReview = {
        id: reviewId,
        subjectId: subject,
        identityEpoch: '1',
        sourceDigest: 'digest',
        matchFingerprint: 'match',
        clientId: 'client',
        requestedBy: null,
        items: command.body.selections.map((item, index) => ({
          key: item.key,
          value: row.labelEvidence!.selectable.find((value) => value.key === item.key)!.value,
          origin: index ? 'customContainer' : 'customLists',
          createKey: 'create-' + index,
          assignKey: 'assign-' + index,
          target:
            'name' in item.target
              ? { name: 'É Private', primary: 0 }
              : { label: { id: item.target.labelId, revision: 1 } },
        })),
      };
      row.labelReview = review;
      return { kind: 'labels-reviewed', ordinal: 0, review };
    },
    async applyLabels(command) {
      command.custody.sender ??= 'encrypted-original-sender';
      commands.push(structuredClone(command));
      if (unknown && attempts++ === 0) return { kind: 'unknown', command };
      return {
        kind: 'labels-applied',
        result: {
          complete: unknown,
          outcomes: [
            {
              ordinal: 0,
              reviewId,
              complete: unknown,
              items: [
                {
                  key: command.body.confirmations[0]!.reviewId,
                  status: unknown ? 'applied' : 'pending',
                  ...(unknown ? { assignment: { id: 'native-assignment', revision: 1 } } : {}),
                  label: { id: labelId, revision: 1 },
                },
              ],
            },
          ],
        },
      };
    },
    async readLabels() {
      return { kind: 'labels-read', labels: [] };
    },
  };
  const journey = createAniListJourney({ port, visit });
  return { row, commands, port, journey, visit };
}
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  host?.remove();
});
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((button) => button.textContent === text)!;
  expect(button).toBeDefined();
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

test('production label controls preserve positive source evidence, normalized native review, exact confirmation and incomplete creation at 390/1280', async () => {
  const f = fixture();
  await f.journey.loadPage(id, -1);
  function Harness() {
    const [snap, setSnap] = useState(f.journey.snapshot());
    return (
      <AniListLabelAdoption
        row={snap.page[0]!}
        meta={snap.meta[0]!}
        busy={false}
        cancelled={false}
        current={f.journey.live}
        onChoose={(target, selections) => setSnap(f.journey.chooseLabels(0, target, selections))}
        onReview={() => void f.journey.reviewLabels(0).then(setSnap)}
        onConfirm={() => void f.journey.confirmLabels(0).then(setSnap)}
        onRead={() => void f.journey.readLabels(0).then(setSnap)}
        onSearch={f.port.labelTargets}
      />
    );
  }
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const routeTree = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/en/library/import-anilist'] }),
  });
  await router.load();
  await act(() => root!.render(<RouterProvider router={router} />));
  for (const width of [390, 1280]) {
    host.style.width = width + 'px';
    expect(host.querySelectorAll('[data-anilist-label-key]')).toHaveLength(3);
    expect(host.querySelector('[data-anilist-label-key="customLists:False"] input')).toBeNull();
    expect(host.querySelector('[data-anilist-label-key="customLists:False"] button')).toBeNull();
  }
  const checks = host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
  expect(checks).toHaveLength(2);
  await act(() => checks[0]!.click());
  await click(m.library_anilist_labels_review());
  expect(host.textContent).toContain('É Private');
  expect(host.querySelector('[data-anilist-label-review]')!.textContent).toContain(' E\u0301  Private ');
  await click(m.library_anilist_labels_confirm());
  expect(f.commands.at(-1)).toMatchObject({
    kind: 'apply-labels',
    body: { confirmations: [{ ordinal: 0, reviewId }] },
  });
  expect(host.textContent).toContain(m.library_anilist_labels_incomplete());
  expect(host.querySelector('[data-anilist-label-outcome="pending"]')).not.toBeNull();
  expect(host.querySelector('[data-anilist-label-results]')!.textContent).not.toContain(
    m.library_anilist_labels_assignment(),
  );
});

test('unknown delivery retains original sender and review; reads cannot release it, retirement prevents late effects, refresh and new choices retire unstarted confirmation independently', async () => {
  const f = fixture(true);
  await f.journey.loadPage(id, -1);
  f.journey.chooseLabels(0, subject, [
    { key: 'customLists: E\u0301  Private ', target: { name: ' E\u0301  Private ' } },
  ]);
  await f.journey.reviewLabels(0);
  await f.journey.confirmLabels(0);
  expect(f.journey.snapshot().notice?.kind).toBe('unknown');
  await f.journey.readLabels(0);
  expect(f.journey.snapshot().notice?.kind).toBe('unknown');
  await f.journey.retryUnknown();
  expect(f.commands.at(-1)).toEqual(f.commands.at(-2));
  expect(f.journey.snapshot().meta[0]!.outcome?.status).toBe('applied');
  f.journey.chooseLabels(0, subject, [{ key: 'group:name', target: { labelId } }]);
  expect(f.journey.snapshot().meta[0]!.labels!.review).toBeNull();
  await f.journey.reviewLabels(0);
  await f.journey.refresh();
  expect(f.journey.snapshot().meta[0]!.labels!.review).toBeNull();
  const before = f.commands.length;
  await f.journey.confirmLabels(0);
  expect(f.commands).toHaveLength(before);
  f.visit.retire();
  expect((await f.journey.labelTargets('late callback')).kind).toBe('unavailable');
  await f.journey.reviewLabels(0);
  await f.journey.confirmLabels(0);
  expect(f.commands).toHaveLength(before);
});

test('source cancellation prevents confirmation of a retained partial creation without deleting its identity', async () => {
  const f = fixture();
  await f.journey.loadPage(id, -1);
  f.journey.chooseLabels(0, subject, [{ key: 'group:name', target: { name: 'Private' } }]);
  await f.journey.reviewLabels(0);
  await f.journey.confirmLabels(0);
  const work = f.journey.snapshot().page[0]!.labelWork;
  await f.journey.cancelAdmission();
  const before = f.commands.length;
  await f.journey.confirmLabels(0);
  expect(f.commands).toHaveLength(before);
  expect(f.journey.snapshot().page[0]!.labelWork).toEqual(work);
});

test('departure before an unknown acknowledgement retains original label custody while retiring callbacks', async () => {
  const f = fixture();
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  let original: Parameters<AniListImportPort['applyLabels']>[0];
  f.port.applyLabels = async (command) => {
    command.custody.sender = 'encrypted-original-sender';
    original = command;
    await response;
    return { kind: 'unknown', command };
  };
  await f.journey.loadPage(id, -1);
  f.journey.chooseLabels(0, subject, [{ key: 'group:name', target: { name: 'Private' } }]);
  await f.journey.reviewLabels(0);
  const inFlight = f.journey.confirmLabels(0);
  expect(f.journey.snapshot().busy).toBe(true);
  f.visit.retire();
  release();
  await inFlight;
  expect(f.journey.snapshot().notice).toEqual({ kind: 'unknown', command: original! });
  await f.journey.retryUnknown();
  expect(f.journey.live()).toBe(false);
});
