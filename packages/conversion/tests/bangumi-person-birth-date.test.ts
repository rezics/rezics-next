import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite, type BatchCommand } from '@rezics/definitions/bulk';
import { checkStatementInput } from '@rezics/definitions/validate';
import { convertCrossMediaEntity, converter_revision } from '../src/cross-media-entities.ts';
import { projectBangumiPersonBirthDate } from '../src/bangumi-person-birth-date.ts';

const source = 'bangumi_cross_media';
const subjectId = '11111111-1111-4111-8111-111111111111';
const pinned = JSON.parse(
  readFileSync(new URL('../../../specs/fixtures/imports/bangumi/person-birth-date.json', import.meta.url), 'utf8'),
) as {
  id: number;
  type: number;
  name: string;
  birth_year: number;
  birth_mon: number;
  birth_day: number;
  personURL: string;
};
const gregorian = {
  time: '+1974-11-08T00:00:00Z',
  precision: 11,
  calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
};

function convert(record: Record<string, unknown>, bound = true) {
  return convertCrossMediaEntity(
    { external_id: `person:${record.id as number}`, record_revision: null, record },
    { source, ...(bound ? { subjectId } : {}) },
    { sourceKind: 'bangumi' },
  );
}

function birth(result: ReturnType<typeof convert>) {
  return result.proposals.find(
    (command): command is Extract<BatchCommand, { op: 'propose' }> =>
      command.op === 'propose' && command.statement.property.id === 'schema:birthDate',
  );
}

test('an actual type-1 Person date becomes a cited day-precision birthDate on unchanged identity', () => {
  expect(converter_revision).toBe('cross-media-entities@14');
  const person = convert({
    id: pinned.id,
    type: pinned.type,
    name: pinned.name,
    summary: '漫画家。',
    birth_year: pinned.birth_year,
    birth_mon: pinned.birth_mon,
    birth_day: pinned.birth_day,
  });
  const proposal = birth(person);
  expect(person.normalizedRecord).toMatchObject({
    id: 641,
    type: 1,
    name: '岸本斉史',
    summary: '漫画家。',
    birth_year: 1974,
    birth_mon: 11,
    birth_day: 8,
  });
  expect(proposal?.source).toMatchObject({
    source,
    external_id: 'person:641',
    record_revision: 'unversioned',
    converter_revision,
    digest: person.digest,
    field_group: 'facts',
  });
  expect(proposal?.statement.value).toEqual({ type: 'value', content: gregorian });
  expect(proposal?.statement.references).toEqual([
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: pinned.personURL } }] },
  ]);
  expect(checkStatementInput(proposal!.statement, bundledRelease)).toEqual({ violations: [], targets: [] });
  expect(checkBatchWrite({ commands: [proposal!] }, bundledRelease)).toEqual([]);
  const changed = convert({
    id: 641,
    type: 1,
    name: '岸本斉史',
    birth_year: 1974,
    birth_mon: 11,
    birth_day: 9,
  });
  expect(changed.digest).not.toBe(person.digest);
  expect(birth(changed)?.key).not.toBe(proposal?.key);
  expect(birth(changed)?.statement.value).toEqual({
    type: 'value',
    content: { ...gregorian, time: '+1974-11-09T00:00:00Z' },
  });
});

test('partial, invalid and Organization dates are withheld while independent person facts remain', () => {
  const biography = convert({ id: 8101, type: 1, name: '星見', summary: '作者。', birth_year: 1974 });
  expect(birth(biography)).toBeUndefined();
  expect(biography.normalizedRecord.summary).toBe('作者。');
  expect(biography.diagnostics).toContainEqual({
    pointer: '/birth_mon',
    code: 'omitted_partial_person_birth_date',
  });
  expect(
    biography.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:name'),
  ).toBe(true);

  for (const record of [
    { id: 2, type: 1, name: 'a', birth_year: 1974, birth_mon: 11, birth_day: 0 },
    { id: 3, type: 1, name: 'a', birth_year: 1974, birth_mon: 11, birth_day: null },
    { id: 4, type: 1, name: 'a', birth_year: '1974', birth_mon: 11, birth_day: 8 },
    { id: 5, type: 1, name: 'a', birth_year: 1974.5, birth_mon: 11, birth_day: 8 },
    { id: 6, type: 1, name: 'a', birth_year: 1900, birth_mon: 2, birth_day: 29 },
    { id: 7, type: 1, name: 'a', birth_year: 2023, birth_mon: 2, birth_day: 29 },
    { id: 8, type: 1, name: 'a', birth_year: 1974, birth_mon: 13, birth_day: 8 },
  ])
    expect(birth(convert(record))).toBeUndefined();

  const leap = birth(convert({ id: 9, type: 1, name: 'a', birth_year: 2000, birth_mon: 2, birth_day: 29 }));
  expect(leap?.statement.value).toEqual({
    type: 'value',
    content: { time: '+2000-02-29T00:00:00Z', precision: 11, calendarmodel: gregorian.calendarmodel },
  });

  const organization = convert({
    id: 8102,
    type: 2,
    name: '星見制作室',
    summary: '制作室。',
    birth_year: 1999,
    birth_mon: 1,
    birth_day: 1,
  });
  expect(birth(organization)).toBeUndefined();
  expect(organization.diagnostics).toContainEqual({ pointer: '/type', code: 'unadmitted_person_birth_date' });
  expect(organization.normalizedRecord.summary).toBe('制作室。');
  expect(
    projectBangumiPersonBirthDate({ profile: 'schema:Organization', birth_year: 1999, birth_mon: 1, birth_day: 1 }),
  ).toEqual({ diagnostic: { pointer: '/type', code: 'unadmitted_person_birth_date' } });

  const character = convertCrossMediaEntity(
    {
      external_id: 'character:200',
      record_revision: null,
      record: {
        id: 200,
        name: '岡部',
        type: 1,
        infobox: '{{Infobox Crt\n|生日=1984年1月1日\n}}',
      },
    },
    { source, subjectId },
    { sourceKind: 'bangumi' },
  );
  expect(
    character.proposals.some(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:birthDate',
    ),
  ).toBe(false);
  expect(character.diagnostics).toContainEqual({
    pointer: '/infobox/fields/0',
    code: 'omitted_partial_or_fictional_birthday',
  });
});
