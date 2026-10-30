import { expect, test } from 'bun:test';
import type { SourceRecord } from '@rezics/conversion';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { ImportTransport } from '../src/import-contract.ts';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

const subject = '00000000-0000-4000-8000-000000000101';
function row(revision: number): SourceRecord {
  return {
    source: 'vndb',
    key: 'v123',
    revision: String(revision),
    payload: {
      vn: { id: 'v123', olang: 'en', c_average: revision === 7 ? 735 : 812, c_votecount: 20 },
      entry_meta: { id: 'v123', revision },
      vn_titles: [{ id: 'v123', lang: 'en', official: true, title: `Book ${revision}`, latin: null }],
      vn_extlinks: [],
      extlinks: [],
    },
  };
}

test('bound VNDB refresh suppresses source-statistic publication behind the exact facts fence', async () => {
  let fenced = false;
  let statistics = 0;
  let sequence = 0;
  const fences: string[] = [];
  const transport: ImportTransport = {
    async readFence(tuple) {
      fences.push(`${tuple.source}:${tuple.external_id}:${tuple.field_group}`);
      return tuple.field_group === 'facts' && fenced
        ? { fenced: true, securityRevision: '1' }
        : { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {
      statistics++;
    },
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') return { key: command.key, status: 201, value: { id: subject, revision: 1 } };
          if (command.op === 'propose')
            return {
              key: command.key,
              status: 201,
              value: { candidate: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, revision: 1 },
            };
          return { key: command.key, status: 200, value: { revision: 1 } };
        }),
      };
    },
  };
  const importer = new Importer({ path: ':memory:', transport });
  const registration = createSourceRegistration('vndb');
  const run = (revision: number) =>
    importer.runRecords(
      registration,
      (async function* () {
        yield row(revision);
      })(),
    );
  try {
    expect((await run(7)).status).toBe('committed');
    expect(statistics).toBe(1);
    expect(importer.session.bindings.claim({ source: 'vndb', external_id: 'v123' })?.subject).toBe(subject);
    fenced = true;
    const before = fences.length;
    expect((await run(8)).status).toBe('committed');
    expect(statistics).toBe(1);
    expect(fences.slice(before)).toContain('vndb:v123:facts');
    const refreshed = fences.length;
    expect((await run(8)).status).toBe('committed');
    expect(statistics).toBe(1);
    expect(fences.slice(refreshed)).toContain('vndb:v123:facts');
  } finally {
    await importer.close();
  }
});
