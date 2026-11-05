import { test } from 'bun:test';
import { runEntryUndoGrowth } from './support/entry-undo-growth.ts';

test('original-pin preparation charges all pools and denies before private reads at three independent native population scales', async () => {
  await runEntryUndoGrowth('preparation');
}, 3600000);
