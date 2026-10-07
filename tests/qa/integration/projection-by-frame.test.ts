import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { isForegroundOperation } from './support/operation-cost.ts';
import { ProjectionStore, projectionFrameListSql } from '../../../services/main/src/modules/projection/store.ts';
import { PROJECTION_CREATION_QUOTA, projectionKey } from '../../../services/main/src/modules/projection/schema.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';

interface Page { items: { id: string; subject: string; frames: string[]; disclosure: string }[]; nextCursor: string | null }
type Member = Awaited<ReturnType<MediaStack['member']>>;
const id = () => `https://rezics.com/id/${randomUUID()}`;
const short = (ref: string) => ref.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`${response.status}, expected ${status}: ${body}`);
  return JSON.parse(body) as T;
}

let stack: MediaStack, owner: Member, outsider: Member;
let work: string, match: string, otherMatch: string, secret: string, hiddenSubject: string, empty: string;
let first: string, second: string, hidden: string;
const semantic = async (type: string, visible = true) => {
  const saved = await json<{ component: string }>(await owner.send('POST', '/v1/semantic/changes', {
    profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
    state: { component: 'resource', types: [type], properties: visible ? [{
      predicate: 'https://rezics.com/vocab/semanticWork', value: { kind: 'resource', ref: work },
    }] : [] },
  }), 201);
  if (!visible) await owner.grant(`semantic:read:${saved.component}`, 'semantic.read');
  return saved.component;
};
const project = async (subject: string, frames: string[]) => (await json<{ projection: { id: string } }>(
  await owner.send('POST', '/v1/projections', { subject, frames, actingSubject: owner.actor }), 201)).projection.id;
const read = (reader: Member | null, frame: string, options: { subject?: string; cursor?: string; limit?: number } = {}) => {
  const query = new URLSearchParams({ frame, limit: String(options.limit ?? 1),
    ...(options.subject ? { subject: options.subject } : {}), ...(options.cursor ? { cursor: options.cursor } : {}) });
  return reader ? reader.read(`/v1/projections?${query}`) : stack.call('GET', `/v1/projections?${query}`);
};

beforeAll(async () => {
  stack = await startMediaStack('projection-by-frame');
  owner = await stack.member('owner');
  outsider = await stack.member('outsider');
  work = (await stack.publicWork(owner.actor)).work;
  await owner.grant(`work:read:${work}`, 'work.read');
  await owner.grant('semantic:create:root', 'semantic.change');
  await owner.grant('projection:create:root', 'projection.create');
  match = await semantic('https://schema.org/Event');
  otherMatch = await semantic('https://schema.org/Event');
  empty = await semantic('https://schema.org/Event');
  secret = await semantic('https://rezics.com/vocab/NarrativeContinuity', false);
  hiddenSubject = await semantic('https://rezics.com/vocab/Character', false);
  const player = await semantic('https://rezics.com/vocab/Character');
  const otherPlayer = await semantic('https://rezics.com/vocab/Character');
  // Unreadable subjects and other coordinates before, between and after visible rows.
  await project(hiddenSubject, [match]);
  first = await project(player, [match]);
  hidden = await project(player, [match, secret]);
  second = await project(otherPlayer, [match, work]);
  await project(hiddenSubject, [match, work]);
  await project(player, [otherMatch]);
}, 240_000);
afterAll(async () => { await stack?.stop(); });

test('frame listing traverses only the match participants and hides subjects and projections from continuation', async () => {
  for (const reader of [null, outsider]) {
    const page = await json<Page>(await read(reader, match));
    expect(page).toMatchObject({ items: [{ id: first }] });
    // The continuation is opaque: it never exposes a Projection identity.
    expect(page.nextCursor).toBeString();
    expect(page.nextCursor).not.toContain(short(first));
    const rest = await json<Page>(await read(reader, match, { cursor: page.nextCursor! }));
    expect(rest).toMatchObject({ items: [{ id: second }], nextCursor: null });
    expect(page.items[0]!.frames).toEqual([match]);
    expect(rest.items[0]!.frames).toEqual([match, work].sort());
    const full = await json<Page>(await read(reader, match, { limit: 20 }));
    expect(full.items.map(item => item.id)).toEqual([first, second]);
    expect(full.nextCursor).toBeNull();
    const subset = await json<Page>(await read(reader, match, { subject: rest.items[0]!.subject }));
    expect(subset).toMatchObject({ items: [{ id: second }], nextCursor: null });
    // Work membership is literal membership of the retained coordinate set.
    expect(await json<Page>(await read(reader, work))).toMatchObject({ items: [{ id: second }], nextCursor: null });
    expect((await json<Page>(await read(reader, otherMatch))).items).toHaveLength(1);
    for (const frame of [empty, secret, id()]) {
      expect(await json<Page>(await read(reader, frame))).toMatchObject({ items: [], nextCursor: null });
    }
  }
  const own = await json<Page>(await read(owner, match, { limit: 20 }));
  expect(own.items).toHaveLength(5);
  expect(own.items.find(item => item.id === hidden)?.disclosure).toBe('restricted');
  const list = ProjectionStore.prototype.listByFrame;
  let probes = 0;
  ProjectionStore.prototype.listByFrame = function (...args) { probes++; return list.call(this, ...args); };
  try {
    for (const reader of [null, outsider]) {
      for (const cursor of [undefined, randomUUID()]) {
        expect(await json<Page>(await read(reader, match, { subject: hiddenSubject, cursor })))
          .toMatchObject({ items: [], nextCursor: null });
        expect(await json<Page>(await read(reader, secret, { cursor })))
          .toMatchObject({ items: [], nextCursor: null });
      }
    }
    expect(probes).toBe(0);
  } finally { ProjectionStore.prototype.listByFrame = list; }
  for (const query of ['', `frames=${encodeURIComponent(match)}`, `frame=${encodeURIComponent(match)}&limit=21`,
    `frame=${encodeURIComponent(match)}&frame=${encodeURIComponent(otherMatch)}`,
    `frame=${encodeURIComponent(match)}&subject=${encodeURIComponent(hiddenSubject)}&subject=${encodeURIComponent(own.items[0]!.subject)}`,
    `subject=${encodeURIComponent(own.items[0]!.subject)}&frames=${encodeURIComponent(match)}&frame=${encodeURIComponent(match)}`,
    `subject=${encodeURIComponent(own.items[0]!.subject)}&frames=${encodeURIComponent(match)}&cursor=${randomUUID()}`]) {
    expect((await stack.call('GET', `/v1/projections?${query}`)).status, query).toBe(400);
  }
}, 120_000);

interface Plan {
  'Node Type': string; 'Index Name'?: string; 'Actual Rows': number; 'Rows Removed by Filter'?: number;
  'Shared Hit Blocks': number; 'Shared Read Blocks': number; Plans?: Plan[];
}
const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

/** workRead opens and closes on this control query. Summary rows select more variables. */
function workReadPosition(sparql: string): boolean {
  const compact = sparql.replace(/\s+/g, ' ');
  const selected = compact.match(/SELECT (\?[\w]+(?: \?[\w]+)*) WHERE/u);
  if (!selected || !compact.includes('rv:routingEpoch')) return false;
  return selected[1]!.split(' ').every((name) => name === '?epoch' || name === '?sequence');
}

/** A moved graph replays the read. Cost is the attempt whose fences agree, not
 * the discarded ones or another operation sharing the client. */
function settledAttemptQueries(samples: { fence: boolean; sequence: string | null }[]): number {
  const fences = samples.flatMap((sample, index) => (sample.fence ? [index] : []));
  let chosen: { from: number; to: number } | null = null;
  for (let pair = 0; pair + 1 < fences.length; pair += 2) {
    const open = fences[pair]!;
    const close = fences[pair + 1]!;
    const sequence = samples[open]!.sequence;
    if (!sequence || sequence !== samples[close]!.sequence) continue;
    chosen = { from: open, to: fences[pair + 2] ?? samples.length };
  }
  return chosen ? chosen.to - chosen.from : samples.length;
}

const projectionRead = new AsyncLocalStorage<true>();

async function settledGraphQueries(action: () => Promise<void>): Promise<number> {
  const samples: { fence: boolean; sequence: string | null }[] = [];
  const native = stack.fuseki.query.bind(stack.fuseki);
  stack.fuseki.query = async (sparql: string, maxBytes?: number): Promise<SparqlResult> => {
    const result = await native(sparql, maxBytes);
    if (projectionRead.getStore() && isForegroundOperation()) {
      const fence = workReadPosition(sparql);
      samples.push({
        fence,
        sequence: fence ? (result.results?.bindings?.[0]?.sequence?.value ?? null) : null,
      });
    }
    return result;
  };
  try {
    await projectionRead.run(true, action);
  } finally {
    stack.fuseki.query = native;
  }
  return settledAttemptQueries(samples);
}

test('frame candidate seeks and graph cost stay bounded as unrelated and same-frame inventories grow', async () => {
  const store = new ProjectionStore(stack.accessPool);
  const subject = (await json<Page>(await read(null, match))).items[0]!.subject;
  const graphCost = async () => {
    const listed = await settledGraphQueries(async () => {
      expect(await json<Page>(await read(null, match))).toMatchObject({ items: [{ id: first }], nextCursor: expect.any(String) });
    });
    const narrowed = await settledGraphQueries(async () => {
      expect(await json<Page>(await read(null, match, { subject }))).toMatchObject({ items: [{ id: first }], nextCursor: null });
    });
    return listed + narrowed;
  };
  const before = await graphCost();
  // The inventory below is fixture SQL, but the creation quota still applies per principal: spread it over creators
  // that each reserved a Projection through the API, and keep every one below the quota.
  const perCreator = PROJECTION_CREATION_QUOTA - 10;
  const creators: string[] = [];
  const host = await semantic('https://schema.org/Event');
  for (let index = 0; index < Math.ceil((5000 + 2 * 5000) / perCreator) + 1; index++) {
    const creator = await stack.member(`creator-${index}`);
    await creator.grant('projection:create:root', 'projection.create');
    const created = await json<{ projection: { id: string } }>(await creator.send('POST', '/v1/projections',
      { subject: host, frames: [await semantic('https://schema.org/Event')], actingSubject: creator.actor }), 201);
    creators.push((await stack.accessPool.query('SELECT admission_id FROM access.projection_identity WHERE projection = $1',
      [short(created.projection.id)])).rows[0].admission_id);
  }
  let reserved = 0;
  // Ordinal `at` of the fixture belongs to the creator whose quota still has room for it.
  const creatorOf = (at: string, creatorsParam: number, reservedParam: number) =>
    `($${creatorsParam}::uuid[])[(($${reservedParam}::int + ${at} - 1) / ${perCreator})::int + 1]`;
  const client = await stack.accessPool.connect();
  try {
    await client.query('BEGIN');
    const frame = id();
    const measure = async () => {
      const plans: Plan[] = [];
      for (const filtered of [false, true]) for (const continued of [false, true]) {
        const args = [match, ...(filtered ? [subject] : []), ...(continued ? [short(first)] : []), 2];
        const result = await client.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${projectionFrameListSql(filtered, continued)}`, args);
        plans.push(result.rows[0]!['QUERY PLAN'][0]!.Plan);
      }
      return plans;
    };
    const baseline = await measure();
    // A bounded fixture bulk insert expands only owner identities, using the same trigger as reservations.
    const grow = async (count: number, inFrame: string, onSubject: string) => client.query(`
      INSERT INTO access.projection_identity (key, projection, subject, frames, admission_id)
      SELECT encode(sha256(convert_to(s || E'\n' || $2, 'UTF8')), 'hex'), gen_random_uuid(), s, ARRAY[$2], ${creatorOf('n', 4, 5)}
      FROM (SELECT n, 'https://rezics.com/id/' || gen_random_uuid() AS s FROM generate_series(1, $1::int) n) subjects
      UNION ALL SELECT encode(sha256(convert_to($3 || E'\n' || array_to_string(fs, E'\n'), 'UTF8')), 'hex'),
        gen_random_uuid(), $3, fs, ${creatorOf('(n + $1::int)', 4, 5)}
      FROM (SELECT n, ARRAY(SELECT unnest(ARRAY[$2, f]) ORDER BY 1) AS fs FROM
        (SELECT n, 'https://rezics.com/id/' || gen_random_uuid() AS f FROM generate_series(1, $1::int) n) noise) frames`,
    [count, inFrame, onSubject, creators, reserved]);
    // The hash matches the stored frame order, as the identity constraint requires.
    await client.query(`INSERT INTO access.projection_identity (key, projection, subject, frames, admission_id)
      SELECT encode(sha256(convert_to(s || E'\n' || $2, 'UTF8')), 'hex'), gen_random_uuid(), s, ARRAY[$2], ${creatorOf('n', 3, 4)}
      FROM (SELECT n, 'https://rezics.com/id/' || gen_random_uuid() AS s FROM generate_series(1, $1::int) n) subjects`,
    [5000, frame, creators, reserved]);
    reserved += 5000;
    await client.query('ANALYZE access.projection_frame_identity');
    const unrelated = await measure();
    await client.query('COMMIT');
    expect(await graphCost()).toBe(before);
    await client.query('BEGIN');
    await grow(5000, match, subject); // rolled back with its quota increments

    await client.query('ANALYZE access.projection_frame_identity');
    const grown = await measure();
    for (const [index, plan] of grown.entries()) {
      const all = nodes(plan);
      expect(all.some(node => node['Node Type'].includes('Index'))).toBe(true);
      expect(all.some(node => ['Sort', 'Seq Scan', 'Bitmap Heap Scan'].includes(node['Node Type']))).toBe(false);
      expect(all.reduce((sum, node) => sum + (node['Rows Removed by Filter'] ?? 0), 0)).toBe(0);
      expect(all.every(node => node['Actual Rows'] <= 2)).toBe(true);
      const blocks = (p: Plan) => p['Shared Hit Blocks'] + p['Shared Read Blocks'];
      expect(blocks(unrelated[index]!)).toBeLessThanOrEqual(blocks(baseline[index]!) + 12);
      expect(blocks(plan)).toBeLessThanOrEqual(blocks(baseline[index]!) + 12);
    }
  } finally { await client.query('ROLLBACK'); client.release(); }
  expect(await store.listByFrame(match, subject, null, 2)).toContain(first);
}, 120_000);

test('frame index backfills earlier reservations and atomically follows insert, adoption and rollback', async () => {
  const client = await stack.accessPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DROP TRIGGER projection_identity_frames ON access.projection_identity');
    await client.query('DROP TABLE access.projection_frame_identity');
    await client.query('DROP FUNCTION access.index_projection_frames(), access.check_projection_frame_identity()');
    const admission = (await client.query('SELECT admission_id FROM access.projection_identity WHERE projection = $1', [short(first)])).rows[0].admission_id;
    const subject = id(), frame = id(), projection = randomUUID();
    const key = projectionKey(subject, [frame, work]);
    const insert = `INSERT INTO access.projection_identity (key, projection, subject, frames, admission_id)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING`;
    await client.query(insert, [key.key, projection, subject, key.frames, admission]);
    await client.query(readFileSync(new URL('../../../services/main/migrations/access/1090_projection_frame_identity.sql', import.meta.url), 'utf8'));
    const memberships = () => client.query('SELECT frame, subject FROM access.projection_frame_identity WHERE projection = $1 ORDER BY frame', [projection]);
    expect((await memberships()).rows).toEqual(key.frames.map(frame => ({ frame, subject })));
    await client.query(insert, [key.key, randomUUID(), subject, key.frames, admission]);
    expect((await memberships()).rows).toHaveLength(2);
    await client.query('SAVEPOINT insert_probe');
    const next = projectionKey(subject, [id()]);
    const reserved = randomUUID();
    await client.query(insert, [next.key, reserved, subject, next.frames, admission]);
    expect((await client.query('SELECT frame FROM access.projection_frame_identity WHERE projection = $1', [reserved])).rows)
      .toEqual([{ frame: next.frames[0] }]);
    await client.query('ROLLBACK TO SAVEPOINT insert_probe');
    expect((await client.query('SELECT frame FROM access.projection_frame_identity WHERE projection = $1', [reserved])).rows).toEqual([]);
    await expect(client.query('UPDATE access.projection_frame_identity SET subject = $1 WHERE projection = $2', [id(), projection]))
      .rejects.toThrow('append-only');
    await client.query('ROLLBACK TO SAVEPOINT insert_probe');
    await expect(client.query('DELETE FROM access.projection_frame_identity WHERE projection = $1', [projection]))
      .rejects.toThrow('append-only');
    await client.query('ROLLBACK TO SAVEPOINT insert_probe');
    await expect(client.query('INSERT INTO access.projection_frame_identity (frame, projection, subject) VALUES ($1, $2, $3)',
      [id(), projection, subject])).rejects.toThrow('must match its identity');
  } finally { await client.query('ROLLBACK'); client.release(); }
}, 120_000);
