import { expect, test } from 'bun:test';
import { crossMediaAliases, planCrossMediaSeed, type CrossMediaTables } from '../src/cross-media-seed.ts';
import { converter_revision as crossMediaRevision } from '../../../packages/conversion/src/cross-media-entities.ts';
import { createSourceRegistration } from '../src/source-registry.ts';

const biography = '人物紹介：創作と音楽を研究する。';
const authoredPerson = {
  id: 8101,
  type: 1,
  name: '星見',
  summary: biography,
  career: ['mangaka'],
  birth_year: 1974,
  birth_mon: 11,
  birth_day: 8,
};
const rows: Record<'bangumi' | 'vndb', Record<string, Record<string, unknown>[]>> = {
  bangumi: {
    subject: [
      { id: 101, name: 'STEINS;GATE', type: 2 },
      { id: 201, name: 'CLANNAD', type: 2 },
      { id: 301, name: 'Fate/stay night', type: 2 },
    ],
    'subject-persons': [{ subject_id: 101, person_id: 8101, position: 1 }],
    person: [authoredPerson],
  },
  vndb: {
    vn_titles: [
      { id: 'v101', lang: 'ja', title: 'STEINS;GATE', latin: 'STEINS;GATE', official: 't' },
      { id: 'v201', lang: 'ja', title: 'CLANNAD', latin: 'CLANNAD', official: 't' },
      { id: 'v301', lang: 'ja', title: 'Fate/stay night', latin: 'Fate/stay night', official: 't' },
    ],
    vn: [
      { id: 'v101', olang: 'ja', alias: null },
      { id: 'v201', olang: 'ja', alias: null },
      { id: 'v301', olang: 'ja', alias: null },
    ],
    entry_meta: [
      { id: 'v101', revision: '1', lastmod: '2026-11-01' },
      { id: 'v201', revision: '1', lastmod: '2026-11-01' },
      { id: 'v301', revision: '1', lastmod: '2026-11-01' },
    ],
  },
};

const input: CrossMediaTables = {
  async *rows(provider, table) {
    for (const row of rows[provider][table] ?? []) yield structuredClone(row);
  },
};

test("cross-media seed preserves a credited person's raw biography for the current Bangumi registration", async () => {
  const plan = await planCrossMediaSeed(input);
  const record = plan.entities.bangumi.find((item) => item.key === 'person:8101');
  expect(record?.payload).toEqual(authoredPerson);
  expect(plan.credits.some((credit) => credit.person === 'person:8101' && credit.work === '101')).toBe(true);

  const registration = createSourceRegistration('bangumi', {
    source: crossMediaAliases.bangumi,
    converterRevision: crossMediaRevision,
  });
  const converted = registration.convert(
    { external_id: record!.key, record_revision: record!.revision, record: record!.payload },
    { source: registration.source, subjectId: '11111111-1111-4111-8111-111111111111' },
  );
  const biographyCommand = converted.proposals.find((command) => command.source.field_group === 'summary');
  const birthCommand = converted.proposals.find(
    (command) => command.op === 'propose' && command.statement.property.id === 'schema:birthDate',
  );
  expect(registration.converter_revision).toBe(crossMediaRevision);
  expect(converted.normalized).toMatchObject({
    summary: biography,
    birth_year: 1974,
    birth_mon: 11,
    birth_day: 8,
  });
  expect(biographyCommand?.op === 'propose' ? biographyCommand.statement.property.id : undefined).toBe(
    'schema:abstract',
  );
  expect(biographyCommand?.source.digest).toBe(converted.digest);
  expect(birthCommand?.op === 'propose' ? birthCommand.statement.value : undefined).toEqual({
    type: 'value',
    content: {
      time: '+1974-11-08T00:00:00Z',
      precision: 11,
      calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
    },
  });

  const foreign = createSourceRegistration('vndb', {
    source: crossMediaAliases.vndb,
    converterRevision: registration.converter_revision,
  }).convert(
    {
      external_id: 's99',
      record_revision: '1',
      record: { id: 's99', name: 'Foreign creator', description: 'Description with unknown rights.' },
    },
    { source: crossMediaAliases.vndb },
  );
  expect(foreign.proposals.some((command) => command.source.field_group === 'summary')).toBe(false);
});
