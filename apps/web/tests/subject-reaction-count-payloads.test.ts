import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { readReactionCounts } from '../src/features/pages/subject-reactions';

function read(data: unknown) {
  const client = {
    subjects: () => ({ reactions: { get: async () => ({ status: 200, data }) } }),
  } as unknown as KernelClient;
  return readReactionCounts(client, 'subject');
}

test('malformed native reaction count pages are unavailable', async () => {
  for (const page of [
    { counts: {}, watermark: null },
    { counts: [null], watermark: null },
    { counts: [{ kind: 'like', count: 0 }], watermark: null },
    { counts: [{ kind: 'unknown', count: 2 }], watermark: null },
    {
      counts: [
        { kind: 'like', count: 1 },
        { kind: 'like', count: 2 },
      ],
      watermark: null,
    },
    { counts: [], watermark: { epoch: 1, position: '0' } },
  ])
    expect(await read(page)).toBeNull();
});

test('sparse native totals preserve displayed counts and omit known hidden kinds', async () => {
  expect(
    await read({
      counts: [
        { kind: 'like', count: 3 },
        { kind: 'upvote', count: 8 },
      ],
      watermark: { epoch: 1, position: '1' },
    }),
  ).toEqual({ counts: { like: 3 }, value: null });
});
