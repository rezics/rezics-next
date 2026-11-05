import { expect, test } from 'bun:test';
import { convertWikidata } from '../src/wikidata';

const subjectId = '00000000-0000-4000-8000-000000000001';
const foodId = '00000000-0000-4000-8000-000000000002';
const item = (property: string, id: string) => ({
  type: 'statement',
  rank: 'normal',
  mainsnak: {
    snaktype: 'value',
    property,
    datatype: 'wikibase-item',
    datavalue: { type: 'wikibase-entityid', value: { 'entity-type': 'item', 'numeric-id': Number(id.slice(1)), id } },
  },
});
function input(types: string[]) {
  return {
    external_id: 'Q1',
    record_revision: 'unversioned',
    record: {
      id: 'Q1',
      type: 'item',
      labels: { en: { language: 'en', value: 'Mapo tofu' }, 'zh-hant': { language: 'zh-hant', value: '麻婆豆腐' } },
      descriptions: { en: { language: 'en', value: 'A Sichuan tofu dish' } },
      recipeInstructions: 'EXCLUDED METHOD',
      images: ['https://commons.wikimedia.org/EXCLUDED_IMAGE.jpg'],
      claims: {
        P31: types.map((id) => item('P31', id)),
        P186: [item('P186', 'Q2'), item('P186', 'Q3')],
        P18: [
          {
            type: 'statement',
            rank: 'normal',
            mainsnak: {
              property: 'P18',
              snaktype: 'value',
              datatype: 'commonsMedia',
              datavalue: { type: 'string', value: 'EXCLUDED_IMAGE.jpg' },
            },
          },
        ],
      },
    },
  };
}

test('reviewed dish and food classes bind locally with dish precedence and other conflicts refused', () => {
  for (const [types, expected] of [
    [['Q746549'], 'schema:Recipe'],
    [['Q2095'], 'wd:Q2095'],
    [['Q25403900'], 'wd:Q2095'],
    [['Q746549', 'Q2095', 'Q25403900'], 'schema:Recipe'],
    [['Q25403900', 'Q2095', 'Q746549'], 'schema:Recipe'],
    [['Q219239'], 'schema:Recipe'],
    [['Q999999999'], undefined],
  ] as const) {
    const output = convertWikidata(input([...types]));
    expect(output.outcome).toBe(expected ? 'converted' : 'ignored');
    expect(output.proposals).toHaveLength(expected ? 1 : 0);
    if (expected) expect(output.proposals[0]).toMatchObject({ op: 'create', subject: { type: expected } });
  }
  for (const types of [
    ['Q746549', 'Q2095', 'Q5'],
    ['Q5', 'Q25403900'],
    ['Q219239', 'Q2095'],
  ])
    expect(() => convertWikidata(input(types))).toThrow('Ambiguous mapped Wikidata entity types');
  const deprecatedDish = input(['Q746549', 'Q2095']);
  deprecatedDish.record.claims.P31[0]!.rank = 'deprecated';
  expect(convertWikidata(deprecatedDish).proposals[0]).toMatchObject({ subject: { type: 'wd:Q2095' } });
});

test('dish metadata and material relations retain CC0 citations and resolution without methods or images', () => {
  const source = input(['Q746549']);
  const bootstrap = convertWikidata(source);
  expect(bootstrap.proposals[0]).toMatchObject({
    subject: {
      labels: { en: 'Mapo tofu', 'zh-Hant': '麻婆豆腐' },
      descriptions: { en: 'A Sichuan tofu dish' },
    },
  });
  const output = convertWikidata(source, { subjectId, resolvedReferences: { Q2: foodId } });
  const statements = output.proposals.flatMap((p) => (p.op === 'propose' ? [p.statement] : []));
  expect(statements.filter((s) => s.property.id === 'wdt:P186').map((s) => s.value)).toEqual([
    { type: 'value', content: foodId },
    { type: 'somevalue' },
  ]);
  for (const statement of statements)
    expect(statement.references?.[0]?.parts).toContainEqual({
      property: { id: 'schema:url' },
      value: { type: 'value', content: 'https://www.wikidata.org/wiki/Q1' },
    });
  expect(JSON.stringify(statements)).toContain('http://www.wikidata.org/entity/Q3');
  expect(statements.map((s) => s.property.id)).toEqual(['schema:name', 'schema:name', 'wdt:P186', 'wdt:P186']);
  expect(output.sourceMetadata.license).toBe('CC0-1.0');
  expect(output.assets).toEqual([]);
  expect(JSON.stringify([bootstrap, output])).not.toMatch(/EXCLUDED/);
  expect(
    convertWikidata({ ...source, record: output.normalizedRecord }, { subjectId, resolvedReferences: { Q2: foodId } }),
  ).toEqual(output);
});
