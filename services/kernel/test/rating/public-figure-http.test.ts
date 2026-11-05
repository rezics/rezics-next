import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { readPublicFigures } from '../../src/rating/public-figure.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { readWorkerConfig, startWorker } from '../../src/worker.ts';
import { measure, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { createFigureFixture } from './support/figure-fixture.ts';

const routeKey = new Uint8Array(32).fill(94);
const ownerId = newId(0x2201);
const owner: AccountActor = {
  kind: 'account',
  accountId: ownerId,
  clientId: 'figure-http',
  scopes: ['subject:read', 'rating:vote'],
  requestedBy: null,
  authnEpoch: 1,
};
let database: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
const tokens = new Map<string, string>();
let voterOrdinal = 0;
type Figure = {
  questionId: string;
  populationId: string;
  scale: { min: number; max: number; displayStep: number };
  count: number;
  state: 'ready' | 'insufficient_data' | 'updating';
  mean: number | null;
  score: number | null;
};

async function voter() {
  // Match native worker fixtures: independent voters have independently routed account partitions.
  const accountId = newId((0x1000 + voterOrdinal++ * 16) & 0xffff);
  await database.admin.query(
    `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
     VALUES ($1, $2, 'actor', 'active', $2)`,
    [routeOf(accountId), accountId],
  );
  tokens.set(
    accountId,
    await new SignJWT({
      client_id: 'figure-http',
      scope: owner.scopes.join(' '),
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'figure-http', typ: 'at+jwt' })
      .setIssuer('https://auth.figure.test')
      .setAudience('https://kernel.figure.test')
      .setSubject(accountId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signing.privateKey),
  );
  return accountId;
}

function request(path: string, accountId?: string, units?: number) {
  return app.handle(
    new Request(`http://kernel.test${path}`, {
      method: units === undefined ? 'GET' : 'PUT',
      headers: {
        ...(accountId ? { authorization: `Bearer ${tokens.get(accountId)!}` } : {}),
        ...(units === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'idempotency-key': JSON.stringify(randomUUID()),
            }),
      },
      ...(units === undefined ? {} : { body: JSON.stringify({ units }) }),
    }),
  );
}
async function vote(subjectId: string, accountId: string, units: number) {
  const response = await request(`/v1/subjects/${subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, accountId, units);
  expect(response.status, await response.text()).toBe(200);
}
async function subject() {
  const key = randomUUID();
  return (
    await createSubject(database.pool, {
      actor: owner,
      target: subjectTarget(routeKey, ownerId, key),
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      item: { type: 'schema:Book', labels: { en: key } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    })
  ).subject.id;
}
async function figure(subjectId: string) {
  const response = await request(`/v1/subjects/${subjectId}/figure`);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-cache');
  expect(response.headers.get('etag')).toMatch(/^".+"$/);
  const body = (await response.json()) as { figure: Figure };
  expect(Object.keys(body)).toEqual(['figure']);
  expect(Object.keys(body.figure).sort()).toEqual(
    ['questionId', 'populationId', 'scale', 'count', 'state', 'mean', 'score'].sort(),
  );
  return { ...body, etag: response.headers.get('etag') };
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 60_000;
  let value = await read();
  while (!done(value) && performance.now() < deadline) {
    await Bun.sleep(20);
    value = await read();
  }
  if (!done(value)) {
    const workflows = await database.admin.query(`SELECT status, count(*) FROM dbos.workflow_status GROUP BY status`);
    const activity = await database.admin.query(`SELECT state, wait_event_type, wait_event
      FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);
    throw new Error(JSON.stringify({ value, workflows: workflows.rows, activity: activity.rows }));
  }
  return value;
}
async function published(subjectId: string, count: number, populationId = GLOBAL_CONTEXT.id) {
  return until(
    async () =>
      (
        await readPublicFigures(database.admin, {
          partition: partitionOf(routeOf(subjectId)!),
          questionId: STANDARD_QUESTION_ID,
          populationId,
          subjectIds: [subjectId],
        })
      )[0],
    (value) => value?.count === count,
  );
}
// Hold only publication, after the native aggregate apply commits its pending mark.
async function holdPublication(subjectId: string) {
  const client = await database.admin.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 94)', [subjectId]);
  return async () => {
    await client.query('ROLLBACK');
    client.release();
  };
}

beforeAll(async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
  await bootstrapRelease(database.pool, bundledRelease);
  signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'figure-http', alg: 'ES256' };
  app = createKernel({
    pool: database.pool,
    routeKey,
    requestDeadlineMs: 30_000,
    writeRate: createWriteRateLimiter({
      secret: 'figure-http-write-rate-secret-32-bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
    }),
    ratePeer: () => '127.0.0.1',
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) },
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.figure.test',
          audience: 'https://kernel.figure.test',
          jwksUrl: 'https://auth.figure.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
  });
  await database.admin.query(
    `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
    VALUES ($1, $2, 'actor', 'active', $2)`,
    [routeOf(ownerId), ownerId],
  );
  await database.admin.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
    VALUES ('personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
    [ownerId],
  );
  await database.admin.query(`CREATE FUNCTION public.hold_figure_publication() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext(NEW.subject_id::text), 94);
      RETURN NEW;
    END $$;
    CREATE TRIGGER hold_figure_publication BEFORE UPDATE ON rating.public_figure
    FOR EACH ROW WHEN (OLD.pending_position IS NOT NULL AND NEW.pending_position IS NULL)
    EXECUTE FUNCTION public.hold_figure_publication()`);
  const env = workerTestEnv({ DATABASE_URL: database.url, KERNEL_EXECUTOR_ID: `figure-http-${randomUUID()}` });
  worker = await startWorker(readWorkerConfig(env), undefined, env);
}, 60_000);
afterAll(async () => {
  await worker?.stop();
  await database?.close();
});

test('below threshold the subject figure is insufficient_data or updating with no mean or score', async () => {
  const target = await subject();
  expect((await figure(target)).figure).toMatchObject({
    count: 0,
    state: 'insufficient_data',
    mean: null,
    score: null,
  });
  expect((await request(`/v1/subjects/${newId(0x2201)}/figure`)).status).toBe(404);
  const hidden = await subject();
  await database.admin.query(
    `UPDATE semantic.subject SET visibility = 'hidden', security_revision = security_revision + 1
    WHERE route = $1 AND subject_id = $2`,
    [routeOf(hidden), hidden],
  );
  expect((await request(`/v1/subjects/${hidden}/figure`)).status).toBe(404);
  const release = await holdPublication(target);
  try {
    await vote(target, await voter(), 20);
    await until(
      () => figure(target),
      (value) => value.figure.state === 'updating',
    );
    expect((await figure(target)).figure).toMatchObject({ count: 0, state: 'updating', mean: null, score: null });
  } finally {
    await release();
  }
  await published(target, 1);
  expect((await figure(target)).figure).toMatchObject({
    count: 1,
    state: 'insufficient_data',
    mean: null,
    score: null,
  });
  const last = await figure(target);
  const releaseAgain = await holdPublication(target);
  try {
    await vote(target, await voter(), 0);
    await until(
      () => figure(target),
      (value) => value.figure.state === 'updating',
    );
    expect(await figure(target)).toEqual({
      figure: { ...last.figure, state: 'updating' },
      etag: last.etag,
    });
  } finally {
    await releaseAgain();
  }
  await published(target, 2);
  expect((await figure(target)).figure).toMatchObject({
    count: 2,
    state: 'insufficient_data',
    mean: null,
    score: null,
  });
  for (let index = 0; index < 3; index++) await vote(target, await voter(), 10);
  await published(target, 5);
  expect((await figure(target)).figure).toMatchObject({ count: 5, state: 'ready', mean: 5, score: null });
}, 90_000);

test('the subject figure route answers the published Global standard figure with an explicit ready state, display mean and Bayesian score', async () => {
  const target = await subject();
  await figure(target);
  const priorTarget = await subject();
  for (let index = 0; index < 50; index++) await vote(priorTarget, await voter(), 4);
  await until(
    async () => (await published(priorTarget, 50))!,
    (row) => row.priorEpoch !== null,
  );
  const statements: number[] = [];
  for (const count of [1, 64, 512]) {
    const existing = (await figure(target)).figure.count;
    for (let index = existing; index < count; index++) await vote(target, await voter(), 18);
    await published(target, count);
    const releaseScale = await holdPublication(target);
    try {
      const row = (await published(target, count))!;
      await figure(target); // Warm the same anonymous subject-read path at every scale.
      const measured = await measure(database, () => figure(target));
      statements.push(measured.cost.statements);
      if (count === 1)
        expect(measured.value.figure).toMatchObject({ state: 'insufficient_data', mean: null, score: null });
      else {
        expect(measured.value.figure).toEqual({
          questionId: STANDARD_QUESTION_ID,
          populationId: GLOBAL_CONTEXT.id,
          scale: { min: 0, max: 20, displayStep: 1 },
          count,
          state: 'ready',
          mean: row.mean,
          score: row.score,
        });
        expect(row.mean).toBe(9);
        expect(row.score!).toBeGreaterThan(row.m!);
        expect(row.score!).toBeLessThan(row.mean!);
        expect(measured.value.etag).toBe(`"${row.revision}"`);
      }
    } finally {
      await releaseScale();
    }
  }
  expect(statements[0]).toBeGreaterThan(0);
  expect(statements).toEqual([statements[0]!, statements[0]!, statements[0]!]);
  const scale = (await (await request(`/v1/rating-questions/${STANDARD_QUESTION_ID}`)).json()).scale;
  expect((await figure(target)).figure.scale).toEqual(scale);
  const release = await holdPublication(target);
  const before = await figure(target);
  try {
    await vote(target, await voter(), 0);
    await until(
      async () =>
        (
          await database.admin.query(
            `SELECT pending_position FROM rating.public_figure
      WHERE subject_id = $1 AND population_id = $2`,
            [target, GLOBAL_CONTEXT.id],
          )
        ).rows[0]?.pending_position,
      (pending) => pending !== null && pending !== undefined,
    );
    expect(await figure(target)).toEqual(before);
  } finally {
    await release();
  }
  await published(target, 513);
  const document = openApiDocument(app);
  expect(document.components.schemas.PublicFigure).toBeDefined();
  const responseSchema =
    document.paths['/v1/subjects/{id}/figure']?.get?.responses?.['200']?.content?.['application/json']?.schema;
  expect(responseSchema).toMatchObject({ properties: { figure: { $ref: '#/components/schemas/PublicFigure' } } });
  expect(document.paths['/v1/subjects/{id}/figure']?.get?.['x-action']).toBe('subject:read');
}, 300_000);

test('the subject figure never reflects a private Realm population or exposes an individual vote', async () => {
  // The native Auth fixture owns the in-process workflow runtime while its Kernel worker runs separately.
  await worker.stop();
  // The check runner's migrated template is untouched by the route scenarios above.
  const template = new URL(process.env.DATABASE_URL!);
  template.pathname = '/rezics';
  const fixture = await createFigureFixture({
    subjects: 1,
    partitions: 1,
    databaseUrl: template.href,
    deferMembership: true,
  });
  try {
    const target = fixture.subjectIds[0]!;
    const accounts = new Map(
      [...fixture.realmMembers, ...fixture.globalVoters].map((account) => [account.id, account]),
    );
    const request = (path: string, accountId?: string) =>
      fixture.request(path, accountId ? accounts.get(accountId)! : null);
    const vote = (subjectId: string, accountId: string, units: number) =>
      fixture.vote(subjectId, accounts.get(accountId)!, units);
    const figure = fixture.figure;
    const published = fixture.published;
    await figure(target);
    const realmId = fixture.realmId;
    expect((await request(`/v1/realms/${realmId}`)).status).toBe(404);
    const members = fixture.realmMembers.map((account) => account.id);
    const outsiders = fixture.globalVoters.map((account) => account.id);
    for (const accountId of members) await vote(target, accountId, 20);
    for (const accountId of outsiders) await vote(target, accountId, 0);
    await published(target, 10);
    const baseline = await figure(target);
    const before = baseline.figure;
    await fixture.joinMembers();
    // Swap equal groups' extremes: Global remains identical while the new Realm figure is exclusively zero.
    for (const accountId of members) await vote(target, accountId, 0);
    for (const accountId of outsiders) await vote(target, accountId, 20);
    const privateFigure = (await published(target, 5, realmId))!;
    expect(privateFigure.mean).toBe(0);
    await until(
      () => figure(target),
      (value) => value.etag !== baseline.etag && value.figure.mean === before.mean,
    );
    for (const accountId of [undefined, members[0], outsiders[0]]) {
      const response = await request(`/v1/subjects/${target}/figure`, accountId);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(text)).toEqual({ figure: before });
      for (const secret of [realmId, ...members, ...outsiders, 'voterId', 'units', 'histogram', 'vote'])
        expect(text).not.toContain(secret);
    }
  } finally {
    await fixture.close();
  }
}, 180_000);
