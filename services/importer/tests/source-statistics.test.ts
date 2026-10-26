import { expect, test } from 'bun:test';
import type { SourceRecord } from '@rezics/conversion';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { Importer } from '../src/importer.ts';
import type { ImportTransport } from '../src/import-contract.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { createImportTransport } from './transport-driver.ts';

const subjectId = '00000000-0000-4000-8000-000000000101';

function vnRecord(average: number, votes: number, revision: number): SourceRecord {
  return {
    source: 'vndb',
    key: 'v123',
    revision: String(revision),
    payload: {
      vn: { id: 'v123', olang: 'en', c_average: average, c_votecount: votes, c_rating: 900 },
      entry_meta: { id: 'v123', revision },
      vn_titles: [{ id: 'v123', lang: 'en', official: true, title: 'Test visual novel', latin: null }],
      vn_extlinks: [],
      extlinks: [],
    },
  };
}

function resultFor(request: BatchWriteRequest, sequence: { value: number }): BatchWriteResult {
  return {
    results: request.commands.map((command) => {
      sequence.value++;
      if (command.op === 'create') return { key: command.key, status: 201, value: { id: subjectId, revision: 1 } };
      if (command.op === 'propose')
        return {
          key: command.key,
          status: 201,
          value: {
            candidate: `00000000-0000-4000-8000-${sequence.value.toString().padStart(12, '0')}`,
            revision: 1,
          },
        };
      return { key: command.key, status: 200, value: { revision: 1 } };
    }),
  };
}

test('VNDB imports and refreshes its licensed source statistic through the API without writing votes', async () => {
  const requests: { method: string; path: string; body?: unknown; key?: string }[] = [];
  const stored = new Map<string, unknown>();
  const sequence = { value: 0 };
  const transport = {
    async batchWrite(request: BatchWriteRequest) {
      requests.push({ method: 'POST', path: '/v1/subjects:batchWrite', body: request });
      return resultFor(request, sequence);
    },
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic(input: { subjectId: string; value: Record<string, unknown>; idempotencyKey: string }) {
      requests.push({
        method: 'PUT',
        path: `/v1/subjects/${input.subjectId}/source-statistics/vndb`,
        body: input.value,
        key: input.idempotencyKey,
      });
      stored.set(input.subjectId, input.value);
    },
  } as unknown as ImportTransport;
  const importer = new Importer({ path: ':memory:', transport });
  const registration = createSourceRegistration('vndb');

  try {
    const first = await importer.runRecords(
      registration,
      (async function* () {
        yield vnRecord(735, 20, 7);
      })(),
    );
    expect(first.status).toBe('committed');
    expect(stored.get(subjectId)).toEqual({
      sourceRecordId: 'v123',
      scale: { min: 1, max: 10 },
      mean: 7.35,
      count: 20,
      asOf: '2026-10-25',
      licence: 'ODbL-1.0',
      attribution: 'VNDB',
    });

    const second = await importer.runRecords(
      registration,
      (async function* () {
        yield vnRecord(812, 25, 8);
      })(),
    );
    expect(second.status).toBe('committed');
    expect(stored.size).toBe(1);
    expect(stored.get(subjectId)).toEqual({
      sourceRecordId: 'v123',
      scale: { min: 1, max: 10 },
      mean: 8.12,
      count: 25,
      asOf: '2026-10-25',
      licence: 'ODbL-1.0',
      attribution: 'VNDB',
    });
    const statisticRequests = requests.filter((request) => request.path.endsWith('/source-statistics/vndb'));
    expect(statisticRequests).toHaveLength(2);
    expect(new Set(statisticRequests.map((request) => request.key)).size).toBe(2);
    expect(requests.some((request) => request.path.includes('/ratings/'))).toBe(false);
    for (const request of requests.filter((item) => item.path === '/v1/subjects:batchWrite')) {
      expect(JSON.stringify(request.body)).not.toContain('c_rating');
      expect(JSON.stringify(request.body)).not.toContain('ratings/vote');
    }
  } finally {
    await importer.close();
  }
});

test('the production import transport PUTs the VNDB statistic route with its idempotency key', async () => {
  const requests: { method: string; path: string; key: string | null; body: unknown }[] = [];
  const value = {
    sourceRecordId: 'v123',
    scale: { min: 1, max: 10 },
    mean: 7.35,
    count: 20,
    asOf: '2026-10-25',
    licence: 'ODbL-1.0',
    attribution: 'VNDB',
  };
  const transport = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    fetch: (async (request: Request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        key: request.headers.get('idempotency-key'),
        body: JSON.parse(await request.text()),
      });
      return Response.json({ source: 'vndb', ...value });
    }) as typeof fetch,
    maxAttempts: 1,
  });

  await transport.writeSourceStatistic({
    subjectId,
    source: 'vndb',
    value,
    idempotencyKey: 'source-statistic:refresh-1',
  });

  expect(requests).toEqual([
    {
      method: 'PUT',
      path: `/v1/subjects/${subjectId}/source-statistics/vndb`,
      key: '"source-statistic:refresh-1"',
      body: value,
    },
  ]);
});

test('Bangumi score fields remain omitted because its licence does not cover ratings', async () => {
  const source = Bun.YAML.parse(
    await Bun.file(new URL('../../../packages/definitions/sources/bangumi.yaml', import.meta.url)).text(),
  ) as {
    files: { id: string; fields: { id: string; mapping: { status: string; reason?: string } }[] }[];
  };
  const subject = source.files.find((file) => file.id === 'subject');
  expect(subject).toBeDefined();
  for (const fieldName of [
    'rank',
    'score',
    'score_details',
    ...Array.from({ length: 10 }, (_, index) => `score_details.${index + 1}`),
  ]) {
    expect(subject!.fields.find((field) => field.id === fieldName)?.mapping).toEqual({
      status: 'omitted',
      reason: "Bangumi's licence covers entry information and not ratings.",
    });
  }
});
