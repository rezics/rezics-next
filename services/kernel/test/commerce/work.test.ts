import { expect, test } from 'bun:test';
import { commerceWork } from '../../src/commerce/work.ts';
import { KERNEL_WORK_MODULES } from '../../src/work/modules.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';

test('the kernel worker registers commerce exactly once using the existing queue set', () => {
  expect(typeof commerceWork.register).toBe('function');
  expect(KERNEL_WORK_MODULES.filter((module) => module === commerceWork)).toHaveLength(1);
  expect(KERNEL_WORK_MODULES.filter((module) => module.name === commerceWork.name)).toHaveLength(1);
  expect(Object.keys(WORK_QUEUES)).toEqual(['governance', 'effects', 'workflows', 'delivery', 'import', 'maintenance']);
});
