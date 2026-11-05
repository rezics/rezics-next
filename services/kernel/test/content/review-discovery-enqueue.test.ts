import { expect, test } from 'bun:test';
import type { WorkContext } from '../../src/work/registry.ts';
import { enqueueReviewDiscoveryWork } from '../../src/content/review-discovery-work.ts';

test('review invalidation children enter the source partition of the partitioned effects queue on replay', async () => {
  const calls: unknown[][] = [];
  const context = {
    client: {
      enqueue: async (...args: unknown[]) => {
        calls.push(args);
      },
    },
  } as unknown as WorkContext;
  const ref = { route: 160, id: '00000000-0000-8000-8000-00a000000001' };
  await enqueueReviewDiscoveryWork(context, ref);
  await enqueueReviewDiscoveryWork(context, ref);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]?.[0]).toMatchObject({
    queueName: 'effects',
    queuePartitionKey: '10',
    workflowIDReusePolicy: 'return-existing',
  });
  expect(calls[0]?.[1]).toBe(ref);
});
