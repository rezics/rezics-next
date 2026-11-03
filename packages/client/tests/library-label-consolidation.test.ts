import { expect, test } from 'bun:test';
import { createKernelClient } from '../src/index.ts';

test('typed label consolidation calls preserve review evidence and retry the selected item', async () => {
  const sourceLabelId = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const targetLabelId = '019a1b2c-3d4e-7f00-8a00-000000000002';
  const subjectId = '019a1b2c-3d4e-7f00-8a00-000000000003';
  const assignmentId = '019a1b2c-3d4e-7f00-8a00-000000000004';
  const confirmationId = '019a1b2c-3d4e-7f00-8a00-000000000005';
  const selected = { subjectId, assignmentId, revision: 7 };
  const reviewed = {
    selection: 'a'.repeat(64),
    sourceLabel: { id: sourceLabelId, revision: 2, name: 'source' },
    targetLabel: { id: targetLabelId, revision: 3, name: 'target' },
    items: [
      {
        selected,
        source: { id: assignmentId, revision: 7, effective: true },
        target: null,
        outcome: 'movable' as const,
      },
    ],
    next: null,
  };
  const reviewEvidence = {
    selection: reviewed.selection,
    sourceLabel: reviewed.sourceLabel,
    targetLabel: reviewed.targetLabel,
    items: reviewed.items,
  };
  const expiresAt = '2026-11-05T12:00:00.000Z';
  const result = {
    confirmationId,
    sourceLabelId,
    targetLabelId,
    status: 'active' as const,
    expiresAt,
    items: [{ item: 0, selected, status: 'pending' as const }],
  };
  const replies: unknown[] = [
    reviewed,
    { confirmationId, expiresAt, status: 'active', itemCount: 1 },
    result,
    result,
    result,
    result,
  ];
  const requests: { method: string; path: string; body: unknown }[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: request.body === null ? null : await request.json(),
      });
      return Response.json(replies.shift());
    }) as typeof fetch,
  });
  const options = { headers: { 'idempotency-key': 'label-consolidation' } };

  const review = await client.libraryLabels({ id: sourceLabelId }).$reviewConsolidation.post({
    targetLabelId,
    items: [selected],
  });
  if (review.data === null) throw new Error('review failed');
  const evidence = {
    selection: review.data.selection,
    sourceLabel: review.data.sourceLabel,
    targetLabel: review.data.targetLabel,
    items: review.data.items.filter(
      (item): item is Extract<(typeof review.data.items)[number], { outcome: 'movable' }> =>
        item.outcome === 'movable' && item.source !== null,
    ),
  };
  const confirmation = await client.libraryLabels({ id: sourceLabelId }).$confirmConsolidation.post(evidence, options);
  if (confirmation.data === null) throw new Error('confirmation failed');
  const apply = await client
    .libraryLabels({ id: sourceLabelId })
    .$applyConsolidation.post({ confirmationId: confirmation.data.confirmationId }, options);
  if (apply.data === null) throw new Error('apply failed');
  const selectedResult = apply.data.items[0];
  if (selectedResult?.selected === undefined) throw new Error('selected item missing');
  await client
    .libraryLabels({ id: sourceLabelId })
    .$retryConsolidation.post({ confirmationId: confirmation.data.confirmationId, item: selectedResult.item }, options);
  await client
    .libraryLabels({ id: sourceLabelId })
    .$cancelConsolidation.post({ confirmationId: confirmation.data.confirmationId }, options);
  await client
    .libraryLabels({ id: sourceLabelId })
    .consolidations({ confirmationId: confirmation.data.confirmationId })
    .get();

  expect(requests.map(({ method, path }) => [method, path])).toEqual([
    ['POST', `/v1/libraryLabels/${sourceLabelId}:reviewConsolidation`],
    ['POST', `/v1/libraryLabels/${sourceLabelId}:confirmConsolidation`],
    ['POST', `/v1/libraryLabels/${sourceLabelId}:applyConsolidation`],
    ['POST', `/v1/libraryLabels/${sourceLabelId}:retryConsolidation`],
    ['POST', `/v1/libraryLabels/${sourceLabelId}:cancelConsolidation`],
    ['GET', `/v1/libraryLabels/${sourceLabelId}/consolidations/${confirmationId}`],
  ]);
  expect(requests[1]!.body).toEqual(reviewEvidence);
  expect(requests[3]!.body).toEqual({ confirmationId, item: 0 });
});
