import { afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/import-mal' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MalRowReview } = await import('../src/library/personal-mal-import/row');
const { MalConfirmPage } = await import('../src/library/personal-mal-import/confirm');
const { MalResultPage } = await import('../src/library/personal-mal-import/results');
const { MalImportPortContext } = await import('../src/library/personal-mal-import/port');
const { labelReviewRow: row } = await import('../src/library/personal-mal-import/labels.fixture');
const { admittedFields } = await import('../src/library/personal-mal-import/meaning');
const { m } = await import('../src/paraglide/messages.js');
import type { MalImportPort } from '../src/library/personal-mal-import/contract';
const host = document.createElement('div');
document.body.append(host);
let root = createRoot(host);
afterEach(async () => {
  await act(() => root.unmount());
  host.replaceChildren();
  root = createRoot(host);
});

test('native evidence indices and reviewed identities survive explicit selection without parsing display tags', async () => {
  let saved: import('../src/library/personal-mal-import/row').RowDraft | undefined;
  await act(() =>
    root.render(
      <MalRowReview
        row={row}
        busy={false}
        onSave={(draft) => {
          saved = draft;
        }}
      />,
    ),
  );
  expect(host.textContent).toContain(' A & B,second,A & B');
  expect(host.textContent).toContain('Duplicate of source index 0');
  expect(host.querySelectorAll('input[type=checkbox]:checked').length).toBeGreaterThanOrEqual(3);
  const save = [...host.querySelectorAll('button')].find((b) => b.textContent === m.library_mal_save_review())!;
  await act(() => save.click());
  expect(saved?.labels).toEqual(row.review!.labels!.selections.map((s) => ({ value: s.value, target: s.target! })));
  const statusLabel = [...host.querySelectorAll('label')].find(
    (label) => label.textContent === m.library_mal_select_status(),
  )!;
  await act(async () => {
    statusLabel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await act(() => save.click());
  expect(saved?.fields).toEqual(['tags']);
  expect(admittedFields(row)).toEqual(['status', 'tags']);
  expect(admittedFields({ ...row, selectedFields: ['tags'] })).toEqual(['tags']);
  expect(admittedFields({ ...row, review: (({ labels, ...review }) => review)(row.review!) })).toEqual(['status']);
  expect(admittedFields({ ...row, review: { ...row.review!, skip: true } })).toEqual([]);
});

test('confirmation shows exact native version and normalized target; unsupported evidence remains visible', async () => {
  await act(() =>
    root.render(
      <MalConfirmPage
        rows={[row]}
        busy={false}
        confirmPrivacy
        confirmTimestamps
        onBack={() => {}}
        onConfirm={() => {}}
        onConfirmSource={() => {}}
      />,
    ),
  );
  expect(host.textContent).toContain('review-version-2');
  expect(host.textContent).toContain('MAL Café');
  expect(host.textContent).toContain('duplicate');
  await act(() =>
    root.render(
      <MalRowReview
        row={{
          ...row,
          review: null,
          tagEvidence: {
            grammar: 'mal-comma-v1',
            kind: 'unsupported',
            raw: 'a,"b,c"',
            values: [],
            reason: 'ambiguous-quoting-or-escaping',
          },
        }}
        busy={false}
        onSave={() => {}}
      />,
    ),
  );
  expect(host.textContent).toContain('a,"b,c"');
  expect(host.textContent).toContain('ambiguous-quoting-or-escaping');
  expect(host.querySelector('select')).toBeNull();
});

test('partial receipt results read current exact Subject assignments independently and ignore departed read', async () => {
  const reads: string[] = [];
  const assignment = { id: 'native-assignment', labelId: 'native-label', subjectId: row.target!, revision: 2 };
  const unavailable = async () => ({ kind: 'unavailable' as const });
  const port: MalImportPort = {
    preview: unavailable,
    page: unavailable,
    review: unavailable,
    apply: unavailable,
    admitSource: unavailable,
    cancel: unavailable,
    delete: unavailable,
    assignments: async (subjectId: string) => {
      reads.push(subjectId);
      return { kind: 'assignments' as const, assignments: [assignment] };
    },
  };
  await act(async () =>
    root.render(
      <MalImportPortContext.Provider value={port}>
        <MalResultPage
          rows={[row]}
          result={{
            id: 'upload',
            stopped: true,
            remaining: [0],
            outcomes: [
              {
                row: 0,
                status: 'applied',
                applied: ['tags'],
                retained: [],
                reason: null,
                labels: [
                  {
                    value: 0,
                    status: 'accepted',
                    labelId: 'native-label',
                    assignment: { id: 'receipt-assignment', revision: 1 },
                    reason: null,
                  },
                ],
                remainingLabels: [1, 2],
              },
            ],
          }}
          titles={new Map([[0, row.title]])}
          admissions={new Map()}
          busy={false}
          canRetry
          onRetry={() => {}}
          onReview={() => {}}
          onRefresh={() => {}}
        />
      </MalImportPortContext.Provider>,
    ),
  );
  expect(reads).toEqual([row.target!]);
  expect(host.textContent).toContain('receipt-assignment');
  expect(host.textContent).toContain('native-assignment');
  expect(host.textContent).toContain('Remaining source indices: 1, 2');
  await act(() => root.render(<p>Departed</p>));
  expect(host.textContent).toBe('Departed');
});
