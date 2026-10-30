import { expect, test } from 'bun:test';
import { planReads, platformRegistry, readCost, type SelectedContext } from '../src/index.ts';
const subject = '00000000-0000-8000-8000-000000000010';
const context: SelectedContext = {
  id: '00000000-0000-8000-8000-000000000060',
  population: { kind: 'realm', id: '00000000-0000-8000-8000-000000000050', title: 'Readers' },
};
const document = {
  root: { props: {} },
  content: [
    { type: 'SubjectHeader', props: { id: 'header' } },
    { type: 'ThreadList', props: { id: 'discussion', paged: true } },
    { type: 'ThreadList', props: { id: 'preview' } },
  ],
};
test('one continued discussion replaces its preview before dedup and uses the Realm place', () => {
  const plan = planReads(platformRegistry, document, {
    subject,
    context,
    continuation: { node: 'discussion', cursor: 'native-opaque-cursor' },
  });
  expect(plan.reads).toEqual({
    r0: { kind: 'subject', id: subject, context: context.id },
    r1: {
      kind: 'subjectThreads',
      id: subject,
      place: context.population.kind === 'realm' ? context.population.id : '',
      threadKind: 'discussion',
      limit: 5,
      cursor: 'native-opaque-cursor',
    },
    r2: {
      kind: 'subjectThreads',
      id: subject,
      place: '00000000-0000-8000-8000-000000000050',
      threadKind: 'discussion',
      limit: 5,
    },
  });
  expect(Object.values(plan.reads).reduce((n, read) => n + readCost(read), 0)).toBe(11);
  expect(() =>
    planReads(platformRegistry, document, { subject, context, continuation: { node: 'preview', cursor: 'native' } }),
  ).toThrow('Invalid continuation node');
});
