import { expect, test } from 'bun:test';
import { planReads, platformRegistry } from '../src/index.ts';

const subject = '00000000-0000-8000-8000-000000000010';
const board = '00000000-0000-8000-8000-000000000070';
const document = {
  root: { props: {} },
  content: [
    { type: 'SubjectHeader', props: { id: 'header' } },
    { type: 'ThreadList', props: { id: 'discussion' } },
  ],
};
const threadReads = (page: Parameters<typeof planReads>[2]) =>
  Object.values(planReads(platformRegistry, document, page).reads).filter((read) => read.kind === 'subjectThreads');

test('a supplied Board reaches the Subject threads read as its exact operand', () => {
  const [read] = threadReads({ subject, board });
  expect(read).toMatchObject({ kind: 'subjectThreads', id: subject, threadKind: 'discussion', board });
});

test('a page without a Board plans the unchanged Subject threads read', () => {
  const [read] = threadReads({ subject });
  expect(read).toBeDefined();
  expect(read).not.toHaveProperty('board');
});
