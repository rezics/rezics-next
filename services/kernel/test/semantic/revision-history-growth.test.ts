import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { accessCheck } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { listRevisions, proposeStatement } from '../../src/semantic/candidates.ts';
import { subjectReadEligibility } from '../../src/semantic/eligibility.ts';
import { changeStatementDisclosure } from '../../src/semantic/statement-disclosure.ts';
import { encodeCursor } from '../../src/tokens/cursor.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { leafFixture, nativeRelease, statement, type LeafFixture } from './scope-leaf-evidence-fixture.ts';

const historyPerScale = 256;
const unrelatedSubjectsPerScale = 8;
const pageLimit = 8;
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(91)]]) };
let db: GrowthDatabase;
let fixture: LeafFixture;

beforeAll(async () => {
  db = await openGrowthDatabase(process.env.DATABASE_URL!);
  fixture = await leafFixture(db.pool, db.admin);
});

afterAll(async () => {
  if (db) await db.close();
});

test("revision history first and deep pages stay bounded as the subject's and unrelated subjects' history grows", async () => {
  const subject = await fixture.create('schema:Book');
  const unrelated = await Promise.all(
    Array.from({ length: unrelatedSubjectsPerScale }, () => fixture.create('schema:Book')),
  );
  const route = routeOf(subject)!;
  const binding = { operation: 'subject.list_revisions', parameters: { subject } } as const;
  let deepCursor: string | undefined;

  const createDeepCursor = async (growthDb: GrowthDatabase, scale: number) => {
    const { rows } = await growthDb.admin.query<{ epoch: number }>(
      'SELECT epoch FROM core.partition WHERE partition_no = $1',
      [partitionOf(route)],
    );
    const epoch = rows[0]?.epoch;
    if (epoch === undefined) throw new Error('Subject partition is missing');
    const after = Math.floor((scale * historyPerScale * 3) / 4) + 1;
    return encodeCursor(tokens, binding, { epoch, after: [after] });
  };

  const readPages = async (growthDb: GrowthDatabase, cursor: string) => {
    const resource = { route, id: subject };
    const firstAuthorization = await accessCheck(
      fixture.access,
      fixture.reader,
      'subject:read',
      { ...resource, eligibility: subjectReadEligibility(resource) },
      { pool: growthDb.pool, deadline: Date.now() + 30_000 },
    );
    const first = await listRevisions(growthDb.pool, tokens, {
      subject,
      limit: pageLimit,
      authorize: firstAuthorization,
    });
    const deepAuthorization = await accessCheck(
      fixture.access,
      fixture.reader,
      'subject:read',
      { ...resource, eligibility: subjectReadEligibility(resource) },
      { pool: growthDb.pool, deadline: Date.now() + 30_000 },
    );
    const deep = await listRevisions(growthDb.pool, tokens, {
      subject,
      limit: pageLimit,
      cursor,
      authorize: deepAuthorization,
    });
    expect(first.revisions).toHaveLength(pageLimit);
    expect(first.next).toBeString();
    expect(deep.revisions).toHaveLength(pageLimit);
    expect(deep.revisions[0]!.revision).toBeLessThan(first.revisions.at(-1)!.revision);
    return { first, deep };
  };

  const report = await checkGrowth(db, {
    name: 'Revision history first and deep pages',
    scales: [1, 8, 64],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      const previousRows = previous * historyPerScale;
      const currentRows = scale * historyPerScale;
      await growthDb.admin.query(
        `INSERT INTO semantic.revision
             (route, subject_id, revision, kind, release, recorded_transaction_id, source)
           SELECT $1, $2, revision, 'propose', $3, gen_random_uuid(), NULL
           FROM generate_series($4::integer, $5::integer) AS revision`,
        [route, subject, nativeRelease.digest, previousRows + 2, currentRows + 1],
      );

      const rows = Array.from({ length: currentRows - previousRows }, (_, offset) => {
        const ordinal = previousRows + offset;
        return {
          subject: unrelated[ordinal % unrelated.length]!,
          revision: Math.floor(ordinal / unrelated.length) + 2,
        };
      });
      await growthDb.admin.query(
        `INSERT INTO semantic.revision
             (route, subject_id, revision, kind, release, recorded_transaction_id, source)
           SELECT input_rows.route, input_rows.subject_id, input_rows.revision, 'propose', $4, gen_random_uuid(), NULL
           FROM unnest($1::integer[], $2::uuid[], $3::integer[]) AS input_rows(route, subject_id, revision)`,
        [
          rows.map(() => route),
          rows.map(({ subject: id }) => id),
          rows.map(({ revision }) => revision),
          nativeRelease.digest,
        ],
      );
    },
    warmup: async (growthDb, scale) => {
      deepCursor = await createDeepCursor(growthDb, scale);
      await readPages(growthDb, deepCursor);
    },
    prepare: async (growthDb, scale) => {
      deepCursor = await createDeepCursor(growthDb, scale);
    },
    operation: async (growthDb) => {
      if (!deepCursor) throw new Error('Deep revision cursor was not prepared');
      return readPages(growthDb, deepCursor);
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
}, 240_000);

test('statement disclosure change stays bounded with one affected candidate as unrelated candidates grow', async () => {
  const agent = await ensureAccountAgent(db.pool, {
    account: fixture.editor.accountId,
    kind: 'person',
    name: 'Statement disclosure growth authority',
  });
  const unrelatedSubject = await fixture.create();
  const initialCandidate = await fixture.propose(unrelatedSubject, 'rezics:penNameOf', agent.subject.id);
  const route = routeOf(unrelatedSubject)!;
  const candidateRows = await db.admin.query<{
    slot_id: string;
    statement: unknown;
    release: string;
    property: string;
    rank: string;
  }>(
    `SELECT slot_id::text AS slot_id, statement, release, property, rank
       FROM semantic.candidate WHERE route = $1 AND subject_id = $2 AND candidate_id = $3`,
    [route, unrelatedSubject, initialCandidate],
  );
  const initial = candidateRows.rows[0];
  if (!initial) throw new Error('Unrelated candidate fixture is missing');
  const revisionRows = await db.admin.query<{ revision: number }>(
    'SELECT max(revision)::integer AS revision FROM semantic.revision WHERE route = $1 AND subject_id = $2',
    [route, unrelatedSubject],
  );
  const baseRevision = revisionRows.rows[0]?.revision;
  if (baseRevision === undefined) throw new Error('Unrelated revision fixture is missing');
  const unrelatedCandidates: Population = {
    name: `statement-disclosure-unrelated-${randomUUID()}`,
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const revision = baseRevision + ordinal + 1;
      const transactionId = randomUUID();
      return {
        'semantic.revision': [
          {
            route,
            subject_id: unrelatedSubject,
            revision,
            kind: 'propose',
            release: nativeRelease.digest,
            recorded_transaction_id: transactionId,
            source: { kind: 'agent', subject: agent.subject.id },
          },
        ],
        'semantic.candidate': [
          {
            route,
            subject_id: unrelatedSubject,
            candidate_id: newId(route),
            slot_id: initial.slot_id,
            property: initial.property,
            rank: initial.rank,
            statement: initial.statement,
            release: initial.release,
            revision,
            origin: 'proposal',
            view_order: ordinal + 1,
          },
        ],
      };
    },
  };

  const makeCandidate = async (pool: GrowthDatabase['pool']) => {
    const subject = await fixture.create();
    const proposed = await proposeStatement(pool, {
      ...(await fixture.command('statement:propose')),
      actor: fixture.editor,
      subject,
      release: nativeRelease,
      statement: {
        ...statement('rezics:penNameOf', agent.subject.id),
        references: [],
      },
    });
    return proposed.candidate;
  };
  const disclose = async (pool: GrowthDatabase['pool'], candidate: string) => {
    const result = await changeStatementDisclosure(pool, {
      ...(await fixture.command('statement:propose')),
      actor: fixture.editor,
      candidate,
    });
    expect(result.candidate).toBe(candidate);
    return result;
  };
  let preparedCandidate: string | undefined;

  const report = await checkGrowth(db, {
    name: 'Statement disclosure change with one affected candidate',
    scales: [1, 8, 64],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed(growthDb, unrelatedCandidates, {
        from: previous * 128,
        to: scale * 128,
      });
    },
    warmup: async (growthDb) => {
      await disclose(growthDb.pool, await makeCandidate(growthDb.pool));
    },
    prepare: async (growthDb) => {
      preparedCandidate = await makeCandidate(growthDb.pool);
    },
    operation: async (growthDb) => {
      if (!preparedCandidate) throw new Error('Disclosure candidate was not prepared');
      const candidate = preparedCandidate;
      preparedCandidate = undefined;
      return disclose(growthDb.pool, candidate);
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
}, 240_000);
