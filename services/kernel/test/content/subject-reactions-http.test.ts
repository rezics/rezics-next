import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createSubject } from '../../src/semantic/subject.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { readSubjectReactionCounts } from '../../src/content/reads.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { IDEMPOTENCY_HEADER, SESSION_HEADER } from '../../src/http/request.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth } from '../support/growth.ts';
import { reactionFixture } from './reactions.test.ts';
import { observeSql } from './support/sql-observer.ts';

const routeKey = new Uint8Array(32).fill(71);
const subjectKinds = ['like', 'love', 'laugh', 'insightful', 'sad'] as const;
const accountRoute = 0x7131;
const batchRoutes = [0x4200, 0x4220, 0x4240, 0x4260] as const;

let fixture: Awaited<ReturnType<typeof reactionFixture>>;
let kernel: ReturnType<typeof createKernel>;

type CallOptions = { bearer?: string; body?: unknown; key?: string };

beforeAll(async () => {
  fixture = await reactionFixture();
  await bootstrapRelease(fixture.db.pool, bundledRelease);
  const writeRate = createWriteRateLimiter({
    secret: 'subject-reactions-http-write-rate-secret-32b',
    overrides: JSON.stringify({
      anonymous: { write: { maximum: 100_000, seconds: 86_400 } },
      'new-account': { write: { maximum: 100_000, seconds: 86_400 } },
    }),
  });
  kernel = createKernel({
    pool: fixture.db.pool,
    routeKey,
    access: fixture.access,
    writeRate,
  });
}, 120_000);

afterAll(async () => {
  await fixture?.close();
});

async function subject(label: string, grantReaction = true): Promise<string> {
  const id = newId(fixture.targetRoute);
  await createSubject(fixture.db.pool, {
    actor: await fixture.verified(fixture.managerId),
    target: { route: fixture.targetRoute, id },
    idempotencyKey: crypto.randomUUID(),
    digest: createHash('sha256').update(id).digest(),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  if (grantReaction) await fixture.grant(id, ['reaction:set']);
  return id;
}

async function call(method: string, path: string, options: CallOptions = {}) {
  const headers = new Headers();
  if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(options.key));
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const text = await response.text();
  return { response, text, value: text ? (JSON.parse(text) as Record<string, any>) : null };
}

function reactionPath(id: string): string {
  return `/v1/subjects/${id}/reaction`;
}

function reactionsPath(id: string): string {
  return `/v1/subjects/${id}/reactions`;
}

async function setTotals(ids: readonly string[], count: number): Promise<void> {
  const routes = ids.map((id) => routeOf(id)!);
  await fixture.db.admin.query(
    `INSERT INTO content.reaction_total AS stored
       (route,target_id,kind,count,source_epoch,source_position)
     SELECT target.route, target.id, kinds.kind,
            CASE WHEN kinds.kind='like' THEN $3::integer ELSE 0 END, 1, 1
     FROM unnest($1::integer[],$2::uuid[]) AS target(route,id)
     CROSS JOIN unnest($4::text[]) AS kinds(kind)
     ON CONFLICT (route,target_id,kind) DO UPDATE
       SET count=EXCLUDED.count,source_epoch=EXCLUDED.source_epoch,source_position=EXCLUDED.source_position`,
    [routes, ids, count, [...subjectKinds]],
  );
}

async function seedReactors(
  ids: readonly string[],
  actors: readonly string[],
  from: number,
  to: number,
): Promise<void> {
  const additions = actors.slice(from, to);
  if (additions.length === 0) return;
  const routes = ids.map((id) => routeOf(id)!);
  await fixture.db.admin.query(
    `INSERT INTO content.subject_reactor(route,subject_id,actor_account_id,kind)
     SELECT target.route,target.id,reactor.id,'like'
     FROM unnest($1::integer[],$2::uuid[]) AS target(route,id)
     CROSS JOIN unnest($3::uuid[]) AS reactor(id)`,
    [routes, ids, additions],
  );
}

async function seedTotalDecoys(route: number, count: number): Promise<void> {
  const ids = Array.from({ length: count }, () => newId(route));
  await fixture.db.admin.query(
    `INSERT INTO content.reaction_total(route,target_id,kind,count,source_epoch,source_position)
     SELECT $1::integer,id,'like',0,1,1 FROM unnest($2::uuid[]) AS id`,
    [route, ids],
  );
}

async function merge(source: string, survivor: string): Promise<void> {
  await mergeSubjects(fixture.db.pool, {
    subjects: [source, survivor],
    actor: await fixture.verified(fixture.managerId),
    idempotencyKey: crypto.randomUUID(),
    digest: createHash('sha256').update(`${source}:${survivor}`).digest(),
    release: { digest: bundledDigest, release: bundledRelease },
    deadline: Date.now() + 30_000,
    authorization: {
      action: 'subject:merge',
      resource: { route: 0, id: GLOBAL_CONTEXT },
      denied: () => new Error('Denied'),
      async authorize() {
        return 'execute';
      },
    },
  });
}

test('subject reaction HTTP routes are mounted with the thread write contract', () => {
  const writes = kernel.routes.filter((route) => route.path === '/v1/subjects/:id/reaction');
  expect(writes.map(({ method }) => method.toUpperCase()).sort()).toEqual(['DELETE', 'GET', 'PUT']);
  const document = openApiDocument(kernel);
  const subjectOperations = document.paths['/v1/subjects/{id}/reaction'];
  const subjectRead = document.paths['/v1/subjects/{id}/reactions'];
  const threadOperations = document.paths['/v1/threads/{id}/reaction'];
  expect(subjectOperations?.put?.operationId).toBe('subject.set_reaction');
  expect(subjectOperations?.delete?.operationId).toBe('subject.clear_reaction');
  expect(subjectOperations?.get?.operationId).toBe('subject.get_own_reaction');
  expect(subjectOperations?.get?.responses).toHaveProperty('308');
  expect(subjectOperations?.get?.['x-exposure']).toBe('public');
  expect(subjectRead?.get?.operationId).toBe('subject.reactions');
  expect(subjectRead?.get?.responses).toHaveProperty('200');
  expect(subjectRead?.get?.responses).toHaveProperty('308');
  expect(subjectOperations?.put?.['x-action']).toBe('reaction:set');
  expect(subjectOperations?.delete?.['x-action']).toBe('reaction:set');
  expect(subjectOperations?.put?.['x-rate-limit']).toEqual(threadOperations?.put?.['x-rate-limit']);
  expect(subjectOperations?.delete?.['x-rate-limit']).toEqual(threadOperations?.delete?.['x-rate-limit']);
});

test('an account sets, changes and clears one subject reaction using strict JSON and an Idempotency-Key', async () => {
  const id = await subject('Subject reaction writes');
  const bearer = fixture.bearer();
  const path = reactionPath(id);

  const first = await call('PUT', path, { bearer, body: { kind: 'like' }, key: 'subject-like' });
  if (first.response.status !== 200) throw new Error(`Subject reaction set failed: ${first.text}`);
  expect(first.response.status).toBe(200);
  expect(first.value).toEqual({ kind: 'like' });
  const afterFirst = await fixture.effects();

  const replay = await call('PUT', path, { bearer, body: { kind: 'like' }, key: 'subject-like' });
  expect(replay.response.status).toBe(200);
  expect(replay.value).toEqual({ kind: 'like' });
  expect(await fixture.effects()).toEqual(afterFirst);

  expect((await call('GET', path, { bearer })).value).toEqual({ kind: 'like' });
  expect((await call('GET', path)).response.status).toBe(401);

  const changed = await call('PUT', path, { bearer, body: { kind: 'love' }, key: 'subject-love' });
  expect(changed.response.status).toBe(200);
  expect(changed.value).toEqual({ kind: 'love' });
  expect((await call('GET', path, { bearer })).value).toEqual({ kind: 'love' });
  const slot = await fixture.db.admin.query<{ kind: string }>(
    `SELECT kind FROM content.reaction WHERE route=$1 AND actor_account_id=$2 AND target_id=$3`,
    [fixture.home, fixture.accountId, id],
  );
  expect(slot.rows).toEqual([{ kind: 'love' }]);

  const unknownField = await call('PUT', path, {
    bearer,
    body: { kind: 'like', extra: true },
    key: 'subject-extra',
  });
  expect(unknownField.response.status).toBe(400);
  expect(unknownField.value?.code).toBe('invalid_request');
  const missingKey = await call('PUT', path, { bearer, body: { kind: 'like' } });
  expect(missingKey.response.status).toBe(400);
  expect(missingKey.value?.code).toBe('invalid_request');
  for (const kind of ['upvote', 'downvote']) {
    const refused = await call('PUT', path, { bearer, body: { kind }, key: `subject-${kind}` });
    expect(refused.response.status).toBe(400);
    expect(refused.value?.code).toBe('invalid_request');
  }

  const cleared = await call('DELETE', path, { bearer, key: 'subject-clear' });
  expect(cleared.response.status).toBe(204);
  const empty = await fixture.db.admin.query(
    `SELECT 1 FROM content.reaction WHERE route=$1 AND actor_account_id=$2 AND target_id=$3`,
    [fixture.home, fixture.accountId, id],
  );
  expect(empty.rows).toHaveLength(0);
  expect((await call('GET', path, { bearer })).value).toEqual({ kind: null });
  expect(cleared.response.headers.get(SESSION_HEADER)).toBeTruthy();
});

test('subject reaction reads return relayed counts and the own slot separately, while concealing unreadable ids', async () => {
  const id = await subject('Subject reaction reads');
  await setTotals([id], 0);
  await fixture.db.admin.query(
    `UPDATE content.reaction_total SET count=CASE kind WHEN 'like' THEN 3 WHEN 'love' THEN 2 ELSE 0 END
     WHERE route=$1 AND target_id=$2`,
    [routeOf(id), id],
  );
  await fixture.db.admin.query(
    `INSERT INTO content.reaction(route,actor_account_id,target_kind,target_route,target_id,kind,updated_at)
     VALUES ($1,$2,'subject',$3,$4,'insightful',now())`,
    [fixture.home, fixture.accountId, routeOf(id), id],
  );

  const anonymousTrace = observeSql(fixture.db.pool);
  const anonymous = await call('GET', reactionsPath(id));
  await anonymousTrace.close();
  expect(anonymous.response.status).toBe(200);
  expect(anonymous.value?.counts).toEqual([
    { kind: 'like', count: 3 },
    { kind: 'love', count: 2 },
  ]);
  expect(anonymous.value).not.toHaveProperty('viewer');
  expect(anonymous.value).toHaveProperty('watermark');

  const countsTrace = observeSql(fixture.db.pool);
  const ownCounts = await call('GET', reactionsPath(id), { bearer: fixture.bearer() });
  await countsTrace.close();
  expect(ownCounts.response.status).toBe(200);
  expect(ownCounts.value?.counts).toEqual(anonymous.value?.counts);
  expect(ownCounts.value).not.toHaveProperty('viewer');
  expect(countsTrace.records.filter((record) => /\bcontent\.reaction_total\b/.test(record.statement))).toHaveLength(1);
  expect(countsTrace.records.filter((record) => /\bcontent\.reaction\b/.test(record.statement))).toHaveLength(0);
  expect(
    countsTrace.records.find((record) => /\bcontent\.reaction_total\b/.test(record.statement))?.parameters.includes(id),
  ).toBe(true);

  const ownTrace = observeSql(fixture.db.pool);
  const own = await call('GET', reactionPath(id), { bearer: fixture.bearer() });
  await ownTrace.close();
  expect(own.response.status).toBe(200);
  expect(own.value).toEqual({ kind: 'insightful' });
  expect(ownTrace.records.filter((record) => /\bcontent\.reaction_total\b/.test(record.statement))).toHaveLength(0);
  expect(ownTrace.records.filter((record) => /\bcontent\.reaction\b/.test(record.statement))).toHaveLength(1);
  expect(
    ownTrace.records
      .find((record) => /\bcontent\.reaction\b/.test(record.statement))
      ?.parameters.includes(fixture.accountId),
  ).toBe(true);

  const unknown = await call('GET', reactionsPath(newId(fixture.targetRoute)));
  expect(unknown.response.status).toBe(404);
  expect(
    (await call('GET', reactionPath(newId(fixture.targetRoute)), { bearer: fixture.bearer() })).response.status,
  ).toBe(404);
  const hidden = await subject('Unreadable subject', false);
  await fixture.db.admin.query(
    `UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2`,
    [routeOf(hidden), hidden],
  );
  const unreadable = await call('GET', reactionsPath(hidden));
  expect(unreadable.response.status).toBe(404);
  expect((await call('GET', reactionPath(hidden), { bearer: fixture.bearer() })).response.status).toBe(404);
});

test('both subject reaction reads redirect a merged id to the surviving subject', async () => {
  const first = await subject('Merged subject one', false);
  const second = await subject('Merged subject two', false);
  await merge(first, second);
  const survivor = [first, second].sort()[0]!;
  const redirected = [first, second].sort()[1]!;

  const result = await call('GET', reactionsPath(redirected));
  expect(result.response.status).toBe(308);
  expect(result.response.headers.get('location')).toBe(reactionsPath(survivor));
  expect(result.value).toEqual({ redirect: { from: redirected, to: survivor } });

  const own = await call('GET', reactionPath(redirected), { bearer: fixture.bearer() });
  expect(own.response.status).toBe(308);
  expect(own.response.headers.get('location')).toBe(reactionPath(survivor));
  expect(own.value).toEqual({ redirect: { from: redirected, to: survivor } });
});

test('subject reaction read', async () => {
  const target = await subject('Subject reaction read growth');
  const spare = await subject('Subject reaction read warmup', false);
  const actors = Array.from({ length: 4096 }, () => newId(accountRoute));

  const report = await checkGrowth(fixture.db, {
    name: 'subject reaction read',
    scales: [64, 512, 4096],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(_database, scale, previous) {
      if (previous === 0) await seedTotalDecoys(routeOf(target)!, 2048);
      await seedReactors([target], actors, previous, scale);
      await setTotals([target], scale);
    },
    async warmup() {
      const result = await call('GET', reactionsPath(spare), { bearer: fixture.bearer() });
      expect(result.response.status).toBe(200);
    },
    async operation(_database, scale) {
      const result = await call('GET', reactionsPath(target), { bearer: fixture.bearer() });
      expect(result.response.status).toBe(200);
      expect(result.value?.counts).toContainEqual({ kind: 'like', count: scale });
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
  expect(report.samples.map(({ cost }) => cost.rows)).toEqual([
    report.samples[0]!.cost.rows,
    report.samples[0]!.cost.rows,
    report.samples[0]!.cost.rows,
  ]);
  expect(report.samples.map(({ cost }) => cost.statements)).toEqual([
    report.samples[0]!.cost.statements,
    report.samples[0]!.cost.statements,
    report.samples[0]!.cost.statements,
  ]);
  expect(report.samples[2]!.cost.relations['content.reaction_total']?.rows).toBeLessThanOrEqual(5);
});

test('subject own reaction read', async () => {
  const target = await subject('Subject own reaction read growth');
  const spare = await subject('Subject own reaction read warmup', false);
  const actors = Array.from({ length: 4096 }, () => newId(accountRoute));
  await fixture.db.admin.query(
    `INSERT INTO content.reaction(route,actor_account_id,target_kind,target_route,target_id,kind,updated_at)
     VALUES ($1,$2,'subject',$3,$4,'sad',now())`,
    [fixture.home, fixture.accountId, routeOf(target), target],
  );

  const report = await checkGrowth(fixture.db, {
    name: 'subject own reaction read',
    scales: [64, 512, 4096],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(_database, scale, previous) {
      await seedReactors([target], actors, previous, scale);
      await fixture.db.admin.query(
        `INSERT INTO content.reaction(route,actor_account_id,target_kind,target_route,target_id,kind,updated_at)
         SELECT $1,actor_id,'subject',$2,$3,'like',now()
         FROM unnest($4::uuid[]) AS reactors(actor_id)
         ON CONFLICT (route,actor_account_id,target_id) DO UPDATE SET kind=EXCLUDED.kind`,
        [accountRoute, routeOf(target), target, actors.slice(previous, scale)],
      );
    },
    async warmup() {
      const result = await call('GET', reactionPath(spare), { bearer: fixture.bearer() });
      expect(result.response.status).toBe(200);
    },
    async operation(_database, scale) {
      const trace = observeSql(fixture.db.pool);
      const result = await call('GET', reactionPath(target), { bearer: fixture.bearer() });
      await trace.close();
      expect(result.response.status).toBe(200);
      expect(result.value).toEqual({ kind: 'sad' });
      expect(trace.records.filter((record) => /\bcontent\.reaction\b/.test(record.statement))).toHaveLength(1);
      expect(trace.records.filter((record) => /\bcontent\.reaction_total\b/.test(record.statement))).toHaveLength(0);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
  expect(report.samples.map(({ cost }) => cost.rows)).toEqual([
    report.samples[0]!.cost.rows,
    report.samples[0]!.cost.rows,
    report.samples[0]!.cost.rows,
  ]);
  expect(report.samples.map(({ cost }) => cost.statements)).toEqual([
    report.samples[0]!.cost.statements,
    report.samples[0]!.cost.statements,
    report.samples[0]!.cost.statements,
  ]);
  expect(report.samples[2]!.cost.relations['content.reaction']?.rows).toBeLessThanOrEqual(1);
});

test('batched subject reaction counts', async () => {
  const ids = batchRoutes.flatMap((route) => Array.from({ length: 25 }, () => newId(route)));
  const spare = newId(batchRoutes[0]);
  const actors = Array.from({ length: 4096 }, () => newId(accountRoute));

  const report = await checkGrowth(fixture.db, {
    name: 'batched subject reaction counts',
    scales: [64, 512, 4096],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(_database, scale, previous) {
      if (previous === 0) {
        for (const route of batchRoutes) await seedTotalDecoys(route, 2048);
      }
      await seedReactors(ids, actors, previous, scale);
      await setTotals(ids, scale);
    },
    async warmup() {
      expect((await readSubjectReactionCounts({ pool: fixture.db.pool }, [spare])).size).toBe(1);
    },
    async operation(_database, scale) {
      const trace = observeSql(fixture.db.pool);
      const counts = await readSubjectReactionCounts({ pool: fixture.db.pool }, ids);
      await trace.close();
      expect(counts.size).toBe(100);
      for (const count of counts.values()) expect(count).toEqual([{ kind: 'like', count: scale }]);
      expect(trace.records.filter((record) => /\bcontent\.reaction_total\b/.test(record.statement))).toHaveLength(4);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
  expect(report.samples.map(({ cost }) => cost.rows)).toEqual([
    report.samples[0]!.cost.rows,
    report.samples[0]!.cost.rows,
    report.samples[0]!.cost.rows,
  ]);
  expect(report.samples.map(({ cost }) => cost.statements)).toEqual([
    report.samples[0]!.cost.statements,
    report.samples[0]!.cost.statements,
    report.samples[0]!.cost.statements,
  ]);
  expect(report.samples[2]!.cost.relations['content.reaction_total']?.rows).toBeLessThanOrEqual(500);
  expect(new Set(ids.map((id) => partitionOf(routeOf(id)!))).size).toBe(4);
});
