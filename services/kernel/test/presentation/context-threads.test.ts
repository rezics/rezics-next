import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { PROFILE_FORMAT, planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../semantic/outcome-driver.ts';

type Account = Awaited<ReturnType<SemanticOutcomeDriver['fixtures']['person']>>;
let driver: SemanticOutcomeDriver;
let app: ReturnType<typeof createKernel>;
let editor: Account;
let reader: Account;
let subject: string;
let selected: string;
let realm: string;
let afterThreads: (() => Promise<void>) | undefined;
const node = (type: string, id: string, props = {}) => ({ type, props: { id, ...props } });
const overview: CompositionDocument = {
  root: { props: {} },
  content: [node('SubjectHeader', 'header'), node('ThreadList', 'discussion')],
};
const discussion: CompositionDocument = {
  root: { props: {} },
  content: [node('SubjectHeader', 'header'), node('ThreadList', 'discussion', { paged: true })],
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string');
  return value;
}
async function call(account: Account, method: string, path: string, body?: unknown, headers = {}) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${account.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(randomUUID()),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, headers: response.headers, body: record(await response.json()) };
}
const write = (path: string, body: unknown) => call(editor, 'POST', path, body);
async function makeRealm() {
  const space = await write('/v1/spaces', { title: 'Discussion host' });
  expect(space.status).toBe(201);
  const created = await write('/v1/realms', {
    spaceId: record(space.body.space).spaceId,
    title: 'Selected readers',
    visibility: 'protected',
    contextId: selected,
  });
  expect(created.status).toBe(201);
  const id = text(record(created.body.realm).realmId);
  expect(
    (
      await write('/v1/grants', {
        resource: { route: routeOf(id), id },
        subject: { kind: 'account', id: reader.accountId },
        actions: ['realm:read'],
        valid: '(,)',
      })
    ).status,
  ).toBe(201);
  expect((await write(`/v1/realms/${id}/publications`, { subjectId: subject })).status).toBe(201);
  return id;
}
beforeAll(async () => {
  driver = await createSemanticDriver((config) => {
    app = createKernel({
      ...config,
      writeRate: createWriteRateLimiter({
        secret: 'context-thread-page-fixture-secret-32-bytes',
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
      }),
    });
    app.wrap((handle) => async (request: Request) => {
      const response = await handle(request);
      if (new URL(request.url).pathname === `/v1/subjects/${subject}/threads` && afterThreads) {
        const work = afterThreads;
        afterThreads = undefined;
        await work();
      }
      return response;
    });
    return app;
  });
  editor = await driver.fixtures.person('editor');
  reader = await driver.fixtures.person('context_thread_reader');
  await driver.fixtures.grantAccount(editor, [
    'space:create',
    'realm:create',
    'presentation:publish',
    'presentation:activate',
  ]);
  const context = await write('/v1/contexts', { labels: { en: 'Selected facts' } });
  expect(context.status).toBe(201);
  selected = text(record(context.body.context).id);
  const created = await write('/v1/subjects', { type: 'schema:Book', labels: { en: 'Selected book' } });
  expect(created.status).toBe(201);
  subject = text(record(created.body.subject).id);
  const proposed = await write(`/v1/subjects/${subject}/candidates`, {
    statement: { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/selected' } },
  });
  expect(proposed.status).toBe(201);
  const candidate = text(proposed.body.candidate);
  expect(
    (await write(`/v1/subjects/${subject}/candidates/${candidate}:accept`, { context: selected, expected_head: null }))
      .status,
  ).toBe(200);
  expect(
    (
      await write(`/v1/subjects/${subject}:adopt`, {
        context: selected,
        property: 'schema:url',
        mode: 'replace',
        selection: [{ candidate, rank: 'normal' }],
        expected_head: null,
      })
    ).status,
  ).toBe(200);
  realm = await makeRealm();
  // The existing Content HTTP fixture's supported storage seam supplies native thread/index rows; all reads use the product.
  const pool = driver.fixtures.pool;
  const board = newId(0x4321);
  await pool.query(
    `INSERT INTO content.board(route,board_id,realm_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,'Current board','published',1,$2)`,
    [routeOf(board), board, realm, subject],
  );
  for (let index = 0; index < 6; index++) {
    const id = newId(0x1234),
      post = newId(0x1234),
      revision = newId(0x1234);
    const body = Buffer.from(JSON.stringify(fromPlainText(`Opening ${index}`)));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
      VALUES ($1,$2,$3,$4,$5,'published',1,$2,$6)`,
        [routeOf(id), id, editor.accountId, board, `Current discussion ${index}`, post],
      );
      await client.query(
        `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
      VALUES ($1,$2,$3,$4,$5,'published',1,$3)`,
        [routeOf(id), id, post, editor.accountId, revision],
      );
      await client.query(
        `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
      VALUES ($1,$2,$3,$4,$5,sha256($5),'Opening','MIT',$6,$7,'available',$4)`,
        [routeOf(id), id, post, revision, body, [subject], board],
      );
      await client.query(
        `INSERT INTO content.subject_thread(route,subject_id,thread_route,thread_id,place_id,kind,last_activity_at,source_epoch,source_position)
      VALUES ($1,$2,$3,$4,$5,'discussion',$6,1,1)`,
        [routeOf(subject), subject, routeOf(id), id, realm, new Date(Date.now() - index * 1000).toISOString()],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  const active = await call(editor, 'GET', '/v1/presentation/active');
  const published = await write('/v1/presentation/profiles', {
    profile: {
      format: PROFILE_FORMAT,
      generic: overview,
      types: [{ type: 'schema:Book', views: { overview, discussion } }],
      bases: [],
      routes: [],
    },
  });
  expect(published.status).toBe(201);
  expect(
    (await write(`/v1/presentation/profiles/${published.body.digest}:activate`, { expected_head: active.body.head }))
      .status,
  ).toBe(200);
}, 120000);
afterAll(async () => {
  await driver?.close();
});
function page(realmId = realm, continuation?: { node: string; cursor: string }) {
  return call(reader, 'POST', '/v1/pages:read', {
    target: { subject, realm: realmId, view: 'discussion' },
    ...(continuation ? { continuation } : {}),
  });
}
function threadBody(body: Record<string, unknown>) {
  const reads = record(body.reads);
  const plan = planReads(platformRegistry, discussion, {
    subject,
    context: { id: selected, population: { kind: 'realm', id: realm, title: 'Selected readers' } },
  });
  return record(record(reads[plan.nodes.discussion!]).body);
}
test('selected factual Context and current discussions share one authorized page, with one native continuation', async () => {
  const first = await page();
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.context).toEqual({
    id: selected,
    population: { kind: 'realm', id: realm, title: 'Selected readers' },
  });
  expect(JSON.stringify(first.body)).toContain('https://example.test/selected');
  const threads = threadBody(first.body);
  expect(threads.threads).toHaveLength(5);
  const second = await page(realm, { node: 'discussion', cursor: text(threads.next) });
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  const next = threadBody(second.body);
  expect(next.threads).toHaveLength(1);
  expect(next.next).toBeNull();
  if (!Array.isArray(next.threads) || !Array.isArray(threads.threads)) throw new Error('Expected threads');
  expect(record(next.threads[0]).id).not.toBe(record(threads.threads[0]).id);
});
test.each(['withdraw', 'ban'] as const)('late %s discards the selected output', async (change) => {
  const target = await makeRealm();
  afterThreads = async () => {
    const result =
      change === 'withdraw'
        ? await (async () => {
            const current = await call(editor, 'GET', `/v1/realms/${target}/publications/${subject}`);
            return call(editor, 'POST', `/v1/realms/${target}/publications/${subject}:withdraw`, undefined, {
              'if-match': JSON.stringify(record(current.body.publication).publicationId),
            });
          })()
        : await call(editor, 'PUT', `/v1/realms/${target}/bans/${reader.accountId}`, { reason: 'Private reason' });
    expect(result.status).toBe(200);
  };
  const result = await page(target);
  expect(result.status).toBe(change === 'ban' ? 404 : 503);
  expect(result.body).not.toHaveProperty('reads');
  expect(result.body).not.toHaveProperty('context');
  if (change === 'withdraw') expect(result.headers.get('retry-after')).toBe('1');
});
