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
import { runCommand, currentCommand } from '../../src/command/command.ts';
import { runCatalogueBuildStep } from '../../src/semantic/definition-catalogue-publication.ts';
import {
  configureCatalogueConsumerSources,
  enrollCatalogueConsumer,
  catalogueConsumerCaptureDigest,
  type CatalogueConsumerCapture,
  type CatalogueConsumerSource,
} from '../../src/semantic/definition-catalogue-lifecycle.ts';

async function publisher(f: CollectionKindFixture) {
  const authority = await createRealAccess(f.database.pool, { publisher: newId(0) }, [
    'definitions:publish',
    'definitions:activate',
    'definitions:read',
    'gate:definition_publication',
  ]);
  for (const action of ['definitions:publish', 'definitions:activate', 'gate:definition_publication'])
    await authority.grant({ route: 0, id: GLOBAL_CONTEXT }, 'publisher', action);
  const config = {
    pool: f.database.pool,
    access: authority.access,
    writeRate: createWriteRateLimiter({
      secret: 'native-catalogue-enrollment-fixture',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 60 } } }),
    }),
    routeKey: new Uint8Array(32).fill(37),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(38)]]) },
  };
  let app = createKernel(config);
  async function call(path: string, body?: unknown, key = JSON.stringify(randomUUID())) {
    const response = await app.handle(
      new Request(`https://catalogue.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${authority.bearer('publisher')}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': key }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  async function build(version: string, execute = true) {
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
    if (!execute) return pin;
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
  return {
    authority,
    call,
    build,
    activate,
    restart: () => {
      app = createKernel(config);
    },
  };
}

test('Unset presentation Type uses mixed member hints while explicit Type selection and current publication dependencies remain correct', async () => {
  const f = await createCollectionKindFixture();
  try {
    const p = await publisher(f),
      pin = await p.build(`mixed-${randomUUID()}`);
    const before = await p.call('/v1/definitions/catalogue');
    expect((await p.activate(pin, typeof before.body?.head === 'number' ? before.body?.head : null)).status).toBe(200);
    const collection = await f.collection({ visibility: 'public' });
    for (const type of ['schema:Book', 'schema:Movie']) await f.add(collection.id, await f.subject(type));
    expect(await f.read(collection.id)).toMatchObject({
      presentationKind: null,
      presentationKindSource: 'mixed',
    });
    const descriptors = await p.call(`/v1/definitions/catalogues/${pin.rootDigest}/kinds:resolve`, {
      ids: ['schema:Book', 'schema:Movie'],
    });
    expect(descriptors.status).toBe(200);
    const values = descriptors.body as unknown as {
      value: { declaration: { presentation: { type: { typeId: string } } } };
    }[];
    expect(values.map((row) => row.value.declaration.presentation.type.typeId)).toEqual([
      'schema:Book',
      'schema:Movie',
    ]);
    expect(await f.patch(collection.id, 'schema:Book')).toMatchObject({
      presentationKind: 'schema:Book',
      presentationKindSource: 'owner',
    });
    expect(await f.patch(collection.id, null)).toMatchObject({
      presentationKind: null,
      presentationKindSource: 'mixed',
    });
    // Mixed presentation has no catalogue enrollment or automatic preparation dependency.
    expect(
      (
        await f.database.admin.query(
          'SELECT id FROM semantic.definition_catalogue_consumer WHERE route=0 AND root_digest=$1',
          [pin.rootDigest],
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await f.close();
  }
}, 180_000);

test('Catalogue root closure serializes enrollment and final publication requires exact durable current withdrawal acknowledgements for every captured consumer', async () => {
  const f = await createCollectionKindFixture();
  try {
    const p = await publisher(f),
      first = await p.build(`first-${randomUUID()}`);
    const before = await p.call('/v1/definitions/catalogue');
    const activated = await p.activate(first, typeof before.body?.head === 'number' ? before.body?.head : null);
    expect(activated.status).toBe(200);
    // A native test Source implements the named adapter using committed domain rows.
    // No fixture writes catalogue acknowledgement, frontier or completion fields.
    await f.database.admin.query(`CREATE TABLE semantic.catalogue_test_source (
      id text PRIMARY KEY, capture_digest text NOT NULL, owner_generation text NOT NULL,
      restore_generation text NOT NULL, receipt_owner text NOT NULL, receipt_restore text NOT NULL,
      withdrawn boolean NOT NULL, receipt bytea NOT NULL)`);
    configureCatalogueConsumerSources(
      f.database.pool,
      new Map<string, CatalogueConsumerSource>([
        [
          'native-test-source',
          {
            async readCurrentWithdrawal(tx, capture) {
              const row = (
                await tx.query<{
                  capture_digest: string;
                  receipt: Buffer;
                  owner_generation: string;
                  restore_generation: string;
                }>(
                  `SELECT capture_digest,receipt,owner_generation,restore_generation FROM semantic.catalogue_test_source
           WHERE id=$1 AND withdrawn AND owner_generation=receipt_owner AND restore_generation=receipt_restore`,
                  [capture.id],
                )
              ).rows[0];
              return row
                ? {
                    captureDigest: row.capture_digest,
                    receipt: row.receipt,
                    ownerGeneration: row.owner_generation,
                    restoreGeneration: row.restore_generation,
                  }
                : null;
            },
          },
        ],
      ]),
    );
    const enroll = (key: string) =>
      runCommand(f.database.pool, { partition: 0 }, async (tx) => ({
        value: await enrollCatalogueConsumer(tx, first.rootDigest, {
          consumer: { source: 'native-test-source', key },
          provenance: { ownerGeneration: '1', restoreGeneration: '1' },
          dependency: { op: 'kinds', pin: first, ids: ['schema:Book'] },
        }),
        events: [],
      }));
    await enroll('original');
    await enroll('second');
    const next = await p.build(`next-${randomUUID()}`),
      head = Number(activated.body.head);
    const raced = await Promise.allSettled([p.activate(next, head), enroll('late')]);
    expect(raced[0].status).toBe('fulfilled');
    const cut = (
      await f.database.admin.query<{
        state: string;
        generation: string;
        closed_generation: string;
        closed_sequence: string;
        last_sequence: string;
      }>(
        'SELECT state,generation::text,closed_generation::text,closed_sequence::text,last_sequence::text FROM semantic.definition_catalogue_enrollment WHERE route=0 AND root_digest=$1',
        [first.rootDigest],
      )
    ).rows[0]!;
    expect(cut.state).toBe('closed');
    expect(cut.generation).toBe(cut.closed_generation);
    expect(cut.last_sequence).toBe(cut.closed_sequence);
    await expect(enroll('after-close')).rejects.toThrow();
    const frontier = (
      await f.database.admin.query<{
        consumer_id: string;
        sequence: string;
        closed_generation: string;
        consumer: Buffer;
        provenance: Buffer;
        dependency: Buffer;
        enrollment_generation: string;
      }>(
        'SELECT consumer_id,sequence::text,closed_generation::text,consumer,provenance,dependency,enrollment_generation::text FROM semantic.definition_catalogue_frontier WHERE route=0 AND root_digest=$1 ORDER BY slot',
        [next.rootDigest],
      )
    ).rows;
    expect(frontier.length).toBeGreaterThan(0);
    expect(frontier.length).toBeLessThanOrEqual(100);
    const captures: CatalogueConsumerCapture[] = frontier.map((row) => ({
      root: first.rootDigest,
      id: row.consumer_id,
      sequence: row.sequence,
      closedGeneration: row.closed_generation,
      consumer: row.consumer,
      provenance: row.provenance,
      dependency: row.dependency,
      enrollmentGeneration: row.enrollment_generation,
    }));
    expect((await p.activate(next, head)).status).toBe(503);
    // The native Source's old-owner/restore receipt is durably present but no longer current.
    await runCommand(f.database.pool, { partition: 0 }, async (tx) => {
      for (const capture of captures)
        await tx.query(
          `INSERT INTO semantic.catalogue_test_source
        VALUES($1,$2,'2','2','1','1',true,$3)`,
          [capture.id, catalogueConsumerCaptureDigest(capture), Buffer.from(currentCommand(tx).transactionId)],
        );
      return { value: null, events: [] };
    });
    expect((await p.activate(next, head)).status).toBe(503);
    expect((await p.call('/v1/definitions/catalogue')).body.pin).toEqual(first);
    // A current receipt for another cut is also insufficient.
    await f.database.admin.query(
      "UPDATE semantic.catalogue_test_source SET receipt_owner='2',receipt_restore='2',capture_digest='wrong-cut'",
    );
    expect((await p.activate(next, head)).status).toBe(503);
    await f.database.admin.query('UPDATE semantic.catalogue_test_source SET capture_digest=$2 WHERE id=$1', [
      captures[0]!.id,
      catalogueConsumerCaptureDigest(captures[0]!),
    ]);
    expect((await p.activate(next, head)).status).toBe(503);
    await runCommand(f.database.pool, { partition: 0 }, async (tx) => {
      for (const capture of captures)
        await tx.query('UPDATE semantic.catalogue_test_source SET capture_digest=$2,receipt=$3 WHERE id=$1', [
          capture.id,
          catalogueConsumerCaptureDigest(capture),
          Buffer.from(currentCommand(tx).transactionId),
        ]);
      return { value: null, events: [] };
    });
    expect((await p.activate(next, head)).status).toBe(200);
    const acknowledgements = (
      await f.database.admin.query<{
        state: string;
        owner_generation: string;
        restore_generation: string;
        invalidation_receipt: Buffer;
      }>(
        'SELECT state,owner_generation,restore_generation,invalidation_receipt FROM semantic.definition_catalogue_consumer WHERE route=0 AND root_digest=$1',
        [first.rootDigest],
      )
    ).rows;
    expect(acknowledgements).toHaveLength(captures.length);
    for (const row of acknowledgements) {
      expect(row).toMatchObject({ state: 'invalidated', owner_generation: '2', restore_generation: '2' });
      expect(row.invalidation_receipt.byteLength).toBeGreaterThan(0);
    }
    expect((await p.activate(first, head)).status).not.toBe(200);
  } finally {
    await f.close();
  }
}, 240_000);

test('Catalogue build and activation recover the same committed result after a lost reply without duplicate effects', async () => {
  const f = await createCollectionKindFixture();
  try {
    const p = await publisher(f),
      pin = await p.build(`replay-${randomUUID()}`, false);
    const key = JSON.stringify(randomUUID());
    const started = await p.call('/v1/definitions/catalogues', { pin }, key);
    expect(started.status).toBe(200);
    p.restart();
    expect(await p.call('/v1/definitions/catalogues', { pin }, key)).toEqual(started);
    const first = await runCatalogueBuildStep(f.database.pool, pin, () => new Date(), '0');
    const stepped = await p.call(`/v1/definitions/catalogues/${pin.rootDigest}:step`, {});
    expect(stepped.status).toBe(200);
    expect(await runCatalogueBuildStep(f.database.pool, pin, () => new Date(), '0')).toEqual(first);
    expect((await p.call(`/v1/definitions/catalogues/${pin.rootDigest}/build`)).body).toEqual(stepped.body);
    let progress = stepped;
    for (let n = 0; n < 2048 && progress.body.state === 'building'; n++)
      progress = await p.call(`/v1/definitions/catalogues/${pin.rootDigest}:step`, {});
    expect(progress.body.state).toBe('ready');
    const previous = await p.call('/v1/definitions/catalogue');
    const activationKey = JSON.stringify(randomUUID()),
      body = { expected_head: previous.body?.head ?? null };
    const active = await p.call(`/v1/definitions/catalogues/${pin.rootDigest}:activate`, body, activationKey);
    expect(active.status).toBe(200);
    p.restart();
    expect(await p.call(`/v1/definitions/catalogues/${pin.rootDigest}:activate`, body, activationKey)).toEqual(active);
    expect((await p.call('/v1/definitions/catalogue')).body).toEqual(active.body);
    expect(
      (
        await f.database.admin.query(
          'SELECT position FROM semantic.definition_catalogue_checkpoint WHERE route=0 AND root_digest=$1',
          [pin.rootDigest],
        )
      ).rows,
    ).toEqual([{ position: '0' }]);
  } finally {
    await f.close();
  }
}, 240_000);
