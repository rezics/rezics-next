import { expect, test } from 'bun:test';
import { createKernelClient } from '../src/index.ts';

test('typed selected label consolidation calls preserve evidence, command keys and result addressing', async () => {
  const requests: Request[] = [];
  const sourceLabel = { id: 'source-label', name: 'Source', revision: 1 };
  const targetLabel = { id: 'target-label', name: 'Target', revision: 2 };
  const selected = { subjectId: 'subject', assignmentId: 'assignment', revision: 3 };
  const evidence = {
    selection: 'a'.repeat(64), sourceLabel, targetLabel,
    items: [{ selected, source: { id: 'assignment', revision: 3, effective: true }, target: null, outcome: 'movable' as const }],
  };
  const confirmationId = 'confirmation';
  const result = { confirmationId, sourceLabelId: sourceLabel.id, targetLabelId: targetLabel.id,
    status: 'active' as const, expiresAt: '2026-11-03T00:00:00Z', items: [] };
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return requests.length === 1 ? Response.json({ ...evidence, next: null })
        : requests.length === 2 ? Response.json({ confirmationId, expiresAt: result.expiresAt, status: 'active', itemCount: 1 }, { status: 201 })
        : Response.json(result);
    }) as typeof fetch,
  });
  const label = client.libraryLabels({ id: sourceLabel.id });
  const review = await label.$reviewConsolidation.post({ targetLabelId: targetLabel.id, items: [selected], limit: 4 });
  const selection: string | undefined = review.data?.selection;
  expect(selection).toBe(evidence.selection);
  const options = { headers: { 'idempotency-key': 'consolidation-command' } };
  const confirmed = await label.$confirmConsolidation.post(evidence, options);
  const active: 'active' | undefined = confirmed.data?.status;
  expect(active).toBe('active');
  const applied = await label.$applyConsolidation.post({ confirmationId }, options);
  const retried = await label.$retryConsolidation.post({ confirmationId, item: 0 }, options);
  const cancelled = await label.$cancelConsolidation.post({ confirmationId }, options);
  const read = await label.consolidations({ confirmationId }).get();
  for (const response of [applied, retried, cancelled, read]) {
    const status: 'active' | 'completed' | 'cancelled' | undefined = response.data?.status;
    expect(status).toBe('active');
    expect(response.data?.confirmationId).toBe(confirmationId);
  }
  expect(requests.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
    ...['review', 'confirm', 'apply', 'retry', 'cancel'].map((action) => ['POST', `/v1/libraryLabels/source-label:${action}Consolidation`]),
    ['GET', '/v1/libraryLabels/source-label/consolidations/confirmation'],
  ]);
  expect(await requests[0]!.json()).toEqual({ targetLabelId: targetLabel.id, items: [selected], limit: 4 });
  expect(await requests[1]!.json()).toEqual(evidence);
  expect(await requests[3]!.json()).toEqual({ confirmationId, item: 0 });
  expect(requests.slice(1, 5).map((request) => request.headers.get('idempotency-key'))).toEqual(Array(4).fill('consolidation-command'));
});
