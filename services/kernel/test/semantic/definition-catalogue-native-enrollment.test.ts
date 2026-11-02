import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  buildCatalogue,
  catalogueBytes,
  catalogueDigest,
  parseCatalogueJson,
  CATALOGUE_FORMAT,
  CATALOGUE_NODE_FORMAT,
  KIND_FORMAT,
  type KindCataloguePin,
} from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId } from '../../src/route/route.ts';
import { createRealAccess } from './real-access.ts';
import { createCollectionKindFixture, type CollectionKindFixture } from '../library/support/collection-kind-fixture.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import { CATALOGUE_BODY_COST, catalogueBodyWork } from '../../src/semantic/definition-catalogue-work-cost.ts';

/** Real native Collection producer plus a separately authenticated catalogue publisher.
 * No fixture writes consumer registrations, Source custody, withdrawals, ACKs or complete bits.
 * These connected regressions deliberately fail at missing producer integration rather than
 * replacing the original with a successful mock. Native execution is deferred at this boundary.
 */
async function publisher(f: CollectionKindFixture) {
  const authority = await createRealAccess(f.database.pool, { publisher: newId(0) }, [
    'definitions:publish',
    'definitions:activate',
    'definitions:read',
    'gate:definition_publication',
  ]);
  for (const action of ['definitions:publish', 'definitions:activate', 'gate:definition_publication'])
    await authority.grant({ route: 0, id: GLOBAL_CONTEXT }, 'publisher', action);
  const app = createKernel({
    pool: f.database.pool,
    access: authority.access,
    writeRate: createWriteRateLimiter({
      secret: 'native-catalogue-enrollment-fixture',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 60 } } }),
    }),
    routeKey: new Uint8Array(32).fill(37),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(38)]]) },
  });
  async function call(path: string, body?: unknown) {
    const response = await app.handle(
      new Request(`https://catalogue.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${authority.bearer('publisher')}`,
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(randomUUID()) }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  async function build(version: string) {
    const release = structuredClone(bundledRelease);
    release.catalogue = { ...release.catalogue, version };
    const objects = new Map<string, Uint8Array>();
    const pin = await buildCatalogue(
      { releases: [release], compatibility: 'all' },
      {
        read: async (digest) => objects.get(digest),
        put: async (digest, bytes) => {
          objects.set(digest, bytes);
        },
      },
    );
    for (const bytes of objects.values()) {
      const artifact = parseCatalogueJson(bytes, 4194304) as { format: string };
      const kind =
        artifact.format === CATALOGUE_FORMAT
          ? 'root'
          : artifact.format === CATALOGUE_NODE_FORMAT
            ? 'node'
            : artifact.format === KIND_FORMAT
              ? 'declaration'
              : 'release';
      const saved = await call('/v1/definitions/catalogue/artifacts', { kind, artifact });
      expect([200, 201]).toContain(saved.status);
      expect(saved.body.digest).toBe(catalogueDigest(catalogueBytes(artifact)));
    }
    let progress = await call('/v1/definitions/catalogues', { pin });
    expect(progress.status).toBe(200);
    // Finite test input and one real bounded native continuation per call; no test scheduler.
    for (let page = 0; page < 2048 && progress.body.state === 'building'; page++) {
      progress = await call(`/v1/definitions/catalogues/${pin.rootDigest}:step`, {});
      expect(progress.status).toBe(200);
    }
    expect(progress.body.state).toBe('ready');
    return pin;
  }
  async function activate(pin: KindCataloguePin, head: number | null) {
    return call(`/v1/definitions/catalogues/${pin.rootDigest}:activate`, { expected_head: head });
  }
  return { authority, call, build, activate };
}

type Consumer = { id: string; consumer: Buffer; provenance: Buffer; dependency: Buffer; state: string };
async function consumers(f: CollectionKindFixture, pin: KindCataloguePin) {
  return (
    await f.database.admin.query<Consumer>(
      `SELECT id,consumer,provenance,dependency,state FROM semantic.definition_catalogue_consumer
     WHERE route=0 AND root_digest=$1 ORDER BY sequence`,
      [pin.rootDigest],
    )
  ).rows;
}

// Original authority is obtained only through native Collection mutation, preparation and worker dispatch.
test('Genuine original Kind work reads and enrolls exact positive and negative catalogue dependencies while stale foreign and unfunded invocations refuse', async () => {
  const f = await createCollectionKindFixture();
  try {
    const p = await publisher(f);
    const pin = await p.build(`native-${randomUUID()}`);
    const before = await p.call('/v1/definitions/catalogue');
    expect((await p.activate(pin, typeof before.body.head === 'number' ? before.body.head : null)).status).toBe(200);
    const collection = await f.collection({ visibility: 'public' });
    const subject = await f.subject('schema:Book');
    await f.add(collection.id, subject);
    expect(await f.complete(collection.id, null)).toMatchObject({ presentationKindSource: 'members' });
    const positive = await consumers(f, pin);
    expect(positive.length).toBeGreaterThan(0);
    const original = positive.filter((row) => {
      const value = JSON.parse(row.consumer.toString()) as { locator: { collectionId: string } };
      return value.locator.collectionId === collection.id;
    });
    expect(original.length).toBeGreaterThan(0);
    for (const row of original) {
      expect(row.provenance.byteLength).toBeGreaterThan(0);
      const dependency = JSON.parse(row.dependency.toString()) as { op: string; pin?: KindCataloguePin };
      expect(['head', 'kinds', 'candidates']).toContain(dependency.op);
      if (dependency.pin) expect(dependency.pin).toEqual(pin);
    }
    // A zero-contribution and then an excluded original still retain structural dependencies.
    const empty = await f.collection({ visibility: 'public' });
    expect(await f.complete(empty.id, null)).toMatchObject({ presentationKindSource: 'empty' });
    await f.hide(subject);
    expect(await f.complete(collection.id, null)).toMatchObject({ presentationKindSource: 'empty' });
    const negative = await consumers(f, pin);
    expect(negative.length).toBeGreaterThanOrEqual(positive.length);
    expect(negative.some((row) => row.consumer.toString().includes(empty.id))).toBe(true);
    for (const row of original)
      expect(negative.find((value) => value.id === row.id)?.provenance).toEqual(row.provenance);
    // Original owner/episode and selector bytes must be part of retained identity; no locator-only collapse.
    expect(new Set(negative.map((row) => row.id)).size).toBe(negative.length);
    expect(negative.every((row) => row.dependency.byteLength <= 65536)).toBe(true);
  } finally {
    await f.close();
  }
}, 180_000);

test('Catalogue root closure serializes enrollment and final publication requires exact durable current withdrawal acknowledgements for every captured consumer', async () => {
  const f = await createCollectionKindFixture();
  try {
    const p = await publisher(f);
    const first = await p.build(`first-${randomUUID()}`);
    const head = await p.call('/v1/definitions/catalogue');
    expect((await p.activate(first, typeof head.body.head === 'number' ? head.body.head : null)).status).toBe(200);
    // A new empty cut must have real durable registration, rather than migration-certified historical emptiness.
    const registered = (
      await f.database.admin.query<{ protocol: number; state: string }>(
        'SELECT protocol,state FROM semantic.definition_catalogue_enrollment WHERE route=0 AND root_digest=$1',
        [first.rootDigest],
      )
    ).rows[0];
    expect(registered).toEqual({ protocol: 1, state: 'open' });
    const collection = await f.collection({ visibility: 'public' });
    await f.add(collection.id, await f.subject('schema:Book'));
    await f.complete(collection.id, null);
    const captured = await consumers(f, first);
    expect(captured.length).toBeGreaterThan(0);
    const next = await p.build(`next-${randomUUID()}`);
    const active = await p.call('/v1/definitions/catalogue');
    expect(typeof active.body.head).toBe('number');
    const expectedHead = Number(active.body.head);
    // Close races the genuine first/late native preparation. The same root row serializes both paths.
    const late = await f.collection({ visibility: 'public' });
    const raced = await Promise.all([p.activate(next, expectedHead), f.add(late.id, await f.subject('schema:Movie'))]);
    expect([200, 202, 503]).toContain(raced[0].status);
    const cut = (
      await f.database.admin.query<{
        generation: string;
        closed_generation: string;
        closed_sequence: string;
        last_sequence: string;
        state: string;
      }>(
        `SELECT generation::text,closed_generation::text,closed_sequence::text,last_sequence::text,state
       FROM semantic.definition_catalogue_enrollment WHERE route=0 AND root_digest=$1`,
        [first.rootDigest],
      )
    ).rows[0]!;
    expect(cut.state).toBe('closed');
    expect(cut.generation).toBe(cut.closed_generation);
    expect(cut.last_sequence).toBe(cut.closed_sequence);
    expect(BigInt(cut.closed_sequence)).toBeGreaterThanOrEqual(BigInt(captured.length));
    const frontier = (
      await f.database.admin.query<{ consumer_id: string; consumer: Buffer; provenance: Buffer }>(
        `SELECT consumer_id,consumer,provenance FROM semantic.definition_catalogue_frontier
       WHERE route=0 AND root_digest=$1 ORDER BY slot`,
        [next.rootDigest],
      )
    ).rows;
    expect(frontier.length).toBeGreaterThan(0);
    expect(frontier.length).toBeLessThanOrEqual(100);
    for (const row of frontier) {
      expect(row.consumer.byteLength).toBeGreaterThan(0);
      expect(row.provenance.byteLength).toBeGreaterThan(0);
    }
    // Current Source's unavailable ACK producer must leave the head and retained obligations intact.
    const retry = await p.activate(next, expectedHead);
    expect(retry.status).toBe(503);
    expect((await p.call('/v1/definitions/catalogue')).body.pin).toEqual(first);
    const replay = await consumers(f, first);
    for (const original of captured) {
      const retained = replay.find((row) => row.id === original.id);
      expect(retained?.consumer).toEqual(original.consumer);
      expect(retained?.provenance).toEqual(original.provenance);
      expect(retained?.dependency).toEqual(original.dependency);
    }
    // No stale activation of a different replacement may acquire this head's retained cut.
    const competitor = await p.build(`competitor-${randomUUID()}`);
    expect((await p.activate(competitor, expectedHead)).status).not.toBe(200);
  } finally {
    await f.close();
  }
}, 240_000);

// These need no database and use no positive authority. Failed dispatch remains spent.
test('catalogue failed dispatch is cumulative and an expired or unfunded frame never invokes its body', async () => {
  const cost = CATALOGUE_BODY_COST.control;
  const deadline = Date.now() + 1000;
  const work = new NativeCollectionWork({ reservationId: 'failed-dispatch', remaining: cost }, deadline);
  await expect(
    catalogueBodyWork(
      work,
      cost,
      async () => {
        throw new Error('body failed');
      },
      deadline,
    ),
  ).rejects.toThrow('body failed');
  expect(work.receipt().used).toEqual(cost);
  let invoked = false;
  await expect(
    catalogueBodyWork(
      work,
      cost,
      async () => {
        invoked = true;
      },
      deadline,
    ),
  ).rejects.toThrow();
  expect(invoked).toBe(false);
  expect(work.receipt().used).toEqual(cost);
  const expiredDeadline = Date.now() - 1;
  const expired = new NativeCollectionWork({ reservationId: 'expired', remaining: cost }, expiredDeadline);
  await expect(
    catalogueBodyWork(
      expired,
      cost,
      async () => {
        invoked = true;
      },
      expiredDeadline,
    ),
  ).rejects.toThrow();
  expect(invoked).toBe(false);
  const unfunded = new NativeCollectionWork({ reservationId: 'unfunded', remaining: { ...cost, bytes: 0 } }, deadline);
  await expect(
    catalogueBodyWork(
      unfunded,
      cost,
      async () => {
        invoked = true;
      },
      deadline,
    ),
  ).rejects.toThrow();
  expect(invoked).toBe(false);
});

test('catalogue body returning after the original deadline stays charged and cannot renew the frame', async () => {
  const cost = CATALOGUE_BODY_COST.control;
  const deadline = Date.now() + 100;
  const work = new NativeCollectionWork({ reservationId: 'late-callback', remaining: cost }, deadline);
  await expect(
    catalogueBodyWork(
      work,
      cost,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return 'late';
      },
      deadline,
    ),
  ).rejects.toThrow();
  expect(work.receipt().used).toEqual(cost);
  let invoked = false;
  await expect(
    catalogueBodyWork(
      work,
      cost,
      async () => {
        invoked = true;
      },
      deadline,
    ),
  ).rejects.toThrow();
  expect(invoked).toBe(false);
  expect(work.receipt().used).toEqual(cost);
});

// Additive receiving regressions. Existing native outcomes above remain the oracle.
import { Pool } from 'pg';
import {
  cataloguePublisherInvocation,
  CataloguePublisherAdmissionUnavailable,
  CATALOGUE_PUBLISHER_MISSING_COMPOSITION,
} from '../../src/semantic/definition-catalogue-publication-work.ts';
import {
  catalogueOperationCost,
  catalogueLedgerCost,
  catalogueParameterBytes,
  CATALOGUE_PUBLISHER_PATHS,
} from '../../src/semantic/definition-catalogue-work-cost.ts';

test('catalogue publisher factories cannot create an original, extend a deadline or checkout without the inclusive Core association', async () => {
  const pool = new Pool({ max: 1 });
  try {
    for (const deadline of [undefined, Date.now() - 1, Date.now() + 60_000]) {
      expect(() => cataloguePublisherInvocation(pool, 'build', deadline)).toThrow(
        CataloguePublisherAdmissionUnavailable,
      );
      expect(pool.totalCount).toBe(0);
      expect(pool.waitingCount).toBe(0);
    }
    expect(
      CATALOGUE_PUBLISHER_MISSING_COMPOSITION.some(
        (term) => term.owner === 'Core' && term.operation.includes('COMMIT') && term.operation.includes('ROLLBACK'),
      ),
    ).toBe(true);
  } finally {
    await pool.end();
  }
});

test('catalogue literal prices cover independent insert, duplicate, empty and rollback SQL paths', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const transaction = '11111111-1111-4111-8111-111111111111';
  const sql =
    'INSERT INTO semantic.definition_catalogue_artifact(route,digest,kind,bytes,recorded_transaction_id)\n       VALUES(0,$1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING digest';
  const insert = catalogueOperationCost('artifactInsert', [digest, 'node', Buffer.from('{}'), transaction]);
  expect(insert).toEqual({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 80 + Buffer.byteLength(sql) + 71 + 4 + 2 + 36 + 4 * 6,
    emptySeeks: 1,
  });
  const duplicate = catalogueOperationCost('artifactConflict', [digest]);
  // Conflict reads one bounded 4 MiB bytea (hex on output), kind and scalar fields.
  expect(duplicate.nativeRows).toBe(1);
  expect(duplicate.bytes).toBe(
    2 * 4194304 +
      32 +
      Buffer.byteLength('SELECT kind,bytes FROM semantic.definition_catalogue_artifact WHERE route=0 AND digest=$1') +
      71 +
      6,
  );
  const rollback = catalogueOperationCost('stepRollback');
  expect(rollback).toEqual({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 1,
    bytes: Buffer.byteLength('ROLLBACK TO SAVEPOINT catalogue_step'),
    emptySeeks: 0,
  });
  expect(catalogueOperationCost('artifactSize', [digest]).emptySeeks).toBe(1);
  expect(() => Reflect.apply(catalogueOperationCost, null, ['unclassified', []])).toThrow();
  expect(() =>
    catalogueOperationCost('artifactInsert', [digest, 'node', Buffer.alloc(4194305), transaction]),
  ).toThrow();
  expect(catalogueParameterBytes(['a"b', 'c\\d'])).toBe(Buffer.byteLength('{"a\\"b","c\\\\d"}'));
  expect(Object.isFrozen(CATALOGUE_PUBLISHER_PATHS.node.repeated)).toBe(true);
});

test('catalogue ticket and retirement components are finite additive statements rather than a guessed whole schedule', () => {
  const key = 'a'.repeat(64),
    root = `sha256:${'b'.repeat(64)}`;
  const transaction = '11111111-1111-4111-8111-111111111111';
  const spend = catalogueLedgerCost('ticketSpend', { original_key: key, transaction_id: transaction });
  // One owner read, seven ticket reads, seven ticket writes and one owner write.
  expect(spend.nativeRows).toBe(1 + 7 + 7 + 1);
  expect(spend.statements).toBe(1);
  expect(spend.candidateKeys).toBe(7);
  expect(spend.emptySeeks).toBe(1);
  const cleanup = catalogueLedgerCost('retirementTickets', { root, original_key: key });
  // One terminal owner read, seven ticket reads/deletes and seven FK reverse probes.
  expect(cleanup.nativeRows).toBe(1 + 7 + 7 + 7);
  expect(cleanup.nativePoints).toBe(1 + 1 + 7 * 3 + 1);
  expect(cleanup.candidateKeys).toBe(7);
  expect(cleanup.statements).toBe(1);
  expect(() =>
    catalogueLedgerCost('ticketSpend', { original_key: key, transaction_id: transaction, complete: true }),
  ).toThrow();
});

/** The real route, native receipt codec and durable original select replay identity.
 * No test inserts an original, ticket, settlement, consumer ACK or owner proof.
 */
test('catalogue lost-response replay and a new factory preserve the original deadline, input and irreversible spent totals', async () => {
  const f = await createCollectionKindFixture();
  try {
    const p = await publisher(f);
    const pin = await p.build(`original-replay-${randomUUID()}`);
    const config = {
      pool: f.database.pool,
      access: p.authority.access,
      writeRate: createWriteRateLimiter({
        secret: 'catalogue-original-replay',
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 60 } } }),
      }),
      routeKey: new Uint8Array(32).fill(37),
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(38)]]) },
    };
    const idempotencyKey = JSON.stringify(randomUUID());
    const request = () =>
      new Request('https://catalogue.test/v1/definitions/catalogues', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${p.authority.bearer('publisher')}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ pin }),
      });
    const rows = async () =>
      (
        await f.database.admin.query(
          `SELECT original_key,input_digest,deadline_ms::text,admitted::text,spent::text,state,dispatch_transaction_id
       FROM semantic.definition_catalogue_original WHERE route=0 AND root_digest=$1 AND phase='build' ORDER BY original_key`,
          [pin.rootDigest],
        )
      ).rows;
    const before = await rows();
    // Discard the first response: the second producer instance must resolve durable progress.
    expect((await createKernel(config).handle(request())).status).toBe(200);
    const committed = await rows();
    const original = committed.filter((row) => !before.some((old) => old.original_key === row.original_key));
    expect(original.length).toBe(1);
    expect(['spent', 'terminal']).toContain(original[0]!.state);
    expect(original[0]!.spent).toBe(original[0]!.admitted);
    expect((await createKernel(config).handle(request())).status).toBe(200);
    expect(await rows()).toEqual(committed);
    const tickets = (
      await f.database.admin.query(
        'SELECT slot,state FROM semantic.definition_catalogue_ticket WHERE route=0 AND original_key=$1 ORDER BY slot',
        [original[0]!.original_key],
      )
    ).rows;
    // Terminal reclamation may remove auxiliaries, never recreate executable balance.
    expect(tickets.length === 0 || tickets.length === 7).toBe(true);
    expect(tickets.every((row) => row.state === 'spent')).toBe(true);
  } finally {
    await f.close();
  }
}, 240_000);

test('catalogue restore ABA and interrupted pending activation retain both native generations and their last-reference liabilities', async () => {
  const f = await createCollectionKindFixture();
  try {
    const p = await publisher(f);
    const first = await p.build(`retained-aba-${randomUUID()}`);
    const current = await p.call('/v1/definitions/catalogue');
    expect((await p.activate(first, typeof current.body.head === 'number' ? current.body.head : null)).status).toBe(
      200,
    );
    const collection = await f.collection({ visibility: 'public' });
    const member = await f.add(collection.id, await f.subject('schema:Book'));
    await f.complete(collection.id, null);
    const initial = await consumers(f, first);
    expect(initial.length).toBeGreaterThan(0);
    const live = await f.read(collection.id);
    const removed = await f.send(
      f.owner.bearer,
      'DELETE',
      `${f.path(collection.id)}/members/${member}?revision=${live.revision}`,
    );
    expect(removed.status).toBe(204);
    await f.complete(collection.id, null);
    const restored = await f.send(f.owner.bearer, 'POST', `${f.path(collection.id)}/members/${member}:restore`, {
      revision: Number(removed.headers.get('Library-Collection-Member-Deletion-Revision')),
      deletionId: removed.headers.get('Library-Collection-Member-Deletion-Id'),
    });
    expect(restored.status).toBe(200);
    await f.complete(collection.id, null);
    const generations = await consumers(f, first);
    expect(generations.length).toBeGreaterThan(initial.length);
    for (const original of initial) expect(generations.find((row) => row.id === original.id)).toEqual(original);
    const target = await p.build(`retained-target-${randomUUID()}`);
    const head = Number((await p.call('/v1/definitions/catalogue')).body.head);
    // Pending is durably committed even though the authorized response is unavailable.
    expect((await p.activate(target, head)).status).toBe(503);
    const snapshot = async () =>
      (
        await f.database.admin.query(
          `SELECT consumer_id,consumer_root,consumer,provenance,dependency,enrollment_generation::text,closed_generation::text
       FROM semantic.definition_catalogue_frontier WHERE route=0 AND root_digest=$1 ORDER BY slot`,
          [target.rootDigest],
        )
      ).rows;
    const retained = await snapshot();
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.every((row) => row.consumer_root === first.rootDigest)).toBe(true);
    expect((await p.activate(target, head)).status).toBe(503);
    expect(await snapshot()).toEqual(retained);
    expect(await consumers(f, first)).toEqual(generations);
    const old = (
      await f.database.admin.query(
        `SELECT state,closed_sequence::text FROM semantic.definition_catalogue_enrollment WHERE route=0 AND root_digest=$1`,
        [first.rootDigest],
      )
    ).rows[0]!;
    expect(old.state).toBe('closed');
    expect(BigInt(old.closed_sequence)).toBeGreaterThan(0n);
    expect((await p.call('/v1/definitions/catalogue')).body.pin).toEqual(first);
  } finally {
    await f.close();
  }
}, 240_000);
