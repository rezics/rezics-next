import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { ZoneStarter } from '@rezics/composition';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { capture, costOf, openGrowthDatabase } from '../support/growth.ts';

type Collection = { id: string; revision: number; title: string; membershipKind?: string };
type Zone = { id: string; revision: number };
export type ZonePage = { subjects: { id: string }[]; next: string | null };
const starter = (await Bun.file(
  new URL('../../../../packages/definitions/presentation/book/zone.json', import.meta.url),
).json()) as ZoneStarter;

/** Real HTTP and production Access. Only account provisioning is privileged fixture setup. */
export async function membershipFixture() {
  const db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  const owner = newId(0x6c41);
  await db.admin.query(
    `INSERT INTO access.account
     (route,account_id,kind,state,transaction_id,authn_fenced,minimum_authn_epoch,membership_inverse_complete)
     VALUES ($1,$2,'actor','active',$2,false,1,true)`,
    [routeOf(owner), owner],
  );
  const viewer = newId(0x6c42);
  await db.admin.query(
    `INSERT INTO access.account
     (route,account_id,kind,state,transaction_id,authn_fenced,minimum_authn_epoch,membership_inverse_complete)
     VALUES ($1,$2,'actor','active',$2,false,1,true)`,
    [routeOf(viewer), viewer],
  );
  await bootstrapGovernance(db.pool, owner);
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'zone-membership', alg: 'ES256' };
  const scopes = [
    'subject:create',
    'subject:read',
    'presentation:read',
    'collection:create',
    'collection:read',
    'collection:update',
    'collection:delete',
    'zone:create',
    'zone:read',
    'zone:update',
    'zone:delete',
    'exposure:open',
    'moderation:takedown',
    'library_entry:read',
    'library_entry:update',
    'copy:create',
    'access:grant',
  ];
  const token = await new SignJWT({
    client_id: 'web',
    scope: scopes.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .setIssuer('https://auth.zones.test')
    .setAudience('https://api.rezics.test')
    .setSubject(owner)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(signing.privateKey);
  const viewerToken = await new SignJWT({
    client_id: 'web',
    scope: scopes.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .setIssuer('https://auth.zones.test')
    .setAudience('https://api.rezics.test')
    .setSubject(viewer)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(signing.privateKey);
  const app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(83),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(84)]]) },
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.zones.test',
          audience: 'https://api.rezics.test',
          jwksUrl: 'https://auth.zones.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
  });
  async function request(method: string, path: string, body?: unknown, publicRead: boolean | 'viewer' = false) {
    return app.handle(
      new Request(`https://kernel.test${path}`, {
        method,
        headers: {
          ...(publicRead === true ? {} : { authorization: `Bearer ${publicRead === 'viewer' ? viewerToken : token}` }),
          ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(randomUUID()) }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  async function json<T>(response: Response, status = 200): Promise<T> {
    // Do not turn an unavailable route or failed authorization into a cost sample.
    expect(response.status).toBe(status);
    return response.json() as Promise<T>;
  }
  await json(await request('POST', '/v1/platform/exposure/collections:open'));
  // Collection commands open another pool. Use the shared instrumented pool factory as in Collection HTTP tests.
  const NativePool = pg.Pool;
  pg.Pool = class extends NativePool {
    constructor(config?: pg.PoolConfig) {
      super(config);
      pg.Pool = NativePool;
      return db.openPool(config);
    }
  };
  try {
    await json(await request('POST', '/v1/collections', { title: 'Access control', visibility: 'public' }), 201);
  } finally {
    pg.Pool = NativePool;
  }
  async function subject(label = 'Zone book', type = 'schema:Book') {
    const result = await json<{ subject: { id: string } }>(
      await request('POST', '/v1/subjects', { type, labels: { en: label } }),
      201,
    );
    // A control read proves that the fixture creates a legal public subject.
    await json(await request('GET', `/v1/subjects/${result.subject.id}`, undefined, true));
    return result.subject.id;
  }
  async function collection(title = 'Mounted books', visibility = 'public') {
    return (
      await json<{ collection: Collection }>(await request('POST', '/v1/collections', { title, visibility }), 201)
    ).collection;
  }
  async function add(id: string, subjectId: string, note = 'PRIVATE-OCCURRENCE-NOTE') {
    return json(await request('POST', `/v1/collections/${id}/members`, { subjectId, note }), 201);
  }
  async function zone(mounts: string[], scope: string[] = [], visibility = 'public') {
    return (
      await json<{ zone: Zone }>(
        await request('POST', '/v1/zones', {
          configuration: { ...starter, scope },
          mounts,
          visibility,
        }),
        201,
      )
    ).zone;
  }
  async function page(id: string, cursor: string | null = null, limit = 2, publicRead = true) {
    const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    const result = await json<ZonePage>(
      await request('GET', `/v1/zones/${id}/subjects?${query}`, undefined, publicRead),
    );
    expect(Array.isArray(result.subjects)).toBe(true);
    expect(result.subjects.length).toBeLessThanOrEqual(limit);
    expect(result.next === null || typeof result.next === 'string').toBe(true);
    if (result.next) expect(result.next.length).toBeLessThanOrEqual(4096);
    expect(result).not.toHaveProperty('total');
    expect(result).not.toHaveProperty('count');
    expect(JSON.stringify(result)).not.toContain('PRIVATE-OCCURRENCE-NOTE');
    return result;
  }
  async function all(id: string, initial: string | null = null, limit = 2) {
    const ids: string[] = [];
    const cursors = new Set<string>();
    let cursor = initial;
    for (let steps = 0; steps < 1024; steps++) {
      const result = await page(id, cursor, limit);
      for (const row of result.subjects) {
        expect(ids).not.toContain(row.id);
        ids.push(row.id);
      }
      if (result.next === null) return ids.sort();
      expect(cursors.has(result.next)).toBe(false);
      cursors.add(result.next);
      cursor = result.next;
    }
    throw new Error('Finite quiescent Zone traversal did not exhaust');
  }
  async function visibility(value: Collection, next: 'private' | 'public') {
    return (
      await json<{ collection: Collection }>(
        await request('PATCH', `/v1/collections/${value.id}`, { revision: value.revision, visibility: next }),
      )
    ).collection;
  }
  async function suppress(id: string) {
    await json(
      await request('POST', `/v1/subjects/${id}:takedown`, {
        notice: { complaint: 'Membership disclosure fixture', received_at: '2026-01-01T00:00:00Z' },
      }),
    );
  }
  return {
    db,
    owner,
    viewer,
    request,
    json,
    subject,
    collection,
    add,
    zone,
    page,
    all,
    visibility,
    suppress,
    async close() {
      await db.close();
    },
  };
}

let f: Awaited<ReturnType<typeof membershipFixture>>;
beforeAll(async () => {
  f = await membershipFixture();
});
afterAll(async () => {
  await f?.close();
});

test('Zone membership is the deduplicated saved-scope and mounted-Collection union intersected with current access', async () => {
  const a = await f.subject('Overlap');
  const b = await f.subject('Second book');
  const c = await f.subject('Collection-only game', 'schema:VideoGame');
  const scopeOnly = await f.subject('Saved-scope-only book');
  const outside = await f.subject('Outside every source', 'schema:VideoGame');
  const withheld = await f.subject('Withheld');
  const first = await f.collection();
  const second = await f.collection();
  for (const id of [a, a, c, withheld]) await f.add(first.id, id);
  for (const id of [a, b, c]) await f.add(second.id, id);
  await f.suppress(withheld);
  const z = await f.zone([first.id, second.id], ['book/all', 'book/before-2000']);
  const ids = await f.all(z.id);
  expect(ids).toContain(a);
  expect(ids).toContain(b);
  expect(ids).toContain(c);
  expect(ids).toContain(scopeOnly);
  expect(ids).not.toContain(outside);
  expect(ids).not.toContain(withheld);
  expect(ids.length).toBe(new Set(ids).size);
  // A fresh public read must not broaden subject rights through Zone ownership.
  expect((await f.request('POST', `/v1/zones/${z.id}:readPage`, { target: { subject: withheld } }, true)).status).toBe(
    404,
  );
});

test('private revoked deleted and withheld sources reveal no Zone data or counts', async () => {
  for (const mutation of ['private', 'revoked', 'deleted', 'withheld'] as const) {
    const source = await f.collection(`SECRET-MOUNT-${mutation}`);
    const ids = await Promise.all(Array.from({ length: 5 }, (_, i) => f.subject(`SECRET-SUBJECT-${mutation}-${i}`)));
    for (const id of ids) await f.add(source.id, id);
    const z = await f.zone([source.id]);
    const issued = await f.page(z.id, null, 1);
    expect(issued.next).not.toBeNull();
    let current = source;
    if (mutation === 'private' || mutation === 'revoked') current = await f.visibility(source, 'private');
    if (mutation === 'deleted') {
      expect((await f.request('DELETE', `/v1/collections/${source.id}?revision=${source.revision}`)).status).toBe(204);
    }
    if (mutation === 'withheld') for (const id of ids) await f.suppress(id);
    expect(await f.all(z.id, issued.next)).toEqual([]);
    const mounts = await f.json<{ collections: Collection[] }>(
      await f.request('GET', `/v1/zones/${z.id}/collections`, undefined, true),
    );
    if (mutation !== 'withheld') {
      expect(mounts.collections).toEqual([]);
      expect(JSON.stringify(mounts)).not.toContain(source.id);
      expect(JSON.stringify(mounts)).not.toContain(source.title);
      const metadata = await f.json(await f.request('GET', `/v1/zones/${z.id}`, undefined, true));
      expect(JSON.stringify(metadata)).not.toContain(source.id);
      expect(JSON.stringify(metadata)).not.toContain(source.title);
    }
    const shell = await f.json<Record<string, unknown>>(
      await f.request('POST', `/v1/zones/${z.id}:readPage`, { target: { route: '' } }, true),
    );
    expect(JSON.stringify(shell)).not.toContain('SECRET-SUBJECT');
    if (mutation !== 'withheld') expect(JSON.stringify(shell)).not.toContain(source.title);
    const absent = await f.request('POST', `/v1/zones/${z.id}:readPage`, { target: { subject: newId(0x6c41) } }, true);
    const hidden = await f.request('POST', `/v1/zones/${z.id}:readPage`, { target: { subject: ids[0]! } }, true);
    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    const stable = async (response: Response) => {
      const { request_id: _request, ...problem } = (await response.json()) as Record<string, unknown>;
      return problem;
    };
    expect(await stable(hidden)).toEqual(await stable(absent));
    if (mutation === 'private' || mutation === 'revoked') {
      await f.visibility(current, 'public');
      expect(await f.all(z.id)).toEqual([...ids].sort());
    }
    if (mutation === 'withheld') {
      for (const id of ids)
        await f.json(await f.request('POST', `/v1/subjects/${id}:restore`, { reason: 'Reversed notice' }));
      expect(await f.all(z.id)).toEqual([...ids].sort());
    }
  }
});

test('Zone union traversal has bounded examined candidates and makes progress across empty filtered windows', async () => {
  const source = await f.collection();
  const z = await f.zone([source.id]);
  const hidden: string[] = [];
  for (let i = 0; i < 600; i++) {
    const id = await f.subject(`Filtered ${i}`);
    hidden.push(id);
    await f.add(source.id, id);
  }
  const tail = await f.subject('Visible tail');
  await f.add(source.id, tail);
  // Issue before revocation, then remove current subject eligibility for an entire candidate window.
  const issued = await f.page(z.id, null, 1);
  expect(issued.next).not.toBeNull();
  for (const id of [...hidden, tail]) await f.suppress(id);
  const measured = await capture(f.db, () => f.page(z.id, issued.next, 1));
  expect(measured.value.subjects).toEqual([]);
  expect(measured.value.next).not.toBeNull();
  // Shared rows includes rows removed by filters. Provider examined-key counters remain an adapter dependency.
  expect(costOf(measured.capture).rows).toBeLessThanOrEqual(32 * 256 * 32);
  expect(await f.all(z.id, measured.value.next, 1)).toEqual([]);
  await f.json(await f.request('POST', `/v1/subjects/${tail}:restore`, { reason: 'Restored within policy' }));
  expect(await f.all(z.id, null, 1)).toEqual([tail]);
}, 180_000);

test('Zone cursors bind viewer Zone and query and direct targets require membership', async () => {
  const source = await f.collection();
  for (let i = 0; i < 3; i++) await f.add(source.id, await f.subject());
  const a = await f.zone([source.id]);
  const b = await f.zone([]);
  const first = await f.page(a.id, null, 1);
  expect(first.next).not.toBeNull();
  const query = `limit=1&cursor=${encodeURIComponent(first.next!)}`;
  for (const [id, publicRead] of [
    [b.id, true],
    [a.id, false],
  ] as const) {
    const response = await f.request('GET', `/v1/zones/${id}/subjects?${query}`, undefined, publicRead);
    expect([400, 409]).toContain(response.status);
  }
  const outside = await f.subject('Outside scope');
  expect((await f.request('POST', `/v1/zones/${a.id}:readPage`, { target: { subject: outside } }, true)).status).toBe(
    404,
  );
});

test('unsupported saved scope is rejected at admission before enumeration', async () => {
  const result = await f.request('POST', '/v1/zones', {
    configuration: { ...starter, scope: ['unknown/unindexed'] },
    mounts: [],
    visibility: 'public',
  });
  expect(result.status).toBe(400);
  const problem = (await result.json()) as { code: string };
  expect(problem.code).toBe('invalid_request');
});

test('native built-in Collection membership uses Commerce common reader and hides private fact values', async () => {
  // First require the real Zone API: absent dynamic code must never mask its HTTP red.
  await f.zone([]);
  const id = await f.subject('Built-in member');
  await f.json(await f.request('POST', '/v1/platform/exposure/personal_library:open'));
  await f.json(await f.request('PUT', `/v1/libraryEntries/${id}`, { state: 'in_progress' }), 201);
  const list = await f.json<{ collections: Collection[] }>(
    await f.request('GET', `/v1/collections?curatorAccountId=${f.owner}`),
  );
  const dynamic = list.collections.filter((row) => row.membershipKind === 'dynamic');
  expect(
    dynamic.length,
    'Commerce dependency: createCollectionReads common built-in identity/members adapter',
  ).toBeGreaterThan(0);
  // A built-in is selected by actual owner membership, never by a curated stand-in or fabricated resource ID.
  let mounted = false;
  for (const candidate of dynamic) {
    const members = await f.json<{ members: { subjectId: string }[] }>(
      await f.request('GET', `/v1/collections/${candidate.id}/members`),
    );
    if (!members.members.some((row) => row.subjectId === id)) continue;
    const published = await f.visibility(candidate, 'public');
    const z = await f.zone([published.id]);
    expect(await f.all(z.id)).toContain(id);
    const before = await f.page(z.id);
    await f.json(
      await f.request('POST', '/v1/copies', { subjectId: id, status: 'owned', note: 'SECRET-PRIVATE-COPY-VALUE' }),
      201,
    );
    const after = await f.page(z.id);
    expect(after.subjects).toEqual(before.subjects);
    expect(JSON.stringify(after)).not.toContain('SECRET-PRIVATE-COPY-VALUE');
    expect(JSON.stringify(after)).not.toContain('in_progress');
    const publicSource = await f.json<{ collection: Collection }>(
      await f.request('GET', `/v1/collections/${candidate.id}`, undefined, true),
    );
    expect(publicSource.collection).not.toHaveProperty('memberCount');
    expect(JSON.stringify(publicSource)).not.toContain('SECRET-PRIVATE-COPY-VALUE');
    expect(JSON.stringify(publicSource)).not.toContain('in_progress');
    const mounts = await f.json(await f.request('GET', `/v1/zones/${z.id}/collections`, undefined, true));
    expect(JSON.stringify(mounts)).not.toContain('SECRET-PRIVATE-COPY-VALUE');
    expect(JSON.stringify(mounts)).not.toContain('in_progress');
    mounted = true;
    break;
  }
  expect(mounted, 'Commerce dependency: built-in unique subject membership').toBe(true);
});

/** Growth shares this file's native setup and closes it with the existing afterAll hook. */
export function currentMembershipFixture() {
  return f;
}

test('private Zone metadata navigation and target reads are indistinguishable from unknown', async () => {
  const source = await f.collection('SECRET-ZONE-SOURCE');
  const z = await f.zone([source.id], [], 'private');
  const unknown = newId(0x6c41);
  for (const suffix of ['', '/subjects', '/collections', ':readPage']) {
    const method = suffix === ':readPage' ? 'POST' : 'GET';
    const body = method === 'POST' ? { target: { route: '' } } : undefined;
    const hidden = await f.request(method, `/v1/zones/${z.id}${suffix}`, body, true);
    const missing = await f.request(method, `/v1/zones/${unknown}${suffix}`, body, true);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const stable = async (response: Response) => {
      const { request_id: _request, ...problem } = (await response.json()) as Record<string, unknown>;
      return problem;
    };
    expect(await stable(hidden)).toEqual(await stable(missing));
  }
});

test('revoking a real private Collection read grant invalidates already issued Zone access', async () => {
  const source = await f.collection('PRIVATE-GRANTED-MOUNT', 'private');
  const z = await f.zone([source.id]);
  for (let n = 0; n < 4; n++) await f.add(source.id, await f.subject(`Granted ${n}`));
  const input = {
    resource: { route: routeOf(source.id)!, id: source.id },
    subject: { kind: 'account', id: f.viewer },
    actions: ['collection:read'],
    valid: '(,)',
  };
  await f.json(await f.request('POST', '/v1/grants', input), 201);
  await f.json(await f.request('GET', `/v1/collections/${source.id}`, undefined, 'viewer'));
  const first = await f.json<ZonePage>(
    await f.request('GET', `/v1/zones/${z.id}/subjects?limit=1`, undefined, 'viewer'),
  );
  expect(first.subjects).toHaveLength(1);
  expect(first.next).not.toBeNull();
  await f.json(await f.request('POST', '/v1/grants:revoke', input));
  expect((await f.request('GET', `/v1/collections/${source.id}`, undefined, 'viewer')).status).toBe(404);
  const continued = await f.json<ZonePage>(
    await f.request(
      'GET',
      `/v1/zones/${z.id}/subjects?limit=1&cursor=${encodeURIComponent(first.next!)}`,
      undefined,
      'viewer',
    ),
  );
  expect(continued.subjects).toEqual([]);
  const metadata = await f.json<{ collections: Collection[] }>(
    await f.request('GET', `/v1/zones/${z.id}/collections`, undefined, 'viewer'),
  );
  expect(metadata.collections).toEqual([]);
  expect(JSON.stringify(metadata)).not.toContain(source.title);
});

test('a deleted mounted Collection can be restored within policy without retaining stale access', async () => {
  const source = await f.collection();
  const z = await f.zone([source.id]);
  const id = await f.subject('Restorable source subject');
  await f.add(source.id, id);
  const current = (await f.json<{ collection: Collection }>(await f.request('GET', `/v1/collections/${source.id}`)))
    .collection;
  expect((await f.request('DELETE', `/v1/collections/${source.id}?revision=${current.revision}`)).status).toBe(204);
  expect(await f.all(z.id)).toEqual([]);
  // Honest Commerce owner dependency: no raw state update stands in for its restoration command.
  await f.json(await f.request('POST', `/v1/collections/${source.id}:restore`, {}));
  expect(await f.all(z.id)).toEqual([id]);
});

test('Zone pages use canonical subject-ID order across source and occurrence orders', async () => {
  // Require the native route before expensive setup or any missing owner-adapter assertion.
  const left = await f.collection();
  const right = await f.collection();
  const z = await f.zone([right.id, left.id]);
  const ids: string[] = [];
  for (let n = 0; n < 25; n++) ids.push(await f.subject(`Canonical order ${n}`));
  ids.sort();
  // Both source order and ordinary curated occurrence order disagree with the common order.
  for (const id of [...ids].reverse()) await f.add(left.id, id);
  for (const id of [...ids.slice(12), ...ids.slice(0, 12)]) {
    await f.add(right.id, id);
    await f.add(right.id, id);
  }
  const emitted: string[] = [];
  const tokens = new Set<string>();
  let cursor: string | null = null;
  let exhausted = false;
  for (let step = 0; step < 1024; step++) {
    const page = await f.page(z.id, cursor, 3);
    for (const { id } of page.subjects) {
      const previous = emitted.at(-1);
      if (previous !== undefined) expect(id > previous).toBe(true);
      emitted.push(id);
    }
    if (page.next === null) {
      exhausted = true;
      break;
    }
    expect(page.next).not.toBe(cursor);
    expect(tokens.has(page.next)).toBe(false);
    tokens.add(page.next);
    cursor = page.next;
  }
  expect(exhausted).toBe(true);
  expect(emitted).toEqual(ids);
  // The Zone must not normalize stored occurrences, notes or order as a deduplication shortcut.
  const stored = await f.json<{ members: { subjectId: string; note: string }[] }>(
    await f.request('GET', `/v1/collections/${left.id}/members?limit=100`),
  );
  expect(stored.members.map((row) => row.subjectId)).toEqual([...ids].reverse());
  expect(stored.members.every((row) => row.note === 'PRIVATE-OCCURRENCE-NOTE')).toBe(true);
});

test('definitively filtered Zone prefixes advance without skipping a later eligible canonical group', async () => {
  const source = await f.collection();
  const z = await f.zone([source.id]);
  const ids: string[] = [];
  for (let n = 0; n < 300; n++) ids.push(await f.subject(`Settled denied prefix ${n}`));
  ids.sort();
  // Append the greatest canonical ID first: occurrence order cannot drive the union watermark.
  for (const id of [...ids].reverse()) await f.add(source.id, id);
  const tail = ids.at(-1)!;
  for (const id of ids.slice(0, -1)) await f.suppress(id);
  const emitted: string[] = [];
  let cursor: string | null = null;
  const tokens = new Set<string>();
  let exhausted = false;
  for (let step = 0; step < 1024; step++) {
    const page = await f.page(z.id, cursor, 1);
    emitted.push(...page.subjects.map((row) => row.id));
    if (page.next === null) {
      exhausted = true;
      break;
    }
    // Even an empty successful response must represent actual prefix/phase progress.
    expect(page.next).not.toBe(cursor);
    expect(tokens.has(page.next)).toBe(false);
    tokens.add(page.next);
    cursor = page.next;
  }
  expect(exhausted).toBe(true);
  expect(emitted).toEqual([tail]);
  await f.json(await f.request('POST', `/v1/zones/${z.id}:readPage`, { target: { subject: tail } }, true));
}, 180_000);
