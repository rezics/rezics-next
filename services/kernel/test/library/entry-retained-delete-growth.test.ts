import { test } from 'bun:test';
import { runEntryUndoGrowth } from './support/entry-undo-growth.ts';

test('retained clear charges all pools and bounded indexed work across unrelated native live, archive, owner, source and immutable metadata populations', async () => {
  await runEntryUndoGrowth('delete');
}, 3600000);
