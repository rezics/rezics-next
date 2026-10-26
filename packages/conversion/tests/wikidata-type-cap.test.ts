import { expect, test } from 'bun:test';
import record from '../../../specs/fixtures/imports/wikidata/entity.json';
import { convertWikidata, wikidataLimits } from '../src/wikidata';

// The preserved P31 type statement counts once toward the statement cap, even when a catalogue property maps P31.
test('the Wikidata statement cap counts the type statement once', () => {
  const types = record.claims.P31;
  const claim = record.claims.P50[0]!;
  const entity = (fields: number) => ({
    ...record,
    claims: {
      P31: types,
      P50: Array.from({ length: fields }, (_, i) => ({
        ...claim,
        id: `${record.id}$00000000-0000-4000-8000-${String(1000 + i).padStart(12, '0')}`,
        mainsnak: {
          ...claim.mainsnak,
          datavalue: {
            ...claim.mainsnak.datavalue,
            value: { 'entity-type': 'item', 'numeric-id': 1000 + i, id: `Q${1000 + i}` },
          },
        },
      })),
    },
  });
  const convert = (fields: number) =>
    convertWikidata({ external_id: record.id, record_revision: String(record.lastrevid), record: entity(fields) });
  const largest = wikidataLimits.statements - types.length;
  expect(() => convert(largest)).not.toThrow();
  expect(() => convert(largest + 1)).toThrow('Source statement limit exceeded');
});
