import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { pageSubjectPageCandidates } from '../../src/semantic/subject-page-candidates.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { encodeCursor } from '../../src/tokens/cursor.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';

// Transport acceptance deliberately has no publication runner, worker or foreign Relay dependency.
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
const editor = '019a1b2c-3d4e-7f00-8a00-ed170e000191';
const routeKey = new Uint8Array(32).fill(91);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(92)]]) };
const origin = Date.now();
let now = new Date(origin);
const clock = () => now;
const actions = [
  'subject:create',
  'subject:read',
  'subject:merge',
  'statement:propose',
  'context:create',
  'context:accept',
  'context:adopt',
  'moderation:hide',
  'moderation:takedown',
];
type Entry = { id: string; labels: { language: string; value: string }[]; lastModified?: string };
type Page = { subjectPages: Entry[]; next: string | null };
const subjects: Record<string, any> = {};
let ordered: { route: number; id: string }[];
let legacy: string;

function keyIn(partition: number, route?: number) {
  for (;;) {
    const key = randomUUID();
    const home = anchorRoute(routeKey, `${editor}\nsubject.create\n${key}`);
    if (partitionOf(home) === partition && (route === undefined || home === route)) return key;
  }
}
async function post(path: string, body: unknown, status = 200, key = randomUUID()) {
  const send = () =>
    app.handle(
      new Request(`http://kernel.test${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${real.bearer('editor')}`,
          'content-type': 'application/json',
          'idempotency-key': `"${key}"`,
        },
        body: JSON.stringify(body),
      }),
    );
  let response = await send();
  let value = (await response.json()) as Record<string, any>;
  for (
    let retry = 0;
    retry < 2 &&
    response.status === 503 &&
    value.code === 'overloaded' &&
    value.retryable === true &&
    value.effect_status === 'not_applied';
    retry++
  ) {
    response = await send();
    value = (await response.json()) as Record<string, any>;
  }
  expect([path, response.status, response.status === status ? null : value]).toEqual([path, status, null]);
  return value;
}
const statement = (property: string, content: string) => ({
  property: { id: property },
  value: { type: 'value', content },
});
async function book(name: string, positive = false, partition = 0, route = partition === 0 ? 1 : undefined) {
  return (
    await post(
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { ja: `${name} 日本語`, en: name },
        statements: positive ? { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] } : {},
      },
      201,
      keyIn(partition, route),
    )
  ).subject;
}
async function proposal(id: string) {
  return (
    await post(
      `/v1/subjects/${id}/candidates`,
      {
        statement: {
          ...statement('schema:inLanguage', 'en'),
          references: [{ parts: [statement('schema:url', 'https://example.test/source')] }],
        },
      },
      201,
    )
  ).candidate as string;
}
async function select(id: string, candidate: string, context = GLOBAL_CONTEXT, adopt = true) {
  await post(`/v1/subjects/${id}/candidates/${candidate}:accept`, { context, expected_head: null });
  if (adopt)
    await post(`/v1/subjects/${id}:adopt`, {
      context,
      property: 'schema:inLanguage',
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: null,
    });
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  real = await createRealAccess(db.admin, { editor }, actions, { clock });
  await db.admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(editor),
    editor,
  ]);
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  app = createKernel({ pool: db.pool, routeKey, tokens, clock, access: real.access, writeRate: real.writeRate });
  subjects.rawFirst = await book('First raw key', false, 0, 0);
  subjects.rawSecond = await book('Second raw key', false, 0, 0);
  subjects.public = await book('Public', true);
  const target = (
    await post('/v1/subjects', { type: 'schema:Person', labels: { en: 'Current relation target' } }, 201, keyIn(0, 1))
  ).subject;
  subjects.currentHidden = (
    await post(
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'Cached relation identity' },
        statements: { 'schema:author': [statement('schema:author', target.id)] },
      },
      201,
      keyIn(0, 1),
    )
  ).subject;
  await post(`/v1/subjects/${target.id}:hide`, { reason: 'Current target gate, with no Relay delivery' });
  subjects.title = await book('Labels only');
  subjects.pending = await book('Proposal only');
  await proposal(subjects.pending.id);
  subjects.unselected = await book('Accepted only');
  await select(subjects.unselected.id, await proposal(subjects.unselected.id), GLOBAL_CONTEXT, false);
  const context = (await post('/v1/contexts', { labels: { en: 'Private' } }, 201)).context.id;
  subjects.private = await book('Private selection');
  await select(subjects.private.id, await proposal(subjects.private.id), context);
  subjects.hiddenFact = await book('Hidden fact', true);
  await post(
    `/v1/subjects/${subjects.hiddenFact.id}/candidates/${subjects.hiddenFact.statements['schema:inLanguage'][0].id}:hide`,
    { reason: 'Suppress only positive' },
  );
  subjects.hidden = await book('Hidden subject', true);
  await post(`/v1/subjects/${subjects.hidden.id}:hide`, { reason: 'Suppress original' });
  subjects.removed = await book('Removed', true);
  await post(`/v1/subjects/${subjects.removed.id}:takedown`, {
    notice: { complaint: 'Removal', received_at: now.toISOString() },
  });
  const pair = [await book('Merge one', true), await book('Merge two', true)].sort((a, b) => a.id.localeCompare(b.id));
  await post('/v1/subjects:merge', { subjects: pair.map((s) => s.id) });
  subjects.merged = pair[1];
  subjects.survivor = pair[0];
  // More than the default candidate budget, with positive sentinels selected below through real commands.
  for (let i = 0; i < 14; i++) subjects[`padding${i}`] = await book(`Noindex ${i}`);
  subjects.later = await book('After exactly one empty partition', true, 2);
  subjects.terminal = await book('Terminal owner', true, 4095);
  ordered = (await pageSubjectPageCandidates(db.pool, tokens, { partition: 0, size: 1000, clock })).candidates;
  expect(ordered.length).toBeGreaterThan(20);
  // Make the raw second key positive: limit=1 must leave this sentinel for the next request.
  const second = ordered[1]!;
  const candidate = await proposal(second.id);
  await select(second.id, candidate);
  // Legal historical source data only. No publication/index/candidate rows are filled or repaired here.
  legacy = newId(15);
  const tx = randomUUID();
  const facts = itemFacts(legacy, { labels: { en: 'Cold historical labels' } }, 'schema:Book', bundledRelease);
  await db.admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_facts,current_release)
    VALUES (15,$1,'schema:Book',$2,$3,$4)`,
    [legacy, tx, facts.length, bundledDigest],
  );
  await db.admin.query(
    `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
    VALUES (15,$1,1,'create',$2,$3)`,
    [legacy, bundledDigest, tx],
  );
  for (const fact of facts) {
    const row = {
      ...fact,
      body: JSON.stringify(fact.body),
      route: 15,
      subject_id: legacy,
      recorded_transaction_id: tx,
    };
    const keys = Object.keys(row);
    await db.admin.query(
      `INSERT INTO semantic.fact (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(row),
    );
  }
  ordered = (await pageSubjectPageCandidates(db.pool, tokens, { partition: 0, size: 1000, clock })).candidates;
}, 120_000);
afterAll(async () => {
  if (db) await db.close();
});

async function get(limit?: number, cursor?: string, headers: Record<string, string> = {}) {
  const query = new URLSearchParams({
    ...(limit === undefined ? {} : { limit: String(limit) }),
    ...(cursor ? { cursor } : {}),
  });
  return app.handle(new Request(`http://kernel.test/v1/subject-pages?${query}`, { headers }));
}
async function page(limit?: number, cursor?: string, headers?: Record<string, string>): Promise<Page> {
  const response = await get(limit, cursor, headers);
  expect(response.status, 'independent real transport, without a mounted runner prerequisite').toBe(200);
  const body = (await response.json()) as Page;
  expect(Object.keys(body).sort()).toEqual(['next', 'subjectPages']);
  expect(body.next === null || typeof body.next === 'string').toBe(true);
  expect(body.subjectPages.length).toBeLessThanOrEqual(limit ?? 20);
  for (const entry of body.subjectPages) {
    expect(Object.keys(entry).sort()).toEqual(
      Object.hasOwn(entry, 'lastModified') ? ['id', 'labels', 'lastModified'] : ['id', 'labels'],
    );
    expect(entry.labels).toEqual([...entry.labels].sort((a, b) => a.language.localeCompare(b.language, 'en')));
    for (const label of entry.labels) expect(Object.keys(label).sort()).toEqual(['language', 'value']);
    if (Object.hasOwn(entry, 'lastModified'))
      expect(new Date(entry.lastModified!).toISOString()).toBe(entry.lastModified!);
  }
  return body;
}

// Count the real candidate producer, not output rows after Access filtering.
function sourceWindows(plans: readonly unknown[]) {
  const windows: number[] = [];
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value['Query Text'] === 'string' && /FROM semantic\.subject AS s\b/.test(value['Query Text']))
      windows.push(Number(value.Plan['Actual Rows']) * Number(value.Plan['Actual Loops']));
    for (const child of Object.values(value)) if (typeof child === 'object') visit(child);
  };
  visit(plans);
  return windows;
}
test('independent real HTTP traversal needs only native store and source primitive', async () => {
  const first = await capture(db, () => page());
  expect(sourceWindows(first.capture.plans)).toEqual([21]);
  const whole = await page(1000);
  expect(whole.subjectPages.map((s) => s.id)).toContain(subjects.public.id);
  expect(whole.subjectPages.find((s) => s.id === subjects.public.id)).toEqual({
    id: subjects.public.id,
    labels: [
      { language: 'en', value: 'Public' },
      { language: 'ja', value: 'Public 日本語' },
    ],
    lastModified: new Date(origin).toISOString(),
  });
  for (const name of [
    'title',
    'pending',
    'unselected',
    'private',
    'hiddenFact',
    'hidden',
    'currentHidden',
    'removed',
    'merged',
  ]) {
    expect(whole.subjectPages.map((s) => s.id)).not.toContain(subjects[name].id);
  }
  const native = await app.handle(new Request(`http://kernel.test/v1/subjects/${subjects.currentHidden.id}`));
  expect(native.status).toBe(200);
  const current = (await native.json()) as any;
  expect((current.subject.statements['schema:author'] ?? []).map((s: any) => s.id)).not.toContain(
    subjects.currentHidden.statements['schema:author'][0].id,
  );
  expect(whole.subjectPages.map((s) => s.id)).not.toContain(subjects.later.id);
  const english = await page(1000, undefined, {
    authorization: `Bearer ${real.bearer('editor')}`,
    'accept-language': 'en',
  });
  const japanese = await page(1000, undefined, { 'accept-language': 'ja' });
  expect(english).toEqual(japanese);
  expect(whole.subjectPages.map((s) => s.id)).not.toContain(legacy);
  const queued = await db.admin.query(
    `SELECT state FROM semantic.subject_page_repair WHERE route=15 AND subject_id=$1`,
    [legacy],
  );
  expect(queued.rows.length, 'uncertain omission commits durable work before returning').toBe(1);
}, 120_000);
function firstNativeSentinel() {
  return ordered.filter((s) => s.id !== legacy)[1]!.id;
}

test('small raw-key windows preserve the sentinel, hidden progress, and exactly one empty owner step', async () => {
  let cursor: string | undefined;
  const seen: string[] = [];
  for (const candidate of ordered) {
    const measured = await capture(db, () => page(1, cursor));
    expect(sourceWindows(measured.capture.plans)).toEqual([candidate === ordered.at(-1) ? 1 : 2]);
    const body = measured.value;
    expect(body.subjectPages.every((s) => s.id === candidate.id)).toBe(true);
    if (candidate.id === firstNativeSentinel()) expect(body.subjectPages.map((s) => s.id)).toEqual([candidate.id]);
    seen.push(...body.subjectPages.map((s) => s.id));
    expect(body.next).toBeString();
    expect(body.next).not.toBe(cursor);
    cursor = body.next!;
  }
  expect(new Set(seen).size).toBe(seen.length);
  const empty = await capture(db, () => page(1, cursor));
  expect(empty.value.subjectPages).toEqual([]);
  expect(sourceWindows(empty.capture.plans)).toEqual([0]);
  expect(empty.value.next).toBeString();
  const later = await page(1, empty.value.next!);
  expect(later.subjectPages.map((s) => s.id)).toEqual([subjects.later.id]);
  expect(later.next).toBeString();
  cursor = later.next!;
  // Every remaining owner is empty except the terminal owner. Null is legal only there.
  for (let partition = 3; partition <= 4095; partition++) {
    const result = await page(1, cursor);
    if (partition === 4095) {
      expect(result.subjectPages.map((s) => s.id)).toEqual([subjects.terminal.id]);
      expect(result.next).toBeNull();
    } else {
      expect(result.subjectPages).toEqual([]);
      expect(result.next).toBeString();
      expect(result.next).not.toBe(cursor);
      cursor = result.next!;
    }
  }
}, 240_000);

test('signed global cursors reject tampering, foreign purpose, wrong limits, expired and stale epochs', async () => {
  const first = await page(1);
  expect(first.next).toBeString();
  const invalid = async (cursor: string, limit = 1) => {
    const response = await get(limit, cursor);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
  };
  await invalid(`${first.next!.slice(0, -4)}AAAA`);
  const [body, mac] = first.next!.split('.');
  const bytes = Buffer.from(body!, 'base64url');
  expect(bytes[0], 'shared Accounts token version').toBe(1);
  const payload = JSON.parse(bytes.subarray(2).toString());
  expect(payload.e).toBeNumber();
  expect(payload.a).toBeArray();
  for (const changed of [
    { ...payload, e: payload.e + 1 },
    { ...payload, a: [4095, ...payload.a] },
  ]) {
    const forged = Buffer.concat([bytes.subarray(0, 2), Buffer.from(JSON.stringify(changed))]).toString('base64url');
    await invalid(`${forged}.${mac}`);
  }
  const wrongVersion = Buffer.from(bytes);
  wrongVersion[0] = 2;
  await invalid(`${wrongVersion.toString('base64url')}.${mac}`);
  await invalid(first.next!, 2);
  await invalid(
    encodeCursor(
      tokens,
      { operation: 'subject.list', parameters: { size: 1 } },
      { epoch: 1, after: [0, ordered[0]!.id] },
      now.getTime(),
    ),
  );
  const native = await pageSubjectPageCandidates(db.pool, tokens, { partition: 0, size: 1, clock });
  await invalid(native.next!); // A source-only cursor is not a public global continuation.
  now = new Date(origin + 900_001);
  try {
    await invalid(first.next!);
  } finally {
    now = new Date(origin);
  }
  const prior = (await db.admin.query('SELECT epoch,write_state,moved_to FROM core.partition WHERE partition_no=0'))
    .rows[0];
  await db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=0');
  try {
    await invalid(first.next!);
  } finally {
    await db.admin.query('UPDATE core.partition SET epoch=$1 WHERE partition_no=0', [prior.epoch]);
  }
  await db.admin.query("UPDATE core.partition SET write_state='moved',moved_to='elsewhere' WHERE partition_no=0");
  try {
    const moved = await get(1, first.next!);
    expect(moved.status).toBe(503);
    expect(await moved.json()).toMatchObject({ code: 'partition_unavailable' });
  } finally {
    await db.admin.query('UPDATE core.partition SET write_state=$1,moved_to=$2 WHERE partition_no=0', [
      prior.write_state,
      prior.moved_to,
    ]);
  }
}, 120_000);
