import { expect, test } from 'bun:test';
import { convertCrossMediaEntity } from '@rezics/conversion/cross-media-entities';
import { bangumiStaffRoleMapping } from '@rezics/conversion/bangumi-vocabulary';
import { planCrossMediaSeed, type CrossMediaTables } from '../src/cross-media-seed.ts';

test('selected Game planning preserves type-4 staff occurrences and excludes Game character and voice rows', async () => {
  const rows = [
    { subject_id: 999, person_id: 1, position: 1001 },
    { subject_id: 101, person_id: 11, position: 1001, creditedAs: 'Lead developer', appear_eps: '0' },
    { subject_id: 101, person_id: 12, position: 1004, creditedAs: 'Scenario writer', appear_eps: null },
    { subject_id: 101, person_id: 99, position: 1006, creditedAs: 'Composer', appear_eps: '' },
  ];
  const tables: CrossMediaTables = {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') yield { id: 101, name: 'STEINS;GATE', type: 4 };
      if (provider === 'bangumi' && table === 'subject-persons') yield* rows;
      if (provider === 'bangumi' && table === 'person-characters')
        yield { subject_id: 101, person_id: 12, character_id: 21, summary: 'Voice association' };
      if (provider === 'bangumi' && table === 'subject-characters')
        yield { subject_id: 101, character_id: 22, type: 1, order: 1 };
      if (provider === 'bangumi' && table === 'person') {
        yield { id: 11, type: 1, name: 'Creator 11' };
        yield { id: 12, type: 1, name: 'Creator 12' };
      }
    },
  };

  const plan = await planCrossMediaSeed(tables);
  expect(plan.records.bangumi.map(({ key }) => key)).toContain('101');
  expect(plan.credits).toEqual([
    {
      kind: 'staff',
      work: '101',
      workType: 4,
      person: 'person:11',
      roleCode: 1001,
      creditedAs: 'Lead developer',
      path: '/subject-persons/101/11/position',
      record: rows[1]!,
    },
    {
      kind: 'staff',
      work: '101',
      workType: 4,
      person: 'person:12',
      roleCode: 1004,
      creditedAs: 'Scenario writer',
      path: '/subject-persons/101/12/position',
      record: rows[2]!,
    },
    {
      kind: 'staff',
      work: '101',
      workType: 4,
      person: 'person:99',
      roleCode: 1006,
      creditedAs: 'Composer',
      path: '/subject-persons/101/99/position',
      record: rows[3]!,
    },
  ]);
  expect(plan.entities.bangumi.some(({ key }) => key === 'character:21' || key === 'character:22')).toBe(false);
  expect(bangumiStaffRoleMapping(4, 1001)).toMatchObject({
    property: 'wdt:P178',
    uri: 'https://rezics.com/schemes/bangumi/staff/1001',
    sourceUri:
      'https://github.com/bangumi/common/blob/2ee87b9995353f77cf02e390e8635bf97dbc1fa2/subject_staffs.yml',
  });
  expect(bangumiStaffRoleMapping(4, 1004)?.property).toBe('schema:author');
});

test('an unknown Bangumi person type is withheld instead of defaulting to Person', () => {
  expect(() =>
    convertCrossMediaEntity(
      { external_id: 'person:99', record_revision: null, record: { id: 99, type: 99, name: 'Unknown profile' } },
      { source: 'bangumi_cross_media' },
      { sourceKind: 'bangumi' },
    ),
  ).toThrow();
});
