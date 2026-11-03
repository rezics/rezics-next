import { expect, test } from 'bun:test';
import { createKernelClient } from '../src/index.ts';

test.each(['text', 'envelope'])('generated archive upload preserves the %s body for preview', async (format) => {
  const id = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const requests: { method: string; path: string; body: string }[] = [];
  const replies: unknown[] = [
    { uploadId: id, state: 'ready', rows: 1, recordBytes: 20, coverage: [], createdAt: '', expiresAt: '' },
    {
      uploadId: id,
      state: 'ready',
      coverage: [],
      records: [{ ordinal: 0, section: 'labels', evidence: {}, status: 'create', review: {}, reviewRevision: 1 }],
      next: null,
    },
  ];
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push({ method: request.method, path: new URL(request.url).pathname, body: await request.text() });
        return Response.json(replies.shift());
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const archive = { manifest: { version: 2 }, records: [{ section: 'labels', normalized_name: 'chosen' }] };
  const raw = JSON.stringify(archive, null, 2);
  const upload = await client.libraryArchiveMerges.post(format === 'text' ? raw : archive, {
    headers: { 'idempotency-key': 'upload-reviewed-archive' },
  });
  if (!upload.data) throw new Error('upload unavailable');
  const owner = client.libraryArchiveMerges({ id: upload.data.uploadId });
  const preview = await owner.preview.get({ query: { limit: 1 } });
  const row = preview.data?.records[0];
  if (!row) throw new Error('preview unavailable');
  expect(row.ordinal).toBe(0);
  expect(requests[0]?.body).toBe(format === 'text' ? raw : JSON.stringify(archive));
  expect(requests[1]?.path).toBe(`/v1/libraryArchiveMerges/${id}/preview`);
});
