import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { startRelays } from '../../src/events/relays.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { runCommand } from '../../src/command/command.ts';
import { LINKS_CHANGED, SUBJECT_REVISED } from '../../src/semantic/events.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { factDataTypes, isRelationProperty, itemFacts } from '../../src/semantic/item.ts';
import { linkChanges } from '../../src/semantic/link-changes.ts';
import { holderFacts } from '../../src/semantic/link-keys.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { writeFacts } from '../../src/semantic/subject.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import { suspendAccount } from '../support/native-suspension-driver.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createRealAccess } from './real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 4 });
const accounts = {
  editor: newId(0x7210),
  acceptor: newId(0x7220),
  steward: newId(0x7230),
  outsider: newId(0x7240),
  suspended: newId(0x7250),
};
const actions = [
  'definitions:publish',
  'definitions:activate',
  'gate:definition_publication',
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:create',
  'context:read',
  'context:accept',
  'context:adopt',
  'moderation:hide',
];
const real = await createRealAccess(admin, accounts, actions);
const kernel = createKernel({
  pool,
  access: real.access,
  writeRate: real.writeRate,
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(113)]]) },
  routeKey: new Uint8Array(32).fill(114),
  receiptKeys: testReceiptKeys(),
  requestDeadlineMs: 30_000,
});
const projection = linkProjection(pool);
const relays = startRelays(pool, [projection], { intervalMs: 20 });
type Persona = keyof typeof accounts | undefined;
const citation = {
  parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/original' } }],
};
const release = bundledRelease;
const digest = bundledDigest;
const PROPERTY = 'schema:character';
const partitions = new Set<number>();
let work = '';
let role = '';
let people: string[] = [];
let hidden = '';
let publishedAppearance = '';

function snak(id: string, content: unknown) {
  return { property: { id }, value: { type: 'value' as const, content } };
}
function appearance(target: string, _position: number, spoiler = false, extraCitation = false) {
  return {
    property: { id: PROPERTY },
    rank: 'normal' as const,
    value: { type: 'value' as const, content: target },
    qualifiers: [
      snak('wdt:P3831', role),
      snak('wdt:P1932', 'Lead'),
      ...(spoiler ? [snak('rezics:spoilerLevel', { amount: '+2', unit: '1' })] : []),
    ],
    references: extraCitation
      ? [
          citation,
          {
            parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/copy' } }],
          },
        ]
      : [citation],
  };
}

async function handle(method: string, path: string, as?: Persona, body?: unknown, key = randomUUID()) {
  const headers: Record<string, string> = { 'accept-language': 'zh-CN, ja;q=0.8, en;q=0.3' };
  if (as) headers.authorization = `Bearer ${real.bearer(as)}`;
  if (method === 'POST') headers['idempotency-key'] = `"${key}"`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, headers: response.headers, body: (await response.json()) as any };
}

async function call(method: string, path: string, as: Persona = 'editor', body?: unknown) {
  const result = await handle(method, path, as, body);
  if (result.status !== 200 && result.status !== 201)
    throw new Error(`${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function drain() {
  for (let step = 0; step < 400; step++) {
    let pending = false;
    for (const partition of partitions) {
      const result = await projection.run(partition);
      pending ||= result.status === 'busy' || result.envelopes > 0;
    }
    if (!pending) return;
    await Bun.sleep(5);
  }
  throw new Error('Links worker did not drain');
}

async function untilCaughtUp(id: string, query: string) {
  for (let step = 0; step < 200; step++) {
    const page = await call('GET', `/v1/subjects/${id}/${query}`);
    if (page.freshness?.caught_up === true) return page;
    await drain();
    await Bun.sleep(20);
  }
  throw new Error(`Incoming-link worker did not catch up for ${id} ${query}`);
}

async function pageAll(kind: 'relations' | 'links', id: string, property: string, as: Persona = 'editor') {
  const rows: any[] = [];
  let cursor: string | null = null;
  let last: any;
  do {
    const query = new URLSearchParams({ property, limit: '5' });
    if (cursor) query.set('cursor', cursor);
    last = await call('GET', `/v1/subjects/${id}/${kind}?${query}`, as);
    rows.push(...(kind === 'relations' ? last.relations : last.links));
    if (cursor && last.next === cursor) throw new Error('Relation continuation repeated its cursor');
    cursor = last.next;
  } while (cursor);
  return { rows, last };
}

beforeAll(async () => {
  for (const account of Object.values(accounts)) {
    await admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
      routeOf(account),
      account,
    ]);
  }
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'gate:definition_publication');
  const grants: Record<Exclude<keyof typeof accounts, 'editor'>, readonly string[]> = {
    acceptor: ['subject:read', 'context:create', 'context:read', 'context:accept', 'context:adopt'],
    steward: ['subject:read', 'moderation:hide'],
    outsider: ['subject:read'],
    suspended: ['subject:read'],
  };
  for (const [persona, granted] of Object.entries(grants) as [
    Exclude<keyof typeof accounts, 'editor'>,
    readonly string[],
  ][]) {
    for (const action of granted) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, persona, action);
  }
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
  role = (await call('POST', '/v1/subjects', 'editor', { type: 'skos:Concept', labels: { en: 'Lead', ja: '主役' } }))
    .subject.id;
  partitions.add(partitionOf(routeOf(role)!));
  people = [];
  for (let index = 0; index < 16; index++) {
    const person = (
      await call('POST', '/v1/subjects', 'editor', {
        type: 'wd:Q95074',
        labels:
          index === 0
            ? { ja: `人物${String(index).padStart(2, '0')}` }
            : { en: `Person ${String(index).padStart(2, '0')}`, ja: `人物${String(index).padStart(2, '0')}` },
      })
    ).subject.id;
    people.push(person);
    partitions.add(partitionOf(routeOf(person)!));
    await real.grant({ route: routeOf(person)!, id: person }, 'editor', 'subject:read');
  }
  hidden = people[15]!;
  await real.grant({ route: routeOf(hidden)!, id: hidden }, 'steward', 'moderation:hide');
  const created = await call('POST', '/v1/subjects', 'editor', {
    type: 'schema:Movie',
    labels: { en: 'Journey work', ja: '旅程の作品' },
    statements: {
      [PROPERTY]: people.slice(0, 4).map((target, index) => appearance(target, index + 1, index === 3, index < 2)),
    },
  });
  work = created.subject.id;
  partitions.add(partitionOf(routeOf(work)!));
  const workResource = { route: routeOf(work)!, id: work };
  await real.grant(workResource, 'editor', 'subject:read');
  await real.grant(workResource, 'editor', 'statement:propose');
  await real.grant(workResource, 'acceptor', 'subject:read');
  await real.grant(workResource, 'acceptor', 'context:accept');
  await real.grant(workResource, 'acceptor', 'context:adopt');
  await real.grant(workResource, 'outsider', 'subject:read');
  await real.grant(workResource, 'steward', 'subject:read');
  await real.grant(workResource, 'steward', 'moderation:hide');
  const remainder = people.slice(4).map((target, index) => appearance(target, index + 5));
  const facts = itemFacts(
    work,
    { labels: { en: 'Journey work', ja: '旅程の作品' }, statements: { [PROPERTY]: remainder } },
    'schema:Movie',
    release,
  ).filter((fact) => fact.kind === 'statement');
  const seededRoute = routeOf(work)!;
  await runCommand(pool, { partition: partitionOf(seededRoute) }, async (tx, { transactionId }) => {
    await tx.query('UPDATE semantic.subject SET current_release=$3 WHERE route=$1 AND subject_id=$2', [
      seededRoute,
      work,
      digest,
    ]);
    const stored = facts.map((fact) => ({
      ...fact,
      release: digest,
      relation: fact.kind === 'statement' && isRelationProperty(release, fact.property!),
    }));
    await writeFacts(tx, {
      route: seededRoute,
      subject_id: work,
      transaction_id: transactionId,
      facts: stored,
    });
    const identity = await holderFacts(tx, work, release);
    const changes = linkChanges([], stored, factDataTypes(release, stored), {
      subject: work,
      release,
      type: 'schema:Movie',
      identityFacts: identity.facts,
    });
    return {
      value: null,
      events: [
        { type: SUBJECT_REVISED, subject: work, data: { id: work, revision: 1, kind: 'create' } },
        {
          type: LINKS_CHANGED,
          subject: work,
          data: { subject: work, revision: 1, security_revision: 0, changes },
        },
      ],
    };
  });
  await drain();
}, 120_000);

afterAll(async () => {
  await relays.stop();
  await Promise.all([pool.end(), admin.end()]);
});

test('ordinary relation readers exhaust a qualified graph, publish an edit, and keep independent history', async () => {
  const preview = await call('GET', `/v1/subjects/${work}`, undefined);
  expect(preview.subject.statements['schema:character']).toHaveLength(12);
  expect(preview.subject.relationCounts ?? {}).toEqual({});

  const editorPage = await untilCaughtUp(work, 'relations?property=schema:character&limit=5');
  expect(editorPage.freshness).toEqual({ consistency: 'eventual', target_seconds: 10, caught_up: true });
  expect(editorPage).not.toHaveProperty('count');
  const exhausted = await pageAll('relations', work, 'schema:character');
  expect(exhausted.rows).toHaveLength(16);
  expect(exhausted.last.next).toBeNull();
  expect(exhausted.rows.map((row) => row.target).sort()).toEqual([...people].sort());
  expect(new Set(people.map((id) => partitionOf(routeOf(id)!))).size).toBeGreaterThan(1);
  const byTarget = new Map(exhausted.rows.map((row) => [row.target, row]));
  expect(byTarget.get(people[0])?.label).toBe('人物00');
  expect(byTarget.get(people[1])?.label).toBe('人物01');
  expect(byTarget.get(people[0])?.related?.[role]?.label?.value).toBe('主役');
  expect(byTarget.get(people[0])?.statement.references).toHaveLength(2);
  expect(
    byTarget
      .get(people[0])
      ?.statement.references.map(
        (reference: { parts: { value: { content: string } }[] }) => reference.parts[0]?.value.content,
      ),
  ).toEqual(['https://example.test/original', 'https://example.test/copy']);
  expect(byTarget.get(people[2])?.statement.references).toHaveLength(1);
  expect(
    byTarget
      .get(people[3])
      ?.statement.qualifiers?.some(
        (snak: { property: { id: string }; value: { content: { amount: string } } }) =>
          snak.property.id === 'rezics:spoilerLevel' && snak.value.content.amount === '+2',
      ),
  ).toBe(true);

  const observer = observeSql(pool);
  try {
    await call('GET', `/v1/subjects/${work}/relations?property=schema:character&limit=16`);
    const summaryPartitions = new Set(
      observer.records
        .filter(({ statement }) => /summaries|semantic\.summary/i.test(statement))
        .flatMap(({ parameters }) =>
          parameters.filter((value) => typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))),
        )
        .map((value) => Number(value)),
    );
    expect([...summaryPartitions].some((value) => partitions.has(value) || value === 0)).toBe(true);
  } finally {
    await observer.close();
  }

  const inverse = await untilCaughtUp(people[0]!, 'links?property=schema:character&limit=5');
  expect(inverse.freshness.caught_up).toBe(true);
  expect(inverse.links.map((row: { subject: string }) => row.subject)).toEqual([work]);
  const retry = await call(
    'GET',
    `/v1/subjects/${work}/relations?property=schema:character&limit=5&cursor=${encodeURIComponent(editorPage.next)}`,
  );
  expect(retry.relations.map((row: { target: string }) => row.target)).toEqual(
    (
      await call(
        'GET',
        `/v1/subjects/${work}/relations?property=schema:character&limit=5&cursor=${encodeURIComponent(editorPage.next)}`,
      )
    ).relations.map((row: { target: string }) => row.target),
  );

  await call('POST', `/v1/subjects/${hidden}:hide`, 'steward', { reason: 'Concealed relation target' });
  await drain();
  const afterHide = await pageAll('relations', work, 'schema:character', undefined);
  expect(afterHide.rows.map((row) => row.target)).not.toContain(hidden);
  expect(afterHide.rows).toHaveLength(15);
  expect(afterHide.last).not.toMatchObject({ count: { value: 0 } });
  const publicPreview = await call('GET', `/v1/subjects/${work}`, undefined);
  expect(publicPreview.related?.[hidden]).toBeUndefined();

  const extra = (
    await call('POST', '/v1/subjects', 'editor', {
      type: 'wd:Q95074',
      labels: { en: 'Published person', ja: '公開された人物' },
    })
  ).subject.id;
  partitions.add(partitionOf(routeOf(extra)!));
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'statement:propose');
  await real.grant({ route: routeOf(work)!, id: work }, 'editor', 'statement:propose');
  const proposed = await handle('POST', `/v1/subjects/${work}/candidates`, 'editor', {
    statement: appearance(extra, 17),
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  publishedAppearance = proposed.body.candidate;
  const accepted = await handle('POST', `/v1/subjects/${work}/candidates/${publishedAppearance}:accept`, 'acceptor', {
    context: GLOBAL_CONTEXT,
    expected_head: null,
  });
  expect(accepted.status).toBe(200);
  const adopted = await handle('POST', `/v1/subjects/${work}:adopt`, 'acceptor', {
    context: GLOBAL_CONTEXT,
    property: 'schema:character',
    target: extra,
    mode: 'replace',
    selection: [{ candidate: publishedAppearance, rank: 'normal' }],
    expected_head: null,
  });
  expect(adopted.status).toBe(200);
  await drain();
  const independent = await pageAll('relations', work, 'schema:character', undefined);
  expect(independent.rows.map((row) => row.target)).toContain(extra);
  const editorView = await pageAll('relations', work, 'schema:character', 'editor');
  expect(editorView.rows.map((row) => row.target)).toContain(extra);
  const outsider = await handle('GET', `/v1/subjects/${work}/relations?property=schema:character&limit=20`, 'outsider');
  expect(outsider.status).toBe(200);
  expect(outsider.body.relations.map((row: { target: string }) => row.target)).toContain(extra);
  const denied = await handle('POST', `/v1/subjects/${work}/candidates`, 'outsider', {
    statement: appearance(extra, 18),
  });
  expect([401, 403]).toContain(denied.status);
  const missing = await handle('POST', `/v1/subjects/${work}/candidates`, undefined, {
    statement: appearance(extra, 18),
  });
  expect(missing.status).toBe(401);

  const history = await pageAllHistory(work);
  expect(history.map((row) => row.kind)).toEqual(expect.arrayContaining(['create', 'propose', 'accept', 'adopt']));
  const createRevision = history.find((row) => row.kind === 'create')!;
  const createDetail = await call('GET', `/v1/subjects/${work}/revisions/${createRevision.revision}`, undefined);
  expect(createDetail.change?.kind === 'terms' || createDetail.revision.kind === 'create').toBe(true);
  const afterPublish = await call('GET', `/v1/subjects/${work}`, undefined);
  expect(afterPublish.subject.statements['schema:character']).toHaveLength(12);
  expect(afterPublish.subject.relationCounts ?? {}).toEqual({});

  const suspendedBearer = real.bearer('suspended');
  await suspendAccount(admin, accounts.suspended);
  const suspended = await kernel.handle(
    new Request(`http://kernel.test/v1/subjects/${work}/relations?property=schema:character`, {
      headers: { authorization: `Bearer ${suspendedBearer}` },
    }),
  );
  expect(suspended.status).toBe(401);
  expect(suspended.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  expect((await suspended.json()).code).toBe('invalid_credentials');
});

async function pageAllHistory(id: string) {
  const revisions: { revision: number; kind: string }[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '5' });
    if (cursor) query.set('cursor', cursor);
    const page = await call('GET', `/v1/subjects/${id}/revisions?${query}`, undefined);
    revisions.push(...page.revisions);
    cursor = page.next;
  } while (cursor);
  return revisions;
}

test('external relation and history input is refused without inventing a page', async () => {
  const unknownProperty = await handle('GET', `/v1/subjects/${work}/relations?property=ex:missing`);
  expect(unknownProperty.status).toBe(400);
  const badCursor = await handle('GET', `/v1/subjects/${work}/relations?property=schema:character&cursor=not-a-cursor`);
  expect(badCursor.status).toBe(400);
  const filterWithoutProperty = await handle('GET', `/v1/subjects/${work}/links?filter=${role}`);
  expect(filterWithoutProperty.status).toBe(400);
  const typed = await handle('GET', `/v1/subjects/${work}/relations?property=schema:character&type=wd:Q95074&limit=5`);
  expect(typed.status).toBe(200);
  if (typed.body.count) {
    expect(typed.body.count.exact === true ? typed.body.count.value : typed.body.count.value).toBeGreaterThan(0);
  } else {
    expect(typed.body.relations.length).toBeGreaterThan(0);
  }
});
