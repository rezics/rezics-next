import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite, type BatchCommand } from '@rezics/definitions/bulk';
import {
  bangumiCharacterMeasurementLimits,
  projectBangumiCharacterMeasurements,
} from '../src/bangumi-character-measurements.ts';
import { convertCrossMediaEntity, converter_revision } from '../src/cross-media-entities.ts';

const subjectId = '11111111-1111-4111-8111-111111111111';
const url = 'https://bgm.tv/character/200';

function convert(infobox: string) {
  return convertCrossMediaEntity(
    {
      external_id: 'character:200',
      record_revision: null,
      record: {
        id: 200,
        name: 'Rintaro Okabe',
        name_cn: '岡部倫太郎',
        type: 1,
        summary: 'A scientist.',
        infobox,
      },
    },
    { source: 'bangumi_cross_media', subjectId },
    { sourceKind: 'bangumi' },
  );
}

function proposals(result: ReturnType<typeof convert>, property: string) {
  return result.proposals.filter(
    (command): command is Extract<BatchCommand, { op: 'propose' }> =>
      command.op === 'propose' && command.statement.property.id === property,
  );
}

function evidence(result: ReturnType<typeof convert>) {
  return (result.normalizedRecord.characterPhysicalProfile as { fields: Record<string, unknown>[] }).fields;
}

test('Bangumi Crt quantities preserve explicit units and evidence while unsupported profile fields stay local', () => {
  const result = convert(`{{Infobox Crt
|血型=A
|身高= 1.72 m
|体重=56000 g
|生日=1984年1月1日
|BWH=88/60/86
}}`);
  expect(converter_revision).toBe('cross-media-entities@8');
  expect(result.normalizedRecord).toMatchObject({
    id: 200,
    name: 'Rintaro Okabe',
    name_cn: '岡部倫太郎',
    type: 1,
    summary: 'A scientist.',
  });
  expect(evidence(result)).toEqual([
    { field: 'bloodType', pointer: '/infobox/fields/0', outcome: 'unavailable', sourceValue: 'A', sourceValueBytes: 1 },
    {
      field: 'height',
      pointer: '/infobox/fields/1',
      outcome: 'quantity',
      sourceValue: ' 1.72 m',
      sourceValueBytes: 7,
      quantity: { amount: '+1.72', unit: 'http://www.wikidata.org/entity/Q11573' },
    },
    {
      field: 'weight',
      pointer: '/infobox/fields/2',
      outcome: 'quantity',
      sourceValue: '56000 g',
      sourceValueBytes: 7,
      quantity: { amount: '+56000', unit: 'http://www.wikidata.org/entity/Q41803' },
    },
  ]);
  const heights = proposals(result, 'schema:height');
  const weights = proposals(result, 'schema:weight');
  expect(heights.map((command) => command.statement.value)).toEqual([
    { type: 'value', content: { amount: '+1.72', unit: 'http://www.wikidata.org/entity/Q11573' } },
  ]);
  expect(weights.map((command) => command.statement.value)).toEqual([
    { type: 'value', content: { amount: '+56000', unit: 'http://www.wikidata.org/entity/Q41803' } },
  ]);
  expect(proposals(result, 'wdt:P1853')).toEqual([]);
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      { pointer: '/infobox/fields/0', code: 'blood_type_concept_binding_unavailable' },
      { pointer: '/infobox/fields/3', code: 'omitted_partial_or_fictional_birthday' },
      { pointer: '/infobox/fields/4', code: 'omitted_composite_bwh' },
    ]),
  );
  expect(heights[0]?.statement.references?.[0]?.parts).toContainEqual({
    property: { id: 'schema:url' },
    value: { type: 'value', content: url },
  });
  expect(checkBatchWrite({ commands: [...heights, ...weights] }, bundledRelease)).toEqual([]);
});

test('unknown, unitless and removed fields do not erase an independent measurement', () => {
  const unknown = convert(`{{Infobox Crt
|身高=未知
|体重=52
}}`);
  expect(proposals(unknown, 'schema:height')).toEqual([]);
  expect(proposals(unknown, 'schema:weight')).toEqual([]);
  expect(evidence(unknown)).toMatchObject([
    { field: 'height', outcome: 'unknown', sourceValue: '未知' },
    { field: 'weight', outcome: 'unavailable', sourceValue: '52' },
  ]);
  expect(unknown.diagnostics).toEqual(
    expect.arrayContaining([
      { pointer: '/infobox/fields/0', code: 'unknown_source_value' },
      { pointer: '/infobox/fields/1', code: 'missing_explicit_unit' },
    ]),
  );
  expect(proposals(convert('{{Infobox Crt\n|身高=0cm\n}}'), 'schema:height')[0]?.statement.value).toMatchObject({
    content: { amount: '+0', unit: 'http://www.wikidata.org/entity/Q174728' },
  });

  for (const unsupported of ['约170cm', '170–175cm', '7 fictional-units', '170cm and tall'])
    expect(proposals(convert(`{{Infobox Crt\n|身高=${unsupported}\n}}`), 'schema:height')).toEqual([]);

  const before = convert(`{{Infobox Crt
|身高=172cm
|体重=56kg
}}`);
  const after = convert(`{{Infobox Crt
|体重=56kg
}}`);
  expect(after.digest).not.toBe(before.digest);
  expect(proposals(after, 'schema:height')).toEqual([]);
  expect(proposals(after, 'schema:weight')).toHaveLength(1);
  expect(proposals(after, 'schema:weight')[0]?.statement.value).toMatchObject({
    content: { amount: '+56', unit: 'http://www.wikidata.org/entity/Q11570' },
  });
  expect(evidence(after)).toMatchObject([{ field: 'weight', pointer: '/infobox/fields/0', sourceValue: '56kg' }]);
});

test('physical projection rejects exceeded source and value bounds before quantity output', () => {
  const oversized = projectBangumiCharacterMeasurements(
    `{{Infobox Crt\n|身高=${'1'.repeat(bangumiCharacterMeasurementLimits.maxQuantityCharacters + 1)}cm\n}}`,
  );
  expect(oversized.measurements).toEqual([]);
  expect(oversized.diagnostics).toContainEqual({ pointer: '/infobox/fields/0', code: 'quantity_length_limit' });

  const tooManyFields = projectBangumiCharacterMeasurements(
    `{{Infobox Crt\n|身高=172cm\n${'|x=value\n'.repeat(bangumiCharacterMeasurementLimits.maxFields)}|体重=56kg\n}}`,
  );
  expect(tooManyFields.measurements).toEqual([]);
  expect(tooManyFields.diagnostics).toContainEqual({ pointer: '/infobox', code: 'infobox_field_limit' });

  const tooDeep = projectBangumiCharacterMeasurements(
    '{{Infobox Crt\n|metadata={{a|{{b}}}}\n|身高=172cm\n}}',
  );
  expect(tooDeep.measurements).toEqual([]);
  expect(tooDeep.diagnostics).toContainEqual({ pointer: '/infobox/fields/0', code: 'infobox_depth_limit' });

  const tooLarge = projectBangumiCharacterMeasurements(
    `{{Infobox Crt\n|身高=172cm\n${'x'.repeat(bangumiCharacterMeasurementLimits.sourceBytes)}}`,
  );
  expect(tooLarge.measurements).toEqual([]);
  expect(tooLarge.diagnostics).toContainEqual({ pointer: '/infobox', code: 'infobox_byte_limit' });
});
