import { expect, test } from 'bun:test';
import { editorialFieldSlot, validEditorialControlBasis } from '../src/modules/protection/field-control.ts';

const target = { component: 'https://rezics.com/id/00000000-0000-0000-0000-000000000001',
  definition: 'https://rezics.com/definition/work-title',
  occurrence: 'urn:rezics:field-occurrence:english', context: 'https://rezics.com/vocab/GlobalNative' };

test('SYS03: field control identity binds definition, occurrence and context independently of value', () => {
  const key = editorialFieldSlot(target);
  expect(key).toBe(editorialFieldSlot({ ...target }));
  expect(key).not.toBe(editorialFieldSlot({ ...target, occurrence: null }));
  expect(key).not.toBe(editorialFieldSlot({ ...target, context: 'urn:rezics:realm:second' }));
  expect(key).not.toBe(editorialFieldSlot({ ...target, definition: 'urn:rezics:field:subtitle' }));
  expect(() => editorialFieldSlot({ ...target, definition: 'title text' })).toThrow();
  expect(validEditorialControlBasis({ head: null, epoch: '0', protection: null })).toBe(true);
  expect(validEditorialControlBasis({ head: null, epoch: '1', protection: null })).toBe(false);
  expect(validEditorialControlBasis({ head: target.component, epoch: '0', protection: null })).toBe(false);
  expect(validEditorialControlBasis({ head: target.component, epoch: '1', protection: target.component })).toBe(true);
});
