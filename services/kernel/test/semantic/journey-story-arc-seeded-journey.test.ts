import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { setupPresentation } from '../../src/presentation/setup.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const relays = startRelays(pool, [linkProjection(pool)], { intervalMs: 50 });
const accounts = {
  editor: '019a1b2c-3d4e-7f00-8a00-ed170e000241',
  acceptor: '019a1b2c-3d4e-7f00-8a00-ed170e000242',
};
const real = await createRealAccess(admin, accounts, [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
]);
const kernel = createKernel({
  pool,
  access: real.access,
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(43)]]) },
  receiptKeys: testReceiptKeys(),
  routeKey: new Uint8Array(32).fill(44),
  writeRate: real.writeRate,
});
const snak = (id: string, content: unknown) => ({ property: { id }, value: { type: 'value' as const, content } });
const statement = (id: string, content: unknown, qualifiers: unknown[] = [], references: unknown[] = []) => ({
  ...snak(id, content),
  qualifiers,
  references,
});
const cited = (id: string, content: unknown, url: string) =>
  statement(id, content, [], [{ parts: [snak('schema:url', url)] }]);

beforeAll(async () => {
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
  await setupPresentation(pool);
  for (const account of ['editor', 'acceptor'] as const)
    await admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
      routeOf(accounts[account]),
      accounts[account],
    ]);
  for (const action of ['subject:create', 'subject:read', 'statement:propose'] as const)
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  for (const action of ['subject:read', 'context:accept', 'context:adopt'] as const)
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'acceptor', action);
});
afterAll(async () => {
  await relays.stop();
  await pool.end();
  await admin.end();
});

async function call(persona: keyof typeof accounts | null, method: string, path: string, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        ...(persona ? { authorization: `Bearer ${real.bearer(persona)}` } : {}),
        'idempotency-key': `"${randomUUID()}"`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
const projection = linkProjection(pool);
const holders = new Set<string>();
async function create(type: string, name: string, statements: Record<string, unknown> = {}) {
  const answer = await call('editor', 'POST', '/v1/subjects', { type, labels: { en: name }, statements });
  expect(answer.status).toBe(201);
  holders.add(answer.body.subject.id);
  return answer.body.subject as { id: string };
}
/** Relation and link pages read projected rows; drain each partition holding a created subject first. */
async function catchUp() {
  for (const partition of new Set([...holders].map((id) => routeOf(id)! >>> 4))) {
    for (;;) {
      const result = await projection.run(partition);
      if (result.status === 'busy') continue;
      if (result.envelopes === 0) break;
    }
  }
}
function pageSubject(page: Record<string, any>) {
  for (const result of Object.values(page.reads ?? {}) as { status?: number; body?: any }[])
    if (result?.status === 200 && result.body?.subject) return result.body;
}
async function readPage(persona: keyof typeof accounts | null, id: string) {
  return call(persona, 'POST', '/v1/pages:read', { target: { subject: id }, languages: ['en'] });
}

test('a serial work lists its story arcs in native order beyond the preview, with qualifiers and citations', async () => {
  const arcs = [
    await create('wd:Q2620972', 'Opening'),
    await create('wd:Q2620972', 'Journey'),
    await create('wd:Q2620972', 'Finale'),
  ];
  // Supply the arc statements out of order; each keeps its own position, part range and citation.
  const work = await create('schema:TVSeries', 'A 24-episode series', {
    'rezics:storyArc': [2, 0, 1].map((index) =>
      statement(
        'rezics:storyArc',
        arcs[index]!.id,
        [
          snak('schema:position', String(index + 1)),
          snak('rezics:firstPart', String(index * 8 + 1)),
          snak('rezics:lastPart', String(index * 8 + 8)),
        ],
        [{ parts: [snak('schema:url', `https://guide.example.test/arc-${index + 1}`)] }],
      ),
    ),
  });
  await catchUp();
  const found: Record<string, any>[] = [];
  let cursor: string | null = null;
  do {
    const page = await call(
      'editor',
      'GET',
      `/v1/subjects/${work.id}/relations?property=rezics%3AstoryArc&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    expect(page.status).toBe(200);
    found.push(...page.body.relations);
    cursor = page.body.next;
  } while (cursor);
  expect(found.map((entry) => entry.target)).toEqual(arcs.map((arc) => arc.id));
  for (const [index, entry] of found.entries()) {
    expect(entry.statement.qualifiers.map((qualifier: any) => qualifier.property.id)).toEqual([
      'schema:position',
      'rezics:firstPart',
      'rezics:lastPart',
    ]);
    expect(entry.statement.qualifiers[0].value.content).toBe(String(index + 1));
    expect(entry.statement.references[0].parts[0].value.content).toBe(`https://guide.example.test/arc-${index + 1}`);
  }
});

test('a story arc correction is proposed, accepted and adopted, then read back anonymously', async () => {
  const arc = await create('wd:Q2620972', 'Finale');
  const contributor = await create('schema:Person', 'Ren Atsumi');
  const proposed = await call('editor', 'POST', `/v1/subjects/${arc.id}/candidates`, {
    statement: cited('schema:contributor', contributor.id, 'https://guide.example.test/contributor'),
  });
  expect({ status: proposed.status, body: proposed.body }).toMatchObject({ status: 201 });
  await catchUp();
  const pending = await readPage(null, arc.id);
  expect(pageSubject(pending.body).related).not.toHaveProperty(contributor.id);
  const accepted = await call(
    'acceptor',
    'POST',
    `/v1/subjects/${arc.id}/candidates/${proposed.body.candidate}:accept`,
    { context: GLOBAL_CONTEXT, expected_head: null },
  );
  expect(accepted.status).toBe(200);
  const adopted = await call('acceptor', 'POST', `/v1/subjects/${arc.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:contributor',
    target: contributor.id,
    mode: 'replace',
    selection: [{ candidate: proposed.body.candidate, rank: 'normal' }],
    expected_head: null,
  });
  expect(adopted.status).toBe(200);
  const readback = await readPage(null, arc.id);
  expect(readback.status).toBe(200);
  expect(pageSubject(readback.body).related[contributor.id].labels.en).toBe('Ren Atsumi');
});
