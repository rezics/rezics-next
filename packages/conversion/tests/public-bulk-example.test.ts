import { expect, test } from 'bun:test';
import { ConversionError, type ConversionInput, type SourceId } from '@rezics/conversion';
import { convertBangumi, converter_revision as bangumiRevision } from '@rezics/conversion/bangumi';
import { convertVndb, converter_revision as vndbRevision } from '@rezics/conversion/vndb';
import { convertOpenLibrary, converter_revision as openLibraryRevision } from '@rezics/conversion/open-library';
import { convertWikidata, converter_revision as wikidataRevision } from '@rezics/conversion/wikidata';
import { checkBatchWrite, type BatchWriteRequest, type BatchWriteResult } from '@rezics/definitions/bulk';
import { publicBulkRecord } from '../examples/public-bulk.ts';
import bangumi from '../../../specs/fixtures/imports/bangumi/subject.json';
import vndb from '../../../specs/fixtures/imports/vndb/record.json';
import work from '../../../specs/fixtures/imports/open-library/work.json';
import entity from '../../../specs/fixtures/imports/wikidata/entity.json';

// Protocol doubles below prove the example's local binding guards, never native identity or authorization.
const id = '00000000-0000-4000-8000-000000000001';
const feeds = [
  {
    source: 'bangumi',
    convert: convertBangumi,
    revision: bangumiRevision,
    input: {
      external_id: String(bangumi.id),
      record_revision: '7',
      record: { id: bangumi.id, type: bangumi.type, name: bangumi.name },
    },
  },
  {
    source: 'vndb',
    convert: convertVndb,
    revision: vndbRevision,
    input: {
      external_id: vndb.vn.id,
      record_revision: String(vndb.entry_meta.revision),
      record: { vn: { id: vndb.vn.id }, entry_meta: vndb.entry_meta, vn_titles: vndb.vn_titles },
    },
  },
  {
    source: 'openlibrary',
    convert: convertOpenLibrary,
    revision: openLibraryRevision,
    input: {
      external_id: work.key,
      record_revision: String(work.revision),
      record: {
        type: work.type,
        key: work.key,
        revision: work.revision,
        last_modified: work.last_modified,
        title: work.title,
      },
    },
  },
  {
    source: 'wikidata',
    convert: convertWikidata,
    revision: wikidataRevision,
    input: {
      external_id: entity.id,
      record_revision: String(entity.lastrevid),
      record: {
        id: entity.id,
        type: entity.type,
        lastrevid: entity.lastrevid,
        labels: entity.labels,
        claims: { P31: entity.claims.P31 },
      },
    },
  },
] satisfies {
  source: SourceId;
  input: ConversionInput;
  convert: typeof convertBangumi | typeof convertVndb | typeof convertOpenLibrary | typeof convertWikidata;
  revision: string;
}[];

function freeze(value: unknown) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
for (const feed of feeds) {
  test(`${feed.source}: public example rebinds the same normalized export without trusting the source body`, async () => {
    const input = structuredClone(feed.input);
    Object.assign(input.record, {
      source: 'hostile',
      converter_revision: 'hostile',
      subjectId: 'hostile',
      mediaIds: { hostile: id },
    });
    const before = structuredClone(input);
    freeze(input);
    const requests: BatchWriteRequest[] = [];
    const result = await publicBulkRecord(
      input,
      feed.source,
      async (request) => {
        expect(checkBatchWrite(request)).toEqual([]);
        requests.push(structuredClone(request));
        return {
          results: request.commands.map((c) => ({
            key: c.key,
            status: 201,
            value: c.op === 'create' ? { id, revision: 1 } : { candidate: id, revision: 2 },
          })),
        };
      },
      'community',
    );
    expect(result.outcome).toBe('submitted');
    if (result.outcome !== 'submitted') throw new Error('Expected bound submission');
    const expected = feed.convert(input, { source: 'community' }, { converterRevision: feed.revision });
    expect(result.bootstrap).toEqual(expected);
    expect(result.bound).toEqual(
      feed.convert(
        {
          external_id: expected.external_id,
          record_revision: expected.record_revision,
          record: expected.normalizedRecord,
        },
        { source: 'community', subjectId: id },
        { converterRevision: feed.revision },
      ),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]!.commands.length).toBeGreaterThan(0);
    for (const c of requests[1]!.commands) {
      expect(c.op).toBe('propose');
      expect(c.subject).toBe(id);
      expect(c.source.source).toBe('community');
      expect(c.source.converter_revision).toBe(feed.revision);
      expect(c.source.digest).toBe(result.bootstrap.digest);
    }
    expect(input).toEqual(before);
  });
}

const invalidResponses: [string, (key: string) => unknown][] = [
  [
    'denied',
    (key) => ({ results: [{ key, status: 403, problem: { type: 'about:blank', title: 'Denied', status: 403 } }] }),
  ],
  ['non-success with an id', (key) => ({ results: [{ key, status: 403, value: { id, revision: 1 } }] })],
  ['missing results', () => ({})],
  ['missing entry', () => ({ results: [] })],
  ['foreign key', () => ({ results: [{ key: 'other', status: 201, value: { id, revision: 1 } }] })],
  ['missing id', (key) => ({ results: [{ key, status: 201, value: { revision: 1 } }] })],
  ['candidate identity', (key) => ({ results: [{ key, status: 201, value: { candidate: id, revision: 1 } }] })],
  ['malformed id', (key) => ({ results: [{ key, status: 201, value: { id: 'PRIVATE_SENTINEL', revision: 1 } }] })],
  ['duplicate entry', (key) => ({ results: [1, 2].map(() => ({ key, status: 201, value: { id, revision: 1 } })) })],
];
for (const [name, response] of invalidResponses) {
  test(`public example stops before bound send on ${name}`, async () => {
    let sends = 0;
    const input = structuredClone(feeds[0]!.input);
    const before = structuredClone(input);
    try {
      await publicBulkRecord(input, 'bangumi', async (request) => {
        sends++;
        return response(request.commands[0]!.key) as BatchWriteResult;
      });
      throw new Error('Expected a rejected create identity');
    } catch (error) {
      expect(error).toBeInstanceOf(ConversionError);
      const safe = error as ConversionError;
      expect(safe.code).toMatch(/^invalid_create_/);
      expect(safe.pointer).toMatch(/^\/results/);
      expect(safe.message).not.toContain('PRIVATE_SENTINEL');
    }
    expect(sends).toBe(1);
    expect(input).toEqual(before);
  });
}

test('public example seals normalized input and the exact create key before awaiting transport', async () => {
  const input = structuredClone(feeds[0]!.input);
  let sends = 0;
  const result = await publicBulkRecord(input, 'bangumi', async (request) => {
    sends++;
    if (sends === 1) input.record.name = 'Changed during transport';
    return {
      results: request.commands.map((c) => ({
        key: c.key,
        status: 200,
        value: c.op === 'create' ? { id, revision: 1 } : { candidate: id, revision: 2 },
      })),
    };
  });
  expect(result.outcome).toBe('submitted');
  if (result.outcome !== 'submitted') throw new Error('Expected submission');
  expect(result.bound.normalizedRecord).toEqual(result.bootstrap.normalizedRecord);
  let calls = 0;
  await expect(
    publicBulkRecord(feeds[0]!.input, 'bangumi', async (request) => {
      calls++;
      request.commands[0]!.key = 'changed';
      return { results: [{ key: 'changed', status: 201, value: { id, revision: 1 } }] };
    }),
  ).rejects.toBeInstanceOf(ConversionError);
  expect(calls).toBe(1);
});

test('ignored launch records and unsupported sources never call the transport', async () => {
  const never = async (): Promise<BatchWriteResult> => {
    throw new Error('Unexpected effect');
  };
  const ignored = await publicBulkRecord(
    { external_id: '1', record_revision: null, record: { id: 1, type: 3 } },
    'bangumi',
    never,
  );
  expect(ignored.outcome).toBe('ignored');
  expect(ignored.bootstrap.proposals).toEqual([]);
  const ignoredEntity = await publicBulkRecord(
    { external_id: 'Q1', record_revision: 'unversioned', record: { id: 'Q1', type: 'item', labels: {}, claims: {} } },
    'wikidata',
    never,
  );
  expect(ignoredEntity.outcome).toBe('ignored');
  await expect(publicBulkRecord(feeds[0]!.input, 'unsupported' as SourceId, never)).rejects.toMatchObject({
    code: 'unsupported_source',
    pointer: '/source',
  });
  await expect(
    publicBulkRecord({ ...feeds[0]!.input, record: { id: 1, type: 'PRIVATE_SENTINEL' } }, 'bangumi', never),
  ).rejects.toBeInstanceOf(ConversionError);
});
