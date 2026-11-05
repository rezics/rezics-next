import { expect, test } from 'bun:test';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { subjectTabs } from '../src/features/pages/views';

for (const type of ['SubjectList', 'AccountPosts'] as const) {
  test(`${type} repeats preserve counts, local limits and continuation`, () => {
    const view = type === 'SubjectList' ? 'works' : 'posts';
    const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e80';
    const account = { id: subject, handle: 'reader' };
    const run = (
      limits: number[],
      count: unknown = { value: 3, exact: true },
      next: string | null = 'next',
      distinct = false,
      empty = false,
    ) => {
      const document = {
        root: { props: {} },
        content: limits.map((limit, index) => ({
          type,
          props: {
            id: `preview-${index}`,
            limit,
            ...(type === 'SubjectList' ? { title: { en: 'Works' }, property: 'schema:author' } : {}),
            ...(distinct && index === 1 ? { property: 'schema:illustrator' } : {}),
          },
        })),
      } as unknown as CompositionDocument;
      const plan = planReads(platformRegistry, document, { subject, account });
      const reads = Object.fromEntries(
        Object.entries(plan.reads).map(([key, read]) => {
          const items = Array.from({ length: empty ? 0 : Math.min('limit' in read ? read.limit : 2, 2) }, () => ({}));
          const body = { links: items, posts: items, count, next: next === null && items.length === 2 ? null : 'next' };
          return [key, { status: 200, body }];
        }),
      );
      return subjectTabs({ subject, account, document, reads, views: [view] });
    };
    const count = { value: type === 'SubjectList' ? 3 : 2, relation: type === 'SubjectList' ? 'exact' : 'lower_bound' };
    for (const limit of [1, 2]) {
      expect(run([limit, 2])).toEqual([{ view, count }]);
      expect(run([2, limit])).toEqual([{ view, count }]);
    }
    expect(run([2, 2], { value: 2, exact: true }, null)).toEqual([]);
    expect(run([1, 2], { value: 2, exact: true }, null)).toEqual([{ view, count: { value: 2, relation: 'exact' } }]);
    if (type === 'SubjectList') {
      expect(run([2, 2], null)).toEqual([{ view }]);
      expect(run([2, 2, 2], undefined, 'next', true)).toEqual([{ view, count: { value: 6, relation: 'exact' } }]);
    } else
      expect(run([2, 2], null, 'next', false, true)).toEqual([{ view, count: { value: 0, relation: 'lower_bound' } }]);
  });
}
