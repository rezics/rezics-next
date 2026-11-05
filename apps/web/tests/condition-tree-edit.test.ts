import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FilterDocument } from '@rezics/filter';
import recording from '../src/kernel/recorded/definitions-release.json';
import { ConditionEditor } from '../src/search/condition-editor';
import { conditionMetadata } from '../src/search/condition-editor-model';
import { conditionTreeCanSubmit, editConditionTree, type ConditionTreePath } from '../src/search/condition-tree-edit';
import { m } from '../src/paraglide/messages.js';

const leaf: FilterDocument = { type: { in: ['schema:Book'] } };

test('group changes retain NOT operands and all other leaves until explicit unwrap', () => {
  const negated: FilterDocument = { not: leaf };
  const and = editConditionTree(negated, [], { type: 'operator', operator: 'and' });
  expect(and).toEqual({ accepted: true, value: { and: [negated] } });
  expect(editConditionTree(negated, [], { type: 'operator', operator: 'or' })).toEqual({
    accepted: true,
    value: { or: [negated] },
  });
  expect(editConditionTree(negated, [], { type: 'unwrap' })).toEqual({ accepted: true, value: leaf });

  const operands: FilterDocument[] = [negated, { saved: 'extension-rule' }];
  expect(editConditionTree({ and: operands }, [], { type: 'operator', operator: 'or' })).toEqual({
    accepted: true,
    value: { or: operands },
  });
});

test('structural edits reject depth, NOT, OR and total-leaf overflow without changing their input', () => {
  const tooDeep: FilterDocument = { and: [{ and: [{ and: [leaf] }] }] };
  const leafPath: ConditionTreePath = ['and', 0, 'and', 0, 'and', 0];
  expect(editConditionTree(tooDeep, leafPath, { type: 'operator', operator: 'not' }).accepted).toBe(false);
  expect(editConditionTree({ not: leaf }, [], { type: 'operator', operator: 'not' }).accepted).toBe(false);

  const fullOr: FilterDocument = { or: Array.from({ length: 16 }, () => leaf) };
  expect(editConditionTree(fullOr, [], { type: 'append', value: leaf }).accepted).toBe(false);
  const fullAnd: FilterDocument = { and: Array.from({ length: 32 }, () => leaf) };
  expect(editConditionTree(fullAnd, [], { type: 'append', value: leaf }).accepted).toBe(false);
  expect(fullAnd).toEqual({ and: Array.from({ length: 32 }, () => leaf) });
});

test('deleting the last child keeps an empty recoverable group and prevents submitting it', () => {
  const removed = editConditionTree({ and: [leaf] }, ['and', 0], { type: 'remove' });
  expect(removed).toEqual({ accepted: true, value: { and: [] } });
  const empty = removed.accepted ? removed.value : undefined;
  expect(conditionTreeCanSubmit(empty)).toBe(false);
  expect(conditionTreeCanSubmit(undefined)).toBe(true);

  const html = renderToStaticMarkup(
    createElement(ConditionEditor, {
      value: { and: [] },
      metadata: conditionMetadata(recording.release),
      onChange() {},
      locale: 'en',
    }),
  );
  expect(html).toContain(m.condition_tree_empty_group());
  expect(html).toContain(m.condition_add_type());
  expect(html).toContain(m.condition_add_statement());
  expect(html).toMatch(/<button\b(?=[^>]*type="submit")(?=[^>]*disabled="")[^>]*>/);

  expect(editConditionTree(empty!, [], { type: 'append', value: leaf })).toEqual({
    accepted: true,
    value: { and: [leaf] },
  });
});
