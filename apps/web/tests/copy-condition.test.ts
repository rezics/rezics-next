import { expect, test } from 'bun:test';
import {
  COPY_CONDITION_CLEAR,
  copyConditionDraftOf,
  copyConditionOperand,
  copyConditionWritten,
  kindAdmitsCondition,
} from '../src/library/copy-condition';

test('condition drafts distinguish omit, recorded grades and an intentional clear', () => {
  expect(copyConditionDraftOf(undefined)).toBe('');
  expect(copyConditionDraftOf({ state: 'not_recorded' })).toBe('');
  expect(copyConditionDraftOf({ state: 'unavailable' })).toBe('');
  expect(copyConditionDraftOf({ state: 'cleared' })).toBe(COPY_CONDITION_CLEAR);
  expect(copyConditionDraftOf({ state: 'recorded', id: 'near_mint', label: 'Near mint' })).toBe('near_mint');
  expect(copyConditionOperand('')).toBeUndefined();
  expect(copyConditionOperand(COPY_CONDITION_CLEAR)).toBeNull();
  expect(copyConditionOperand('mint')).toBe('mint');
  expect(copyConditionOperand('shiny')).toBeUndefined();
  expect(copyConditionWritten(undefined, undefined)).toBeUndefined();
  expect(copyConditionWritten({ state: 'recorded', id: 'good', label: 'Good' }, undefined)).toEqual({
    state: 'recorded',
    id: 'good',
    label: 'Good',
  });
  expect(copyConditionWritten(undefined, null)).toEqual({ state: 'cleared' });
  expect(copyConditionWritten(undefined, 'fair')?.state).toBe('recorded');
  expect(kindAdmitsCondition('physical-v1')).toBe(true);
  expect(kindAdmitsCondition('digital')).toBe(false);
});
