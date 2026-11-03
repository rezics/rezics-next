import { expect, test } from 'bun:test';
import { createKernelClient } from '../src/index.ts';

test('typed label consolidation uses all six native routes and preserves confirmation evidence', async () => {
  const id = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const selected = { subjectId: id, assignmentId: id, revision: 1 };
  const evidence = {
    selection: 'a'.repeat(64),
    sourceLabel: { id, revision: 1, name: 'Source' },
    targetLabel: { id, revision: 2, name: 'Target' },
    items: [{ selected, source: { id, revision: 1, effective: true }, target: null, outcome: 'movable' as const }],
  };
  const result = {
    confirmationId: id, sourceLabelId: id, targetLabelId: id, status: 'completed' as const,
    expiresAt: '2026-11-03T00:00:00Z',
    items: [{ item: 0, selected, status: 'target_applied_source_retained' as const, targetAssignment: { id, revision: 2 } }],
  };
  const sent: { method: string; url: string; body: unknown }[] = [];
  const client = createKernelClient('http://kernel.test', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push({ method: init?.method ?? 'GET', url, body: init?.body });
      if (url.endsWith(':reviewConsolidation')) return Response.json({ ...evidence, next: null });
      if (url.endsWith(':confirmConsolidation'))
        return Response.json({ confirmationId: id, expiresAt: result.expiresAt, status: 'active', itemCount: 1 }, { status: 201 });
      return Response.json(result);
    }) as typeof fetch,
  });
  const label = client.libraryLabels({ id });
  const options = { headers: { 'idempotency-key': 'consolidation-test' } };
  const review = await label.$reviewConsolidation.post({ targetLabelId: id, items: [selected], limit: 4 });
  expect(review.data?.items[0]?.outcome).toBe('movable');
  const confirmation = await label.$confirmConsolidation.post(evidence, options);
  const confirmed: string | undefined = confirmation.data?.confirmationId;
  expect(confirmed).toBe(id);
  const apply = await label.$applyConsolidation.post({ confirmationId: id }, options);
  const retry = await label.$retryConsolidation.post({ confirmationId: id, item: 0 }, options);
  const cancel = await label.$cancelConsolidation.post({ confirmationId: id }, options);
  const read = await label.consolidations({ confirmationId: id }).get();
  for (const response of [apply, retry, cancel, read]) {
    const status: 'active' | 'completed' | 'cancelled' | undefined = response.data?.status;
    expect(status).toBe('completed');
    expect(response.data?.items[0]?.targetAssignment?.revision).toBe(2);
  }
  const base = `http://kernel.test/v1/libraryLabels/${id}`;
  expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
    ...['review', 'confirm', 'apply', 'retry', 'cancel'].map((action) => `POST ${base}:${action}Consolidation`),
    `GET ${base}/consolidations/${id}`,
  ]);
  expect(JSON.parse(sent[1]!.body as string)).toEqual(evidence);
  expect(JSON.parse(sent[3]!.body as string)).toEqual({ confirmationId: id, item: 0 });
});
