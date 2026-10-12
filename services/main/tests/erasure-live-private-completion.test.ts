import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import sharp from 'sharp';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentCore, migrateContent } from '../../content/src/index.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult, type SparqlResult }
  from '../src/infrastructure/fuseki.ts';
import { ObjectNotFound, ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { boundedPool } from '../src/infrastructure/pg-pool.ts';
import { AdmissionDenied, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { CONTRIBUTION_PROFILE } from '../src/modules/contribution/draft.ts';
import { applyContentErasure, ContentErasureStale, probeContentErasure } from '../src/modules/erasure/content.ts';
import { ERASURE_PREFLIGHT_LIMITS, journalErasure, readErasure,
  sha256, ErasurePreflightUnsupported, type ErasureTargetInput } from '../src/modules/erasure/journal.ts';
import { completePendingContentErasures, contentErasureDigest, ErasureDenied, ErasureService,
  requestContentErasure, type ContentErasureInput } from '../src/modules/erasure/request.ts';
import { assetIri, assetNamespace, assetVariant, MediaStore } from '../src/modules/media/store.ts';
import { MediaErasureUnsupported } from '../src/modules/media/erasure.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody, type SlimEnvelope } from '../src/modules/outbox/receipt-custody.ts';
import { GRAPHS, hash, prepareComponent, prepareWorkComponent, type WorkActivationEnvironment }
  from '../src/modules/work/activate.ts';
import { METADATA_PROFILE, metadataDigest, type MetadataEditionState } from '../src/modules/work/metadata-schema.ts';

const root = resolve(import.meta.dir, '../../..');
const resource = () => `https://rezics.com/id/${randomUUID()}`;
const uri = (value: string) => ({ type: 'uri', value });
const lit = (value: string) => ({ type: 'literal', value });
const bool = (value: boolean) => ({ ...lit(String(value)), datatype: 'http://www.w3.org/2001/XMLSchema#boolean' });
let cluster: PostgresCluster | undefined;
let admin: Pool;
let directory: string;

beforeAll(async () => {
  directory = join(root, '.temp', `erasure-private-completion-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  cluster = await startPostgresCluster();
  admin = new Pool(cluster.connection);
  await admin.query('CREATE DATABASE erasure_completion_template');
  const pool = boundedPool({ ...cluster.connection, database: 'erasure_completion_template', max: 8 });
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
        PRIMARY KEY (hold_id,operation_id,material_ref));
      CREATE TABLE access.admission (id uuid PRIMARY KEY, principal_id uuid, acting_subject text,
        scope_id text, action text, idempotency_key text, request_digest text,
        authority_epoch bigint, expires_at timestamptz)`);
    for (const file of ['1765_receipt_custody.sql', '1766_receipt_custody_delivery.sql', '1786_command_custody_erasure.sql']) {
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
  } finally { await pool.end(); }
}, 120_000);

afterAll(async () => {
  await admin?.end();
  cluster?.remove();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

class Objects {
  data = new Map<string, Uint8Array>();
  deletes: string[] = [];
  signals = new Set<AbortSignal>();
  failure = false;
  beforeDelete: (() => Promise<void>) | undefined;
  namespace = (prefix = ''): ImmutableObjects => ({
    put: async bytes => {
      const digest = hash(bytes);
      this.data.set(`${prefix}sha256/${digest}`, bytes.slice());
      return digest;
    },
    get: async digest => {
      const bytes = this.data.get(`${prefix}sha256/${digest}`);
      if (!bytes) throw new ObjectNotFound('missing exact key');
      return bytes.slice();
    },
    probe: async (digest, signal) => {
      if (signal) { this.signals.add(signal); signal.throwIfAborted(); }
      if (this.failure) throw new ObjectUnavailable('object probe outage');
      if (!this.data.has(`${prefix}sha256/${digest}`)) throw new ObjectNotFound('missing exact key');
    },
    deleteAndVerifyAbsent: async (digest, signal) => {
      if (signal) { this.signals.add(signal); signal.throwIfAborted(); }
      await this.beforeDelete?.();
      if (this.failure) throw new ObjectUnavailable('object delete outage');
      const key = `${prefix}sha256/${digest}`;
      this.deletes.push(key);
      this.data.delete(key);
    },
    listPrefix: async (selected, options) => {
      options.signal?.throwIfAborted();
      const keys = [...this.data.keys()].filter(key => key.startsWith(selected));
      if (keys.length > options.maxEntries) throw new Error('inventory overflow');
      return keys;
    },
  });
}

class Graph extends FusekiClient {
  readonly lineage = { dataEpoch: randomUUID(), routingEpoch: randomUUID() };
  readonly revisions = new Map<string, { kind: string; owner: string; manifest?: string }>();
  readonly suppressed = new Set<string>();
  readonly commands: CommandEnvelope[] = [];
  readonly queries: string[] = [];
  readonly units: { graph: string; unit: string; target: string }[] = [];
  constructor() { super('http://erasure-completion.invalid'); }
  override async commandHealth() { return { moduleVersion: 'fixture', instanceId: 'fixture',
    publicSearchWriteEpoch: 'fixture', publicSearchWriteActive: true, profiles: {
      'erasure-graph-v1': profileRegistry['erasure-graph-v1'].sha256,
    } }; }
  override async query(query: string): Promise<SparqlResult> {
    this.queries.push(query);
    if (query.includes('SELECT DISTINCT ?revision ?owner ?erased ?owned')) {
      return { results: { bindings: [] } };
    }
    if (query.includes('SELECT ?revision ?kind ?owner ?manifest ?erased')) {
      return { results: { bindings: [...this.revisions].filter(([id]) => query.includes(`<${resourceIri(id)}>`))
        .map(([id, row]) => ({ revision: uri(resourceIri(id)), kind: lit(row.kind), owner: uri(row.owner),
          ...(row.manifest ? { manifest: uri(row.manifest) } : {}), erased: bool(this.suppressed.has(resourceIri(id))) })) } };
    }
    if (query.includes('SELECT ?revision ?component ?manifest ?erased ?duplicate')) {
      return { results: { bindings: [...this.revisions].filter(([, row]) => row.manifest && query.includes(`<${row.manifest}>`))
        .map(([id, row]) => ({ revision: uri(resourceIri(id)), component: uri(row.owner), manifest: uri(row.manifest!),
          erased: bool(this.suppressed.has(resourceIri(id))), duplicate: bool(false) })) } };
    }
    if (query.includes('SELECT DISTINCT ?graph ?unit ?target')) {
      const limit = Number(/LIMIT (\d+)/.exec(query)?.[1]);
      return { results: { bindings: this.units.filter(unit => !this.suppressed.has(unit.target)).slice(0, limit)
        .map(unit => ({ graph: uri(unit.graph), unit: uri(unit.unit), target: uri(unit.target) })) } };
    }
    if (query.includes('SELECT DISTINCT ?target')) {
      const selected = /VALUES \?target \{([^}]+)\}/.exec(query)?.[1] ?? '';
      const targets = [...selected.matchAll(/<([^>]+)>/g)].map(match => match[1]!);
      return { results: { bindings: targets.filter(target => this.suppressed.has(target)).map(target => ({ target: uri(target),
        sequence: lit('5'), currentSequence: lit('5'), receiptEpoch: lit(this.lineage.dataEpoch) })) } };
    }
    throw new Error(`unexpected graph query: ${query.slice(0, 120)}`);
  }
  override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    this.commands.push(envelope);
    for (const target of envelope.validations.flatMap(validation => validation.focus)) this.suppressed.add(target);
    return { status: 'committed', position: { datasetId: 'urn:rezics:dataset:product',
      dataEpoch: this.lineage.dataEpoch, sequence: '5' } };
  }
}
const resourceIri = (id: string) => `https://rezics.com/id/${id}`;

async function fixture(run: (f: Awaited<ReturnType<typeof environment>>) => Promise<void>) {
  const name = `erasure_completion_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE erasure_completion_template`);
  const pool = boundedPool({ ...cluster!.connection, database: name, max: 8 });
  const relay = boundedPool({ ...cluster!.connection, database: name, max: 2 });
  const accessPool = boundedPool({ ...cluster!.connection, database: name, max: 2 });
  const objectDirectory = join(directory, name);
  mkdirSync(objectDirectory);
  try { await run(await environment(pool, objectDirectory, relay, accessPool)); }
  finally {
    await Promise.all([pool.end(), relay.end(), accessPool.end()]);
    await admin.query(`DROP DATABASE ${name}`);
  }
}

async function environment(pool: Pool, objectDirectory: string, relay: Pool, accessPool: Pool) {
  const graph = new Graph(), objects = new Objects(), core = new ContentCore(pool);
  const env: WorkActivationEnvironment = { fuseki: graph, lineage: graph.lineage,
    objectDirectory, workObjects: objects.namespace() };
  const service = new ErasureService(relay, pool, accessPool, objects.namespace);
  const admissions = new Map<string, RegisteredAdmission>();
  const outcomes: string[] = [];
  let denied = false;
  const access = {
    register: async (input: Omit<RegisteredAdmission, 'id' | 'principalId' | 'authorityEpoch' | 'expiresAt'
      | 'state' | 'dispatchEligible' | 'replayed'>) => {
      const previous = admissions.get(input.idempotencyKey);
      if (previous) {
        if (previous.requestDigest !== input.requestDigest) throw new AdmissionDenied('changed request');
        return { ...previous, replayed: true };
      }
      const admitted: RegisteredAdmission = { ...input, id: randomUUID(), principalId: randomUUID(), authorityEpoch: '7',
        expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'registered', dispatchEligible: true, replayed: false };
      admissions.set(input.idempotencyKey, admitted);
      await accessPool.query(`INSERT INTO access.admission VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [admitted.id,
        admitted.principalId, admitted.actingSubject, admitted.scope, admitted.action, admitted.idempotencyKey,
        admitted.requestDigest, admitted.authorityEpoch, admitted.expiresAt]);
      return admitted;
    },
    claim: async () => { if (denied) throw new AdmissionDenied('denied'); },
    recordGraphOutcome: async (id: string, proof: { outcome: string }) => {
      outcomes.push(proof.outcome);
      for (const admission of admissions.values()) if (admission.id === id) admission.state = 'sealed';
    },
    activePrincipalId: async () => null,
  };
  const account = { verify: async () => ({ issuer: 'fixture', subject: 'fixture' }) } as never;
  const call = (input: ContentErasureInput) => requestContentErasure(service, env, account, access as never,
    new Request('http://localhost/v1/erasures'), input);
  const draft = async (owner: string) => {
    const saved = await core.saveDraft({ operationId: randomUUID(), variant: { id: `urn:rezics:variant:${randomUUID()}`,
      resourceId: owner, language: { kind: 'zxx' }, direction: 'none' }, expectedHead: null,
      model: 'fixture', sourceRevision: null, provenance: {}, serializedJson: '{"secret":"private SQL bytes"}' });
    expect(saved.outcome).toBe('succeeded');
    return saved.revisionId!;
  };
  const input = (owner: string, revisionIds: string[]): ContentErasureInput => ({ actingSubject: resource(),
    resourceId: owner, revisionIds, idempotencyKey: randomUUID() });
  const contribution = (owner: string) => {
    const id = randomUUID();
    const digest = prepareComponent(objectDirectory, owner, { work: resource(), author: resource(), language: 'en',
      body: 'private authored component bytes', publication: 'draft' }, CONTRIBUTION_PROFILE);
    const manifest = JSON.parse(readFileSync(join(objectDirectory, digest), 'utf8')) as { payload: string };
    const payload = manifest.payload.slice(7);
    objects.data.set(`sha256/${payload}`, readFileSync(join(objectDirectory, payload)));
    graph.revisions.set(id, { kind: 'text_contribution_draft', owner, manifest: `urn:rezics:sha256:${digest}` });
    return { id, digest, payload };
  };
  return { pool, relay, accessPool, core, graph, objects, env, service, admissions, outcomes, access, call, draft, input, contribution,
    objectDirectory, deny: () => { denied = true; } };
}

test('P1/P4 mixed primary and derived targets retain exact intent after SQL clear and object outage; sealed replay finishes', async () => {
  await fixture(async f => {
    const owner = resource(), revision = await f.draft(owner), contribution = f.contribution(owner);
    const input = f.input(owner, [revision, contribution.id]);
    const unrelated = await f.objects.namespace().put(Buffer.from('unrelated bytes'));
    f.objects.failure = true;
    const first = await f.call(input);
    expect(first.report.stage).toBe('deleting');
    expect(first.report.suppression).toBe('suppressed');
    expect(first.report.verifiedAt).toBeNull();
    expect(first.report.targets.map(target => [target.kind, target.ref])).toEqual([
      ['content_revision', revision], ['text_contribution_draft', contribution.id], ['object', `sha256:${contribution.payload}`],
    ]);
    expect(first.report.targets.find(target => target.kind === 'object')).toMatchObject({ completionState: 'failed',
      completionReasonCode: 'live_copy_unavailable' });
    expect((await f.pool.query('SELECT availability,serialized_bytes,body FROM content.revision WHERE id=$1', [revision])).rows)
      .toEqual([{ availability: 'erased', serialized_bytes: null, body: null }]);
    expect(f.objects.data.has(`sha256/${contribution.payload}`)).toBe(true);
    expect(existsSync(join(f.objectDirectory, contribution.digest))).toBe(true);
    expect(f.graph.commands).toHaveLength(1);
    expect(f.graph.commands[0]!.validations[0]!.focus).toHaveLength(2);
    f.objects.failure = false;
    const replay = await f.call(input);
    expect(replay.replayed).toBe(true);
    expect(replay.report.erasureId).toBe(first.report.erasureId);
    expect(replay.report.erasureEpoch).toBe(first.report.erasureEpoch);
    expect(replay.report.stage).toBe('reconciling');
    expect(replay.report.targets.every(target => target.completionState === 'completed')).toBe(true);
    expect(f.objects.data.has(`sha256/${contribution.payload}`)).toBe(false);
    expect(existsSync(join(f.objectDirectory, contribution.payload))).toBe(false);
    expect(f.objects.data.has(`sha256/${unrelated}`)).toBe(true);
    expect(existsSync(join(f.objectDirectory, contribution.digest))).toBe(true);
    expect(f.objects.signals.size).toBe(2);
    const completed = replay.report.targets.map(target => target.completionEvidenceRef);
    expect((await f.call(input)).report.targets.map(target => target.completionEvidenceRef)).toEqual(completed);
  });
});

test('retained erasure retry preserves a payload newly referenced by a live Contribution revision', async () => {
  await fixture(async f => {
    const owner = resource(), contribution = f.contribution(owner);
    const input = f.input(owner, [contribution.id]);
    f.objects.failure = true;
    const first = await f.call(input);
    expect(first.report.stage).toBe('deleting');
    expect(first.report.targets.find(target => target.kind === 'object')?.completionState).toBe('failed');

    // A surviving draft edited back to the original body reuses its immutable
    // manifest and payload. Its new revision is outside the retained closure.
    const liveRevision = randomUUID();
    f.graph.revisions.set(liveRevision, { kind: 'text_contribution_draft', owner,
      manifest: `urn:rezics:sha256:${contribution.digest}` });
    writeFileSync(join(f.objectDirectory, contribution.payload),
      f.objects.data.get(`sha256/${contribution.payload}`)!);
    f.objects.failure = false;
    try { await f.call(input); }
    catch (error) { expect(error).toBeInstanceOf(ContentErasureStale); }

    expect(f.objects.data.has(`sha256/${contribution.payload}`)).toBe(true);
    expect(existsSync(join(f.objectDirectory, contribution.payload))).toBe(true);
    expect(f.objects.deletes).toEqual([]);
    const retained = await readErasure(f.relay, first.report.erasureId);
    expect(retained.erasureEpoch).toBe(first.report.erasureEpoch);
    expect(retained.targets.find(target => target.kind === 'object')?.completionState).toBe('failed');
    expect(retained.stage).toBe('deleting');
    expect(f.graph.suppressed.has(resourceIri(liveRevision))).toBe(false);
  });
});

test('P4 a preservation hold refuses sealed recovery without deleting remaining objects', async () => {
  await fixture(async f => {
    const owner = resource(), revision = await f.draft(owner), contribution = f.contribution(owner);
    const input = f.input(owner, [revision, contribution.id]);
    f.objects.failure = true;
    const first = await f.call(input);
    f.objects.failure = false;
    await f.pool.query('INSERT INTO access.governance_preservation_hold VALUES ($1,$2,$3,NULL)',
      [randomUUID(), owner, 'preserve']);
    await expect(f.call(input)).rejects.toBeInstanceOf(ContentErasureStale);
    expect(f.objects.deletes).toEqual([]);
    expect((await readErasure(f.pool, first.report.erasureId)).stage).toBe('deleting');
    expect(f.objects.data.has(`sha256/${contribution.payload}`)).toBe(true);
  });
});

test('P4 denied admission and a changed digest do not widen a retained request', async () => {
  await fixture(async f => {
    const owner = resource(), revision = await f.draft(owner);
    f.deny();
    await expect(f.call(f.input(owner, [revision]))).rejects.toBeInstanceOf(ErasureDenied);
    expect((await f.pool.query('SELECT id FROM relay.erasure')).rows).toEqual([]);
    expect(f.graph.commands).toEqual([]);
  });
  await fixture(async f => {
    const owner = resource(), revision = await f.draft(owner), other = await f.draft(owner);
    const input = f.input(owner, [revision]);
    await f.call(input);
    await expect(f.call({ ...input, revisionIds: [other] })).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await f.pool.query('SELECT availability FROM content.revision WHERE id=$1', [other])).rows[0]?.availability)
      .toBe('available');
  });
});

test('P4 a foreign Content tombstone refuses journal replay before object deletion', async () => {
  await fixture(async f => {
    const owner = resource(), revision = await f.draft(owner), input = f.input(owner, [revision]);
    const admitted = await f.access.register({ actingSubject: input.actingSubject, scope: `erasure:${owner}`,
      action: 'erasure.request', idempotencyKey: input.idempotencyKey, requestDigest: contentErasureDigest(input) });
    const payload = await f.objects.namespace().put(Buffer.from('exact pending object'));
    const entry = await journalErasure(f.pool, { operationId: `erasure:${admitted.id}`, requestDigest: admitted.requestDigest,
      kind: 'revision', principalId: admitted.principalId, admissionId: admitted.id, authorityEpoch: admitted.authorityEpoch,
      targets: [{ kind: 'content_revision', ref: revision }, { kind: 'object', ref: `sha256:${payload}` }] });
    await applyContentErasure(f.pool, { preservationAccess: f.accessPool, resourceId: owner, revisionIds: [revision],
      erasureId: randomUUID(), erasureEpoch: entry.erasureEpoch });
    admitted.state = 'sealed';
    await expect(f.call(input)).rejects.toBeInstanceOf(ContentErasureStale);
    expect(f.objects.deletes).toEqual([]);
    expect((await readErasure(f.pool, entry.erasureId)).targets.every(target => target.completionState === 'pending')).toBe(true);
  });
});

test('P4 pending recovery finishes sealing and inventory after all target flags committed', async () => {
  await fixture(async f => {
    const owner = resource(), revision = await f.draft(owner), contribution = f.contribution(owner);
    const input = f.input(owner, [revision, contribution.id]);
    const record = f.access.recordGraphOutcome;
    f.access.recordGraphOutcome = async () => { throw new Error('lost Access seal response'); };
    await expect(f.call(input)).rejects.toThrow('lost Access seal response');
    const entry = (await f.pool.query<{ id: string }>('SELECT id FROM relay.erasure')).rows[0]!;
    const interrupted = await readErasure(f.pool, entry.id);
    expect(interrupted.targets.every(target => target.completionState === 'completed')).toBe(true);
    expect(interrupted.stage).toBe('deleting');
    expect(interrupted.dispositions).toEqual([]);
    const deletes = f.objects.deletes.length;
    f.access.recordGraphOutcome = record;
    expect(await completePendingContentErasures(f.service, f.env, f.access as never))
      .toEqual({ completed: 1, failed: [], continuation: false });
    const recovered = await readErasure(f.pool, entry.id);
    expect(recovered.stage).toBe('reconciling');
    expect(recovered.erasureEpoch).toBe(interrupted.erasureEpoch);
    expect(recovered.dispositions.length).toBeGreaterThan(0);
    expect(f.outcomes).toEqual(['succeeded']);
    expect(f.objects.deletes).toHaveLength(deletes);
    expect(await completePendingContentErasures(f.service, f.env, f.access as never))
      .toEqual({ completed: 0, failed: [], continuation: false });
  });
});

test('P4 one pending tick attempts sixteen objects, includes deleting entries and reports continuation', async () => {
  await fixture(async f => {
    const owner = resource(), revision = await f.draft(owner), input = f.input(owner, [revision]);
    const admitted = await f.access.register({ actingSubject: input.actingSubject, scope: `erasure:${owner}`,
      action: 'erasure.request', idempotencyKey: input.idempotencyKey, requestDigest: contentErasureDigest(input) });
    const keys = await Promise.all(Array.from({ length: 17 }, (_, index) => f.objects.namespace().put(Buffer.from(`object ${index}`))));
    const targets: ErasureTargetInput[] = [{ kind: 'content_revision', ref: revision },
      ...keys.map(ref => ({ kind: 'object' as const, ref: `sha256:${ref}` }))];
    const entry = await journalErasure(f.pool, { operationId: `erasure:${admitted.id}`, requestDigest: admitted.requestDigest,
      kind: 'revision', principalId: admitted.principalId, admissionId: admitted.id, authorityEpoch: admitted.authorityEpoch, targets });
    const other = await f.draft(resource());
    await journalErasure(f.pool, { operationId: `erasure:${randomUUID()}`, requestDigest: sha256('next request'),
      kind: 'revision', principalId: randomUUID(), admissionId: randomUUID(), authorityEpoch: '1',
      targets: [{ kind: 'content_revision', ref: other }] });
    const first = await completePendingContentErasures(f.service, f.env, f.access as never);
    expect(first).toEqual({ completed: 0, failed: [], continuation: true });
    expect(f.objects.deletes).toHaveLength(16);
    expect((await readErasure(f.pool, entry.erasureId)).stage).toBe('deleting');
    expect((await f.pool.query('SELECT availability FROM content.revision WHERE id=$1', [other])).rows[0]?.availability)
      .toBe('available');
    const second = await completePendingContentErasures(f.service, f.env, f.access as never);
    expect(second).toEqual({ completed: 1, failed: [], continuation: true });
    expect(f.objects.deletes).toHaveLength(17);
    expect((await readErasure(f.pool, entry.erasureId)).targets.every(target => target.completionState === 'completed')).toBe(true);
  });
});

async function media(f: Awaited<ReturnType<typeof environment>>, image: Buffer, asset: string | null = null) {
  const store = new MediaStore(f.pool, f.core);
  const actor = asset ? (await f.pool.query<{ owner: string }>('SELECT owner FROM media.asset WHERE id=$1', [asset])).rows[0]!.owner : resource();
  const upload = await store.reserveUpload({ admissionId: randomUUID(), principalId: randomUUID(),
    actingSubject: actor, authorityEpoch: '1', requestDigest: hash(image) },
  { asset, disclosure: 'private', mediaType: 'image/png', byteLength: image.length, sha256: hash(image) });
  await store.settleUpload(upload.upload, { status: 'activated', sha256: hash(image), byteLength: image.length,
    mediaType: 'image/png', width: 16, height: 16 }, async signal => {
    await f.objects.namespace(`${upload.quarantineKey}/`).put(image, signal);
    return f.objects.namespace(upload.objectNamespace).put(image, signal);
  });
  const recorded = await store.recordAssetRevision(upload.upload);
  return { store, upload, revision: recorded.revision };
}

test('D3 graph and Media indexed units share one preflight ceiling; exactly 64 passes', async () => {
  for (const total of [65, 64]) await fixture(async f => {
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#bd335b' } }).png().toBuffer();
    const { upload, revision } = await media(f, image);
    // Media's representation and upload contribute the other two indexed units.
    for (let at = 0; at < total - 2; at++) f.graph.units.push({ graph: 'urn:rezics:search:private',
      unit: `urn:rezics:match-unit:${at}`, target: `urn:rezics:content:revision:${revision}` });
    const input = f.input(assetIri(upload.asset), [revision]);
    if (total > ERASURE_PREFLIGHT_LIMITS.indexedUnits) {
      await expect(f.call(input)).rejects.toThrow(MediaErasureUnsupported);
      expect((await f.pool.query('SELECT id FROM relay.erasure')).rows).toEqual([]);
      expect(f.graph.commands).toEqual([]);
      expect(f.objects.deletes).toEqual([]);
      expect((await f.pool.query('SELECT availability,serialized_bytes IS NOT NULL AS present FROM content.revision WHERE id=$1',
        [revision])).rows[0]).toEqual({ availability: 'available', present: true });
      expect(f.outcomes).toEqual(['cancelled']);
    } else {
      const result = await f.call(input);
      expect(result.report.targets.every(target => target.completionState === 'completed')).toBe(true);
      expect(f.objects.data.size).toBe(0);
      expect(f.outcomes).toEqual(['succeeded']);
    }
  });
});

test('D3 a retained mixed closure re-preflights graph and Media together before retry mutation', async () => {
  await fixture(async f => {
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#bd335b' } }).png().toBuffer();
    const { upload, revision } = await media(f, image);
    for (let at = 0; at < 62; at++) f.graph.units.push({ graph: 'urn:rezics:search:private',
      unit: `urn:rezics:retry-unit:${at}`, target: `urn:rezics:content:revision:${revision}` });
    const input = f.input(assetIri(upload.asset), [revision]);
    const command = f.graph.commandWithReceipt.bind(f.graph);
    f.graph.commandWithReceipt = async () => { throw new Error('graph suppression outage'); };
    await expect(f.call(input)).rejects.toThrow();
    const id = (await f.relay.query<{ id: string }>('SELECT id FROM relay.erasure')).rows[0]!.id;
    const retained = await readErasure(f.relay, id);
    expect(retained.targets.every(target => target.completionState === 'pending')).toBe(true);
    f.graph.commandWithReceipt = command;
    f.graph.units.push({ graph: 'urn:rezics:search:private', unit: 'urn:rezics:retry-unit:overflow',
      target: `urn:rezics:content:revision:${revision}` });
    await expect(f.call(input)).rejects.toThrow(MediaErasureUnsupported);
    expect(f.graph.commands).toEqual([]);
    expect(f.objects.deletes).toEqual([]);
    expect((await f.pool.query('SELECT availability,serialized_bytes IS NOT NULL AS present FROM content.revision WHERE id=$1',
      [revision])).rows[0]).toEqual({ availability: 'available', present: true });
    f.graph.units.pop();
    const completed = await f.call(input);
    expect(completed.report.erasureId).toBe(retained.erasureId);
    expect(completed.report.erasureEpoch).toBe(retained.erasureEpoch);
    expect(completed.report.targets.every(target => target.completionState === 'completed')).toBe(true);
  });
});

test('D3 Contribution and Media metadata share one preflight ceiling; exactly 8 MiB passes', async () => {
  for (const overflow of [1, 0]) await fixture(async f => {
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#bd335b' } }).png().toBuffer();
    const { upload, revision } = await media(f, image);
    const owner = assetIri(upload.asset), contribution = f.contribution(owner);
    const mediaBytes = (await f.pool.query<{ byte_length: number }>('SELECT byte_length FROM content.revision WHERE id=$1',
      [revision])).rows[0]!.byte_length;
    const manifest = readFileSync(join(f.env.objectDirectory, contribution.digest));
    const payload = readFileSync(join(f.env.objectDirectory, contribution.payload));
    // Valid JSON whitespace makes the actual immutable manifest read reach the boundary.
    const padded = Buffer.concat([manifest, Buffer.alloc(ERASURE_PREFLIGHT_LIMITS.metadataBytes
      - mediaBytes - payload.length - manifest.length + overflow, 32)]);
    const digest = hash(padded);
    writeFileSync(join(f.env.objectDirectory, digest), padded);
    f.graph.revisions.get(contribution.id)!.manifest = `urn:rezics:sha256:${digest}`;
    const input = f.input(owner, [revision, contribution.id]);
    if (overflow) {
      await expect(f.call(input)).rejects.toThrow(MediaErasureUnsupported);
      expect((await f.pool.query('SELECT id FROM relay.erasure')).rows).toEqual([]);
      expect(f.graph.commands).toEqual([]);
      expect(f.objects.deletes).toEqual([]);
      expect((await f.pool.query('SELECT availability,serialized_bytes IS NOT NULL AS present FROM content.revision WHERE id=$1',
        [revision])).rows[0]).toEqual({ availability: 'available', present: true });
      expect(existsSync(join(f.env.objectDirectory, contribution.payload))).toBe(true);
      expect(f.outcomes).toEqual(['cancelled']);
    } else {
      const result = await f.call(input);
      expect(result.report.targets.every(target => target.completionState === 'completed')).toBe(true);
      expect(existsSync(join(f.env.objectDirectory, contribution.payload))).toBe(false);
      expect(f.objects.data.size).toBe(0);
      expect(f.outcomes).toEqual(['succeeded']);
    }
  });
});

test('P3/P4 unfinished Media with an independently committed Content clear retries inventory, then deletes only after Media commit', async () => {
  await fixture(async f => {
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#bd335b' } }).png().toBuffer();
    const { upload, revision } = await media(f, image);
    const orphan = await f.objects.namespace(assetNamespace(upload.asset)).put(Buffer.from('orphan derivative'));
    const input = f.input(assetIri(upload.asset), [revision]);
    let fail = true;
    const failing = new Proxy(f.pool, { get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, key) {
          if (key === 'query') return (sql: string, values?: unknown[]) => {
            if (fail && sql.includes('INSERT INTO media.asset_state')) {
              fail = false;
              return Promise.reject(new Error('failure after Content clear before Media commit'));
            }
            return connection.query(sql, values);
          };
          const value = Reflect.get(connection, key);
          return typeof value === 'function' ? value.bind(connection) : value;
        } }) as PoolClient;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const service = new ErasureService(f.relay, failing, f.accessPool, f.objects.namespace);
    const call = () => requestContentErasure(service, f.env, { verify: async () => ({}) } as never,
      f.access as never, new Request('http://localhost'), input);
    await expect(call()).rejects.toThrow('failure after Content clear');
    const retained = (await f.pool.query<{ id: string }>('SELECT id FROM relay.erasure')).rows[0]!.id;
    const first = await readErasure(f.pool, retained);
    // An independently restored owner may already carry this journal's SQL clear.
    await applyContentErasure(f.pool, { erasureId: retained, erasureEpoch: first.erasureEpoch,
      resourceId: input.resourceId, revisionIds: [revision], preservationAccess: f.accessPool,
      graphProof: { receipt: `urn:rezics:receipt:erasure-graph:${hash(retained)}`,
        dataEpoch: f.graph.lineage.dataEpoch, sequence: '5' } });
    expect((await f.pool.query('SELECT body,serialized_bytes FROM content.revision WHERE id=$1', [revision])).rows[0])
      .toEqual({ body: null, serialized_bytes: null });
    expect(first.stage).toBe('requested');
    expect(first.targets.some(target => target.ref === `media-asset:v1:${upload.asset}:sha256:${orphan}`)).toBe(true);
    expect(f.objects.deletes).toEqual([]);
    f.objects.beforeDelete = async () => {
      expect((await f.pool.query(`SELECT s.lifecycle FROM media.asset a JOIN media.asset_state s ON s.id=a.state_head
        WHERE a.id=$1`, [upload.asset])).rows[0]?.lifecycle).toBe('erased');
    };
    const replay = await call();
    expect(replay.report.erasureId).toBe(first.erasureId);
    expect(replay.report.erasureEpoch).toBe(first.erasureEpoch);
    expect(replay.report.targets.some(target => target.kind === 'content_variant' && target.ref === assetVariant(upload.asset))).toBe(true);
    expect(replay.report.targets.every(target => target.completionState === 'completed')).toBe(true);
    expect(f.objects.data.size).toBe(0);
    expect(replay.report.stage).toBe('reconciling');
  });
});

test('P3 selecting only part of retained Media history refuses before journaling or clearing bytes', async () => {
  await fixture(async f => {
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#6d335b' } }).png().toBuffer();
    const first = await media(f, image);
    const second = await media(f, image, first.upload.asset);
    await expect(f.call(f.input(assetIri(first.upload.asset), [second.revision]))).rejects.toBeInstanceOf(MediaErasureUnsupported);
    expect((await f.pool.query('SELECT id FROM relay.erasure')).rows).toEqual([]);
    expect(f.graph.commands).toEqual([]);
    expect(f.objects.deletes).toEqual([]);
    expect((await f.pool.query('SELECT availability FROM content.revision WHERE id=ANY($1::uuid[])',
      [[first.revision, second.revision]])).rows.every(row => row.availability === 'available')).toBe(true);
  });
});

test('P2/P4 the existing ReceiptCustody owner clears a journaled command before object retry and preserves historical facts', async () => {
  for (const overflow of [false, true]) await fixture(async f => {
    const component = resource(), work = resource(), id = randomUUID(), revision = resourceIri(id);
    const receipt = `urn:rezics:receipt:${randomUUID()}`;
    const state: MetadataEditionState = { kind: 'edition', id: component, status: 'active',
      title: { value: 'Retained edition', language: 'en' }, contentLanguage: 'en',
      editionStatement: null, publisher: null, publicationYear: null, isbn13: null };
    const digest = metadataDigest({ work, expectedHead: null, state });
    const manifest = `urn:rezics:sha256:${await prepareWorkComponent(f.objects.namespace(), component,
      { revision, intent: { work, expectedHead: null, state } }, METADATA_PROFILE)}`;
    const entry = profileRegistry['work-metadata-details-v1'];
    const originalShape = readFileSync(join(root, 'generated/model', entry.file));
    const shape = overflow ? Buffer.concat([originalShape, Buffer.alloc(4_194_304 - originalShape.length, 32)]) : originalShape;
    const shapeDigest = await f.objects.namespace().put(shape);
    if (!overflow) expect(shapeDigest).toBe(entry.sha256);
    const validations = (['work', 'component', 'revision'] as const).map(role => ({ profile: 'work-metadata-details-v1',
      sha256: shapeDigest, shape: `${METADATA_PROFILE}/${role}-shape`,
      focus: [role === 'work' ? work : role === 'component' ? component : revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] }));
    let proof: { payload: string } | undefined;
    const custody = new ReceiptCustody(new PostgresReceiptCustodyStore(f.accessPool), f.objects.namespace(), {
      query: async () => ({ results: { bindings: proof ? [{ digest: lit(digest), payload: lit(proof.payload),
        epoch: lit(f.graph.lineage.dataEpoch), sequence: lit('4'), streamSequence: lit('4') }] : [] } }),
    }, 'a'.repeat(64), async () => undefined);
    f.env.receiptCustody = custody;
    await custody.commit({ envelope: { receipt, digest, update: 'bounded fixture metadata update', validations, deadlineMs: 10_000 },
      component, revision, manifest, routingEpoch: f.graph.lineage.routingEpoch, state,
      receipt: { outcome: 'succeeded', receipt, admissionId: randomUUID(), requestDigest: digest, authorityEpoch: '1',
        scope: `work:edit:${work}`, dataEpoch: f.graph.lineage.dataEpoch, work, component, revision, predecessor: component },
      dispatch: async envelope => {
        proof = { payload: (envelope as SlimEnvelope).slim.payloadSha256 };
        return { status: 'committed', position: { datasetId: 'urn:rezics:dataset:product',
          dataEpoch: f.graph.lineage.dataEpoch, sequence: '4' } };
      } });
    let preflightReadBytes = 0, applicationReadBytes = 0, finalMetadataBytes = 0;
    const readCommitted = custody.readCommitted.bind(custody);
    custody.readCommitted = async (selectedReceipt, budget) => {
      const before = budget?.metadataBytes ?? 0;
      const source = await readCommitted(selectedReceipt, budget);
      preflightReadBytes += (budget?.metadataBytes ?? 0) - before;
      return source;
    };
    const erasePayload = custody.erasePayloadForErasure.bind(custody);
    custody.erasePayloadForErasure = async (selectedReceipt, erasure, client, budget) => {
      expect(budget).toBeDefined();
      const before = budget!.metadataBytes;
      const result = await erasePayload(selectedReceipt, erasure, client, budget);
      applicationReadBytes += budget!.metadataBytes - before;
      finalMetadataBytes = budget!.metadataBytes;
      return result;
    };
    const original = (await f.pool.query(`SELECT receipt,revision,request_digest,payload_sha256,terminal,outbox,
      data_epoch,stream_sequence::text FROM access.command_custody WHERE receipt=$1`, [receipt])).rows[0]!;
    f.graph.revisions.set(id, { kind: 'semantic_revision', owner: component });
    const sqlRevision = await f.draft(component);
    const input = f.input(component, [id, sqlRevision]);
    if (overflow) {
      // Each bounded owner read fits alone. Reserving custody's second exact read
      // pushes the one request past 8 MiB, so even the first tombstone is refused.
      await expect(f.call(input)).rejects.toThrow(ErasurePreflightUnsupported);
      expect(preflightReadBytes).toBeGreaterThan(ERASURE_PREFLIGHT_LIMITS.metadataBytes / 2);
      expect(applicationReadBytes).toBe(0);
      expect(f.graph.commands).toEqual([]);
      expect(f.objects.deletes).toEqual([]);
      expect((await f.pool.query('SELECT id FROM relay.erasure')).rows).toEqual([]);
      expect((await f.pool.query('SELECT payload IS NOT NULL AS present FROM access.command_custody WHERE receipt=$1',
        [receipt])).rows[0]).toEqual({ present: true });
      expect((await f.pool.query('SELECT availability FROM content.revision WHERE id=$1',
        [sqlRevision])).rows[0]).toEqual({ availability: 'available' });
      return;
    }
    // HEAD still works for owner verification, but deletion fails after SQL terminalization.
    const workObjects = f.env.workObjects!;
    f.env.workObjects = { ...workObjects, deleteAndVerifyAbsent: async () => { throw new ObjectUnavailable('delete outage'); } };
    const first = await f.call(input);
    expect(preflightReadBytes).toBeGreaterThan(0);
    expect(applicationReadBytes).toBe(preflightReadBytes);
    expect(finalMetadataBytes).toBe(preflightReadBytes + applicationReadBytes);
    expect(first.report.stage).toBe('deleting');
    expect(first.report.targets.some(target => target.kind === 'object' && target.ref === `sha256:${original.payload_sha256}`)).toBe(true);
    expect(first.report.dispositions.filter(disposition => disposition.owner === 'access')
      .map(disposition => [disposition.domain, disposition.destruction]).sort()).toEqual([
      ['access:postgresql-wal:live', 'retained'], ['access:postgresql:live', 'retained'],
    ]);
    const cleared = (await f.pool.query(`SELECT receipt,revision,request_digest,payload_sha256,terminal,outbox,
      data_epoch,stream_sequence::text,payload,payload_erasure_id::text,payload_erasure_epoch::text
      FROM access.command_custody WHERE receipt=$1`, [receipt])).rows[0]!;
    expect(cleared.payload).toBeNull();
    expect(cleared.payload_erasure_id).toBe(first.report.erasureId);
    expect(cleared.payload_erasure_epoch).toBe(first.report.erasureEpoch);
    for (const key of ['receipt', 'revision', 'request_digest', 'payload_sha256', 'terminal', 'data_epoch', 'stream_sequence']) {
      expect(cleared[key]).toEqual(original[key]);
    }
    expect(cleared.outbox).toMatchObject(original.outbox);
    expect(f.objects.data.has(`sha256/${original.payload_sha256}`)).toBe(true);
    f.env.workObjects = workObjects;
    const replay = await f.call(input);
    expect(replay.report.targets.every(target => target.completionState === 'completed')).toBe(true);
    expect(f.objects.data.has(`sha256/${original.payload_sha256}`)).toBe(false);
    expect(f.objects.data.has(`sha256/${manifest.slice(-64)}`)).toBe(true);
    expect(f.objects.data.has(`sha256/${entry.sha256}`)).toBe(true);
    const client = await f.pool.connect();
    try {
      expect(await custody.readHistorical({ dataEpoch: f.graph.lineage.dataEpoch, streamSequence: '4' }, client))
        .toMatchObject({ kind: 'erased', receipt, revision, erasureId: first.report.erasureId,
          erasureEpoch: first.report.erasureEpoch, payloadSha256: original.payload_sha256 });
    } finally { client.release(); }
  });
});

test('P4 final SQL absence rejects replanted bytes with a matching erasure identity; completed objects are re-probed', async () => {
  await fixture(async f => {
    const owner = resource(), revision = await f.draft(owner), contribution = f.contribution(owner);
    const input = f.input(owner, [revision, contribution.id]);
    const first = await f.call(input);
    const tombstone = (await f.pool.query('SELECT * FROM content.revision_erasure WHERE revision_id=$1', [revision])).rows[0];
    await f.pool.query('ALTER TABLE content.revision DISABLE TRIGGER revision_immutable');
    await f.pool.query('ALTER TABLE content.revision DROP CONSTRAINT revision_check');
    try {
      await f.pool.query('UPDATE content.revision SET serialized_bytes=$2 WHERE id=$1', [revision, Buffer.from('replanted private SQL')]);
    } finally { await f.pool.query('ALTER TABLE content.revision ENABLE TRIGGER revision_immutable'); }
    expect((await probeContentErasure(f.pool, first.report.erasureId, [revision], first.report.erasureEpoch)).get(revision)).toBe('foreign');
    await expect(f.call(input)).rejects.toThrow('live SQL erasure completion is unavailable');
    expect((await f.pool.query('SELECT * FROM content.revision_erasure WHERE revision_id=$1', [revision])).rows[0]).toEqual(tombstone);
  });
  await fixture(async f => {
    const owner = resource(), contribution = f.contribution(owner), input = f.input(owner, [contribution.id]);
    const first = await f.call(input);
    const objectTarget = first.report.targets.find(target => target.kind === 'object')!;
    writeFileSync(join(f.objectDirectory, contribution.payload), 'replanted object bytes');
    f.objects.data.set(`sha256/${contribution.payload}`, Buffer.from('replanted object bytes'));
    const replay = await f.call(input);
    expect(replay.report.targets.find(target => target.kind === 'object')?.completionEvidenceRef).toBe(objectTarget.completionEvidenceRef);
    expect(existsSync(join(f.objectDirectory, contribution.payload))).toBe(false);
    expect(f.objects.data.has(`sha256/${contribution.payload}`)).toBe(false);
  });
});
