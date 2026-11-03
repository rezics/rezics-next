import { expect, test } from 'bun:test';
import readChain from '../../src/content/read-chain.sql';
import readDates from '../../src/content/read-revision-batch.sql';
import readSubject from '../../src/semantic/read-subject-reference.sql';
import readLabels from '../../src/semantic/read-related.sql';
import { CommandUnavailableError } from '../../src/access/unavailable.ts';
import { assertGrowthAccessPaths, checkGrowth, type ReportSample } from '../support/growth.ts';
import { observeSql, type SqlExecution } from './support/sql-observer.ts';
import {
  editionMetadataFixture,
  metadataAxes,
  metadataScales,
  type EditionKey,
  type EditionMetadataFixture,
} from './support/growth-edition-metadata-fixture.ts';

async function metadata(response: Promise<Response>, expected: unknown) {
  const result = await response;
  const text = await result.text();
  expect({ status: result.status, error: result.status === 200 ? null : text }).toEqual({ status: 200, error: null });
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(JSON.parse(text)).toEqual(expected); // Exact closed DTO, including the optional identity shape.
  expect(text).not.toMatch(/"(?:body|postId|threadId|sourceUrl|source_url|url)"|https?:/);
  expect(text).not.toContain('Pinned edition body');
}
async function refused(response: Promise<Response>, status = 404) {
  const result = await response;
  const text = await result.text();
  expect({ status: result.status, error: result.status === status ? null : text }).toEqual({ status, error: null });
  expect(text).not.toMatch(/revisionCreatedAt|Pinned edition body|Edition label/);
  return text;
}

/** Inspect the real native queries as well as their inclusive auto_explain cost. */
function binding(f: EditionMetadataFixture, key: EditionKey, rows: readonly SqlExecution[], ordinaryDate: boolean) {
  const subjects = rows.filter((row) => row.statement === readSubject.sql);
  expect(subjects.length).toBeGreaterThanOrEqual(2);
  for (const row of subjects) expect(row.parameters).toContain(f.subjectId);
  const labels = rows.filter((row) => row.statement === readLabels.sql);
  expect(labels).toHaveLength(2);
  for (const row of labels) {
    const ids = row.parameters[readLabels.params.indexOf('subject_ids')];
    // Native pg bindings retain the UUID array instead of substituting caller facts.
    expect(Array.isArray(ids) ? ids : JSON.stringify(ids)).toEqual(
      Array.isArray(ids) ? [f.subjectId] : JSON.stringify([f.subjectId]),
    );
  }
  const editions = rows.filter((row) => row.statement.includes('FROM content.edition WHERE'));
  expect(editions.length).toBeGreaterThanOrEqual(3);
  for (const row of editions) expect(row.parameters).toEqual([f.route, key.editionId]);
  const sources = rows.filter((row) => row.statement.includes('FROM content.post p JOIN content.revision r'));
  expect(sources.length).toBeGreaterThanOrEqual(2);
  for (const row of sources) {
    expect(row.parameters).toContain(f.post.id);
    expect(row.parameters).toContain(f.post.revisionId);
    expect(row.parameters).toContain(f.subjectId);
  }
  expect(rows.lastIndexOf(subjects.at(-1)!)).toBeGreaterThan(rows.indexOf(subjects[0]!));
  expect(rows.lastIndexOf(sources.at(-1)!)).toBeGreaterThan(rows.indexOf(labels[0]!));
  expect(rows.lastIndexOf(editions.at(-1)!)).toBeGreaterThan(rows.indexOf(labels[0]!));
  const chains = rows.filter((row) => row.statement === readChain.sql);
  for (const row of chains) expect(row.parameters[readChain.params.indexOf('include_body')]).toBe(false);
  for (const id of [f.post.id, f.post.revisionId, f.threadId, f.boardId])
    expect(chains.filter((row) => row.parameters.includes(id)).length).toBeGreaterThanOrEqual(2);
  for (const [relation, id] of [
    ['community.realm', f.realmId],
    ['community.space', f.spaceId],
  ] as const) {
    const probes = rows.filter((row) => row.statement.includes(relation) && row.parameters.includes(id));
    expect(probes.length).toBeGreaterThanOrEqual(2);
    expect(rows.lastIndexOf(probes.at(-1)!)).toBeGreaterThan(rows.indexOf(labels[0]!));
  }
  // These are production Access queries on the same captured pool, never an allow-all adapter.
  expect(rows.some((row) => row.statement.includes('access.resource_grant'))).toBe(true);
  const dates = rows.filter((row) => row.statement === readDates.sql);
  expect(dates).toHaveLength(ordinaryDate ? 1 : 0);
  for (const row of dates) expect(row.parameters[readDates.params.indexOf('include_body')]).toBe(false);
}

function indexed(name: string, samples: readonly ReportSample[]) {
  const relations = [
    'content.edition',
    'content.post',
    'content.revision',
    'content.board',
    'community.realm',
    'community.space',
    'semantic.subject',
    'access.resource_grant',
  ];
  assertGrowthAccessPaths(name, samples, relations);
  for (const relation of relations) {
    for (const sample of samples) {
      const cost = sample.cost.relations[relation];
      expect(cost, `${name}: missing native cost for ${relation}`).toBeDefined();
      expect(cost!.rows).toBeGreaterThan(0);
    }
  }
  for (const metric of ['controlStatements', 'catalogStatements'] as const)
    expect(new Set(samples.map(({ cost }) => cost[metric])).size).toBe(1);
}

async function atIdentity(
  f: EditionMetadataFixture,
  key: EditionKey,
  mutate: () => Promise<unknown>,
  reader = f.creator,
) {
  const trace = observeSql(f.db.pool);
  const barrier = trace.hold({ statement: readLabels.sql }, 'after');
  const pending = f.read(key, reader);
  try {
    await Promise.race([
      barrier.entered,
      pending.then(async (response) => {
        throw new Error(`Metadata missed its native identity boundary: ${response.status} ${await response.text()}`);
      }),
    ]);
    await mutate(); // Separate native command envelope on the original, unobserved mutation pool.
    barrier.release();
    await refused(pending);
    expect(trace.records.some((row) => row.statement === readSubject.sql)).toBe(true);
  } finally {
    barrier.release();
    await pending.catch(() => undefined);
    await trace.close();
  }
}

async function finalDisclosure(f: EditionMetadataFixture) {
  await atIdentity(f, f.published, f.revokeReader, f.reader);
  await refused(f.read(f.published, f.reader));
  await f.restoreReader();
  await metadata(f.read(f.published, f.reader), f.expected(f.published, 'published'));
  await atIdentity(f, f.draft, () => f.editRealm('Changed during metadata composition'));
  await metadata(f.read(f.draft), f.expected(f.draft, 'draft'));
  await atIdentity(f, f.draft, f.hideSubject);
  await refused(f.read(f.published, f.reader));
  await f.restoreSubject();
  await metadata(f.read(f.draft), f.expected(f.draft, 'draft'));
  // Native database error, transported at the supported source-query fault seam.
  const division = await f.db.admin.query('SELECT 1/0').then(
    () => {
      throw new Error('Expected PostgreSQL division-by-zero');
    },
    (error: unknown) => error as Error,
  );
  for (const [error, status, code] of [
    [division, 500, 'internal_error'],
    [new CommandUnavailableError('overloaded', f.route >>> 4), 503, 'overloaded'],
  ] as const) {
    const trace = observeSql(f.db.pool);
    try {
      trace.armFault({ match: { statement: readChain.sql }, boundary: 'before', error });
      expect(await refused(f.read(f.draft), status)).toContain(code);
      await metadata(f.read(f.draft), f.expected(f.draft, 'draft'));
    } finally {
      await trace.close();
    }
  }
  await atIdentity(f, f.draft, f.eraseSource);
  for (const key of [f.draft, f.withdrawn]) await refused(f.read(key));
  await refused(f.read(f.published, f.reader));
}

for (const axis of metadataAxes) {
  test(`native HTTP edition metadata bounds with independent ${axis} at three scales`, async () => {
    const f = await editionMetadataFixture();
    try {
      const name = `Native edition metadata ${axis}`;
      const report = await checkGrowth(f.db, {
        name,
        scales: metadataScales,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        async grow(_database, scale, previous) {
          await f.grow(axis, scale, previous);
        },
        async operation() {
          const trace = observeSql(f.db.pool);
          try {
            for (const [key, actor, state] of [
              [f.draft, f.creator, 'draft'],
              [f.withdrawn, f.creator, 'withdrawn'],
              [f.published, f.reader, 'published'],
            ] as const) {
              const start = trace.records.length;
              await metadata(f.read(key, actor), f.expected(key, state));
              binding(f, key, trace.records.slice(start), state !== 'published');
            }
            await metadata(f.read(f.published, f.reader, false), f.expected(f.published, 'published', false));
            // Grant-closed published metadata and draft/withdrawn creator-only admission.
            await refused(f.read(f.published, f.outsider));
            await refused(f.read(f.draft, f.reader));
            await refused(f.read(f.withdrawn, f.reader));
            await refused(f.ordinaryPost());
            // An allowed control follows every refusal batch on the same native pool.
            await metadata(f.read(f.published, f.reader), f.expected(f.published, 'published'));
          } finally {
            await trace.close();
          }
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([...metadataScales]);
      indexed(name, report.samples);
      // Races and native failures are semantic assertions at the grown 4096 state;
      // they are outside the steady reader's cost capture and do not claim a growth measurement.
      await finalDisclosure(f);
    } finally {
      await f.close();
    }
  }, 3_600_000);
}
