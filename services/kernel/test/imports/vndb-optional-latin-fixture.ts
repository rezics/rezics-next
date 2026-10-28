import { Database } from 'bun:sqlite';
import { expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchWriteResult } from '@rezics/definitions/bulk';
import type { Dump, Run } from '../../../../specs/imports-api-driver.ts';
import { converter_revision } from '../../../../packages/conversion/src/vndb.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { VndbTablesStore } from '../../../importer/src/vndb-tables.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';

const text = (name: string) =>
  readFileSync(new URL(`../../../../specs/fixtures/imports/vndb-tables/db/${name}`, import.meta.url), 'utf8');
const nativeRow = (name: string) =>
  text(name)
    .split('\n')
    .find((line) => line.startsWith('v124\t'))! + '\n';
export const primary = '港の物語';
export const romanized = 'Minato no Monogatari';
export const registration = createSourceRegistration('vndb');

// Real fixture headers and unchanged v124 VN/entry_meta rows (native revision 19).
// The fixture itself is synthetic; empty/blank cells below are controlled schema edges.
export function latinDump(latin: string | null, titles?: string): Dump {
  const members = [
    ['vn.header', text('vn.header')],
    ['vn', nativeRow('vn')],
    ['vn_titles.header', text('vn_titles.header')],
    ['vn_titles', titles ?? `v124\tja\tt\t${primary}\t${latin === null ? '\\N' : latin}\n`],
    ['entry_meta.header', text('entry_meta.header')],
    ['entry_meta', nativeRow('entry_meta')],
  ];
  return {
    source: 'vndb',
    snapshot: 'controlled-optional-latin',
    converterRevision: converter_revision,
    bytes: new Uint8Array(),
    async *entries() {
      for (const [name, content] of members) {
        const bytes = new TextEncoder().encode(content!);
        yield {
          path: `db/${name}`,
          kind: 'file' as const,
          declaredBytes: bytes.length,
          bytes: (async function* () {
            yield bytes;
          })(),
        };
      }
    },
  };
}

export async function staged(dump: Dump) {
  const directory = mkdtempSync(join(tmpdir(), 'vndb-optional-latin-'));
  const db = new Database(join(directory, 'tables.sqlite'));
  try {
    const tables = new VndbTablesStore(db, { pageSize: 1 });
    tables.begin('vndb', 'optional-latin');
    expect(() => tables.page('vndb', 'optional-latin', { after: null, limit: 1 })).toThrow();
    await tables.stage('vndb', 'optional-latin', dump.entries!());
    expect(tables.inspect('vndb', 'optional-latin').state).toBe('ready');
    const page = tables.page('vndb', 'optional-latin', { after: null, limit: 1 });
    expect(page.next).toBeNull();
    expect(page.records).toHaveLength(1);
    const row = page.records[0]!;
    expect(row.key).toBe('v124');
    expect(row.revision).toBe(19);
    return { external_id: row.key, record_revision: String(row.revision), record: row.record };
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function openLatinFixture() {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  try {
    const observer = await openApiObserver(runtime);
    return { runtime, observer };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
export type LatinFixture = Awaited<ReturnType<typeof openLatinFixture>>;

export async function completed(f: LatinFixture, run: Run) {
  expect(run.outcome).toBe('complete');
  for (const exchange of run.exchanges) {
    expect(exchange.response.status).toBe(200);
    const body = exchange.response.body as unknown as BatchWriteResult;
    expect(body.results).toHaveLength(exchange.request.keys.length);
    for (const result of body.results) expect(result.status).toBeLessThan(300);
    for (const receipt of exchange.receipts) {
      expect(receipt.identity).not.toBeNull();
      expect(await f.runtime.receipt(receipt.key)).toBe(receipt.identity);
    }
  }
}

// Identity comes only from completed public create-or-resolve responses.
export function returnedSubject(run: Run) {
  for (const exchange of run.exchanges) {
    const commands = (exchange.request.body as { commands: { op: string; key: string }[] }).commands;
    const body = exchange.response.body as unknown as BatchWriteResult;
    for (const result of body.results)
      if (commands.some((c) => c.op === 'create' && c.key === result.key) && 'value' in result && 'id' in result.value)
        return result.value.id;
  }
  throw new Error('No completed native create-or-resolve subject');
}
