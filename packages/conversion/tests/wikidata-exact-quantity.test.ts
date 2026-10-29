import { expect, test } from 'bun:test';
import record from '../../../specs/fixtures/imports/wikidata/entity.json';
import { convertWikidata } from '../src/wikidata';

const subjectId = '00000000-0000-4000-8000-000000000001';
const pointer = '/claims/P6570';
type FixtureEntity = {
  id: string;
  lastrevid: number;
  claims: Record<string, Array<{ qualifiers?: Record<string, unknown[]>; [key: string]: unknown }>>;
};
function entity(qualifiers?: Record<string, unknown[]>) {
  const copy = structuredClone(record) as unknown as FixtureEntity;
  copy.claims.P6570 = [
    {
      type: 'statement',
      rank: 'normal',
      mainsnak: {
        snaktype: 'value',
        property: 'P6570',
        datatype: 'quantity',
        datavalue: { type: 'quantity', value: { amount: '+1450', unit: '1' } },
      },
      ...(qualifiers === undefined ? {} : { qualifiers }),
    },
  ];
  return copy;
}
function convert(source: ReturnType<typeof entity>) {
  return convertWikidata(
    { external_id: source.id, record_revision: String(source.lastrevid), record: source },
    { subjectId },
  );
}
const stringSnak = (property: string, value: string) => ({
  snaktype: 'value',
  property,
  datatype: 'string',
  datavalue: { type: 'string', value },
});

test('unqualified exact quantity remains an ordinary admitted conversion', () => {
  const output = convert(entity());
  const count = output.proposals.find(
    (command) => command.op === 'propose' && command.statement.property.id === 'schema:wordCount',
  );
  expect(count).toBeDefined();
  expect(output.diagnostics.filter((diagnostic) => diagnostic.pointer === pointer)).toEqual([]);
});

test('mapped but unadmitted qualifier withholds the whole exact quantity', () => {
  const output = convert(entity({ P1545: [stringSnak('P1545', '1')] }));
  expect(
    output.proposals.filter(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:wordCount',
    ),
  ).toEqual([]);
  expect(output.diagnostics.some((diagnostic) => diagnostic.pointer === pointer)).toBe(true);
});

test('unknown and unresolved item qualifiers withhold the whole exact quantity', () => {
  const unknown = convert(entity({ P459: [{ snaktype: 'somevalue', property: 'P459', datatype: 'wikibase-item' }] }));
  expect(
    unknown.proposals.filter(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:wordCount',
    ),
  ).toEqual([]);
  expect(unknown.diagnostics.some((diagnostic) => diagnostic.pointer === pointer)).toBe(true);

  const unresolved = convert(
    entity({ P518: [{ snaktype: 'somevalue', property: 'P518', datatype: 'wikibase-item' }] }),
  );
  expect(
    unresolved.proposals.filter(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:wordCount',
    ),
  ).toEqual([]);
  expect(unresolved.diagnostics.some((diagnostic) => diagnostic.pointer === pointer)).toBe(true);
});

test('unknown qualifier bodies are rejected without being read', () => {
  const source = entity();
  const qualifiers: Record<string, unknown[]> = {};
  Object.defineProperty(qualifiers, 'P459', {
    enumerable: true,
    get() {
      throw new Error('unknown qualifier body was read');
    },
  });
  source.claims.P6570![0]!.qualifiers = qualifiers;

  const output = convert(source);
  expect(
    output.proposals.filter(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:wordCount',
    ),
  ).toEqual([]);
  expect(output.diagnostics.some((diagnostic) => diagnostic.pointer === pointer)).toBe(true);
});

test('established nonmeasurement output remains unchanged by exact qualifier rejection', () => {
  const plain = convert(entity());
  const withRejectedMeasurement = convert(
    entity({ P459: [{ snaktype: 'somevalue', property: 'P459', datatype: 'wikibase-item' }] }),
  );
  const ordinary = (output: ReturnType<typeof convert>) =>
    output.proposals
      .filter((command) => command.op === 'propose' && command.statement.property.id !== 'schema:wordCount')
      .map((command) => command.statement);
  expect(ordinary(withRejectedMeasurement)).toEqual(ordinary(plain));
});
