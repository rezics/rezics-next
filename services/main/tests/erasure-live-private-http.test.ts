import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore, migrateContent } from '../../content/src/index.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import {
  startPostgresCluster,
  type PostgresCluster,
} from '../../../tests/qa/support/postgres-cluster.ts';
import {
  FusekiClient,
  type CommandEnvelope,
  type CommandResult,
  type SparqlResult,
} from '../src/infrastructure/fuseki.ts';
import {
  ObjectNotFound,
  ObjectUnavailable,
  type ImmutableObjects,
} from '../src/infrastructure/immutable-objects.ts';
import { boundedPool } from '../src/infrastructure/pg-pool.ts';
import { AdmissionDenied, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { CONTRIBUTION_PROFILE } from '../src/modules/contribution/draft.ts';
import { ErasureConflict, readErasure } from '../src/modules/erasure/journal.ts';
import { ErasureService } from '../src/modules/erasure/request.ts';
import { ERASURE_DEFERRED_REASON } from '../src/modules/erasure/schema.ts';
import { MediaStore } from '../src/modules/media/store.ts';
import {
  hash,
  prepareComponent,
  createWorkActivationEnvironment,
  type WorkActivationEnvironment,
} from '../src/modules/work/activate.ts';
import { erasureRoutes, openApiOperations } from '../src/routes/erasures.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const root = resolve(import.meta.dir, '../../..');
const resource = () => `https://rezics.com/id/${randomUUID()}`;
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
const bool = (value: boolean) => ({
  ...literal(String(value)),
  datatype: 'http://www.w3.org/2001/XMLSchema#boolean',
});
let cluster: PostgresCluster | undefined;
let admin: Pool;
let directory: string;

beforeAll(async () => {
  directory = join(root, '.temp', `erasure-private-http-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  cluster = await startPostgresCluster();
  admin = new Pool(cluster.connection);
  await admin.query('CREATE DATABASE erasure_http_template');
  const pool = boundedPool({ ...cluster.connection, database: 'erasure_http_template', max: 4 });
  try {
    await migrateContent(pool);
    for (const file of schemaFiles(root, 'relay')) {
      await pool.query(readFileSync(join(root, 'services/main/migrations/relay', file), 'utf8'));
    }
    await pool.query(`CREATE SCHEMA access;
      CREATE TABLE access.governance_preservation_hold (
        id uuid PRIMARY KEY, target_resource text NOT NULL, reason text NOT NULL, released_at timestamptz);
      CREATE TABLE access.governance_erasure_postponement (
        hold_id uuid NOT NULL, operation_id text NOT NULL, material_ref text NOT NULL, reason text NOT NULL,
        PRIMARY KEY (hold_id,operation_id,material_ref))`);
    for (const file of [
      '1765_receipt_custody.sql',
      '1766_receipt_custody_delivery.sql',
      '1786_command_custody_erasure.sql',
    ]) {
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
  } finally {
    await pool.end();
  }
}, 120_000);

afterAll(async () => {
  await admin?.end();
  cluster?.remove();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

class Objects {
  readonly data = new Map<string, Uint8Array>();
  readonly deletes: string[] = [];
  failure = false;
  namespace = (prefix: string): ImmutableObjects => ({
    put: async (bytes) => {
      const digest = hash(bytes);
      this.data.set(`${prefix}sha256/${digest}`, bytes.slice());
      return digest;
    },
    get: async (digest) => {
      const bytes = this.data.get(`${prefix}sha256/${digest}`);
      if (!bytes) throw new ObjectNotFound('missing exact key');
      return bytes.slice();
    },
    probe: async (digest, signal) => {
      signal?.throwIfAborted();
      if (this.failure) throw new ObjectUnavailable('private storage diagnostic');
      if (!this.data.has(`${prefix}sha256/${digest}`))
        throw new ObjectNotFound('missing exact key');
    },
    deleteAndVerifyAbsent: async (digest, signal) => {
      signal?.throwIfAborted();
      if (this.failure) throw new ObjectUnavailable('private storage diagnostic');
      const key = `${prefix}sha256/${digest}`;
      this.deletes.push(key);
      this.data.delete(key);
    },
    listPrefix: async (selected, options) => {
      options.signal?.throwIfAborted();
      const keys = [...this.data.keys()].filter((key) => key.startsWith(selected));
      if (keys.length > options.maxEntries) throw new ObjectUnavailable('inventory overflow');
      return keys;
    },
  });
}

class Graph extends FusekiClient {
  readonly lineage = { dataEpoch: randomUUID(), routingEpoch: randomUUID() };
  readonly revisions = new Map<string, { owner: string; manifest: string }>();
  readonly units: { graph: string; unit: string; target: string }[] = [];
  readonly suppressed = new Set<string>();
  readonly queries: string[] = [];
  readonly commands: CommandEnvelope[] = [];
  constructor() {
    super('http://erasure-http.invalid');
  }
  override async commandHealth() {
    return {
      moduleVersion: 'fixture',
      instanceId: 'fixture',
      publicSearchWriteEpoch: 'fixture',
      publicSearchWriteActive: true,
      profiles: { 'erasure-graph-v1': profileRegistry['erasure-graph-v1'].sha256 },
    };
  }
  override async query(query: string): Promise<SparqlResult> {
    this.queries.push(query);
    if (query.includes('SELECT DISTINCT ?revision ?owner ?erased ?owned'))
      return { results: { bindings: [] } };
    if (query.includes('SELECT ?revision ?kind ?owner ?manifest ?erased')) {
      return {
        results: {
          bindings: [...this.revisions]
            .filter(([id]) => query.includes(`<https://rezics.com/id/${id}>`))
            .map(([id, row]) => ({
              revision: uri(`https://rezics.com/id/${id}`),
              owner: uri(row.owner),
              kind: literal('text_contribution_draft'),
              manifest: uri(row.manifest),
              erased: bool(this.suppressed.has(`https://rezics.com/id/${id}`)),
            })),
        },
      };
    }
    if (query.includes('SELECT ?revision ?component ?manifest ?erased ?duplicate')) {
      return {
        results: {
          bindings: [...this.revisions]
            .filter(([, row]) => query.includes(`<${row.manifest}>`))
            .map(([id, row]) => ({
              revision: uri(`https://rezics.com/id/${id}`),
              component: uri(row.owner),
              manifest: uri(row.manifest),
              erased: bool(this.suppressed.has(`https://rezics.com/id/${id}`)),
              duplicate: bool(false),
            })),
        },
      };
    }
    if (query.includes('SELECT DISTINCT ?graph ?unit ?target')) {
      const limit = Number(/LIMIT (\d+)/.exec(query)?.[1]);
      return {
        results: {
          bindings: this.units
            .filter((unit) => !this.suppressed.has(unit.target))
            .slice(0, limit)
            .map((unit) => ({
              graph: uri(unit.graph),
              unit: uri(unit.unit),
              target: uri(unit.target),
            })),
        },
      };
    }
    if (query.includes('SELECT DISTINCT ?target')) {
      const selected = /VALUES \?target \{([^}]+)\}/.exec(query)?.[1] ?? '';
      return {
        results: {
          bindings: [...selected.matchAll(/<([^>]+)>/g)]
            .map((match) => match[1]!)
            .filter((target) => this.suppressed.has(target))
            .map((target) => ({
              target: uri(target),
              sequence: literal('5'),
              currentSequence: literal('5'),
              receiptEpoch: literal(this.lineage.dataEpoch),
            })),
        },
      };
    }
    throw new Error(`unexpected graph query: ${query.slice(0, 100)}`);
  }
  override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    this.commands.push(envelope);
    for (const target of envelope.validations.flatMap((validation) => validation.focus))
      this.suppressed.add(target);
    return {
      status: 'committed',
      position: {
        datasetId: 'urn:rezics:dataset:product',
        dataEpoch: this.lineage.dataEpoch,
        sequence: '5',
      },
    };
  }
}

async function environment(pool: Pool, relay: Pool, accessPool: Pool, objectDirectory: string) {
  const core = new ContentCore(pool),
    graph = new Graph(),
    objects = new Objects();
  const env = createWorkActivationEnvironment<WorkActivationEnvironment>({
    fuseki: graph,
    lineage: graph.lineage,
    referenceFencePool: pool,
    objectDirectory,
    workObjects: objects.namespace('semantic/work/'),
  });
  // The production composition needs the same existing namespace factory as its fourth argument.
  const service = new ErasureService(relay, pool, accessPool, objects.namespace);
  const principalId = randomUUID(),
    admissions = new Map<string, RegisteredAdmission>();
  let reader = principalId,
    denied = false;
  const scopes: string[][] = [];
  const account = {
    verify: async (_request: Request, required: string[]) => {
      scopes.push(required);
      return { issuer: 'fixture', subject: 'fixture' };
    },
  };
  const access = {
    register: async (
      input: Pick<
        RegisteredAdmission,
        'actingSubject' | 'scope' | 'action' | 'idempotencyKey' | 'requestDigest'
      >,
    ) => {
      const previous = admissions.get(input.idempotencyKey);
      if (previous) {
        if (previous.requestDigest !== input.requestDigest)
          throw new ErasureConflict('private conflicting request');
        return { ...previous, replayed: true };
      }
      const admission: RegisteredAdmission = {
        ...input,
        id: randomUUID(),
        principalId,
        authorityEpoch: '7',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'registered',
        dispatchEligible: true,
        replayed: false,
      };
      admissions.set(input.idempotencyKey, admission);
      return admission;
    },
    claim: async () => {
      if (denied) throw new AdmissionDenied('private authority diagnostic');
    },
    recordGraphOutcome: async (id: string) => {
      for (const admission of admissions.values())
        if (admission.id === id) admission.state = 'sealed';
    },
    activePrincipalId: async () => reader,
  };
  const app = erasureRoutes({
    erasures: service,
    environment: env,
    account,
    access,
  } as unknown as MainWorkDependencies);
  const post = (owner: string, revisionIds: string[], key = randomUUID()) =>
    app.handle(
      new Request('http://main.local/v1/erasures', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          profile: 'content-revision-erasure-v1',
          actingSubject: owner,
          resourceId: owner,
          revisionIds,
        }),
      }),
    );
  const get = (id: string) => app.handle(new Request(`http://main.local/v1/erasures/${id}`));
  const drafts = async (owner: string, count = 1) => {
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const saved = await core.saveDraft({
        operationId: randomUUID(),
        variant: {
          id: `urn:rezics:variant:${randomUUID()}`,
          resourceId: owner,
          language: { kind: 'zxx' },
          direction: 'none',
        },
        expectedHead: null,
        model: 'fixture',
        sourceRevision: null,
        provenance: {},
        serializedJson: '{"secret":"private SQL bytes"}',
      });
      expect(saved.outcome).toBe('succeeded');
      ids.push(saved.revisionId!);
    }
    return ids;
  };
  const contribution = (owner: string) => {
    const id = randomUUID();
    const digest = prepareComponent(
      objectDirectory,
      owner,
      {
        work: resource(),
        author: owner,
        language: 'en',
        body: 'private authored payload',
        publication: 'draft',
      },
      CONTRIBUTION_PROFILE,
    );
    const manifest = JSON.parse(readFileSync(join(objectDirectory, digest), 'utf8')) as {
      payload: string;
    };
    const payload = manifest.payload.slice(7);
    objects.data.set(
      `semantic/work/sha256/${payload}`,
      readFileSync(join(objectDirectory, payload)),
    );
    graph.revisions.set(id, { owner, manifest: `urn:rezics:sha256:${digest}` });
    return { id, payload };
  };
  return {
    pool,
    relay,
    core,
    graph,
    objects,
    admissions,
    scopes,
    service,
    post,
    get,
    drafts,
    contribution,
    deny: () => {
      denied = true;
    },
    otherReader: () => {
      reader = randomUUID();
    },
  };
}

async function fixture(run: (f: Awaited<ReturnType<typeof environment>>) => Promise<void>) {
  const database = `erasure_http_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database} TEMPLATE erasure_http_template`);
  const pool = boundedPool({ ...cluster!.connection, database, max: 4 });
  const relay = boundedPool({ ...cluster!.connection, database, max: 1 });
  const access = boundedPool({ ...cluster!.connection, database, max: 1 });
  const objectDirectory = join(directory, database);
  mkdirSync(objectDirectory);
  try {
    await run(await environment(pool, relay, access, objectDirectory));
  } finally {
    await Promise.all([pool.end(), relay.end(), access.end()]);
    await admin.query(`DROP DATABASE ${database}`);
  }
}

test('64 requested revisions report exact completed live targets through POST and the requester GET', async () => {
  await fixture(async (f) => {
    const owner = resource(),
      ids = await f.drafts(owner, 64);
    const originals = (
      await f.pool.query('SELECT id,byte_digest FROM content.revision ORDER BY id')
    ).rows;
    const response = await f.post(owner, ids);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const report = await response.json();
    expect(report).toMatchObject({
      stage: 'reconciling',
      suppression: 'suppressed',
      replayed: false,
      verifiedAt: null,
    });
    expect(report.targets).toHaveLength(64);
    expect(report.targets.map((target: { ref: string }) => target.ref)).toEqual(ids);
    for (const target of report.targets) {
      expect(target).toMatchObject({
        owner: 'content',
        kind: 'content_revision',
        completionState: 'completed',
        completedAt: expect.any(String),
      });
      expect(Object.keys(target).sort()).toEqual([
        'completedAt',
        'completionState',
        'kind',
        'owner',
        'ref',
      ]);
    }
    expect(
      (await f.pool.query('SELECT id,byte_digest FROM content.revision ORDER BY id')).rows,
    ).toEqual(originals);
    expect(
      (
        await f.pool.query(`SELECT count(*)::int AS n FROM content.revision
      WHERE availability='erased' AND serialized_bytes IS NULL AND body IS NULL`)
      ).rows,
    ).toEqual([{ n: 64 }]);
    const read = await f.get(report.erasureId);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(report);
    expect(f.scopes).toEqual([['access:manage'], ['access:manage']]);
    expect([...f.admissions.values()][0]).toMatchObject({
      scope: `erasure:${owner}`,
      action: 'erasure.request',
    });
  });
});

for (const count of [65, 256])
  test(`${count} requested IDs are refused before admission, journal or owner mutation`, async () => {
    await fixture(async (f) => {
      const owner = resource(),
        [revision] = await f.drafts(owner);
      const ids = [revision!, ...Array.from({ length: count - 1 }, () => randomUUID())];
      const response = await f.post(owner, ids);
      expect(response.status).toBe(422);
      expect(f.admissions.size).toBe(0);
      expect((await f.pool.query('SELECT count(*)::int AS n FROM relay.erasure')).rows).toEqual([
        { n: 0 },
      ]);
      expect(
        (
          await f.pool.query(
            'SELECT availability,serialized_bytes IS NOT NULL AS present FROM content.revision',
          )
        ).rows,
      ).toEqual([{ availability: 'available', present: true }]);
      expect(f.graph.commands).toHaveLength(0);
      expect(f.objects.deletes).toHaveLength(0);
    });
  });

for (const count of [64, 65])
  test(`one revision with ${count} indexed units inventories its complete bounded closure`, async () => {
    await fixture(async (f) => {
      const owner = resource(),
        ids = await f.drafts(owner);
      for (let index = 0; index < count; index++)
        f.graph.units.push({
          graph: 'urn:rezics:search:private',
          unit: `urn:rezics:preflight-unit:${index}`,
          target: `urn:rezics:content:revision:${ids[0]}`,
        });
      const response = await f.post(owner, ids);
      expect(response.status).toBe(count === 64 ? 200 : 409);
      if (count === 64) {
        expect((await response.json()).targets[0].completionState).toBe('completed');
        for (const unit of f.graph.units)
          expect(f.graph.commands[0]!.update).toContain(`<${unit.unit}>`);
      } else {
        expect(await response.json()).toEqual({
          type: 'https://rezics.com/problems/erasure_inventory_unsupported',
          code: 'erasure_inventory_unsupported',
          status: 409,
          title: 'Erasure targets cannot be completely inventoried within supported limits',
        });
        expect((await f.pool.query('SELECT count(*)::int AS n FROM relay.erasure')).rows).toEqual([
          { n: 0 },
        ]);
        expect((await f.pool.query('SELECT availability FROM content.revision')).rows).toEqual([
          { availability: 'available' },
        ]);
        expect(f.graph.commands).toHaveLength(0);
        expect(f.objects.deletes).toHaveLength(0);
        expect(
          f.graph.queries.filter((query) => query.includes('SELECT DISTINCT ?graph ?unit ?target')),
        ).toHaveLength(1);
      }
      expect(
        f.graph.queries.find((query) => query.includes('SELECT DISTINCT ?graph ?unit ?target')),
      ).toContain('LIMIT 65');
    });
  });

test('preservation POST, replay and GET expose deferred progress without the hold or case basis', async () => {
  await fixture(async (f) => {
    const owner = resource(),
      ids = await f.drafts(owner),
      key = randomUUID(),
      hold = randomUUID();
    const reason = 'Private case SAFETY-42; preserve confidential evidence';
    await f.pool.query(`INSERT INTO access.governance_preservation_hold VALUES ($1,$2,$3,NULL)`, [
      hold,
      owner,
      reason,
    ]);
    const response = await f.post(owner, ids, key);
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report).toMatchObject({
      stage: 'blocked',
      blockedReason: ERASURE_DEFERRED_REASON,
      dispositions: [],
      targets: [{ completionState: 'pending', completedAt: null }],
    });
    for (const next of [await f.post(owner, ids, key), await f.get(report.erasureId)]) {
      expect(next.status).toBe(200);
      const body = await next.text();
      expect(body).not.toContain(hold);
      expect(body).not.toContain(reason);
      expect(JSON.parse(body)).toMatchObject({
        erasureId: report.erasureId,
        blockedReason: ERASURE_DEFERRED_REASON,
        targets: report.targets,
        dispositions: [],
      });
    }
    expect(
      (await f.pool.query('SELECT reason FROM access.governance_erasure_postponement')).rows,
    ).toEqual([{ reason }]);
    expect((await f.pool.query('SELECT availability FROM content.revision')).rows).toEqual([
      { availability: 'available' },
    ]);
  });
});

test('retention bases stay in the owner journal while public report reasons stay non-sensitive', async () => {
  await fixture(async (f) => {
    const owner = resource(),
      response = await f.post(owner, await f.drafts(owner));
    expect(response.status).toBe(200);
    const report = await response.json(),
      reason = 'Private retention case SAFETY-97';
    await f.pool.query('UPDATE relay.erasure_disposition SET reason=$2 WHERE erasure_id=$1', [
      report.erasureId,
      reason,
    ]);
    await f.pool.query(
      `UPDATE relay.erasure SET destruction_status='blocked',blocked_reason=$2 WHERE id=$1`,
      [report.erasureId, reason],
    );
    const read = await f.get(report.erasureId);
    expect(read.status).toBe(200);
    const publicReport = await read.json();
    expect(JSON.stringify(publicReport)).not.toContain(reason);
    expect(publicReport.blockedReason).toBe(ERASURE_DEFERRED_REASON);
    expect(
      publicReport.dispositions.every(
        (disposition: { reason: string }) =>
          disposition.reason === 'Copy destruction requires verification',
      ),
    ).toBe(true);
    const retained = await readErasure(f.relay, report.erasureId);
    expect(retained.blockedReason).toBe(reason);
    expect(retained.dispositions.every((disposition) => disposition.reason === reason)).toBe(true);
  });
});

test('object failure reports unfinished progress, same-key recovery preserves identities, and incomplete verification is stable', async () => {
  await fixture(async (f) => {
    const owner = resource(),
      contribution = f.contribution(owner),
      key = randomUUID();
    f.objects.failure = true;
    const response = await f.post(owner, [contribution.id], key);
    expect(response.status).toBe(200);
    const pending = await response.json();
    expect(pending).toMatchObject({
      stage: 'deleting',
      suppression: 'suppressed',
      verifiedAt: null,
      targets: [{ completionState: 'completed' }, { completionState: 'failed', completedAt: null }],
    });
    const diagnostic = await readErasure(f.relay, pending.erasureId);
    expect(diagnostic.targets[1]).toMatchObject({
      completionState: 'failed',
      completionReasonCode: 'live_copy_unavailable',
    });
    expect(JSON.stringify(pending)).not.toContain('live_copy_unavailable');
    f.objects.failure = false;
    const retry = await f.post(owner, [contribution.id], key);
    expect(retry.status).toBe(200);
    const completed = await retry.json();
    expect(completed).toMatchObject({
      erasureId: pending.erasureId,
      erasureEpoch: pending.erasureEpoch,
      stage: 'reconciling',
      replayed: true,
    });
    expect(
      completed.targets.every(
        (target: { completionState: string }) => target.completionState === 'completed',
      ),
    ).toBe(true);
    expect(f.objects.data.has(`semantic/work/sha256/${contribution.payload}`)).toBe(false);
    f.objects.data.set(
      `semantic/work/sha256/${contribution.payload}`,
      Buffer.from('replanted bytes'),
    );
    f.objects.failure = true;
    const incomplete = await f.post(owner, [contribution.id], key);
    expect(incomplete.status).toBe(503);
    expect(await incomplete.json()).toEqual({
      type: 'https://rezics.com/problems/erasure_incomplete',
      status: 503,
      code: 'erasure_incomplete',
      title: 'Erasure completion could not be verified',
    });
    expect(
      (
        await f.pool.query('SELECT live_completion_pending FROM relay.erasure WHERE id=$1', [
          pending.erasureId,
        ])
      ).rows,
    ).toEqual([{ live_completion_pending: true }]);
  });
});

test('test composition supplies the existing Media factory; partial retained history refuses before mutation', async () => {
  await fixture(async (f) => {
    const store = new MediaStore(f.pool, f.core),
      actor = resource(),
      image = Buffer.from('exact private image bytes');
    const revisions: string[] = [];
    let asset: string | null = null;
    for (let index = 0; index < 2; index++) {
      const upload = await store.reserveUpload(
        {
          admissionId: randomUUID(),
          principalId: randomUUID(),
          actingSubject: actor,
          authorityEpoch: '1',
          requestDigest: hash(image),
        },
        {
          asset,
          disclosure: 'private',
          mediaType: 'image/png',
          byteLength: image.length,
          sha256: hash(image),
        },
      );
      await store.settleUpload(
        upload.upload,
        {
          status: 'activated',
          sha256: hash(image),
          byteLength: image.length,
          mediaType: 'image/png',
          width: 16,
          height: 16,
        },
        async (signal) => {
          await f.objects.namespace(`${upload.quarantineKey}/`).put(image, signal);
          return f.objects.namespace(upload.objectNamespace).put(image, signal);
        },
      );
      const revision = await store.recordAssetRevision(upload.upload);
      asset = upload.asset;
      revisions.push(revision.revision);
    }
    const owner = `https://rezics.com/id/${asset}`;
    const partial = await f.post(owner, [revisions[0]!]);
    expect(partial.status).toBe(409);
    expect((await partial.json()).code).toBe('erasure_inventory_unsupported');
    expect((await f.pool.query('SELECT count(*)::int AS n FROM relay.erasure')).rows).toEqual([
      { n: 0 },
    ]);
    expect(f.objects.deletes).toHaveLength(0);
    expect((await f.pool.query('SELECT availability FROM content.revision')).rows).toEqual([
      { availability: 'available' },
      { availability: 'available' },
    ]);
    const hold = randomUUID(),
      reason = 'Private Media preservation case SAFETY-73';
    await f.pool.query(`INSERT INTO access.governance_preservation_hold VALUES ($1,$2,$3,NULL)`, [
      hold,
      owner,
      reason,
    ]);
    const held = await f.post(owner, revisions);
    expect(held.status).toBe(409);
    expect(await held.json()).toEqual({
      type: 'https://rezics.com/problems/erasure_deferred',
      status: 409,
      code: 'erasure_deferred',
      title: ERASURE_DEFERRED_REASON,
    });
    expect((await f.pool.query('SELECT count(*)::int AS n FROM relay.erasure')).rows).toEqual([
      { n: 0 },
    ]);
    expect(f.objects.deletes).toHaveLength(0);
    expect(
      (
        await f.pool.query(
          'SELECT reason FROM access.governance_preservation_hold WHERE id=$1 AND released_at IS NULL',
          [hold],
        )
      ).rows,
    ).toEqual([{ reason }]);
    await f.pool.query(
      'UPDATE access.governance_preservation_hold SET released_at=clock_timestamp() WHERE id=$1',
      [hold],
    );
    const complete = await f.post(owner, revisions);
    expect(complete.status).toBe(200);
    const report = await complete.json();
    expect(
      report.targets.every(
        (target: { completionState: string }) => target.completionState === 'completed',
      ),
    ).toBe(true);
    expect(f.objects.data.size).toBe(0);
    expect(
      [...f.admissions.values()].every(
        (admission) =>
          admission.scope === `erasure:${owner}` && admission.action === 'erasure.request',
      ),
    ).toBe(true);
  });
});

test('denied dispatch and another requester cannot mutate or discover the erasure', async () => {
  await fixture(async (f) => {
    const owner = resource(),
      ids = await f.drafts(owner);
    f.deny();
    const response = await f.post(owner, ids);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('erasure_denied');
    expect((await f.pool.query('SELECT count(*)::int AS n FROM relay.erasure')).rows).toEqual([
      { n: 0 },
    ]);
    expect((await f.pool.query('SELECT availability FROM content.revision')).rows).toEqual([
      { availability: 'available' },
    ]);
  });
  await fixture(async (f) => {
    const owner = resource(),
      response = await f.post(owner, await f.drafts(owner));
    expect(response.status).toBe(200);
    const report = await response.json();
    f.otherReader();
    const read = await f.get(report.erasureId);
    expect(read.status).toBe(404);
    expect(await read.json()).toEqual({
      type: 'https://rezics.com/problems/erasure_unavailable',
      status: 404,
      code: 'erasure_unavailable',
      title: 'Erasure is unavailable',
    });
  });
});

test('existing erasure exposure, rate limits, bearer and idempotency requirements stay explicit', () => {
  expect(openApiOperations).toEqual({
    '/v1/erasures': {
      post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true },
    },
    '/v1/erasures/{erasureId}': {
      get: { exposure: 'public', rateLimitFamily: 'read', bearer: true },
    },
  });
});
