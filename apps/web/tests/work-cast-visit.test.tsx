import { expect, test } from 'bun:test';
import {
  subjectVisitReturn,
  workCastVisitReturn,
  workCastVisitReturnFragment,
} from '../src/features/pages/subject-visit-navigation';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;

test('work-cast returns validate exact current focus and bound cursor history', () => {
  const address = {
    context: id(1),
    node: 'cast',
    presentation: 'credit-order' as const,
    statement: id(2),
    character: id(3),
    history: [null, 'window-1', 'window-2'],
  };
  const hash = workCastVisitReturnFragment(address);
  const href = `/en/subjects/${id(4)}/a-work/credits?node=cast&cursor=window-3${hash}`;
  expect(subjectVisitReturn(href, 'en')).toBe(href);
  expect(workCastVisitReturn(hash)).toEqual(address);
  expect(workCastVisitReturn(`${hash}&node=other`)).toBeUndefined();
  expect(subjectVisitReturn(href.replace(`context=${id(1)}`, 'context=not-a-context'), 'en')).toBeUndefined();

  const many = Array.from({ length: 16 }, (_, index) => `${'x'.repeat(1000)}${index}`);
  const bounded = workCastVisitReturn(workCastVisitReturnFragment({ ...address, history: many }));
  expect(bounded?.history?.length).toBeLessThan(16);
  expect(bounded?.history?.at(-1)).toBe(many.at(-1));
  expect(workCastVisitReturnFragment({ ...address, history: ['unsafe\ncursor'] })).toBe('#work-cast');
});
