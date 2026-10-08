import { test } from 'bun:test';
import { assertPreparedWorkRead } from './work-name-scope-prepared.ts';

test('a Work header read sees a complete Work name scope after the stack reset', async () => {
  if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl test');
  await assertPreparedWorkRead('scope-after-reset');
}, 180_000);
