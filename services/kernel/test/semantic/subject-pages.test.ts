import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { createRealAccess } from './real-access.ts';
import { itemFacts } from '../../src/semantic/item.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const routeKey = new Uint8Array(32).fill(74);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(75)]]) };
// Authentication keeps real time; domain transitions are six distinct instants within the token lifetime.
const origin = Date.now();
let now = new Date(origin);
const at = (n: number) => (now = new Date(origin + n * 1000)).toISOString();
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000174' };
const actions = [
  'subject:create',
  'subject:read',
  'subject:merge',
  'subject:batch_write',
  'statement:propose',
  'context:create',
  'context:accept',
  'context:adopt',
  'moderation:hide',
  'moderation:takedown',
  'source_fence:takedown',
];
const access = await createRealAccess(admin, accounts, actions, { clock: () => now });
const app = createKernel({
  pool,
  routeKey,
  tokens,
  access: access.access,
  writeRate: access.writeRate,
  clock: () => now,
});
beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(accounts.editor),
    accounts.editor,
  ]);
  for (const action of actions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
}, 60_000);
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function request(path: string, body?: unknown, key = randomUUID(), headers: Record<string, string> = {}) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined
          ? {}
          : {
              authorization: `Bearer ${access.bearer('editor')}`,
              'content-type': 'application/json',
              'idempotency-key': `"${key}"`,
            }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
async function post(path: string, body: unknown, status = 200, key = randomUUID()) {
  let answer = await request(path, body, key);
  // Shared-host overload may reject fixture writes before application. Retry only that explicit outcome,
  // retaining the same receipt key and domain time; feed reads themselves are never retried or replaced.
  for (
    let retry = 0;
    retry < 2 &&
    answer.status === 503 &&
    answer.body.code === 'overloaded' &&
    answer.body.retryable === true &&
    answer.body.effect_status === 'not_applied';
    retry++
  )
    answer = await request(path, body, key);
  expect([path, answer.status, answer.status === status ? null : answer.body]).toEqual([path, status, null]);
  return answer.body;
}
const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});
async function book(name: string, statements: Record<string, unknown[]> = {}, key = randomUUID()) {
  return (
    await post(
      '/v1/subjects',
      { type: 'schema:Book', labels: { ja: `${name} 日本語`, en: name }, statements },
      201,
      key,
    )
  ).subject;
}
async function propose(id: string, language: string) {
  return (
    await post(
      `/v1/subjects/${id}/candidates`,
      {
        statement: {
          ...statement('schema:inLanguage', language),
          references: [{ parts: [statement('schema:url', 'https://example.test/source')] }],
        },
      },
      201,
    )
  ).candidate as string;
}
async function accept(id: string, candidate: string, context = GLOBAL_CONTEXT, decision = 'accept') {
  await post(`/v1/subjects/${id}/candidates/${candidate}:${decision}`, { context, expected_head: null });
}
async function adopt(
  id: string,
  candidate: string,
  expectedHead: number | null | undefined = undefined,
  context = GLOBAL_CONTEXT,
) {
  if (expectedHead === undefined) {
    const result = await admin.query(
      `SELECT max(head)::int AS head FROM semantic.adoption
       WHERE route=$1 AND subject_id=$2 AND context_id=$3`,
      [routeOf(id), id, context],
    );
    expectedHead = result.rows[0].head;
  }
  return post(`/v1/subjects/${id}:adopt`, {
    context,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [{ candidate, rank: 'normal' }],
    expected_head: expectedHead,
  });
}
type Entry = { id: string; lastModified?: string; labels: { language: string; value: string }[] };
type Page = { subjectPages: Entry[]; next: string | null };
async function page(limit = 1000, cursor?: string, headers?: Record<string, string>): Promise<Page> {
  const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
  const answer = await request(`/v1/subject-pages?${query}`, undefined, undefined, headers);
  // A missing route or explicit unavailable backend is an honest red, never a fixture or skip.
  expect(answer.status, 'real public subject-page feed must be implemented').toBe(200);
  expect(Object.keys(answer.body).sort()).toEqual(['next', 'subjectPages']);
  expect(answer.body.subjectPages.length).toBeLessThanOrEqual(limit);
  expect(answer.body.next === null || typeof answer.body.next === 'string').toBe(true);
  for (const entry of answer.body.subjectPages) {
    expect(Object.keys(entry).sort()).toEqual(
      Object.hasOwn(entry, 'lastModified') ? ['id', 'labels', 'lastModified'] : ['id', 'labels'],
    );
    if (Object.hasOwn(entry, 'lastModified')) {
      expect(typeof entry.lastModified).toBe('string');
      expect(new Date(entry.lastModified!).toISOString()).toBe(entry.lastModified);
    }
    expect(entry.labels).toEqual([...entry.labels].sort((a, b) => a.language.localeCompare(b.language, 'en')));
  }
  return answer.body as Page;
}
async function all(limit = 1000): Promise<Entry[]> {
  const entries: Entry[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  // There are 4096 partitions. Each may require its own empty response.
  for (let step = 0; step < 8192; step++) {
    const result = await page(limit, cursor);
    entries.push(...result.subjectPages);
    if (result.next === null) return entries;
    expect(cursors.has(result.next), 'continuation must make progress even on empty output').toBe(false);
    cursors.add(result.next);
    cursor = result.next;
  }
  throw new Error('Finite unchanged fixture did not terminate');
}
async function entry(id: string) {
  return (await all()).find((value) => value.id === id);
}

// This is the production runtime mounted by createKernel, not a test-created dormant factory.
// Resolve only after a real HTTP 200, so a missing backend fails on behavior, never static imports.
type Publication = {
  requestRebuild(subject: { route: number; id: string }): Promise<void>;
  step(options: { limit: number }): Promise<{ processed: number; next: string | null; done: boolean }>;
};
async function publication(): Promise<Publication> {
  await page(4);
  const path = '../../src/semantic/subject-page-publication.ts';
  const module = await import(path);
  expect(typeof module.createSubjectPagePublication, 'production publication factory').toBe('function');
  expect(typeof module.subjectPagePublicationFor, 'runtime mounted by createKernel').toBe('function');
  const runtime = module.subjectPagePublicationFor(app);
  expect(typeof runtime?.step).toBe('function');
  expect(typeof runtime?.requestRebuild).toBe('function');
  return runtime;
}
async function converge(runtime: Publication, maximum = 16384) {
  const cursors = new Set<string>();
  for (let step = 0; step < maximum; step++) {
    const result = await runtime.step({ limit: 32 });
    expect(result.processed).toBeGreaterThanOrEqual(0);
    expect(result.processed).toBeLessThanOrEqual(32);
    if (result.done) {
      expect(result.next).toBeNull();
      return;
    }
    expect(typeof result.next).toBe('string');
    expect(cursors.has(result.next!), 'durable repair must progress').toBe(false);
    cursors.add(result.next!);
  }
  throw new Error('Finite publication repair did not converge under quiescence');
}
async function stable(runtime: Publication, id: string, expected: Entry | undefined) {
  for (let repeat = 0; repeat < 3; repeat++) {
    expect(await entry(id)).toEqual(expected);
    expect(await runtime.step({ limit: 32 })).toEqual({ processed: 0, next: null, done: true });
  }
}

// All setup uses admitted commands, real grants, and the shared domain clock.
test('subject page feed includes only current anonymously indexable pages', async () => {
  at(1);
  const title = await book('Title only');
  const pending = await book('Pending only');
  await propose(pending.id, 'ja');
  const unselected = await book('Accepted but unselected');
  const unselectedCandidate = await propose(unselected.id, 'ja');
  await accept(unselected.id, unselectedCandidate);
  const rejected = await book('Rejected only');
  await accept(rejected.id, await propose(rejected.id, 'ja'), GLOBAL_CONTEXT, 'reject');
  const context = (await post('/v1/contexts', { labels: { en: 'Private selection' } }, 201)).context.id;
  const privateOnly = await book('Private Context only');
  const privateCandidate = await propose(privateOnly.id, 'ja');
  await accept(privateOnly.id, privateCandidate, context);
  await adopt(privateOnly.id, privateCandidate, null, context);
  const publicBook = await book('Published', { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] });
  const hiddenFact = await book('Hidden fact', { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] });
  await post(`/v1/subjects/${hiddenFact.id}/candidates/${hiddenFact.statements['schema:inLanguage'][0].id}:hide`, {
    reason: 'Hidden qualifying fact',
  });
  const hidden = await book('Hidden subject', { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] });
  await post(`/v1/subjects/${hidden.id}:hide`, { reason: 'Hidden subject' });
  const takenDown = await book('Taken down', { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] });
  await post(`/v1/subjects/${takenDown.id}:takedown`, {
    notice: { complaint: 'Rights holder notice', received_at: now.toISOString() },
  });
  const survivor = await book('Survivor', { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] });
  const merged = await book('Redirected', { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] });
  const ordered = [survivor.id, merged.id].sort();
  await post('/v1/subjects:merge', { subjects: ordered });
  expect((await request(`/v1/subjects/${ordered[1]}`)).status).toBe(308);
  const entries = await all();
  const ids = entries.map(({ id }) => id);
  for (const subject of [title, pending, unselected, rejected, privateOnly, hiddenFact, hidden, takenDown]) {
    expect(ids).not.toContain(subject.id);
  }
  expect(ids).not.toContain(ordered[1]);
  expect(ids).toContain(publicBook.id);
  expect(entries.find(({ id }) => id === publicBook.id)?.labels).toEqual([
    { language: 'en', value: 'Published' },
    { language: 'ja', value: 'Published 日本語' },
  ]);
  expect((await request(`/v1/subjects/${hidden.id}`)).status).toBe(404);
  expect((await request(`/v1/subjects/${takenDown.id}`)).status).toBe(404);
  const english = await page(1000, undefined, {
    'accept-language': 'en',
    authorization: `Bearer ${access.bearer('editor')}`,
  });
  const japanese = await page(1000, undefined, { 'accept-language': 'ja' });
  expect(english.subjectPages).toEqual(japanese.subjectPages);
}, 120_000);

test('subject page lastModified tracks shown public changes and ignores private activity', async () => {
  const t1 = at(11);
  const subject = await book('Publication clock', {
    'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
    'schema:url': [statement('schema:url', 'https://example.test/older-B')],
  });
  const shownA = subject.statements['schema:inLanguage'][0].id as string;
  at(12); // T2: proposal exists in editorial history but is not selected.
  const candidate = await propose(subject.id, 'en');
  at(13); // T3: moderation of a never-shown candidate is not a public change.
  const unshown = await propose(subject.id, 'fr');
  await post(`/v1/subjects/${subject.id}/candidates/${unshown}:hide`, { reason: 'Unshown candidate' });
  expect((await entry(subject.id))?.lastModified).toBe(t1);
  const t4 = at(14);
  await accept(subject.id, candidate);
  await adopt(subject.id, candidate);
  expect((await entry(subject.id))?.lastModified).toBe(t4);
  const t5 = at(15); // Remove shown replacement; older B still qualifies.
  const key = randomUUID();
  const path = `/v1/subjects/${subject.id}/candidates/${candidate}:hide`;
  const body = { reason: 'Remove shown A while B remains' };
  await post(path, body, 200, key);
  expect((await entry(subject.id))?.lastModified).toBe(t5);
  const t6 = at(16);
  await post(`/v1/subjects/${subject.id}/candidates/${candidate}:restore`, { reason: 'Restore public selection' });
  expect((await entry(subject.id))?.lastModified).toBe(t6);
  at(17);
  await post(path, body, 200, key); // Historical receipt replay must not hide again or fabricate freshness.
  expect((await entry(subject.id))?.lastModified).toBe(t6);
  expect(
    (await request(`/v1/subjects/${subject.id}`)).body.subject.statements['schema:inLanguage'].map((s: any) => s.id),
  ).toContain(candidate);
  expect(shownA).not.toBe(candidate);
  at(18);
  const runtime = await publication();
  await runtime.requestRebuild({ route: routeOf(subject.id)!, id: subject.id });
  await converge(runtime);
  const rebuilt = await entry(subject.id);
  expect(rebuilt?.lastModified).toBe(t6);
  await stable(runtime, subject.id, rebuilt);
}, 240_000);

// The request has no partition selector: choose ordinary creation keys that place this fixture at the start.
function keyIn(partition: number) {
  for (;;) {
    const key = randomUUID();
    if (partitionOf(anchorRoute(routeKey, `${accounts.editor}\nsubject.create\n${key}`)) === partition) return key;
  }
}
test('subject page keysets advance across empty and noindex windows without gaps', async () => {
  at(21);
  // Keep the noindex run and intervening empty partition independent of earlier random route placements.
  const existing = (
    await admin.query('SELECT route >> 4 AS partition, count(*)::int AS candidates FROM semantic.subject GROUP BY 1')
  ).rows;
  const occupied = new Set(existing.map((row) => row.partition));
  let partition = 0;
  while (occupied.has(partition) || occupied.has(partition + 1) || occupied.has(partition + 2)) partition++;
  expect(partition).toBeLessThan(4094);
  const precedingSteps = Array.from({ length: partition }, (_, p) =>
    Math.max(1, Math.ceil((existing.find((row) => row.partition === p)?.candidates ?? 0) / 4)),
  ).reduce((sum, steps) => sum + steps, 0);
  const candidates = [];
  for (let index = 0; index < 45; index++) candidates.push(await book(`Noindex ${index}`, {}, keyIn(partition)));
  candidates.sort((a, b) => routeOf(a.id)! - routeOf(b.id)! || a.id.localeCompare(b.id));
  const eligible = candidates.pop()!;
  const noindex = candidates.map(({ id }) => id as string);
  const selected = await propose(eligible.id, 'ja');
  await accept(eligible.id, selected);
  await adopt(eligible.id, selected);
  const later = await book(
    'After empty partition',
    { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] },
    keyIn(partition + 2),
  );
  expect(partitionOf(routeOf(eligible.id)!)).toBe(partition);
  const traversed: Entry[] = [];
  let cursor: string | undefined;
  let empty = 0;
  for (let step = 0; step < 8192; step++) {
    const result = await page(4, cursor);
    if (result.subjectPages.some(({ id }) => id === eligible.id)) {
      // Forty-four preceding noindex candidates consume eleven full candidate windows.
      expect(step).toBe(precedingSteps + 11);
    }
    traversed.push(...result.subjectPages);
    if (!result.subjectPages.length && result.next) empty++;
    if (result.next === null) break;
    expect(result.next).not.toBe(cursor);
    cursor = result.next;
    expect(step).toBeLessThan(8191);
  }
  const ids = traversed.map(({ id }) => id);
  expect(empty).toBeGreaterThan(10);
  expect(ids.filter((id) => id === eligible.id)).toEqual([eligible.id]);
  expect(ids.filter((id) => id === later.id)).toEqual([later.id]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.some((id) => noindex.includes(id))).toBe(false);
  const first = await page(4);
  expect(first.next).toBeString();
  const invalid = new URLSearchParams({ limit: '4', cursor: `${first.next!.slice(0, -4)}AAAA` });
  expect((await request(`/v1/subject-pages?${invalid}`)).status).toBe(400);
  const foreign = new URLSearchParams({ limit: '5', cursor: first.next! });
  expect((await request(`/v1/subject-pages?${foreign}`)).status).toBe(400);
  for (const limit of ['0', '1001']) expect((await request(`/v1/subject-pages?limit=${limit}`)).status).toBe(400);
  expect((await request('/v1/subject-pages')).status).toBe(200);
}, 120_000);

// This is the adversarial completeness case, independent of whether the implementation calls its
// bounded evidence a witness, a preview, an existence cache or a publication projection.
test('foreign tuple fences allow lag then repair the surviving public fact at its original removal time', async () => {
  const publishedAt = at(31);
  const subject = await book('Foreign fence', {
    'schema:url': [statement('schema:url', 'https://example.test/survivor')],
  });
  let externalId: string;
  do {
    externalId = randomUUID();
  } while (partitionOf(tupleRoute(routeKey, 'openlibrary', externalId)) === partitionOf(routeOf(subject.id)!));
  const batch = await post('/v1/subjects:batchWrite', {
    commands: [
      {
        op: 'propose',
        key: 'foreign',
        subject: subject.id,
        source: {
          source: 'openlibrary',
          external_id: externalId,
          record_revision: '1',
          digest: 'a'.repeat(64),
          converter_revision: '1',
          field_group: 'facts',
        },
        statement: {
          ...statement('schema:inLanguage', 'ja'),
          references: [{ parts: [statement('schema:url', 'https://example.test/import')] }],
        },
      },
    ],
  });
  expect(batch.results[0].status).toBe(201);
  const candidate = batch.results[0].value.candidate;
  await accept(subject.id, candidate);
  await adopt(subject.id, candidate);
  expect((await entry(subject.id))?.lastModified).toBe(publishedAt);
  const runtime = await publication();
  const removedAt = at(32);
  await post('/v1/sourceFences:takedown', {
    source: 'openlibrary',
    externalId,
    fieldGroup: 'facts',
    reason: 'Foreign tuple removal',
  });
  at(33); // No relay was started. Reading now cannot substitute this time for the fence's effective time.
  const lagging = await entry(subject.id);
  if (lagging) {
    expect([publishedAt, removedAt]).toContain(lagging.lastModified!);
    await runtime.requestRebuild({ route: routeOf(subject.id)!, id: subject.id });
  } // Omission must already have durably scheduled repair.
  await converge(runtime);
  const repaired = await entry(subject.id);
  expect(repaired?.lastModified).toBe(removedAt);
  await stable(runtime, subject.id, repaired);
  await post(`/v1/subjects/${subject.id}/candidates/${subject.statements['schema:url'][0].id}:hide`, {
    reason: 'Remove final public fact',
  });
  expect(await entry(subject.id)).toBeUndefined();
  await converge(runtime);
  await stable(runtime, subject.id, undefined);
}, 120_000);

// D=8 current witness probes per candidate; ten independent homes exceed that budget.
test('more than D foreign witnesses repair finitely and never disclose title-only uncertainty', async () => {
  const t1 = at(41);
  const runtime = await publication();
  const subject = await book('Foreign witnesses');
  const sources: string[] = [];
  const selected: string[] = [];
  const homes = new Set([partitionOf(routeOf(subject.id)!)]);
  for (let index = 0; index < 10; index++) {
    let externalId: string;
    do externalId = randomUUID();
    while (homes.has(partitionOf(tupleRoute(routeKey, 'openlibrary', externalId))));
    homes.add(partitionOf(tupleRoute(routeKey, 'openlibrary', externalId)));
    sources.push(externalId);
    const batch = await post('/v1/subjects:batchWrite', {
      commands: [
        {
          op: 'propose',
          key: `witness-${index}`,
          subject: subject.id,
          source: {
            source: 'openlibrary',
            external_id: externalId,
            record_revision: '1',
            digest: 'b'.repeat(64),
            converter_revision: '1',
            field_group: 'facts',
          },
          statement: {
            ...statement('schema:inLanguage', ['ja', 'en', 'fr', 'de', 'es', 'it', 'pt', 'ko', 'zh', 'ru'][index]),
            references: [{ parts: [statement('schema:url', 'https://example.test/witness')] }],
          },
        },
      ],
    });
    expect(batch.results[0].status).toBe(201);
    const candidate = batch.results[0].value.candidate;
    selected.push(candidate);
    await accept(subject.id, candidate);
    await adopt(subject.id, candidate);
  }
  // Replace selection would leave only one witness. Select all ten in one public adoption.
  const head = await admin.query(
    `SELECT max(head)::int AS head FROM semantic.adoption WHERE route=$1 AND subject_id=$2 AND context_id=$3`,
    [routeOf(subject.id), subject.id, GLOBAL_CONTEXT],
  );
  await post(`/v1/subjects/${subject.id}:adopt`, {
    context: GLOBAL_CONTEXT,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: selected.map((candidate) => ({ candidate, rank: 'normal' })),
    expected_head: head.rows[0].head,
  });
  await runtime.requestRebuild({ route: routeOf(subject.id)!, id: subject.id });
  await converge(runtime);
  expect((await entry(subject.id))?.lastModified).toBe(t1);
  const removedAt = at(42);
  // Fence nine of ten independent homes. A bounded probe cannot establish completeness
  // from stale cached positives; only a currently verified survivor authorizes inclusion.
  for (const externalId of sources.slice(0, -1)) {
    await post('/v1/sourceFences:takedown', {
      source: 'openlibrary',
      externalId,
      fieldGroup: 'facts',
      reason: 'Remove foreign witness',
    });
  }
  at(43);
  const lagging = await entry(subject.id);
  if (lagging) {
    expect([t1, removedAt]).toContain(lagging.lastModified!);
    // An omitted entry must already have queued repair. An included survivor may need catch-up.
    await runtime.requestRebuild({ route: routeOf(subject.id)!, id: subject.id });
  }
  await converge(runtime);
  const repaired = await entry(subject.id);
  expect(repaired?.lastModified).toBe(removedAt);
  await stable(runtime, subject.id, repaired);
  at(44);
  await post('/v1/sourceFences:takedown', {
    source: 'openlibrary',
    externalId: sources.at(-1),
    fieldGroup: 'facts',
    reason: 'Remove final witness',
  });
  expect(await entry(subject.id)).toBeUndefined();
  await converge(runtime);
  await stable(runtime, subject.id, undefined);
}, 240_000);

test('preexisting public rows without retained time omit the field until a proven public change', async () => {
  at(51);
  const runtime = await publication();
  const id = newId(0);
  const tx = randomUUID();
  // Legal old rows with no command receipt or effective-time evidence. No publication truth is seeded.
  await admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_facts,current_release)
     VALUES (0,$1,'schema:Book',$2,2,$3)`,
    [id, tx, bundledDigest],
  );
  await admin.query(
    `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
     VALUES (0,$1,1,'create',$2,$3)`,
    [id, bundledDigest, tx],
  );
  for (const fact of itemFacts(
    id,
    { labels: { en: 'No retained time' }, statements: { 'schema:inLanguage': [statement('schema:inLanguage', 'ja')] } },
    'schema:Book',
    bundledRelease,
  )) {
    const row = {
      ...fact,
      route: 0,
      subject_id: id,
      recorded_transaction_id: tx,
      release: fact.kind === 'statement' ? bundledDigest : null,
    };
    const keys = Object.keys(row);
    await admin.query(
      `INSERT INTO semantic.fact (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(row),
    );
  }
  await admin.query(`INSERT INTO semantic.partition_subjects(partition_no,visible) VALUES (0,1)
    ON CONFLICT(partition_no) DO UPDATE SET visible=semantic.partition_subjects.visible+1`);
  await runtime.requestRebuild({ route: 0, id });
  await converge(runtime);
  const old = await entry(id);
  expect(old).toEqual({ id, labels: [{ language: 'en', value: 'No retained time' }] });
  expect(Object.hasOwn(old!, 'lastModified')).toBe(false);
  at(52);
  const unshown = await propose(id, 'en');
  expect(await entry(id)).toEqual(old);
  await runtime.requestRebuild({ route: 0, id });
  await converge(runtime);
  await stable(runtime, id, old);
  const changedAt = at(53);
  await accept(id, unshown);
  await adopt(id, unshown);
  expect((await entry(id))?.lastModified).toBe(changedAt);
  at(54);
  await runtime.requestRebuild({ route: 0, id });
  await converge(runtime);
  const changed = await entry(id);
  expect(changed?.lastModified).toBe(changedAt);
  await stable(runtime, id, changed);
}, 120_000);
