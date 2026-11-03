import { expect, test } from 'bun:test';
import { createKernelClient } from '../src/index.ts';

test.each(['text', 'envelope'])('generated archive methods carry the %s body and exact reviewed revision', async (format) => {
  const id = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const requests: { method: string; path: string; body: string }[] = [];
  const replies: unknown[] = [
    { uploadId: id, state: 'ready', rows: 1, recordBytes: 20, coverage: [], createdAt: '', expiresAt: '' },
    { uploadId: id, state: 'ready', coverage: [], records: [{ ordinal: 0, section: 'labels', evidence: {}, status: 'create', review: {}, reviewRevision: 1 }], next: null },
    { uploadId: id, reviewed: [{ ordinal: 0, status: 'create', reviewRevision: 2 }] },
    { uploadId: id, applied: [{ ordinal: 0, status: 'acknowledged', result: { effect: 'label.create' } }] },
  ];
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({ method: request.method, path: new URL(request.url).pathname, body: await request.text() });
      return Response.json(replies.shift());
    }, { preconnect: fetch.preconnect }),
  });
  const archive = { manifest: { version: 2 }, records: [{ section: 'labels', normalized_name: 'chosen' }] };
  const raw = JSON.stringify(archive, null, 2);
  const upload = await client.libraryArchiveMerges.post(format === 'text' ? raw : archive, { headers: { 'idempotency-key': 'upload-reviewed-archive' } });
  if (!upload.data) throw new Error('upload unavailable');
  const owner = client.libraryArchiveMerges({ id: upload.data.uploadId });
  const preview = await owner.preview.get({ query: { limit: 1 } });
  const row = preview.data?.records[0];
  if (!row) throw new Error('preview unavailable');
  const reviewed = await owner.review.patch({ items: [{ ordinal: row.ordinal, kind: 'label', target: { mode: 'create' } }] });
  const item = reviewed.data?.reviewed[0];
  if (!item) throw new Error('review unavailable');
  const items = [{ ordinal: item.ordinal, reviewRevision: item.reviewRevision }];
  const applied = await owner.apply.post({ items });
  expect(applied.data?.applied[0]?.status).toBe('acknowledged');
  expect(row.reviewRevision).toBe(1);
  expect(requests[0]?.body).toBe(format === 'text' ? raw : JSON.stringify(archive));
  expect(requests[3]).toEqual({ method: 'POST', path: `/v1/libraryArchiveMerges/${id}/apply`, body: JSON.stringify({ items }) });
});
