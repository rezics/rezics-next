import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { readDump } from '../src/dumps.ts';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

const sourceItems = readFileSync(
  new URL('../../../specs/fixtures/imports/ledger/wikidata.jsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .slice(0, 5)
  .map((line) => JSON.parse(line));
const property = {
  type: 'property',
  id: 'P31',
  lastrevid: 123,
  datatype: 'wikibase-item',
  labels: { en: { language: 'en', value: 'instance of' } },
  claims: {},
};
async function* bytes(rows: unknown[]) {
  yield new TextEncoder().encode('[\n' + rows.map((row) => JSON.stringify(row)).join(',\n') + '\n]\n');
}

test('native mixed Wikidata dump imports only items and preserves refresh and mass-stop semantics', async () => {
  expect(sourceItems).toHaveLength(5);
  const sent: BatchWriteRequest[] = [];
  const receipts = new Map<string, BatchWriteResult['results'][number]>();
  const importer = new Importer({
    path: ':memory:',
    transport: {
      async readFence() {
        return { fenced: false, securityRevision: null };
      },
      async batchWrite(request): Promise<BatchWriteResult> {
        sent.push(structuredClone(request));
        return {
          results: request.commands.map((command) => {
            const old = receipts.get(command.key);
            if (old) return old;
            const result: BatchWriteResult['results'][number] =
              command.op === 'create'
                ? { key: command.key, status: 201, value: { id: randomUUID(), revision: 1 } }
                : command.op === 'propose'
                  ? { key: command.key, status: 201, value: { candidate: randomUUID(), revision: 1 } }
                  : { key: command.key, status: 200, value: { revision: 1 } };
            receipts.set(command.key, result);
            return result;
          }),
        };
      },
    },
  });
  const registration = createSourceRegistration('wikidata');
  const mixed = [property, ...sourceItems.slice(0, 2), { ...property, id: 'P50' }, ...sourceItems.slice(2)];
  try {
    const initial = await importer.runDump(registration, bytes(mixed));
    expect(initial.status).toBe('committed');
    expect(initial.counts.new).toBe(5);
    expect(importer.session.store.source('wikidata').count).toBe(5);
    expect(sent.flatMap((r) => r.commands).every((c) => /^Q[1-9][0-9]*$/.test(c.source.external_id))).toBe(true);
    const before = sent.length;
    const unchanged = await importer.runDump(registration, bytes(mixed));
    expect(unchanged.status).toBe('committed');
    expect(unchanged.counts.unchanged).toBe(5);
    expect(sent).toHaveLength(before);
    const changed = structuredClone(mixed);
    const item = changed[1] as (typeof sourceItems)[number];
    item.lastrevid += 1000;
    item.labels.en.value = 'Changed native item';
    expect((await importer.runDump(registration, bytes(changed))).counts.changed).toBe(1);
    const baseline = importer.session.store.source('wikidata');
    const effects = sent.length;
    expect((await importer.runDump(registration, bytes([property]))).status).toBe('mass-disappearance');
    expect(importer.session.store.source('wikidata')).toEqual(baseline);
    expect(sent).toHaveLength(effects);
    expect((await importer.runDump(registration, bytes([...sourceItems, { ...property, id: 'Q1' }]))).status).toBe(
      'invalid-dump',
    );
    expect(importer.session.store.source('wikidata')).toEqual(baseline);
    expect(sent).toHaveLength(effects);
  } finally {
    await importer.close();
  }
});

for (const invalidProperty of [
  { ...property, id: 'P0' },
  { ...property, id: 'P31\n' },
  { ...property, lastrevid: 0 },
  { ...property, lastrevid: null },
  { ...property, type: 'talk' },
]) {
  test(`malformed native property is rejected: ${JSON.stringify(invalidProperty)}`, async () => {
    await expect(
      (async () => {
        for await (const _ of readDump('wikidata', bytes([sourceItems[0], invalidProperty]))) {
          /* consume complete acquisition */
        }
      })(),
    ).rejects.toBeInstanceOf(Error);
  });
}
