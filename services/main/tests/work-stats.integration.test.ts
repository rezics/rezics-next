import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { meterStatements } from '../../../tests/qa/integration/feed-read-support.ts';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { createMainApp } from '../src/app.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../src/modules/rating/global.ts';
import { WORK_STATS_COST, WorkReaderStats } from '../src/modules/work/read-stats.ts';

interface Stats { work: string; reading: { value: number; kind: string }; wantToRead: { value: number; kind: string };
  reviews: { value: number; kind: string } | null }

test('G394: Work reader stats count public Person libraries and visible reviews within their statement budget', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
  const stack = await startMediaStack('work-stats');
  const meter = meterStatements();
  try {
    const writer = await stack.member('writer');
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, media: stack.media,
      workStats: new WorkReaderStats(stack.contentPool, stack.accessPool),
      account: { verify: async () => { throw new AccountAssertionDenied('Public reads only'); } } });
    const call = (target: string) => app.handle(new Request(`http://main.local${target}`));
    const read = async (work: string, context?: string, status = 200) => {
      const response = await call(`/v1/works/${work.slice(-36)}/reader-stats${context
        ? `?context=${encodeURIComponent(context)}` : ''}`);
      const text = await response.text();
      expect(response.status, text).toBe(status);
      expect(response.headers.get('cache-control')).toContain('no-store');
      return JSON.parse(text) as Stats;
    };
    const book = await stack.publicWork(writer.actor, ['en'], `Reader stats book ${randomUUID()}`);
    const other = await stack.publicWork(writer.actor, ['en'], `Reader stats other ${randomUUID()}`);
    const hidden = await stack.privateWork(writer.actor, `Reader stats private ${randomUUID()}`);
    await writer.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const created = await writer.send('POST', '/v1/global-rating-contexts', { profile: 'global-rating-standing-context-v1',
      question: 'How good is this book?', actingSubject: writer.actor });
    expect(created.status).toBe(201);
    const { context } = await created.json() as { context: string };

    // Nobody has shelved or reviewed it yet; a private Work has no public numbers, nor an unknown question.
    expect(await read(book.work, context)).toMatchObject({ work: book.work,
      reading: { value: 0, kind: 'exact' }, reviews: { value: 0, kind: 'exact' } });
    expect((await read(book.work)).reviews).toBeNull();
    await read(hidden.work, undefined, 404);
    await read(book.work, `https://rezics.com/id/${randomUUID()}`, 404);
    expect((await call(`/v1/works/${book.work.slice(-36)}/reader-stats?context=not-an-id`)).status).toBe(400);

    // Only people whose Person library is public count, and only the Currently reading shelf.
    const people = await Promise.all(['public', 'public-too', 'followers', 'private', 'wants', 'finished',
      'organization'].map(name => stack.member(name)));
    const kinds = ['person', 'person', 'person', 'person', 'person', 'person', 'organization'];
    const visibility = ['public', 'public', 'followers', 'private', 'public', 'public', 'public'];
    const statuses = ['reading', 'reading', 'reading', 'reading', 'want-to-read', 'read', 'reading'];
    for (const [index, person] of people.entries()) {
      const representation = (await stack.accessPool.query<{ id: string }>(`
        SELECT id::text FROM access.representation WHERE principal_id = $1 AND subject_id = $2 LIMIT 1`,
      [person.principalId, person.actor])).rows[0]!.id;
      await stack.accessPool.query(`INSERT INTO access.agent_provision
        (id, principal_id, idempotency_key, request_digest, agent_id, agent_kind,
          display_name, principal_epoch, state, graph_data_epoch, graph_sequence, representation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,0,'active',$8,0,$9)`,
      [randomUUID(), person.principalId, `stats-${randomUUID()}`, 'a'.repeat(64), person.actor, kinds[index],
        person.name, stack.env.lineage.dataEpoch, representation]);
      await stack.accessPool.query(`INSERT INTO access.agent_library_visibility (agent_id, visibility, version)
        VALUES ($1,$2,1)`, [person.actor, visibility[index]]);
      await stack.contentPool.query(`INSERT INTO reader.library_status (agent, work, status, version)
        VALUES ($1,$2,$3,1)`, [person.actor, book.work, statuses[index]]);
    }
    // Another Work's reader is not this Work's.
    await stack.contentPool.query(`INSERT INTO reader.library_status (agent, work, status, version)
      VALUES ($1,$2,'reading',1)`, [people[2]!.actor, other.work]);
    expect((await read(book.work, context)).reading).toEqual({ value: 2, kind: 'exact' });
    expect((await read(book.work, context)).wantToRead).toEqual({ value: 1, kind: 'exact' });
    await stack.accessPool.query(`UPDATE access.agent_library_visibility SET visibility = 'private', version = 2
      WHERE agent_id = $1`, [people[1]!.actor]);
    expect((await read(book.work, context)).reading).toEqual({ value: 1, kind: 'exact' });

    // Reviews count as the Work's list shows them: not deleted ones, nor those of inactive authors.
    const reviewers = await Promise.all(['review-a', 'review-b', 'deleted', 'inactive', 'elsewhere']
      .map(name => stack.member(name)));
    for (const [index, reviewer] of reviewers.entries()) {
      await stack.accessPool.query(`INSERT INTO access.reader_review (principal_id, acting_subject, context, work,
        main_version, rating_observation, rating_revision, rating, language, body, spoiler, revision, deleted)
        VALUES ($1,$2,$3,$4,$5,$6,$6,4,'en','A review',false,$7,$8)`,
      [reviewer.principalId, reviewer.actor, context, index === 4 ? other.work : book.work,
        index === 4 ? other.mainVersion : book.mainVersion, `https://rezics.com/id/${randomUUID()}`,
        randomUUID(), index === 2]);
    }
    await stack.accessPool.query('UPDATE access.authority_subject SET active = false WHERE id = $1',
      [reviewers[3]!.actor]);
    expect((await read(book.work, context)).reviews).toEqual({ value: 2, kind: 'exact' });

    // Budget: the graph once besides the read envelope's two position reads, and a fixed set of statements.
    const queries = stack.fuseki.queries, statements = meter.count();
    await read(book.work, context);
    expect(stack.fuseki.queries - queries).toBeLessThanOrEqual(WORK_STATS_COST.graphQueries + 2);
    expect(meter.count() - statements).toBeLessThanOrEqual(WORK_STATS_COST.sqlStatements.readerCounts
      + WORK_STATS_COST.sqlStatements.reviews);
    expect(meter.violations).toEqual([]);

    // Past the probe the reader count is a lower bound rather than a scan of every shelf.
    await stack.contentPool.query(`INSERT INTO reader.library_status (agent, work, status, version)
      SELECT 'https://rezics.com/id/' || gen_random_uuid(), $1, 'reading', 1
      FROM generate_series(1, $2::integer)`, [book.work, WORK_STATS_COST.readerProbe]);
    try {
      expect((await read(book.work)).reading.kind).toBe('lower-bound');
    } finally {
      await stack.contentPool.query(`DELETE FROM reader.library_status WHERE work = $1 AND agent <> ALL($2::text[])`,
        [book.work, people.map(person => person.actor)]);
    }

    // Both probes seek their indexes rather than scan the tables.
    const plan = async (pool: typeof stack.contentPool, sql: string, params: unknown[]) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        return (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)).rows
          .map(row => row['QUERY PLAN']).join('\n');
      } finally { await client.query('ROLLBACK'); client.release(); }
    };
    expect(await plan(stack.contentPool, `SELECT agent FROM reader.library_status WHERE work = $1
      AND status = 'reading' ORDER BY agent LIMIT 10001`, [book.work]))
      .toMatch(/library_status_(?:readers_idx|also_enjoyed_work)/);
    expect(await plan(stack.accessPool, `SELECT 1 FROM access.reader_review r WHERE r.context = $1 AND r.work = $2
      AND NOT r.deleted LIMIT 10001`, [context, book.work])).toMatch(/reader_review_(?:new|helpful)/);
  } finally {
    meter.restore();
    await stack.stop();
  }
}, 180_000);
