import { expect, test } from 'bun:test';

test('the test process carries no control-plane variables', () => {
  expect(Object.keys(process.env).filter((key) => key.startsWith('GOAL_') || key === 'CODEX_THREAD_ID')).toEqual([]);
});
