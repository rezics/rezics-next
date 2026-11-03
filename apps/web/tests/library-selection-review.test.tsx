import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { shelfSelectionLimit } from '../src/library/shelf-selection';
import {
  appendSelectionWithinLimit,
  groupSelectionResults,
  selectionResultStates,
  selectionReviewSignature,
  type SelectionResultItem,
} from '../src/library/selection-review';
import { SelectionResultView } from '../src/library/selection-result-view';
import { SelectionReviewView } from '../src/library/selection-review-view';
import { m } from '../src/paraglide/messages.js';

test('selection review stays ordered and refuses additions beyond each bounded selection size', () => {
  for (const count of [1, 20, shelfSelectionLimit]) {
    let selected: readonly string[] = [];
    for (let index = 0; index < count; index++) {
      const addition = appendSelectionWithinLimit(selected, `subject-${index}`, count);
      expect(addition.overflow).toBe(false);
      selected = addition.selected;
    }
    expect(selected).toHaveLength(count);
    expect(appendSelectionWithinLimit(selected, 'overflow', count)).toEqual({ selected, overflow: true });
  }
  expect(appendSelectionWithinLimit([], 'first', shelfSelectionLimit)).toEqual({
    selected: ['first'],
    overflow: false,
  });
});

test('review identity changes with current entry state and command identity', () => {
  const entry = {
    subjectId: 'subject-1',
    revision: 1,
    incarnationId: 'incarnation-1',
    changeKey: 'change-1',
    removeKey: 'remove-1',
    state: 'planned',
  };
  const signature = selectionReviewSignature([entry]);
  expect(selectionReviewSignature([{ ...entry, revision: 2 }])).not.toBe(signature);
  expect(selectionReviewSignature([{ ...entry, incarnationId: 'incarnation-2' }])).not.toBe(signature);
  expect(selectionReviewSignature([{ ...entry, removeKey: 'remove-2' }])).not.toBe(signature);
  expect(selectionReviewSignature([{ ...entry, state: 'finished' }])).not.toBe(signature);
});

test('result inspectors keep every supplied outcome in its own bounded group', () => {
  const results: SelectionResultItem[] = selectionResultStates.map((state) => ({
    key: state,
    subjectId: `subject-${state}`,
    title: `Work ${state}`,
    state,
  }));
  const groups = groupSelectionResults(results);
  expect(Object.values(groups).map((items) => items.length)).toEqual(selectionResultStates.map(() => 1));
  const html = renderToStaticMarkup(createElement(SelectionResultView, { results }));
  for (const state of selectionResultStates) expect(html).toContain(`data-selection-result-group="${state}"`);
});

test('opening the selected-row review only renders supplied data and starts no action', () => {
  let calls = 0;
  const html = renderToStaticMarkup(
    createElement(SelectionReviewView, {
      open: true,
      onOpenChange: () => calls++,
      items: [{ subjectId: 'subject-1', title: 'Current work', stateLabel: 'Planned' }],
      statusChoices: [{ id: 'finished', label: { text: 'Finished', lang: 'en' } }],
      statusValue: '',
      statusAllowed: true,
      statusBlocked: false,
      pending: false,
      hydrated: true,
      onStatusChange: () => calls++,
      onReviewStatus: () => calls++,
      launcher: { current: null },
      isCurrent: () => true,
    }),
  );
  expect(html).toContain('Current work');
  expect(html).toContain('subject-1');
  expect(html).toContain(m.library_selection_review_title());
  expect(calls).toBe(0);
});
