import { expect, test } from 'bun:test';
import { converter_revision } from '@rezics/conversion/wikidata';
import { bundledRelease } from '@rezics/definitions/bundled';
import { checkStatementInput } from '@rezics/definitions/validate';
import { createSourceRegistration } from '../src/source-registry.ts';
import { readDump } from '../src/dumps.ts';
import { birth, height, losslessRecord, claim } from './wikidata-lossless-fixture.ts';

test('production JSONL registration carries complete released values and withholds unsupported neighbours', async () => {
  const registration = createSourceRegistration('wikidata');
  const record = losslessRecord();
  const decoded = readDump('wikidata', (async function* () { yield new TextEncoder().encode(`${JSON.stringify(record)}\n`); })());
  const rows = await Array.fromAsync(decoded);
  expect(rows).toHaveLength(1);
  const input = { external_id: record.id, record_revision: String(record.lastrevid), record: rows[0]!.payload };
  const context = { source: 'wikidata', subjectId: '00000000-0000-4000-8000-000000000001' };
  const first = registration.convert(input, context);
  expect(registration.converter_revision).toBe(converter_revision);
  const statements = first.proposals.flatMap(c => c.op === 'propose' ? [c.statement] : []);
  expect(statements).toHaveLength(5);
  expect(statements.filter(s => s.property.id === 'schema:birthDate').map(s => s.value)).toEqual([{ type: 'value', content: birth }]);
  expect(statements.filter(s => s.property.id === 'schema:height').map(s => s.value)).toEqual([{ type: 'value', content: height }]);
  expect(statements.filter(s => s.property.id === 'schema:deathDate').map(s => s.value)).toEqual(record.claims.P570.map(c => ({ type: 'value', content: c.mainsnak.datavalue.value })));
  for (const statement of statements) expect(checkStatementInput(statement, bundledRelease).violations).toEqual([]);
  expect(first.diagnostics.length).toBeGreaterThanOrEqual(7);
  const reopened = registration.convert({ ...input, record: JSON.parse(JSON.stringify(first.normalized)) }, context);
  expect(reopened.proposals).toEqual(first.proposals);
  expect(reopened.digest).toBe(first.digest);
  const changed = losslessRecord();
  changed.claims.P2048 = [claim('P2048', 'quantity', { ...height, upperBound: '+9007199254740993.000000000000000003' })];
  const refreshed = registration.convert({ ...input, record: changed }, context);
  expect(refreshed.digest).not.toBe(first.digest);
  expect(refreshed.proposals.map(c => c.key)).not.toEqual(first.proposals.map(c => c.key));
  for (const snaktype of ['somevalue', 'novalue']) {
    const record = losslessRecord();
    Object.assign(record.claims.P569[0]!.mainsnak, { snaktype });
    const output = registration.convert({ ...input, record }, context);
    expect(output.proposals.some(c => c.op === 'propose' && c.statement.property.id === 'schema:birthDate' && c.statement.value.type === snaktype)).toBe(true);
  }
});
