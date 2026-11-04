import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useMemo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import type { ConsolidationTransport, ReviewPage, SelectedAssignment } from '../src/library/label-consolidation/client';
import type { LabelShelfEntry } from '../src/library/label-shelf-read';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library', width: 390, height: 844 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
mock.module('@rezics/ui/shadcn/dialog', () => ({
  Dialog: Part,
  DialogContent: Part,
  DialogTitle: Part,
  DialogDescription: Part,
  DialogClose: Part,
  DialogHeader: Part,
  DialogFooter: Part,
  DialogTrigger: Part,
  DialogPortal: Part,
  DialogOverlay: Part,
}));
const { createRoot } = await import('react-dom/client');
const { ConsolidationWorkspace } = await import('../src/library/label-consolidation/workspace');
const { LabelShelfEntries } = await import('../src/library/shelf-view');
const { sessionQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { consolidationEnvelope } = await import('../src/library/label-consolidation/envelope');
const { usePrivateReportOrigin } = await import('../src/library/private-report-current-origin');
const { ConsolidationReview } = await import('../src/library/label-consolidation/review');
const { ConsolidationVisit } = await import('../src/library/label-consolidation/visit');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const selected = (n: number): SelectedAssignment => ({
  subjectId: `subject-${n}`,
  assignmentId: `assignment-${n}`,
  revision: 3,
});
const label = { id: 'source', name: 'Imported', revision: 1 };
const target = { id: 'target', name: 'Reading', revision: 2 };
const entries: LabelShelfEntry[] = Array.from({ length: 6 }, (_, n) => ({
  id: selected(n).assignmentId,
  subjectId: selected(n).subjectId,
  labelId: label.id,
  revision: 3,
  subject: {
    id: selected(n).subjectId,
    type: 'schema:Book',
    types: ['schema:Book'],
    typeLabel: 'Book',
    label: { value: `Work ${n}`, language: 'en' },
    cover: null,
  },
}));
function client() {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  value.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'owner', csrfToken: 'csrf' });
  const snapshot = viewerExposureLifetime(value).getSnapshot();
  if (snapshot.state !== 'signed-in') throw new Error('Missing test viewer');
  value.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
    subject: 'owner',
    admitted: ['personal_library', 'reading_progress', 'library_label.assignment_list', 'library_label.list'],
  });
  return value;
}
const host = window.document.createElement('div');
window.document.body.append(host);
const root = createRoot(host as unknown as HTMLDivElement);
const click = async (text: string) => {
  const button = Array.from(window.document.querySelectorAll('button')).find((node) => node.textContent === text);
  expect(button, text).toBeDefined();
  expect(button!.disabled, text).toBe(false);
  await act(async () => {
    button!.click();
  });
};

test('the real shelf selects exact visible assignments, reviews all pages, replays expiry operands and exposes native partial results and undo', async () => {
  const queryClient = client();
  const calls: unknown[][] = [];
  const refreshes: string[][] = [];
  let unknown = true;
  let expired = true;
  const transport: ConsolidationTransport = {
    review: async (body) => {
      calls.push(['review', structuredClone(body)]);
      const page: ReviewPage = {
        selection: 'digest',
        sourceLabel: label,
        targetLabel: target,
        items: body.items.slice(body.cursor ? 4 : 0, body.cursor ? 5 : 4).map((selected) => ({
          selected,
          source: { id: selected.assignmentId, revision: selected.revision, effective: true },
          target: null,
          outcome: 'movable',
        })),
        next: body.cursor ? null : 'next-review',
      };
      return { data: page, error: null };
    },
    confirm: async (...args) => {
      calls.push(['confirm', structuredClone(args)]);
      if (unknown) {
        unknown = false;
        throw new Error('lost acknowledgement');
      }
      return {
        data: { confirmationId: 'plan', status: 'active', expiresAt: '2030-01-01T00:00:00Z', itemCount: 5 },
        error: null,
      };
    },
    apply: async (...args) => {
      calls.push(['apply', structuredClone(args)]);
      if (expired) {
        expired = false;
        return { data: null, error: { status: 409, code: 'conflict' } };
      }
      return {
        data: {
          confirmationId: 'plan',
          sourceLabelId: 'source',
          targetLabelId: 'target',
          status: 'active',
          expiresAt: '2030-01-01T00:00:00Z',
          items: [
            {
              item: 0,
              selected: selected(0),
              status: 'moved',
              targetAssignment: { id: 'accepted-target', revision: 1 },
              sourceUnassignRevision: 4,
            },
            { item: 1, selected: selected(1), status: 'target_applied_source_retained' },
            { item: 2, selected: selected(2), status: 'processing' },
            { item: 3, status: 'inaccessible' },
            { item: 4, selected: selected(4), status: 'changed' },
          ],
        },
        error: null,
      };
    },
    retry: async () => {
      throw new Error('Not used');
    },
    cancel: async () => {
      throw new Error('Not used');
    },
    result: async () => {
      throw new Error('Not used');
    },
  };
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ConsolidationWorkspace
          page={{ state: 'loaded', label, entries, next: null, csrfToken: 'csrf' }}
          viewer="owner"
          locale="en"
          envelope={{
            capture: () => ({ headers: { 'x-csrf-token': 'csrf' }, isCurrent: () => true }),
            subscribeRetirement: () => () => {},
          }}
          isCurrent={() => true}
          transport={() => transport}
          refreshAssignments={(...ids) => refreshes.push(ids)}
          canUndo={() => true}
          csrfToken={() => 'csrf'}
          catalogue={async () => ({
            state: 'loaded',
            provenance: { viewer: 'owner', csrfToken: 'csrf', query: '' },
            labels: [label, target],
            next: null,
          })}
        >
          <LabelShelfEntries entries={entries} label={label} locale="en" layout="table" size="m" csrfToken="csrf" />
        </ConsolidationWorkspace>
      </QueryClientProvider>,
    ),
  );
  await click(m.library_consolidation_select());
  const boxes = Array.from(host.querySelectorAll('[role="checkbox"]'));
  expect(boxes).toHaveLength(6);
  for (const box of boxes.slice(0, 5))
    await act(async () => {
      (box as unknown as HTMLElement).click();
    });
  await click(m.library_consolidation_open());
  const form = window.document.querySelector('form')!;
  await act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  const radios = window.document.querySelectorAll('input[type="radio"]');
  expect(radios).toHaveLength(1);
  await act(async () => {
    (radios[0] as unknown as HTMLInputElement).click();
  });
  await click(m.library_consolidation_review());
  expect(calls[0]).toEqual([
    'review',
    { targetLabelId: 'target', items: Array.from({ length: 5 }, (_, n) => selected(n)), limit: 4 },
  ]);
  expect(
    Array.from(window.document.querySelectorAll('button')).find(
      (node) => node.textContent === m.library_consolidation_confirm(),
    )!.disabled,
  ).toBe(true);
  await click(m.library_consolidation_next_review());
  await click(m.library_consolidation_confirm());
  await click(m.library_consolidation_replay());
  expect(calls[2]).toEqual(calls[3]);
  await click(m.library_consolidation_apply());
  expect(refreshes).toEqual([]);
  await click(m.library_consolidation_replay());
  expect(calls[4]).toEqual(calls[5]);
  expect(refreshes).toEqual([['source', 'target']]);
  for (const state of ['moved', 'target_applied_source_retained', 'processing', 'inaccessible', 'changed']) {
    expect(window.document.querySelector(`[data-consolidation-result="${state}"]`)).not.toBeNull();
  }
  const undo = window.document.querySelector('input[name="intent"][value="restore"]')!.parentElement!;
  expect(undo.querySelector('input[name="assignmentId"]')!.getAttribute('value')).toBe('assignment-0');
  expect(undo.querySelector('input[name="revision"]')!.getAttribute('value')).toBe('4');
  expect(undo.querySelector('input[name="csrf_token"]')!.getAttribute('value')).toBe('csrf');
  await act(async () => root.render(<div />));
  queryClient.clear();
});

test('the concrete private-reader envelope synchronously retires A → B → A and reader replacement', async () => {
  for (const change of ['viewer', 'reader']) {
    const queryClient = client();
    const source = {};
    queryClient.setQueryData(['assignment-reader'], source);
    let bound: ReturnType<typeof consolidationEnvelope> | undefined;
    function Binding() {
      const { origin } = usePrivateReportOrigin('source', 'en', () => 'source');
      bound = useMemo(() => {
        const enrolled = origin.capture('personal_library', 'reading_progress', 'library_label.assignment_list');
        return consolidationEnvelope(
          origin,
          () => enrolled() && queryClient.getQueryData(['assignment-reader']) === source,
          (notify) => queryClient.getQueryCache().subscribe(notify),
        );
      }, [origin]);
      return null;
    }
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Binding />
        </QueryClientProvider>,
      ),
    );
    expect(bound!.capture('apply')).not.toBeNull();
    const visit = new ConsolidationVisit(
      new ConsolidationReview('source', 'target', [selected(0)]),
      bound!,
      () => {
        throw new Error('No dispatch');
      },
      () => {},
    );
    await act(async () => {
      if (change === 'viewer') {
        queryClient.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'other', csrfToken: 'other' });
        queryClient.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'owner', csrfToken: 'csrf' });
      } else queryClient.setQueryData(['assignment-reader'], { changed: true });
      expect(visit.isRetired).toBe(true);
      expect(visit.review.total).toBe(0);
    });
    await act(async () => root.render(<div />));
    queryClient.clear();
  }
});

test('all eight locales retain outcome distinctions and interpolate review operands', () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const) {
    setLocale(locale, { reload: false });
    expect(m.library_consolidation_destination({ name: 'Exact target' })).toContain('Exact target');
    expect(m.library_consolidation_reviewed({ count: 4, total: 5 })).toContain('4');
    expect(m.library_consolidation_moved()).not.toBe(m.library_consolidation_source_retained());
    expect(m.library_consolidation_changed()).not.toBe(m.library_consolidation_capacity());
  }
  setLocale('en', { reload: false });
});
afterAll(async () => {
  await act(async () => root.unmount());
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});
