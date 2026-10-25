import { expect, test } from 'bun:test';
import { readDump } from '../src/dumps';
async function collect(payload: unknown) {
  async function* input() {
    yield new TextEncoder().encode(JSON.stringify(payload) + '\n');
  }
  const rows = [];
  for await (const row of readDump('wikidata', input(), { maxRecordBytes: 65536 })) rows.push(row);
  return rows;
}
test('missing Wikidata native revision stays absent while malformed explicit revisions reject', async () => {
  const record = { id: 'Q1', type: 'item', labels: { en: { language: 'en', value: 'Example' } }, claims: {} };
  expect(await collect(record)).toEqual([{ source: 'wikidata', key: 'Q1', revision: null, payload: record }]);
  expect((await collect({ ...record, lastrevid: 7 }))[0]!.revision).toBe('7');
  for (const lastrevid of [null, 0, -1, 0.5, '7', 'bad'])
    await expect(collect({ ...record, lastrevid })).rejects.toThrow();
});
