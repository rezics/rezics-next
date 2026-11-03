import { expect, expectTypeOf, test } from 'bun:test';
import { createKernelClient } from '../src/index.ts';

test('typed Labels client exposes the six installed selected consolidation routes', async () => {
  const sent: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      sent.push(new Request(input, init));
      return Response.json({});
    }) as typeof fetch,
  });
  const id = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const targetLabelId = '019a1b2c-3d4e-7f00-8a00-000000000002';
  const confirmationId = '019a1b2c-3d4e-7f00-8a00-000000000003';
  const label = client.libraryLabels({ id });
  const selected = { subjectId: id, assignmentId: id, revision: 1 };
  const evidence = {
    selection: 'a'.repeat(64),
    sourceLabel: { id, name: 'Source', revision: 1 },
    targetLabel: { id: targetLabelId, name: 'Target', revision: 1 },
    items: [{ selected, source: { id, revision: 1, effective: true }, target: null, outcome: 'movable' as const }],
  };
  const options = { headers: { 'idempotency-key': 'selected-consolidation' } };
  const reviewBody = { targetLabelId, items: [selected], limit: 4, cursor: 'continuation' };
  const review = await label.$reviewConsolidation.post(reviewBody);
  expectTypeOf<NonNullable<typeof review.data>['items'][number]['outcome']>().toEqualTypeOf<
    'movable' | 'already_on_target' | 'missing' | 'changed' | 'inaccessible' | 'capacity_limited'
  >();
  const confirmation = await label.$confirmConsolidation.post(evidence, options);
  expectTypeOf<NonNullable<typeof confirmation.data>['status']>().toEqualTypeOf<'active'>();
  const applied = await label.$applyConsolidation.post({ confirmationId }, options);
  const retried = await label.$retryConsolidation.post({ confirmationId, item: 0 }, options);
  const cancelled = await label.$cancelConsolidation.post({ confirmationId }, options);
  const result = await label.consolidations({ confirmationId }).get();
  type Result = NonNullable<typeof result.data>;
  expectTypeOf(applied.data).toEqualTypeOf<Result | null>();
  expectTypeOf(retried.data).toEqualTypeOf<Result | null>();
  expectTypeOf(cancelled.data).toEqualTypeOf<Result | null>();
  expectTypeOf<Result['status']>().toEqualTypeOf<'active' | 'completed' | 'cancelled'>();
  expectTypeOf<Result['items'][number]['status']>().toEqualTypeOf<
    'pending' | 'processing' | 'moved' | 'target_applied_source_retained' | 'capacity_limited' | 'changed' | 'inaccessible'
  >();
  expect(sent.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
    ...['review', 'confirm', 'apply', 'retry', 'cancel'].map((action) => `POST /v1/libraryLabels/${id}:${action}Consolidation`),
    `GET /v1/libraryLabels/${id}/consolidations/${confirmationId}`,
  ]);
  expect(await Promise.all(sent.slice(0, 5).map((request) => request.json()))).toEqual([
    reviewBody, evidence, { confirmationId }, { confirmationId, item: 0 }, { confirmationId },
  ]);
  expect(sent.slice(1, 5).map((request) => request.headers.get('idempotency-key'))).toEqual(
    Array(4).fill('selected-consolidation'),
  );
});
