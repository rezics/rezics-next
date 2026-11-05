import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite, type BatchCommand } from '@rezics/definitions/bulk';
import type { Release } from '@rezics/definitions';
import { converter_revision, convertCrossMediaEntity, vndbCharacterQuantity } from '../src/cross-media-entities.ts';
import { createSourceRegistration } from '../../../services/importer/src/source-registry.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
const centimeter = 'http://www.wikidata.org/entity/Q174728';
const kilogram = 'http://www.wikidata.org/entity/Q11570';

function character(overrides: Record<string, unknown> = {}) {
  return {
    external_id: 'c1',
    record_revision: null,
    record: { id: 'c1', name: 'Authored heroine', height: '157', weight: '48', ...overrides },
  };
}

function quantities(proposals: readonly BatchCommand[]) {
  return Object.fromEntries(
    proposals.flatMap((command) =>
      command.op === 'propose' &&
      (command.statement.property.id === 'schema:height' || command.statement.property.id === 'schema:weight') &&
      command.statement.value.type === 'value'
        ? [[command.statement.property.id, command.statement.value.content]]
        : [],
    ),
  );
}

test('production caller publishes exact COPY height and weight and keeps unknown measurements absent', () => {
  expect(converter_revision).toBe('cross-media-entities@14');
  const registration = createSourceRegistration('vndb', {
    source: 'vndb_cross_media',
    converterRevision: converter_revision,
  });
  const bound = registration.convert(character(), { source: registration.source, subjectId });
  expect(checkBatchWrite({ commands: [...bound.proposals] }, bundledRelease)).toEqual([]);
  expect(bound.normalized).toMatchObject({ id: 'c1', name: 'Authored heroine', height: '157', weight: '48' });
  expect(quantities(bound.proposals)).toEqual({
    'schema:height': { amount: '+157', unit: centimeter },
    'schema:weight': { amount: '+48', unit: kilogram },
  });
  const cited = bound.proposals.find(
    (command) => command.op === 'propose' && command.statement.property.id === 'schema:height',
  );
  if (cited?.op !== 'propose') throw new Error('Missing height proposal');
  expect(cited.statement.references).toEqual([
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://vndb.org/c1' } }] },
  ]);
  const unknown = convertCrossMediaEntity(character({ height: '0', weight: null }), { subjectId });
  expect(unknown.normalizedRecord).toMatchObject({ height: '0', weight: null });
  expect(quantities(unknown.proposals)).toEqual({});
  expect(unknown.diagnostics).toEqual([]);
  expect(
    unknown.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'wdt:P3180'),
  ).toBe(true);
  expect(unknown.digest).not.toBe(bound.digest);
});

test('source sentinels, malformed numeric cells and withdrawn units never become native quantities', () => {
  const bound = (record: Record<string, unknown>) =>
    convertCrossMediaEntity(
      { external_id: 'c1', record_revision: null, record: { id: 'c1', name: 'Authored heroine', ...record } },
      { subjectId },
    );
  for (const cell of ['-1', '157.5', 'NaN', 'Infinity', '32768', '000157', '+157', ' ', '1'.repeat(20)]) {
    const height = bound({ height: cell });
    expect(height.diagnostics).toContainEqual({ pointer: '/height', code: 'invalid_source_value' });
    expect(quantities(height.proposals)).toEqual({});
  }
  expect(quantities(bound({ height: 157 }).proposals)).toEqual({});
  expect(bound({ height: 157 }).diagnostics).toContainEqual({ pointer: '/height', code: 'invalid_source_value' });
  expect(vndbCharacterQuantity('157', 'schema:height')).toEqual({ amount: '+157', unit: centimeter });
  expect(vndbCharacterQuantity('0', 'schema:height')).toBe('unknown');
  expect(vndbCharacterQuantity('0', 'schema:weight')).toBe('unknown');
  expect(vndbCharacterQuantity(null, 'schema:weight')).toBe('unknown');
  expect(vndbCharacterQuantity('\\N', 'schema:height')).toBe('invalid');
  const withdrawn = structuredClone(bundledRelease) as Release;
  withdrawn.properties['schema:height']!.units = ['http://www.wikidata.org/entity/Q11573'];
  expect(vndbCharacterQuantity('157', 'schema:height', withdrawn)).toBe('unadmitted');
  const removed = structuredClone(bundledRelease) as Release;
  removed.types['wd:Q95074']!.properties = removed.types['wd:Q95074']!.properties.filter(
    (property) => property !== 'schema:weight',
  );
  expect(vndbCharacterQuantity('48', 'schema:weight', removed)).toBe('unadmitted');
});
