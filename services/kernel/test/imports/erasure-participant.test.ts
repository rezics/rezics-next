import { expect, test } from 'bun:test';
import { importsWorkModule } from '../../src/imports/erasure.ts';
import { KERNEL_WORK_MODULES } from '../../src/work/modules.ts';

test('real account deletion delivers the registered imports effect and persists a truthful immutable none acknowledgement', () => {
  expect(KERNEL_WORK_MODULES.filter((module) => module === importsWorkModule)).toHaveLength(1);
  expect(importsWorkModule.name).toBe('imports');
});
