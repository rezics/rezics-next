import { expect, test } from 'bun:test';
import { checkBatchWrite, type BatchCommand } from '@rezics/definitions/bulk';
import { ConversionError } from '../src/index.ts';
import { converter_revision, convertCrossMediaEntity } from '../src/cross-media-entities.ts';
import { vndbLimits } from '../src/vndb.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
const context = { source: 'vndb', subjectId };

function urls(commands: readonly BatchCommand[]): string[] {
  return commands
    .filter((command) => command.op === 'propose' && command.statement.property.id === 'schema:url')
    .map((command) =>
      command.op === 'propose' && command.statement.value.type === 'value'
        ? String(command.statement.value.content)
        : '',
    );
}

function citation(commands: readonly BatchCommand[], id: string): void {
  for (const command of commands) {
    if (command.op !== 'propose') continue;
    expect(
      command.statement.references
        .flatMap((reference) => reference.parts)
        .some((part) => {
          return (
            part.property.id === 'schema:url' &&
            part.value.type === 'value' &&
            part.value.content === `https://vndb.org/${id}`
          );
        }),
    ).toBe(true);
  }
}

test('selected staff, producer and release websites become sourced schema:url facts on their native types', () => {
  const shared = { id: 7, site: 'website', value: 'https://example.org/shared' };
  const staff = convertCrossMediaEntity(
    {
      external_id: 's4',
      record_revision: null,
      record: {
        id: 's4',
        name: 'Authored staff',
        staff_extlinks: [
          { id: 's4', link: 7 },
          { id: 's4', link: 8 },
        ],
        extlinks: [shared, { id: 8, site: 'website', value: 'https://example.org/staff' }],
      },
    },
    context,
  );
  const producer = convertCrossMediaEntity(
    {
      external_id: 'p1',
      record_revision: null,
      record: {
        id: 'p1',
        name: 'Authored producer',
        producers_extlinks: [{ id: 'p1', link: 7 }],
        extlinks: [shared],
      },
    },
    context,
  );
  const release = convertCrossMediaEntity(
    {
      external_id: 'r1',
      record_revision: null,
      record: {
        id: 'r1',
        title: 'Authored release',
        releases_titles: [{ id: 'r1', lang: 'en', mtl: false, title: 'Authored release', latin: null }],
        releases_extlinks: [{ id: 'r1', link: 9 }],
        extlinks: [{ id: 9, site: 'website', value: 'https://example.org/release' }],
      },
    },
    context,
  );
  expect(converter_revision).toBe('cross-media-entities@9');
  expect(
    staff.proposals[0] && staff.proposals[0].op === 'propose' ? staff.proposals[0].source.converter_revision : '',
  ).toBe(converter_revision);
  const previousRevision = convertCrossMediaEntity(
    { external_id: 's4', record_revision: null, record: staff.normalizedRecord },
    context,
    { converterRevision: 'cross-media-entities@3' },
  );
  const previousBytes = JSON.stringify(previousRevision.proposals);
  const previousReplay = convertCrossMediaEntity(
    { external_id: 's4', record_revision: null, record: staff.normalizedRecord },
    context,
    { converterRevision: 'cross-media-entities@3' },
  );
  expect(JSON.stringify(previousReplay.proposals)).toBe(previousBytes);
  expect(previousRevision.digest).toBe(staff.digest);
  expect(previousRevision.proposals[0]?.key).not.toBe(staff.proposals[0]?.key);
  expect(urls(staff.proposals)).toEqual(['https://example.org/shared', 'https://example.org/staff']);
  expect(urls(producer.proposals)).toEqual(['https://example.org/shared']);
  expect(urls(release.proposals)).toEqual(['https://example.org/release']);
  const individualProducer = convertCrossMediaEntity(
    {
      external_id: 'p2',
      record_revision: null,
      record: {
        id: 'p2',
        type: 'in',
        name: 'Individual producer',
        producers_extlinks: [{ id: 'p2', link: 10 }],
        extlinks: [{ id: 10, site: 'website', value: 'https://example.org/individual' }],
      },
    },
    context,
  );
  const individualCreate = convertCrossMediaEntity({
    external_id: 'p2',
    record_revision: null,
    record: { id: 'p2', type: 'in', name: 'Individual producer' },
  });
  expect(individualCreate.proposals[0]?.op === 'create' ? individualCreate.proposals[0].subject.type : '').toBe(
    'schema:Person',
  );
  expect(urls(individualProducer.proposals)).toEqual(['https://example.org/individual']);
  citation(individualProducer.proposals, 'p2');
  expect(staff.normalizedRecord).toMatchObject({
    id: 's4',
    staff_extlinks: [
      { id: 's4', link: 7 },
      { id: 's4', link: 8 },
    ],
    extlinks: [
      { id: 7, site: 'website', value: 'https://example.org/shared' },
      { id: 8, site: 'website', value: 'https://example.org/staff' },
    ],
  });
  citation(staff.proposals, 's4');
  citation(producer.proposals, 'p1');
  citation(release.proposals, 'r1');
  expect(checkBatchWrite({ commands: [...staff.proposals, ...producer.proposals, ...release.proposals] })).toEqual([]);
  const create = convertCrossMediaEntity({
    external_id: 's4',
    record_revision: null,
    record: { id: 's4', name: 'Authored staff' },
  });
  expect(create.proposals).toHaveLength(1);
  expect(create.proposals[0]?.op === 'create' ? create.proposals[0].subject.type : '').toBe('schema:Person');
  const producerCreate = convertCrossMediaEntity({
    external_id: 'p1',
    record_revision: null,
    record: { id: 'p1', name: 'Authored producer' },
  });
  expect(producerCreate.proposals[0]?.op === 'create' ? producerCreate.proposals[0].subject.type : '').toBe(
    'schema:Organization',
  );
  const releaseCreate = convertCrossMediaEntity({
    external_id: 'r1',
    record_revision: null,
    record: { id: 'r1', title: 'Authored release' },
  });
  expect(releaseCreate.proposals[0]?.op === 'create' ? releaseCreate.proposals[0].subject.type : '').toBe(
    'wd:Q20631656',
  );
  expect(staff.digest).not.toBe(
    convertCrossMediaEntity(
      { external_id: 's4', record_revision: null, record: { id: 's4', name: 'Authored staff' } },
      context,
    ).digest,
  );
});

test('unsupported sites stay source losses; Bangumi-looking websites stay schema:url; malformed and overflow fail', () => {
  const unsupported = convertCrossMediaEntity(
    {
      external_id: 's4',
      record_revision: null,
      record: {
        id: 's4',
        name: 'Authored staff',
        staff_extlinks: [{ id: 's4', link: 1 }],
        extlinks: [{ id: 1, site: 'wikidata', value: 'Q1' }],
      },
    },
    context,
  );
  expect(urls(unsupported.proposals)).toEqual([]);
  expect(unsupported.diagnostics).toEqual([
    { pointer: '/extlinks/0/site', code: 'Unsupported external link site; retained as source metadata only' },
  ]);
  expect(unsupported.normalizedRecord.extlinks).toEqual([{ id: 1, site: 'wikidata', value: 'Q1' }]);
  const bangumiShaped = convertCrossMediaEntity(
    {
      external_id: 's4',
      record_revision: null,
      record: {
        id: 's4',
        name: 'Authored staff',
        staff_extlinks: [{ id: 's4', link: 2 }],
        extlinks: [{ id: 2, site: 'website', value: 'https://bgm.tv/subject/1' }],
      },
    },
    context,
  );
  expect(urls(bangumiShaped.proposals)).toEqual(['https://bgm.tv/subject/1']);
  expect(JSON.stringify(bangumiShaped.proposals)).not.toContain('wdt:P5732');
  for (const value of [
    'javascript:alert(1)',
    'http://example.org/x',
    'https://u:p@example.org/x',
    'https://example.org:8443/x',
    'https://example.org/' + 'x'.repeat(1500),
    'not a url',
    'https://127.0.0.1/x',
  ]) {
    expect(() =>
      convertCrossMediaEntity(
        {
          external_id: 's4',
          record_revision: null,
          record: {
            id: 's4',
            name: 'Authored staff',
            staff_extlinks: [{ id: 's4', link: 1 }],
            extlinks: [{ id: 1, site: 'website', value }],
          },
        },
        context,
      ),
    ).toThrow(ConversionError);
  }
  const overflow = Array.from({ length: vndbLimits.maxLinks + 1 }, (_, i) => ({ id: 's4', link: i + 1 }));
  expect(() =>
    convertCrossMediaEntity(
      {
        external_id: 's4',
        record_revision: null,
        record: {
          id: 's4',
          name: 'Authored staff',
          staff_extlinks: overflow,
          extlinks: overflow.map((row) => ({
            id: row.link,
            site: 'website',
            value: `https://example.org/${row.link}`,
          })),
        },
      },
      context,
    ),
  ).toThrow(ConversionError);
  expect(() =>
    convertCrossMediaEntity(
      {
        external_id: 's4',
        record_revision: null,
        record: {
          id: 's4',
          name: 'Authored staff',
          staff_extlinks: [{ id: 's4', link: 1 }],
          extlinks: [],
        },
      },
      context,
    ),
  ).toThrow(ConversionError);
  expect(() =>
    convertCrossMediaEntity(
      {
        external_id: 's4',
        record_revision: null,
        record: {
          id: 's4',
          name: 'Authored staff',
          staff_extlinks: [
            { id: 's4', link: 1 },
            { id: 's4', link: 1 },
          ],
          extlinks: [{ id: 1, site: 'website', value: 'https://example.org/x' }],
        },
      },
      context,
    ),
  ).toThrow(ConversionError);
  expect(() =>
    convertCrossMediaEntity(
      {
        external_id: 's4',
        record_revision: null,
        record: {
          id: 's4',
          name: 'Authored staff',
          staff_extlinks: [{ id: 's9', link: 1 }],
          extlinks: [{ id: 1, site: 'website', value: 'https://example.org/x' }],
        },
      },
      context,
    ),
  ).toThrow(ConversionError);
});
