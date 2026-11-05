import { expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type DiscoveryPersona,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

type World = ReleasedDiscoveryFixture;
type Header = { id: string; title: string; revision: number; visibility: string } & Record<string, unknown>;
type Page = { pins: { collectionId: string; target: Header | null }[]; revision: number; next: string | null };
type Statement = { text: string; values: unknown };

function status(r: HttpResponse, expected: number) {
  expect(r.status, `Native HTTP ${r.status}: ${JSON.stringify(r.body)}`).toBe(expected);
  return r;
}
function problem(r: HttpResponse, expected: number, code?: string) {
  status(r, expected);
  expect(r.headers.get('content-type')).toContain('application/problem+json');
  expect(r.body.status).toBe(expected);
  if (code) expect(r.body.code).toBe(code);
  expect(r.body.pins).toBeUndefined();
  return r;
}
function page(r: HttpResponse): Page {
  status(r, 200);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(Object.keys(r.body).sort()).toEqual(['next', 'pins', 'revision']);
  expect(Array.isArray(r.body.pins)).toBe(true);
  const p = r.body as Page;
  expect(Number.isSafeInteger(p.revision) && p.revision >= 0).toBe(true);
  expect(p.next === null || (typeof p.next === 'string' && p.next.length > 0)).toBe(true);
  for (const pin of p.pins) {
    expect(Object.keys(pin).sort()).toEqual(['collectionId', 'target']);
    expect(typeof pin.collectionId).toBe('string');
    if (pin.target !== null) expect(pin.target.id).toBe(pin.collectionId);
  }
  expect(new Set(p.pins.map((p) => p.collectionId)).size).toBe(p.pins.length);
  return p;
}
function revision(r: HttpResponse, value: number) {
  status(r, 200);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(r.body).toEqual({ revision: value });
}
async function world(run: (f: World) => Promise<void>) {
  const f = await createReleasedDiscoveryFixture({ version: 1 });
  try {
    await f.setup.openFeatures(['personal_library']);
    await run(f);
  } finally {
    await f.close();
  }
}
async function collection(f: World, visibility = 'private', owner: 'alice' | 'bob' = 'alice') {
  const r = status(
    await f.request(
      owner,
      'POST',
      '/v1/collections',
      { title: `${owner} ${visibility} pin target`, visibility },
      discoveryKey(),
    ),
    201,
  );
  const c = r.body.collection as Header;
  expect(typeof c.id).toBe('string');
  expect(c.visibility).toBe(visibility);
  expect(c.revision).toBe(1);
  return c;
}
const list = async (f: World, query = '', owner: DiscoveryPersona = 'alice') =>
  page(await f.request(owner, 'GET', `/v1/libraryPins${query}`));
const put = (f: World, id: string, rev: number, after?: string | null, key = discoveryKey()) =>
  f.request('alice', 'PUT', `/v1/libraryPins/${id}`, { revision: rev, ...(after === undefined ? {} : { after }) }, key);
const remove = (f: World, id: string, rev: number, key = discoveryKey()) =>
  f.request('alice', 'DELETE', `/v1/libraryPins/${id}?revision=${rev}`, undefined, key);
const ids = (p: Page) => p.pins.map((p) => p.collectionId);

// Observes the actual pg transport, preserving every argument, callback, result and error unchanged.
async function observe<T>(run: () => Promise<T>) {
  const statements: Statement[] = [];
  const active = new AsyncLocalStorage<boolean>();
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const q = args[0];
    if (active.getStore()) {
      statements.push({
        text: typeof q === 'string' ? q : typeof q === 'object' && q !== null && 'text' in q ? String(q.text) : '',
        values: typeof q === 'object' && q !== null && 'values' in q ? q.values : args[1],
      });
    }
    return Reflect.apply(original, this, args);
  } as typeof original;
  try {
    return { value: await active.run(true, run), statements };
  } finally {
    pg.Client.prototype.query = original;
  }
}
function noWrites(statements: Statement[]) {
  expect(statements.length).toBeGreaterThan(0);
  expect(
    statements.filter((s) => /\b(?:INSERT\s+INTO|UPDATE\s+(?!OF\b)|DELETE\s+FROM|MERGE\s+INTO)\b/i.test(s.text)),
  ).toEqual([]);
}
async function position(f: World) {
  const partition = partitionOf(routeOf(f.personas.alice.accountId)!);
  return (await f.inspect('SELECT epoch, position::text FROM core.partition WHERE partition_no = $1', [partition]))
    .rows;
}
async function receipt(f: World, key: ReturnType<typeof discoveryKey>) {
  return (
    await f.inspect(
      `SELECT command_kind, transaction_id, position::text, response FROM core.receipt
     WHERE partition_no = $1 AND principal_kind = 'account' AND principal_id = $2 AND idempotency_key = $3`,
      [
        partitionOf(routeOf(f.personas.alice.accountId)!),
        f.personas.alice.accountId,
        key['Idempotency-Key'].slice(1, -1),
      ],
    )
  ).rows;
}
async function storedTarget(f: World, c: Header) {
  const key = [routeOf(c.id), c.id];
  return {
    header: (await f.inspect('SELECT * FROM library.collection WHERE route = $1 AND collection_id = $2', key)).rows,
    grants: (
      await f.inspect(
        'SELECT * FROM access.resource_grant WHERE route = $1 AND resource_id = $2 ORDER BY action, subject_id',
        key,
      )
    ).rows,
    roles: (
      await f.inspect(
        'SELECT * FROM access.resource_role_grant WHERE route = $1 AND resource_id = $2 ORDER BY grant_role, subject_id',
        key,
      )
    ).rows,
    initialization: (
      await f.inspect('SELECT * FROM access.resource_initialization WHERE route = $1 AND resource_id = $2', key)
    ).rows,
  };
}

test(
  'Pins empty and same-owner readonly reads are closed private revision-zero no-write preferences',
  () =>
    world(async (f) => {
      const empty = await observe(() => f.request('alice', 'GET', '/v1/libraryPins'));
      expect(page(empty.value)).toEqual({ pins: [], revision: 0, next: null });
      noWrites(empty.statements);
      const read = await f.scoped('alice', ['library_pin:list', 'collection:read']);
      expect(read.accountId).toBe(f.personas.alice.accountId);
      const before = await position(f);
      const captured = await observe(() => read.request('GET', '/v1/libraryPins'));
      expect(page(captured.value)).toEqual({ pins: [], revision: 0, next: null });
      noWrites(captured.statements);
      expect(await list(f)).toEqual({ pins: [], revision: 0, next: null });
      expect(await position(f)).toEqual(before);
      const c = await collection(f);
      for (const method of ['PUT', 'DELETE'] as const) {
        const r = await read.request(
          method,
          `/v1/libraryPins/${c.id}${method === 'DELETE' ? '?revision=0' : ''}`,
          method === 'PUT' ? { revision: 0 } : undefined,
          discoveryKey(),
        );
        problem(r, 403);
        expect(r.headers.get('www-authenticate')).toContain('insufficient_scope');
      }
      expect(await list(f)).toEqual({ pins: [], revision: 0, next: null });
    }),
  180_000,
);

test(
  'Pins append public private-own and unlisted Collections then reorder and unpin without deleting targets',
  () =>
    world(async (f) => {
      const a = await collection(f, 'public');
      const b = await collection(f);
      const c = await collection(f, 'unlisted', 'bob');
      revision(await put(f, a.id, 0), 1);
      revision(await put(f, b.id, 1), 2);
      revision(await put(f, c.id, 2), 3);
      expect(ids(await list(f))).toEqual([a.id, b.id, c.id]);
      revision(await put(f, c.id, 3, null), 4);
      revision(await put(f, a.id, 4, b.id), 5);
      expect(ids(await list(f))).toEqual([c.id, b.id, a.id]);
      revision(await remove(f, b.id, 5), 6);
      expect(ids(await list(f))).toEqual([c.id, a.id]);
      for (const target of [a, b, c]) {
        expect(status(await f.request('alice', 'GET', `/v1/collections/${target.id}`), 200).body.collection).toEqual(
          target,
        );
      }
    }),
  180_000,
);

test(
  'Pins duplicate placement and absent removal use native noEffect while retained empty revision prevents ABA',
  () =>
    world(async (f) => {
      const a = await collection(f);
      const b = await collection(f);
      const emptyPosition = await position(f);
      revision(await remove(f, b.id, 0), 0);
      expect(await list(f)).toEqual({ pins: [], revision: 0, next: null });
      expect(await position(f)).toEqual(emptyPosition);
      revision(await put(f, a.id, 0), 1);
      revision(await put(f, b.id, 1), 2);
      const before = await position(f);
      for (const after of [undefined, null]) revision(await put(f, a.id, 2, after), 2);
      revision(await put(f, b.id, 2, a.id), 2);
      expect(await position(f)).toEqual(before);
      const absent = await collection(f);
      const afterSetup = await position(f);
      const key = discoveryKey();
      revision(await remove(f, absent.id, 2, key), 2);
      expect(await position(f)).toEqual(afterSetup);
      expect(await receipt(f, key)).toHaveLength(1);
      expect(before).not.toEqual(afterSetup);
      revision(await remove(f, a.id, 2), 3);
      revision(await remove(f, b.id, 3), 4);
      expect(await list(f)).toEqual({ pins: [], revision: 4, next: null });
      problem(await put(f, a.id, 0), 409, 'conflict');
      revision(await put(f, a.id, 4), 5);
    }),
  180_000,
);

test(
  'Pins exact receipts replay original effects after later edits and reject conflicting intent without target metadata',
  () =>
    world(async (f) => {
      const a = await collection(f);
      const b = await collection(f);
      const key = discoveryKey();
      revision(await put(f, a.id, 0, undefined, key), 1);
      const original = await receipt(f, key);
      expect(original).toHaveLength(1);
      revision(await put(f, b.id, 1), 2);
      revision(await remove(f, a.id, 2), 3);
      status(
        await f.request('alice', 'DELETE', `/v1/collections/${a.id}?revision=${a.revision}`, undefined, discoveryKey()),
        204,
      );
      revision(await put(f, a.id, 0, undefined, key), 1);
      expect(await receipt(f, key)).toEqual(original);
      problem(await put(f, a.id, 0, null, key), 422, 'idempotency_conflict');
      expect(ids(await list(f))).toEqual([b.id]);
      const deletion = discoveryKey();
      revision(await remove(f, b.id, 3, deletion), 4);
      revision(await put(f, b.id, 4), 5);
      revision(await remove(f, b.id, 3, deletion), 4);
      expect(ids(await list(f))).toEqual([b.id]);
    }),
  180_000,
);

test(
  'Pins one global CAS admits one concurrent winner and rejects stale PUT and DELETE without receipts',
  () =>
    world(async (f) => {
      const a = await collection(f);
      const b = await collection(f);
      const keys = [discoveryKey(), discoveryKey()] as const;
      const results = await Promise.all([put(f, a.id, 0, undefined, keys[0]), put(f, b.id, 0, undefined, keys[1])]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = results[0]!.status === 200 ? a : b;
      const loser = winner === a ? b : a;
      const losingKey = winner === a ? keys[1] : keys[0];
      problem(
        results.find((r) => r.status === 409)!,
        409,
        'conflict',
      );
      expect(await receipt(f, losingKey)).toEqual([]);
      const p = await list(f);
      expect(ids(p)).toEqual([winner.id]);
      expect(p.revision).toBe(1);
      problem(await remove(f, winner.id, 0), 409, 'conflict');
      revision(await put(f, loser.id, 1, undefined, losingKey), 2);
    }),
  180_000,
);

test(
  'Pins signed keyset pages bind owner limit and list revision and reject tamper and raw offsets',
  () =>
    world(async (f) => {
      const targets = [await collection(f), await collection(f), await collection(f)];
      for (const [i, c] of targets.entries()) revision(await put(f, c.id, i), i + 1);
      const first = await list(f, '?limit=1');
      expect(ids(first)).toEqual([targets[0]!.id]);
      expect(typeof first.next).toBe('string');
      const suffix = `&cursor=${encodeURIComponent(first.next!)}`;
      const second = await list(f, `?limit=1${suffix}`);
      expect(ids(second)).toEqual([targets[1]!.id]);
      const third = await list(f, `?limit=1&cursor=${encodeURIComponent(second.next!)}`);
      expect(ids(third)).toEqual([targets[2]!.id]);
      expect(third.next).toBeNull();
      expect([first.revision, second.revision, third.revision]).toEqual([3, 3, 3]);
      problem(await f.request('bob', 'GET', `/v1/libraryPins?limit=1${suffix}`), 400, 'invalid_cursor');
      problem(await f.request('alice', 'GET', `/v1/libraryPins?limit=2${suffix}`), 400, 'invalid_cursor');
      const token = first.next!;
      const middle = Math.floor(token.length / 2);
      const tampered = token.slice(0, middle) + (token[middle] === 'A' ? 'B' : 'A') + token.slice(middle + 1);
      for (const cursor of [tampered, '1', btoa(JSON.stringify({ offset: 1 }))]) {
        problem(
          await f.request('alice', 'GET', `/v1/libraryPins?limit=1&cursor=${encodeURIComponent(cursor)}`),
          400,
          'invalid_cursor',
        );
      }
      revision(await put(f, targets[2]!.id, 3, null), 4);
      problem(await f.request('alice', 'GET', `/v1/libraryPins?limit=1${suffix}`), 409, 'stale_cursor');
    }),
  180_000,
);

test(
  'Pins validate closed inputs self and missing anchors revision limits selectors and required idempotency',
  () =>
    world(async (f) => {
      const a = await collection(f);
      const missingAnchor = await collection(f);
      revision(await put(f, a.id, 0), 1);
      for (const body of [
        { revision: 1, after: a.id },
        { revision: 1, after: missingAnchor.id },
        { revision: 1, accountId: f.personas.bob.accountId },
        { revision: -1 },
        { revision: 1.5 },
        { revision: '1' },
        { revision: Number.MAX_SAFE_INTEGER + 1 },
        { revision: 1, after: 42 },
        {},
      ]) {
        problem(
          await f.request('alice', 'PUT', `/v1/libraryPins/${a.id}`, body, discoveryKey()),
          400,
          'invalid_request',
        );
      }
      problem(await f.request('alice', 'PUT', `/v1/libraryPins/${a.id}`, { revision: 1 }), 400, 'invalid_request');
      for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=no', `accountId=${f.personas.bob.accountId}`]) {
        problem(await f.request('alice', 'GET', `/v1/libraryPins?${query}`), 400, 'invalid_request');
      }
      for (const query of ['', 'revision=-1', 'revision=1.5', `revision=1&accountId=${f.personas.bob.accountId}`]) {
        problem(
          await f.request('alice', 'DELETE', `/v1/libraryPins/${a.id}?${query}`, undefined, discoveryKey()),
          400,
          'invalid_request',
        );
      }
      expect((await list(f)).revision).toBe(1);
    }),
  180_000,
);

test(
  'Pins isolate Bob anonymous unscoped invalid and native pre-suspension bearers before private disclosure',
  () =>
    world(async (f) => {
      const a = await collection(f);
      revision(await put(f, a.id, 0), 1);
      expect(await list(f, '', 'bob')).toEqual({ pins: [], revision: 0, next: null });
      problem(
        await f.request('bob', 'PUT', `/v1/libraryPins/${a.id}`, { revision: 0 }, discoveryKey()),
        404,
        'not_found',
      );
      revision(await f.request('bob', 'DELETE', `/v1/libraryPins/${a.id}?revision=0`, undefined, discoveryKey()), 0);
      for (const [who, expected] of [
        ['anonymous', 401],
        ['unscoped', 403],
        ['suspended', 401],
      ] as const) {
        // The shared semantic-persona transport exposes GET/PUT; named account transports also expose DELETE.
        const methods = who === 'unscoped' ? (['GET', 'PUT', 'DELETE'] as const) : (['GET', 'PUT'] as const);
        for (const method of methods) {
          const path =
            method === 'GET' ? '/v1/libraryPins' : `/v1/libraryPins/${a.id}${method === 'DELETE' ? '?revision=1' : ''}`;
          const r = problem(
            await f.request(who, method, path, method === 'PUT' ? { revision: 1 } : undefined, discoveryKey()),
            expected,
          );
          if (who === 'suspended') {
            expect(r.body.code).toBe('invalid_credentials');
            expect(r.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
          }
          if (who === 'unscoped') expect(r.headers.get('www-authenticate')).toContain('insufficient_scope');
        }
      }
      const invalid = problem(
        await f.request('anonymous', 'GET', '/v1/libraryPins', undefined, { authorization: 'Bearer invalid' }),
        401,
        'invalid_credentials',
      );
      expect(invalid.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
      expect(ids(await list(f))).toEqual([a.id]);
    }),
  180_000,
);

test(
  'Pins current own scope and account revocation deny exact receipt replay before receipt lookup',
  () =>
    world(async (f) => {
      const a = await collection(f);
      const key = discoveryKey();
      revision(await put(f, a.id, 0, undefined, key), 1);
      const saved = await receipt(f, key);
      const readonly = await f.scoped('alice', ['library_pin:list', 'collection:read']);
      const denied = await observe(() => readonly.request('PUT', `/v1/libraryPins/${a.id}`, { revision: 0 }, key));
      problem(denied.value, 403);
      expect(denied.value.headers.get('www-authenticate')).toContain('insufficient_scope');
      expect(denied.statements.filter((s) => /\bFROM\s+core\.receipt\b/i.test(s.text))).toEqual([]);
      // Existing native grant administration gives the real steward the native suspension operation.
      await f.grant('steward', ['account:suspend'], GLOBAL_CONTEXT);
      status(
        await f.request(
          'steward',
          'POST',
          `/v1/accounts/${f.personas.alice.accountId}:suspend`,
          { reason: 'Native replay revocation control' },
          discoveryKey(),
        ),
        200,
      );
      const revoked = await observe(() => put(f, a.id, 0, undefined, key));
      const r = problem(revoked.value, 401, 'invalid_credentials');
      expect(r.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
      expect(revoked.statements.filter((s) => /\bFROM\s+core\.receipt\b/i.test(s.text))).toEqual([]);
      problem(
        await f.request('alice', 'DELETE', `/v1/libraryPins/${a.id}?revision=1`, undefined, discoveryKey()),
        401,
        'invalid_credentials',
      );
      problem(await f.request('alice', 'GET', '/v1/libraryPins'), 401, 'invalid_credentials');
      expect(await receipt(f, key)).toEqual(saved);
    }),
  180_000,
);

test(
  'Pins current headers reflect native rename and conceal unreadable or deleted targets while stored IDs remain removable',
  () =>
    world(async (f) => {
      const a = await collection(f);
      const b = await collection(f, 'unlisted', 'bob');
      revision(await put(f, a.id, 0), 1);
      revision(await put(f, b.id, 1), 2);
      expect((await list(f)).pins.map((p) => p.target)).toEqual([a, b]);
      // The inspected fixture forwards method verbatim to Request; PATCH is mounted, but omitted from its TS union.
      const renamed = status(
        (await Reflect.apply(f.request, f, [
          'alice',
          'PATCH',
          `/v1/collections/${a.id}`,
          { revision: a.revision, title: 'Current renamed private title' },
          discoveryKey(),
        ])) as HttpResponse,
        200,
      ).body.collection as Header;
      const current = status(await f.request('alice', 'GET', `/v1/collections/${a.id}`), 200).body.collection as Header;
      expect(current).toEqual(renamed);
      const concealed = status(
        (await Reflect.apply(f.request, f, [
          'bob',
          'PATCH',
          `/v1/collections/${b.id}`,
          { revision: b.revision, visibility: 'private' },
          discoveryKey(),
        ])) as HttpResponse,
        200,
      ).body.collection as Header;
      problem(await f.request('alice', 'GET', `/v1/collections/${b.id}`), 404, 'not_found');
      const p = await list(f);
      expect(p.revision).toBe(2);
      expect(p.pins[0]!.target).toEqual(current);
      expect(p.pins[1]).toEqual({ collectionId: b.id, target: null });
      const pinsOnly = await f.scoped('alice', ['library_pin:list', 'library_pin:update']);
      problem(await pinsOnly.request('GET', `/v1/collections/${a.id}`), 404, 'not_found');
      const hidden = page(await pinsOnly.request('GET', '/v1/libraryPins'));
      expect(hidden).toEqual({
        pins: [
          { collectionId: a.id, target: null },
          { collectionId: b.id, target: null },
        ],
        revision: 2,
        next: null,
      });
      revision(
        await pinsOnly.request('PUT', `/v1/libraryPins/${b.id}`, { revision: 2, after: null }, discoveryKey()),
        3,
      );
      revision(await pinsOnly.request('DELETE', `/v1/libraryPins/${a.id}?revision=3`, undefined, discoveryKey()), 4);
      problem(
        await pinsOnly.request('PUT', `/v1/libraryPins/${a.id}`, { revision: 4 }, discoveryKey()),
        404,
        'not_found',
      );
      status(
        await f.request(
          'bob',
          'DELETE',
          `/v1/collections/${b.id}?revision=${concealed.revision}`,
          undefined,
          discoveryKey(),
        ),
        204,
      );
      expect((await list(f)).pins).toEqual([{ collectionId: b.id, target: null }]);
      revision(await remove(f, b.id, 4), 5);
      problem(await put(f, b.id, 5), 404, 'not_found');
      const unknown = await f.createSubject('schema:Book', 'Native ID with no Collection');
      problem(await put(f, unknown.id, 5), 404, 'not_found');
    }),
  180_000,
);

test(
  'Pins hydration reads only returned targets writes nothing and has no Collection grant follow or personal side effects',
  () =>
    world(async (f) => {
      const targets = [await collection(f), await collection(f, 'public', 'bob'), await collection(f, 'unlisted')];
      const before = await Promise.all(targets.map((c) => storedTarget(f, c)));
      const owner = [routeOf(f.personas.alice.accountId), f.personas.alice.accountId];
      const personal = async () => {
        const results = [];
        for (const table of ['entry', 'copy', 'progress_session', 'follow'] as const) {
          results.push(
            (await f.inspect(`SELECT * FROM library.${table} WHERE route = $1 AND account_id = $2`, owner)).rows,
          );
        }
        results.push(
          (await f.inspect('SELECT * FROM content.reaction WHERE route = $1 AND actor_account_id = $2', owner)).rows,
        );
        return results;
      };
      const facts = await personal();
      for (const [i, c] of targets.entries()) revision(await put(f, c.id, i), i + 1);
      const captured = await observe(() => list(f, '?limit=1'));
      expect(captured.value.pins).toEqual([{ collectionId: targets[0]!.id, target: targets[0]! }]);
      noWrites(captured.statements);
      for (const c of targets.slice(1))
        expect(JSON.stringify(captured.statements.map((s) => s.values))).not.toContain(c.id);
      expect(
        captured.statements.filter((s) => /\bFROM\s+library\.(?:entry|copy|progress_session|follow)\b/i.test(s.text)),
      ).toEqual([]);
      for (const [i, c] of targets.entries()) revision(await remove(f, c.id, 3 + i), 4 + i);
      expect(await personal()).toEqual(facts);
      expect(await Promise.all(targets.map((c) => storedTarget(f, c)))).toEqual(before);
    }),
  180_000,
);

test(
  'Pins target-home deadline propagates native unavailability instead of null or a successful partial page',
  () =>
    world(async (f) => {
      const target = await collection(f, 'public', 'bob');
      revision(await put(f, target.id, 0), 1);
      const database = (await f.inspect<{ name: string }>('SELECT current_database() AS name')).rows[0]!.name;
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/${database}`;
      // Infrastructure fault in this fixture's own database only, with no fabricated domain data.
      const blocker = new pg.Client({ connectionString: url.href });
      await blocker.connect();
      let release: ReturnType<typeof setTimeout> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE library.collection IN ACCESS EXCLUSIVE MODE');
        release = setTimeout(() => {
          void blocker.query('ROLLBACK');
        }, 15_000);
        const r = problem(await f.request('alice', 'GET', '/v1/libraryPins'), 503);
        expect([
          'dependency_unavailable',
          'deadline_exceeded',
          'transaction_retry_exhausted',
          'overloaded',
          'partition_unavailable',
        ]).toContain(r.body.code as string);
      } finally {
        if (release) clearTimeout(release);
        await blocker.query('ROLLBACK');
        await blocker.end();
      }
      expect((await list(f)).pins).toEqual([{ collectionId: target.id, target }]);
    }),
  180_000,
);

test(
  'Pins maximum100 distinct native IDs rejects101 atomically while defaults pages duplicates and reorders stay bounded',
  () =>
    world(async (f) => {
      // Fixed finite controls; no generated target IDs, history population or cursor-until-empty scan.
      const targets: Header[] = [];
      for (let i = 0; i < 101; i++) targets.push(await collection(f));
      for (let i = 0; i < 100; i++) revision(await put(f, targets[i]!.id, i), i + 1);
      const full = await list(f, '?limit=100');
      expect(ids(full)).toEqual(targets.slice(0, 100).map((c) => c.id));
      expect(full.next).toBeNull();
      expect(full.revision).toBe(100);
      const defaultPage = await list(f);
      expect(ids(defaultPage)).toEqual(targets.slice(0, 20).map((c) => c.id));
      expect(typeof defaultPage.next).toBe('string');
      const key = discoveryKey();
      problem(await put(f, targets[100]!.id, 100, undefined, key), 409);
      expect(await receipt(f, key)).toEqual([]);
      expect(await list(f, '?limit=100')).toEqual(full);
      revision(await put(f, targets[0]!.id, 100), 100);
      revision(await put(f, targets[99]!.id, 100, null), 101);
      revision(await remove(f, targets[0]!.id, 101), 102);
      revision(await put(f, targets[100]!.id, 102, undefined, key), 103);
      expect(ids(await list(f, '?limit=100'))).toEqual([
        targets[99]!.id,
        ...targets.slice(1, 99).map((c) => c.id),
        targets[100]!.id,
      ]);
    }),
  300_000,
);
