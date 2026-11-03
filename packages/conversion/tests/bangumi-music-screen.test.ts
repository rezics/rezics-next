import { expect, test } from 'bun:test';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import { convertBangumi, converter_revision } from '../src/bangumi.ts';
import { ConversionError } from '../src/index.ts';

const subjectId = '00000000-0000-4000-8000-000000000001';
const mediaId = '00000000-0000-4000-8000-000000000002';
const image = 'https://lain.bgm.tv/pic/cover/l/music.jpg';
const subject = (type: number, extra: Record<string, unknown> = {}) => ({
  id: 81,
  type,
  name: 'Original title',
  name_cn: '中文标题',
  summary: 'Complete summary.',
  images: { large: image },
  date: '2024-04-01',
  ...extra,
});
const input = (record: object) => ({ external_id: '81', record_revision: 'native:7', record });
const bound = { subjectId, mediaIds: { [image]: mediaId } };

test('type 3 uses MusicAlbum without inventing tracks or an album/recording split', () => {
  const bootstrap = convertBangumi(input(subject(3, { platform: '0', infobox: '{{Infobox Album\n|碟片=1\n|曲目=A / 3:21\n}}' })));
  expect(converter_revision).toBe('bangumi@5');
  expect(bootstrap.outcome).toBe('converted');
  expect(bootstrap.proposals[0]).toMatchObject({
    op: 'create',
    subject: { type: 'schema:MusicAlbum', labels: { und: 'Original title', zh: '中文标题' } },
  });
  expect(bootstrap.proposals).toHaveLength(1);
  expect(JSON.stringify(bootstrap.proposals)).not.toMatch(/schema:MusicRecording|track/i);
  const resolved = convertBangumi(input(subject(3, { platform: '0' })), bound);
  expect(checkBatchWrite({ commands: [...resolved.proposals] })).toEqual([]);
  expect(resolved.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:datePublished')).toBe(
    true,
  );
  expect(resolved.diagnostics).toContainEqual({ pointer: '/platform', code: 'source_platform_selects_profile' });
  expect(convertBangumi(input(resolved.normalizedRecord), bound)).toEqual(resolved);
});

test('type 6 dispatches movie and series from pinned platform or template', () => {
  expect(convertBangumi(input(subject(6, { platform: 'movie' }))).proposals[0]).toMatchObject({
    subject: { type: 'schema:Movie' },
  });
  expect(convertBangumi(input(subject(6, { platform: 6002 }))).proposals[0]).toMatchObject({
    subject: { type: 'schema:Movie' },
  });
  expect(convertBangumi(input(subject(6, { platform: '电影' }))).proposals[0]).toMatchObject({
    subject: { type: 'schema:Movie' },
  });
  expect(convertBangumi(input(subject(6, { platform: '6001' }))).proposals[0]).toMatchObject({
    subject: { type: 'schema:TVSeries' },
  });
  expect(convertBangumi(input(subject(6, { platform: 6003 }))).proposals[0]).toMatchObject({
    subject: { type: 'schema:TVSeries' },
  });
  expect(convertBangumi(input(subject(6, { infobox: '{{Infobox realMovie\n|上映年度=2024\n}}' }))).proposals[0]).toMatchObject({
    subject: { type: 'schema:Movie' },
  });
  const unknown = convertBangumi(input(subject(6, { platform: 'unmapped-kind' })));
  expect(unknown.outcome).toBe('ignored');
  expect(unknown.proposals).toEqual([]);
  expect(unknown.diagnostics).toContainEqual({ pointer: '/platform', code: 'unknown_live_action_platform' });
  expect(unknown.normalizedRecord).toMatchObject({ id: 81, type: 6, name: 'Original title', platform: 'unmapped-kind' });
});

test('identity-only ignored 3/6 projections remain ignored and a named payload converts', () => {
  for (const type of [3, 6] as const) {
    const ignored = convertBangumi({ external_id: '81', record_revision: null, record: { id: 81, type } });
    expect(ignored.outcome).toBe('ignored');
    expect(ignored.normalizedRecord).toEqual({ id: 81, type });
    expect(convertBangumi({ external_id: '81', record_revision: null, record: ignored.normalizedRecord })).toEqual(ignored);
    const converted = convertBangumi(input(subject(type)));
    expect(converted.outcome).toBe('converted');
    expect(converted.digest).not.toBe(ignored.digest);
  }
});

test('types 1/2/4 keep prior class bindings and do not emit dates', () => {
  for (const [type, expected] of [
    [1, 'schema:Book'],
    [2, 'schema:TVSeries'],
    [4, 'schema:VideoGame'],
  ] as const) {
    const bootstrap = convertBangumi(input(subject(type, { platform: 'movie' })));
    expect(bootstrap.proposals[0]).toMatchObject({ subject: { type: expected } });
    const resolved = convertBangumi(input(subject(type, { date: '2024-04-01' })), bound);
    expect(resolved.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:datePublished')).toBe(
      false,
    );
    expect(resolved.diagnostics).toContainEqual({ pointer: '/date', code: 'unsupported_date_mapping' });
  }
});

test('unparseable 3/6 dates stay reviewable and do not invent precision', () => {
  const output = convertBangumi(input(subject(3, { date: 'TBA' })), bound);
  expect(output.outcome).toBe('converted');
  expect(output.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:datePublished')).toBe(
    false,
  );
  expect(output.diagnostics).toContainEqual({ pointer: '/date', code: 'unsupported_date_mapping' });
  const month = convertBangumi(input(subject(6, { platform: 6002, date: '2024-05' })), bound);
  expect(month.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:datePublished' && command.statement.value.type === 'value' && (command.statement.value.content as { precision: number }).precision === 10)).toBe(
    true,
  );
  expect(() => convertBangumi(input({ id: 81, type: 5, name: 'X' }))).toThrow(ConversionError);
});
