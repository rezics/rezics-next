import { expect, test } from 'bun:test';
import { fenceStudioVariantHeads } from '../src/modules/studio/variant-heads.ts';
import { WorkReadExpired } from '../src/modules/work/read-session.ts';

const item = { id: 'urn:rezics:variant:one', languageKind: 'tag', languageTag: 'en',
  originalLanguageTag: 'en', direction: 'ltr', draftHead: 'draft-one' };
const listed = { items: [item], nextCursor: null };

test('Studio fences repeat the exact bounded page, including its continuation and empty inventory', async () => {
  const calls: unknown[] = [];
  await fenceStudioVariantHeads({ listVariantHeads: async (...args) => {
    calls.push(args); return structuredClone(listed);
  } }, 'work', 'after', 1, listed);
  expect(calls).toEqual([['work', 'after', 1]]);
  await fenceStudioVariantHeads({ listVariantHeads: async () => ({ items: [], nextCursor: null }) },
    'empty-work', '', 20, { items: [], nextCursor: null });
});

test('Studio rejects changed heads, inserted or removed variants, metadata and pagination boundaries with 409 basis expiry', async () => {
  for (const current of [
    { items: [{ ...item, draftHead: 'draft-two' }], nextCursor: null },
    { items: [item, { ...item, id: 'urn:rezics:variant:two' }], nextCursor: null },
    { items: [], nextCursor: null },
    { items: [{ ...item, languageTag: 'ja' }], nextCursor: null },
    { items: [item], nextCursor: item.id },
  ]) {
    await expect(fenceStudioVariantHeads({ listVariantHeads: async () => current },
      'work', '', 20, listed)).rejects.toBeInstanceOf(WorkReadExpired);
  }
  await expect(fenceStudioVariantHeads({ listVariantHeads: async () => listed },
    'empty-work', '', 20, { items: [], nextCursor: null })).rejects.toBeInstanceOf(WorkReadExpired);
});
