import { expect, test } from 'bun:test';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { assertGrowth, type GrowthSample } from '../../kernel/test/support/growth-bound.ts';
import { createImportFetch } from '../src/import-fetch.ts';

const ORIGIN = 'https://api.example.test';
const BATCH_URL = `${ORIGIN}/v1/subjects:batchWrite`;
const SCALES = [500, 4_000, 32_000] as const;
const BATCH_SIZE = 100;

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function batch(scale: number): BatchWriteRequest {
  return {
    commands: Array.from({ length: BATCH_SIZE }, (_, index) => {
      const externalId = `record-${scale}-${String(index).padStart(3, '0')}`;
      return {
        op: 'create' as const,
        key: `growth:${externalId}:create`,
        source: {
          source: 'growth',
          external_id: externalId,
          record_revision: 'unversioned',
          converter_revision: 'growth@1',
          digest: 'a'.repeat(64),
          field_group: 'facts' as const,
        },
        subject: { type: 'schema:Thing', labels: { en: `Record ${index}` } },
      };
    }),
  };
}

test('Kernel call stays within its bound as R grows', async () => {
  const samples: GrowthSample[] = [];
  for (const alreadyImported of SCALES) {
    let requests = 0;
    let writeRequests = 0;
    let otherRequests = 0;
    let imported: number = alreadyImported;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests++;
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/subjects:batchWrite') {
        otherRequests++;
        return new Response(null, { status: 404 });
      }
      writeRequests++;
      const body = (await request.json()) as BatchWriteRequest;
      imported += body.commands.length;
      const result: BatchWriteResult = {
        results: body.commands.map((command, index) => ({
          key: command.key,
          status: 201,
          value: { id: uuid(alreadyImported + index + 1), revision: 1 },
        })),
      };
      return Response.json(result);
    }) as typeof globalThis.fetch;
    const client = createImportFetch({ origin: ORIGIN, token: async () => 'actor', fetch, sleep: async () => {} });
    const body = batch(alreadyImported);
    const response = await client(
      new Request(BATCH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(200);
    expect(imported).toBe(alreadyImported + BATCH_SIZE);
    expect(requests).toBe(1);
    expect(writeRequests).toBe(1);
    expect(otherRequests).toBe(0);
    samples.push({
      scale: alreadyImported,
      cost: { rows: requests / body.commands.length, blocks: 0, statements: requests },
    });
  }
  assertGrowth(samples, { rows: 'constant', blocks: 'constant', statements: 'constant' });
});
