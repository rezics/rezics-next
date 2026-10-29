import { expect, test } from 'bun:test';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedValues,
} from '../../kernel/test/support/growth-counters.ts';
import { createImportFetch } from '../src/import-fetch.ts';

const ORIGIN = 'https://api.example.test';
const BATCH_URL = `${ORIGIN}/v1/subjects:batchWrite`;
const SCALES = [64, 512, 4096] as const;
const BATCH_SIZE = 100;
const check: CountedCheck = {
  read: (value: unknown) => value as CountedValues,
  bounds: { 'transport requests': 'linear', 'commands sent': 'linear' },
};

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function batch(start: number, count: number): BatchWriteRequest {
  return {
    commands: Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      const externalId = `record-${index}`;
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

test('client transport sends each supplied bounded batch once as input grows', async () => {
  const samples: { scale: number; counted: ReturnType<typeof countedSample> }[] = [];
  for (const scale of SCALES) {
    let requests = 0;
    let commandsSent = 0;
    let otherRequests = 0;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests++;
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/subjects:batchWrite') {
        otherRequests++;
        return new Response(null, { status: 404 });
      }
      const body = (await request.json()) as BatchWriteRequest;
      expect(body.commands.length).toBeLessThanOrEqual(BATCH_SIZE);
      commandsSent += body.commands.length;
      const result: BatchWriteResult = {
        results: body.commands.map((command, index) => ({
          key: command.key,
          status: 201,
          value: { id: uuid(commandsSent + index + 1), revision: 1 },
        })),
      };
      return Response.json(result);
    }) as typeof globalThis.fetch;
    const client = createImportFetch({ origin: ORIGIN, token: async () => 'actor', fetch, sleep: async () => {} });
    let sent = 0;
    while (sent < scale) {
      const body = batch(sent, Math.min(BATCH_SIZE, scale - sent));
      const response = await client(
        new Request(BATCH_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(200);
      sent += body.commands.length;
    }
    expect(requests).toBe(Math.ceil(scale / BATCH_SIZE));
    expect(commandsSent).toBe(scale);
    expect(otherRequests).toBe(0);
    const counted: CountedValues = { 'transport requests': requests, 'commands sent': commandsSent };
    samples.push({ scale, counted: countedSample([counted]) });
  }
  expect(countedViolations(check, samples)).toEqual([]);
  for (const sample of samples) {
    expect(sample.counted['transport requests']!.value).toBe(Math.ceil(sample.scale / BATCH_SIZE));
    expect(sample.counted['commands sent']!.value).toBe(sample.scale);
  }
});
