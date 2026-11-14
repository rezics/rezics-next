import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { OwnVotesDeparture, type OwnVotesDepartureRef } from '../src/ratings/own-votes/departure';
import type { ClassificationIntent } from '../src/ratings/own-classifications/intent';
import { m } from '../src/paraglide/messages.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnClassificationsWorkspace } from '../src/ratings/own-classifications/page';
import { classificationFrontier, indexOwnClassifications } from '../src/ratings/own-classifications/inventory';
import { classificationRow, classificationsPage, frontier, subjectId } from './own-classification-assessments-fixture';

test('a promoted selection is the supplied occurrence in native order with technical identity disclosed locally', () => {
  const rows = Array.from({ length: 21 }, (_, index) => {
    const row = classificationRow(index);
    if (row.state === 'available') row.target.label = `Concept ${index + 1}`;
    return row;
  });
  const promoted = rows.pop()!;
  rows.splice(7, 0, promoted);
  const page = classificationsPage(rows);
  const address = { cursor: 'raw', selected: { subjectId, associationId: promoted.associationId } };
  const html = renderToStaticMarkup(
    <OwnClassificationsWorkspace
      state="ready"
      page={page}
      frontier={address}
      locale="en"
      isCurrent={() => true}
      onRetry={async () => {}}
      onNext={() => {}}
      commands={{
        read: {
          state: 'ready',
          page,
          frontier: address,
          subject: page.viewer.accountId,
          locale: 'en',
          source: 'content.classification-ballot-own-page.v1',
          credential: 'ab'.repeat(32),
          observation: 'cd'.repeat(32),
        },
        csrfToken: () => 'csrf',
        send: async () => ({ kind: 'acknowledged' }),
        review: async () => ({ kind: 'unavailable' }),
      }}
    />,
  );
  const occurrences = [...html.matchAll(/<li\b[\s\S]*?<\/li>/g)].map(([item]) => item);
  expect(occurrences).toHaveLength(21);
  rows.forEach((row, index) => {
    if (row.state === 'available') expect(occurrences[index]).toContain(row.target.label!);
    expect(occurrences[index]!.includes('<section')).toBe(index === 7);
  });
  expect(occurrences[7]).toContain('aria-expanded="true"');
  expect(occurrences[7]).toContain(`<details>`);
  expect(occurrences[7]).not.toContain('<details open');
  for (const value of [subjectId, promoted.associationId, 'ab'.repeat(32), 'cd'.repeat(32), 'ef'.repeat(32)])
    expect(occurrences[7]).toContain(value);
  expect(html.match(/<fieldset/g)).toHaveLength(1);
});

test('native order, 20 raw slots plus one exact selected promotion, and concealed shape remain native', () => {
  for (const size of [1, 10, 20, 21]) {
    const rows = Array.from({ length: size }, (_, index) => classificationRow(index));
    const address = {
      ...frontier,
      selected: size === 21 ? { subjectId, associationId: rows[20]!.associationId } : null,
    };
    const page = classificationsPage(rows, ' raw +/=%opaque ');
    expect(indexOwnClassifications(page, address).size).toBe(size);
    expect([...indexOwnClassifications(page, address).values()]).toEqual(rows);
    if (size === 21) expect(() => indexOwnClassifications(page, frontier)).toThrow();
  }
  const row = classificationRow();
  const withheld = {
    ...row,
    state: 'withheld' as const,
    subject: null,
    target: null,
    association: null,
    aggregate: null,
    actions: { state: 'withdraw-only' as const, readback: null, set: null, clear: row.actions.clear },
  };
  expect(indexOwnClassifications(classificationsPage([withheld]), frontier).size).toBe(1);
  expect(() =>
    indexOwnClassifications(classificationsPage([{ ...withheld, subject: row.subject }]), frontier),
  ).toThrow();
  expect(() => indexOwnClassifications(classificationsPage([row, row]), frontier)).toThrow();
});

test('withheld rows disclose only own-state and never promise withdrawal before generated binding', () => {
  const row = classificationRow();
  const page = classificationsPage([
    {
      ...row,
      state: 'withheld',
      subject: null,
      target: null,
      association: null,
      aggregate: null,
      actions: { state: 'withdraw-only', readback: null, set: null, clear: row.actions.clear },
    },
  ]);
  const html = renderToStaticMarkup(
    <OwnClassificationsWorkspace
      state="ready"
      page={page}
      frontier={frontier}
      locale="en"
      isCurrent={() => true}
      onRetry={async () => {}}
      onNext={() => {}}
    />,
  );
  expect(html).toContain('Classification context withheld');
  expect(html).toContain('You support this association.');
  for (const concealed of ['Own-page subject', 'Own-page concept', subjectId, 'href=', '<button', 'supportCount'])
    expect(html).not.toContain(concealed);
  expect(classificationFrontier({ selectedSubjectId: subjectId })).toBeNull();
  expect(classificationFrontier({ cursor: '' })).toBeNull();
  expect(classificationFrontier({ cursor: 'x'.repeat(4097) })).toBeNull();
});

test('current summary destinations preserve original association keys and the serialized response stays bounded', () => {
  const row = classificationRow();
  if (row.state !== 'available') throw new Error('Expected disclosed fixture');
  const originalTarget = row.association.targetId;
  row.target = { ...row.target, id: subjectId, label: 'Current destination' };
  const page = classificationsPage([row]);
  expect([...indexOwnClassifications(page, frontier).values()][0]?.associationId).toBe(row.associationId);
  expect(row.association.targetId).toBe(originalTarget);
  row.subject.label = '界'.repeat(350_000);
  expect(() => indexOwnClassifications(page, frontier)).toThrow('Invalid classification frontier');
});

test('the closed native union rejects unknown and malformed private context before rendering any row', () => {
  const invalid: unknown[] = [null, [], { ...classificationsPage(), history: [] }];
  for (const [field, changes] of [
    ['viewer', { extra: 'concealed' }],
    ['inventory', { complete: true }],
    ['own', { pending: 'complete' }],
    ['subject', { label: 'x'.repeat(2001) }],
    ['target', { id: 'not-an-id' }],
    ['association', { qualifiersDigest: 'reconstruct-me' }],
    ['actions', { state: 'allowed' }],
    ['aggregate', { supportCount: 0 }],
  ] as const) {
    const page = classificationsPage();
    const row = page.items[0]!;
    const holder = field === 'viewer' || field === 'inventory' ? page : row;
    const record = holder as unknown as Record<string, object>;
    record[field] = { ...record[field], ...changes };
    invalid.push(page);
  }
  invalid.push(classificationsPage([{ ...classificationRow(), state: 'future' } as never]));
  for (const page of invalid) {
    expect(() => indexOwnClassifications(page, frontier)).toThrow();
    const html = renderToStaticMarkup(
      <OwnClassificationsWorkspace
        state="ready"
        page={page as never}
        frontier={frontier}
        locale="en"
        isCurrent={() => true}
        onRetry={async () => {}}
        onNext={() => {}}
      />,
    );
    expect(html).not.toContain('Own-page subject');
    expect(html).not.toContain('href=');
  }
});

test('native aggregate absence, suppression and published zero remain distinct and keep the original row', () => {
  const row = classificationRow();
  const zero = {
    associationId: row.associationId,
    state: 'published' as const,
    pending: 'unknown' as const,
    supportCount: 0,
    opposeCount: 0,
    falsePositiveCount: 0,
    supportFraction: null,
    asOf: '2026-11-04T00:00:00Z',
    generation: '1',
  };
  for (const aggregate of [null, row.aggregate, zero]) {
    const page = classificationsPage([{ ...row, aggregate }]);
    expect([...indexOwnClassifications(page, frontier).values()][0]).toBe(page.items[0]);
  }
  expect(() =>
    indexOwnClassifications(classificationsPage([{ ...row, aggregate: { ...zero, supportCount: -1 } }]), frontier),
  ).toThrow();
  expect(() =>
    indexOwnClassifications(
      classificationsPage([{ ...row, aggregate: { ...zero, associationId: subjectId } }]),
      frontier,
    ),
  ).toThrow();
});

test('the response cap counts UTF-8 bytes and admits the exact boundary', () => {
  const page = classificationsPage();
  const row = page.items[0]!;
  if (row.state !== 'available') throw new Error('Expected disclosed fixture');
  row.subject.label = '界';
  const bytes = new TextEncoder().encode(JSON.stringify(page)).length;
  page.inventory.generation = '1'.repeat(1_048_576 - bytes + 1);
  expect(indexOwnClassifications(page, frontier).size).toBe(1);
  page.inventory.generation += '1';
  expect(() => indexOwnClassifications(page, frontier)).toThrow('Invalid classification frontier');
});

test('coordinates bound branching, failed targets, direct later entry and selected-pair paths without page bodies', async () => {
  const { ClassificationWindows } = await import('../src/ratings/own-classifications/window-navigation');
  const windows = new ClassificationWindows();
  windows.admit({ ...frontier, cursor: 'direct' });
  expect(windows.previous({ ...frontier, cursor: 'direct' })).toBeNull();
  for (let index = 0; index < 12; index++) {
    const target = { ...frontier, cursor: `raw ${index}` };
    windows.stage(target, true);
    windows.admit(target);
  }
  expect(windows.path).toHaveLength(9);
  const accepted = [...windows.path];
  windows.stage({ ...frontier, cursor: 'failed' }, true);
  expect(windows.path).toEqual(accepted);
  expect(windows.staged?.cursor).toBe('failed');
  windows.admit({ ...frontier, cursor: 'failed' });
  const previous = windows.previous({ ...frontier, cursor: 'failed' })!;
  windows.stage({ ...frontier, ...previous }, false);
  windows.admit({ ...frontier, ...previous });
  expect(windows.path.at(-1)).toBe(previous.cursor);
  windows.stage({ ...frontier, cursor: 'branch' }, false);
  windows.admit({ ...frontier, cursor: 'branch' });
  expect(windows.path).not.toContain('failed');
  windows.admit({ cursor: 'branch', selected: { subjectId, associationId: classificationRow().associationId } });
  expect(windows.path).toEqual(['branch']);
  windows.retire();
  expect(windows.path).toEqual([]);
  expect(windows.staged).toBeNull();
});

test('local close/switch preserves the inventory; Stay keeps drafts and unknown intent; replacement retires review', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library/classification-assessments' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => (callback(0), 0),
    cancelAnimationFrame: () => {},
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const button = (scope: HTMLElement, label: string) => {
    const found = [...scope.querySelectorAll('button')].find((node) => node.textContent === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const makePage = () => classificationsPage([classificationRow(), classificationRow(1)]);
  const departure: OwnVotesDepartureRef = { current: null };
  const sent: ClassificationIntent[] = [];
  let retired = 0;
  let replace!: () => void;
  let decision: Promise<boolean> | undefined;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: createRootRoute({
      component: function Reading() {
        const [page, setPage] = useState(makePage);
        replace = () => setPage(makePage());
        return (
          <OwnClassificationsWorkspace
            state="ready"
            page={page}
            frontier={frontier}
            locale="en"
            isCurrent={() => true}
            onRetry={async () => {}}
            onNext={() => {}}
            commands={{
              read: {
                state: 'ready',
                page,
                frontier,
                subject: page.viewer.accountId,
                locale: 'en',
                source: 'content.classification-ballot-own-page.v1',
                credential: 'ab'.repeat(32),
                observation: 'cd'.repeat(32),
              },
              retire: () => {
                retired++;
              },
              confirmMovement: { current: (movement) => (decision = departure.current!.confirm(movement)) },
              departure: (dirty, locked, current, retire) => (
                <OwnVotesDeparture
                  owner={page}
                  dirty={dirty}
                  locked={locked}
                  isCurrent={current}
                  onLeave={retire}
                  confirmMovement={departure}
                />
              ),
              csrfToken: () => 'csrf',
              send: async (intent) => {
                sent.push(intent);
                return { kind: 'uncertain' };
              },
              review: async () => ({ kind: 'unavailable' }),
            }}
          />
        );
      },
    }),
  });
  const body = document.body;
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const openers = [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')];
    await act(async () => openers[0]!.click());
    const draft = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => draft.click());
    const close = button(host, m.own_classifications_close());
    close.focus();
    await act(async () => close.click());
    expect(body.querySelector('[role="alertdialog"]')).not.toBeNull();
    await act(async () => button(body, m.library_my_ratings_stay()).click());
    expect(document.activeElement).toBe(close);
    await act(async () => openers[1]!.click());
    await act(async () => button(body, m.library_my_ratings_stay()).click());
    expect(host.querySelector('input[type="checkbox"]')).toBe(draft);
    expect(draft.checked).toBe(false);
    expect(openers[0]!.getAttribute('aria-expanded')).toBe('true');
    await act(async () => openers[1]!.click());
    await act(async () => button(body, m.library_my_ratings_leave()).click());
    expect(host.querySelector('section')?.parentElement).toBe(openers[1]!.parentElement);
    expect(draft.isConnected).toBe(false);
    expect(retired).toBe(0);
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => button(host, m.own_classifications_close()).click());
    await act(async () => button(body, m.library_my_ratings_leave()).click());
    expect(host.querySelector('section')).toBeNull();
    expect(host.querySelectorAll('li')).toHaveLength(2);
    expect(retired).toBe(0);
    await act(async () => openers[1]!.click());
    await act(async () => button(host, m.subject_classification_assessment_withdraw()).click());
    await act(async () => button(host.querySelector('[role="group"]')!, m.library_my_ratings_confirm_clear()).click());
    await act(async () => button(host, m.own_classifications_close()).click());
    expect(body.querySelector('[role="alertdialog"]')?.textContent).toContain(m.library_my_ratings_departure_locked());
    expect([...body.querySelectorAll('button')].some((node) => node.textContent === m.library_my_ratings_leave())).toBe(
      false,
    );
    await act(async () => button(body, m.library_my_ratings_stay()).click());
    expect(host.querySelector('fieldset')?.disabled).toBe(true);
    await act(async () => button(host, m.subject_classification_assessment_retry()).click());
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(sent[0]?.csrfToken).toBe('csrf');
    await act(async () => button(host, m.own_classifications_close()).click());
    const pending = decision!;
    const retiredStay = button(body, m.library_my_ratings_stay());
    await act(async () => replace());
    expect(await pending).toBe(false);
    expect(body.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => button(host, m.subject_classification_assessment_inspect()).click());
    const replacement = host.querySelector('section');
    await act(async () => retiredStay.click());
    expect(host.querySelector('section')).toBe(replacement);
    expect(host.querySelector('fieldset')?.disabled).toBe(false);
    expect(retired).toBe(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    for (const [key, value] of previous)
      value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
    window.happyDOM.abort();
  }
});
