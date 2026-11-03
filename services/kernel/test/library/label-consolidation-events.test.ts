import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { classifyEvent } from '../../src/history/contracts.ts';
import { LIBRARY_EVENTS } from '../../src/library/events.ts';

test('consolidation facts identify the private plan without disclosing review evidence', () => {
  const type = 'com.rezics.library.label.consolidation.changed.v1';
  const data = { confirmationId: '019a1b2c-3d4e-7f00-8a00-000000000001' };
  expect(Value.Check(LIBRARY_EVENTS[type], data)).toBe(true);
  expect(Value.Check(LIBRARY_EVENTS[type], {})).toBe(false);
  for (const key of ['selection', 'sourceLabel', 'targetLabel', 'items'])
    expect(Value.Check(LIBRARY_EVENTS[type], { ...data, [key]: 'private review evidence' })).toBe(false);
  expect(() => classifyEvent(type)).not.toThrow();
});
