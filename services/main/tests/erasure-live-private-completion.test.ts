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
import { editTextContributionDraft, textContributionEditDigest } from '../src/modules/contribution/edit.ts';
import { applyContentErasure, ContentErasureStale, probeContentErasure } from '../src/modules/erasure/content.ts';
import { ERASURE_PREFLIGHT_LIMITS, journalErasure, readErasure, completeErasureTarget, createErasurePreflightBudget,
  sha256, ErasurePreflightUnsupported, type ErasureTargetInput } from '../src/modules/erasure/journal.ts';
import { completePendingContentErasures, contentErasureDigest, ErasureDenied, ErasureService,
  requestContentErasure, type ContentErasureInput } from '../src/modules/erasure/request.ts';
import { withReferenceFence } from '../src/modules/erasure/reference-fence.ts';
import { assetIri, assetNamespace, assetVariant, MediaStore, MediaStale } from '../src/modules/media/store.ts';
import { MediaErasureUnsupported } from '../src/modules/media/erasure.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody, type SlimEnvelope } from '../src/modules/outbox/receipt-custody.ts';
import { GRAPHS, hash, prepareComponent, prepareWorkComponent, createWorkActivationEnvironment, type WorkActivationEnvironment }
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
  beforeDelete: ((signal?: AbortSignal) => Promise<void>) | undefined;
  beforeProbe: ((signal?: AbortSignal) => Promise<void>) | undefined;
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
      await this.beforeProbe?.(signal);
      if (this.failure) throw new ObjectUnavailable('object probe outage');
      if (!this.data.has(`${prefix}sha256/${digest}`)) throw new ObjectNotFound('missing exact key');
    },
    deleteAndVerifyAbsent: async (digest, signal) => {
      if (signal) { this.signals.add(signal); signal.throwIfAborted(); }
      await this.beforeDelete?.(signal);
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
    const targets = envelope.validations.flatMap(validation => validation.focus);
    if (this.units.some(unit => targets.includes(unit.target) && !this.suppressed.has(unit.target)
      && !envelope.update.includes(`<${unit.unit}>`))) {
      return { status: 'invalid', report: { reason: 'a live indexed unit was not covered by the inventory' } };
    }
    this.commands.push(envelope);
    for (const target of envelope.validations.flatMap(validation => validation.focus)) this.suppressed.add(target);
    return { status: 'committed', position: { datasetId: 'urn:rezics:dataset:product',
      dataEpoch: this.lineage.dataEpoch, sequence: '5' } };
  }
}
const resourceIri = (id: string) => `https://rezics.com/id/${id}`;

async function fixture(run: (f: Awaited<ReturnType<typeof environment>>) => Promise<void>, connections = 2) {
  const name = `erasure_completion_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE erasure_completion_template`);
  const pool = boundedPool({ ...cluster!.connection, database: name, max: 8 });
  const relay = boundedPool({ ...cluster!.connection, database: name, max: connections });
  const accessPool = boundedPool({ ...cluster!.connection, database: name, max: connections });
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
  const env = createWorkActivationEnvironment<WorkActivationEnvironment>({ fuseki: graph, lineage: graph.lineage,
    referenceFencePool: pool, objectDirectory, workObjects: objects.namespace() });
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
  const contribution = (owner: string, body = 'private authored component bytes') => {
    const id = randomUUID();
    const digest = prepareComponent(objectDirectory, owner, { work: resource(), author: resource(), language: 'en',
      body, publication: 'draft' }, CONTRIBUTION_PROFILE);
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

test('P1 the Contribution editor holds the deletion fence while linking existing bytes', async () => {
  await fixture(async f => {
    const contribution = resource(), work = resource(), author = resource(), head = resource();
    const input = { contribution, expectedHead: head, actingSubject: author, body: 'existing body' };
    const admitted = await f.access.register({ actingSubject: author, scope: `contribution:edit:${contribution}`,
      action: 'contribution.edit', idempotencyKey: randomUUID(), requestDigest: textContributionEditDigest(input) });
    const digest = hash(Buffer.from(JSON.stringify({ format: 'rezics-component-v1', component: contribution,
      state: { work, author, language: 'en', body: input.body, publication: 'draft' } })));
    f.graph.commandHealth = async () => ({ moduleVersion: 'fixture', instanceId: 'fixture',
      publicSearchWriteEpoch: 'fixture', publicSearchWriteActive: true,
      profiles: { 'erasure-graph-v1': profileRegistry['erasure-graph-v1'].sha256,
        'text-contribution-v1': profileRegistry['text-contribution-v1'].sha256 } });
    f.graph.query = async query => query.includes('SELECT ?work ?author ?language ?head')
      ? { results: { bindings: [{ work: uri(work), author: uri(author), language: lit('en'), head: uri(head) }] } }
      : { boolean: false, results: { bindings: [] } };
    let held = false;
    f.graph.commandWithReceipt = async envelope => {
      if (envelope.validations.length) held = !(await f.relay.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('rezics-payload-reference:' || $1, 0)) AS locked", [digest])).rows[0]!.locked;
      throw new Error('uncommitted dispatch');
    };
    await expect(editTextContributionDraft(f.env, admitted, input)).rejects.toThrow();
    expect(held).toBe(true);
  });
});

test('P1 a payload reference fence holds through the owner commit and releases on failure', async () => {
  await fixture(async f => {
    const digest = hash(Buffer.from('existing payload'));
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const pause = new Promise<void>(resolve => { release = resolve; });
    const first = withReferenceFence(f.pool, digest, async () => { entered(); await pause; });
    await ready;
    const client = await f.relay.connect();
    try {
      await client.query('BEGIN');
      expect((await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('rezics-payload-reference:' || $1, 0)) AS locked", [digest])).rows[0]?.locked).toBe(false);
      await client.query('ROLLBACK');
      release();
      await first;
      await expect(withReferenceFence(f.pool, digest, async () => { throw new Error('writer refused'); })).rejects.toThrow('writer refused');
      await client.query('BEGIN');
      expect((await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('rezics-payload-reference:' || $1, 0)) AS locked", [digest])).rows[0]?.locked).toBe(true);
      await client.query('ROLLBACK');
    } finally { release(); await first; client.release(); }
  });
});

function delayed(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

for (const phase of ['delete', 'probe'] as const) test(`D3 the shared ten-second deadline includes preflight and multi-target ${phase}`, async () => {
  await fixture(async f => {
    const owner = resource(), revision = await f.draft(owner), input = f.input(owner, [revision]);
    const admitted = await f.access.register({ actingSubject: input.actingSubject, scope: `erasure:${owner}`,
      action: 'erasure.request', idempotencyKey: input.idempotencyKey, requestDigest: contentErasureDigest(input) });
    const keys = [hash(Buffer.from('first slow key')), hash(Buffer.from('second slow key'))];
    const entry = await journalErasure(f.relay, { operationId: `erasure:${admitted.id}`, requestDigest: admitted.requestDigest,
      kind: 'revision', principalId: admitted.principalId, admissionId: admitted.id, authorityEpoch: admitted.authorityEpoch,
      targets: [{ kind: 'content_revision', ref: revision }, ...keys.map(digest => ({ kind: 'object' as const, ref: `sha256:${digest}` }))] });
    if (phase === 'probe') for (let index = 0; index < keys.length; index++)
      await completeErasureTarget(f.relay, entry.erasureId, index + 2, hash(Buffer.from(keys[index]!)));
    else for (const [index, digest] of keys.entries()) f.objects.data.set(`sha256/${digest}`,
      Buffer.from(index === 0 ? 'first slow key' : 'second slow key'));
    const query = f.graph.query.bind(f.graph);
    let preflightDelayed = false;
    f.graph.query = async sql => {
      if (!preflightDelayed && sql.includes('SELECT DISTINCT ?graph ?unit ?target')) {
        preflightDelayed = true;
        await delayed(4_000);
      }
      return query(sql);
    };
    if (phase === 'delete') f.objects.beforeDelete = signal => delayed(5_000, signal);
    else f.objects.beforeProbe = signal => delayed(6_000, signal);
    const started = Date.now();
    await expect(f.call(input)).rejects.toThrow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
    expect(Date.now() - started).toBeLessThan(12_500);
    expect([...f.objects.signals].some(signal => signal.aborted)).toBe(true);
    const pending = await readErasure(f.relay, entry.erasureId);
    expect(pending.verifiedAt).toBeNull();
    expect(pending.targets.some(target => target.completionState !== 'completed')).toBe(true);
    f.objects.beforeDelete = undefined;
    f.objects.beforeProbe = undefined;
    const recovered = await f.call(input);
    expect(recovered.report.erasureId).toBe(entry.erasureId);
    expect(recovered.report.erasureEpoch).toBe(entry.erasureEpoch);
    expect(recovered.report.targets.every(target => target.completionState === 'completed')).toBe(true);
  });
}, 30_000);

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

test('completion and a concurrent publication finish with separate single-connection Access and Relay pools', async () => {
  await fixture(async f => {
    const firstOwner = resource(), secondOwner = resource();
    const contribution = f.contribution(firstOwner);
    const firstInput = f.input(firstOwner, [contribution.id]);
    const secondInput = f.input(secondOwner, [await f.draft(secondOwner)]);
    let startSecond!: () => void, enteredPublication!: () => void, resumePublication!: () => void;
    const start = new Promise<void>(resolve => { startSecond = resolve; });
    const publicationEntered = new Promise<void>(resolve => { enteredPublication = resolve; });
    const publicationResume = new Promise<void>(resolve => { resumePublication = resolve; });
    let secondHasAccess = false, publicationPaused = false, finishing = false, publicationResumed = false;
    const resume = () => { publicationResumed = true; resumePublication(); };
    const relay = new Proxy(f.relay, { get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect();
        // In the regressed order A owns Relay before B asks for its journal read.
        if (finishing && !publicationResumed) resume();
        return client;
      };
      if (property === 'query') return async (sql: string, values?: unknown[]) => {
        if (secondHasAccess && !publicationPaused && sql.includes('WHERE operation_id = $1')) {
          publicationPaused = true;
          enteredPublication();
          await publicationResume;
        }
        return target.query(sql, values);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const preservationAccess = new Proxy(f.accessPool, { get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, method) {
          if (method === 'query') return async (sql: string, values?: unknown[]) => {
            const result = await connection.query(sql, values);
            if (sql.includes('pg_advisory_xact_lock') && values?.[0] === secondOwner) secondHasAccess = true;
            return result;
          };
          const value = Reflect.get(connection, method, connection);
          return typeof value === 'function' ? value.bind(connection) : value;
        } });
      };
      if (property === 'query') return async (sql: string, values?: unknown[]) => {
        // In the safe order A waits for Access while B can still read Relay.
        if (finishing && !publicationResumed && sql.includes('FROM access.command_custody')) resume();
        return target.query(sql, values);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const service = new ErasureService(relay, f.pool, preservationAccess, f.objects.namespace);
    const account = { verify: async () => ({ issuer: 'fixture', subject: 'fixture' }) } as never;
    const call = (input: ContentErasureInput) => requestContentErasure(service, f.env, account, f.access as never,
      new Request('http://localhost/v1/erasures'), input);
    const record = f.access.recordGraphOutcome;
    f.access.recordGraphOutcome = async (id, terminal) => {
      if (!finishing) {
        startSecond();
        await publicationEntered;
        finishing = true;
      }
      return record(id, terminal);
    };
    const first = call(firstInput), second = start.then(() => call(secondInput));
    try {
      const outcomes = await Promise.allSettled([first, second]);
      expect(publicationPaused).toBe(true);
      expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') expect(outcome.value.report.stage).toBe('reconciling');
      }
      expect((await f.pool.query('SELECT live_completion_pending FROM relay.erasure ORDER BY erasure_epoch')).rows)
        .toEqual([{ live_completion_pending: false }, { live_completion_pending: false }]);
    } finally { startSecond(); resume(); }
  }, 1);
}, 20_000);

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

test('a stale seal callback cannot clear a newer failed live-completion attempt', async () => {
  await fixture(async f => {
    const owner = resource(), revision = await f.draft(owner), contribution = f.contribution(owner);
    const input = f.input(owner, [revision, contribution.id]);
    const initial = await f.call(input);
    let entered!: () => void, release!: () => void;
    const sealing = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const record = f.access.recordGraphOutcome;
    let calls = 0;
    f.access.recordGraphOutcome = async (id, terminal) => {
      if (++calls === 1) { entered(); await resume; }
      return record(id, terminal);
    };
    const firstReplay = f.call(input);
    await sealing;
    f.objects.data.set(`sha256/${contribution.payload}`, Buffer.from('replanted exact key'));
    f.objects.beforeDelete = async () => { throw new ObjectUnavailable('repair outage'); };
    try {
      await expect(f.call(input)).rejects.toThrow('completed object erasure differs from live storage');
    } finally { release(); }
    await firstReplay;
    expect((await f.pool.query('SELECT live_completion_pending FROM relay.erasure WHERE id=$1',
      [initial.report.erasureId])).rows).toEqual([{ live_completion_pending: true }]);
    f.objects.beforeDelete = undefined;
    expect(await completePendingContentErasures(f.service, f.env, f.access as never))
      .toEqual({ completed: 1, failed: [], continuation: false });
    expect(f.objects.data.has(`sha256/${contribution.payload}`)).toBe(false);
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
    const unrelated = await journalErasure(f.pool, { operationId: `erasure:${randomUUID()}`, requestDigest: sha256('next request'),
      kind: 'revision', principalId: randomUUID(), admissionId: randomUUID(), authorityEpoch: '1',
      targets: [{ kind: 'content_revision', ref: other }] });
    const first = await completePendingContentErasures(f.service, f.env, f.access as never);
    expect(first).toEqual({ completed: 0, failed: [], continuation: true });
    expect(f.objects.deletes).toHaveLength(16);
    expect((await readErasure(f.pool, entry.erasureId)).stage).toBe('deleting');
    expect((await f.pool.query('SELECT availability FROM content.revision WHERE id=$1', [other])).rows[0]?.availability)
      .toBe('available');
    const second = await completePendingContentErasures(f.service, f.env, f.access as never);
    expect(second).toEqual({ completed: 0, failed: [unrelated.erasureId], continuation: true });
    expect(f.objects.deletes).toHaveLength(16);
    const third = await completePendingContentErasures(f.service, f.env, f.access as never);
    expect(third).toEqual({ completed: 1, failed: [], continuation: true });
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

test('pending selection skips completed history and rotates a held oldest entry behind recoverable work', async () => {
  await fixture(async f => {
    for (let index = 0; index < 12; index++) {
      const owner = resource(), revision = await f.draft(owner);
      await f.call(f.input(owner, [revision]));
    }
    const heldOwner = resource(), heldRevision = await f.draft(heldOwner), heldPayload = f.contribution(heldOwner);
    f.objects.failure = true;
    const held = await f.call(f.input(heldOwner, [heldRevision, heldPayload.id]));
    f.objects.failure = false;
    await f.accessPool.query('INSERT INTO access.governance_preservation_hold VALUES ($1,$2,$3,NULL)',
      [randomUUID(), heldOwner, 'hold after partial deletion']);
    const nextOwner = resource(), nextRevision = await f.draft(nextOwner), input = f.input(nextOwner, [nextRevision]);
    const admitted = await f.access.register({ actingSubject: input.actingSubject, scope: `erasure:${nextOwner}`,
      action: 'erasure.request', idempotencyKey: input.idempotencyKey, requestDigest: contentErasureDigest(input) });
    const next = await journalErasure(f.relay, { operationId: `erasure:${admitted.id}`, requestDigest: admitted.requestDigest,
      kind: 'revision', principalId: admitted.principalId, admissionId: admitted.id, authorityEpoch: admitted.authorityEpoch,
      targets: [{ kind: 'content_revision', ref: nextRevision }] });
    expect(await completePendingContentErasures(f.service, f.env, f.access as never))
      .toEqual({ completed: 0, failed: [held.report.erasureId], continuation: true });
    expect(await completePendingContentErasures(f.service, f.env, f.access as never))
      .toEqual({ completed: 1, failed: [], continuation: true });
    expect((await readErasure(f.relay, next.erasureId)).targets.every(target => target.completionState === 'completed')).toBe(true);
    const client = await f.relay.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan=off');
      const plan = await client.query(`EXPLAIN (FORMAT JSON) SELECT id FROM relay.erasure
        WHERE live_completion_pending AND kind='revision'
          AND stage IN ('requested','fenced','inventory_complete','deleting','reconciling')
        ORDER BY last_completion_attempt NULLS FIRST,erasure_epoch LIMIT 2`);
      expect(JSON.stringify(plan.rows)).toContain('erasure_live_completion_pending');
      expect((await client.query("SELECT count(*)::integer AS count FROM relay.erasure WHERE NOT live_completion_pending")).rows[0]?.count).toBe(13);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });
});

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

test('D3 graph growth after mixed preflight refuses before any owner mutation', async () => {
  await fixture(async f => {
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#bd335b' } }).png().toBuffer();
    const { upload, revision } = await media(f, image);
    for (let at = 0; at < 62; at++) f.graph.units.push({ graph: 'urn:rezics:search:private',
      unit: `urn:rezics:preflight-unit:${at}`, target: `urn:rezics:content:revision:${revision}` });
    const health = f.graph.commandHealth.bind(f.graph);
    f.graph.commandHealth = async () => {
      f.graph.units.push({ graph: 'urn:rezics:search:private', unit: 'urn:rezics:preflight-unit:late',
        target: `urn:rezics:content:revision:${revision}` });
      return health();
    };
    await expect(f.call(f.input(assetIri(upload.asset), [revision]))).rejects.toThrow();
    expect(f.graph.commands).toEqual([]);
    expect(f.objects.deletes).toEqual([]);
    expect((await f.pool.query('SELECT availability FROM content.revision WHERE id=$1', [revision])).rows[0]?.availability).toBe('available');
    expect((await f.pool.query(`SELECT s.lifecycle FROM media.asset a JOIN media.asset_state s ON s.id=a.state_head WHERE a.id=$1`,
      [upload.asset])).rows[0]?.lifecycle).toBe('active');
  });
});

test('D3 completed absent object targets are probed once within the 512 probe ceiling', async () => {
  await fixture(async f => {
    const owner = resource(), revision = await f.draft(owner), input = f.input(owner, [revision]);
    const admitted = await f.access.register({ actingSubject: input.actingSubject, scope: `erasure:${owner}`,
      action: 'erasure.request', idempotencyKey: input.idempotencyKey, requestDigest: contentErasureDigest(input) });
    const keys = Array.from({ length: 255 }, (_, index) => hash(Buffer.from(`absent object ${index}`)));
    const entry = await journalErasure(f.relay, { operationId: `erasure:${admitted.id}`, requestDigest: admitted.requestDigest,
      kind: 'revision', principalId: admitted.principalId, admissionId: admitted.id, authorityEpoch: admitted.authorityEpoch,
      targets: [{ kind: 'content_revision', ref: revision }, ...keys.map(digest => ({ kind: 'object' as const, ref: `sha256:${digest}` }))] });
    for (let index = 0; index < keys.length; index++) await completeErasureTarget(f.relay, entry.erasureId, index + 2, hash(Buffer.from(keys[index]!)));
    let probes = 0;
    const objects = f.env.workObjects!, probe = objects.probe!;
    f.env.workObjects = { ...objects, probe: async (...args) => { probes++; await probe(...args); } };
    const completed = await f.call(input);
    expect(probes).toBe(255);
    expect(f.objects.deletes).toEqual([]);
    expect(completed.report.targets.every(target => target.completionState === 'completed')).toBe(true);
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
      expect((await f.relay.query(`SELECT s.lifecycle FROM media.asset a JOIN media.asset_state s ON s.id=a.state_head
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
    const source = (await custody.readCommitted(receipt))!;
    const held = await f.accessPool.connect();
    let redundantPayloadBytes = 0;
    const observed = new Proxy(held, { get(client, method) {
      if (method === 'query') return async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        for (const row of result.rows) if (row.payload instanceof Uint8Array) redundantPayloadBytes += row.payload.byteLength;
        return result;
      };
      const value = Reflect.get(client, method, client);
      return typeof value === 'function' ? value.bind(client) : value;
    } }) as PoolClient;
    try { await new PostgresReceiptCustodyStore(f.accessPool).withReceipt(receipt,
      session => session.persistObjectReferences!(source.objectReferences), observed); }
    finally { held.release(); }
    expect(redundantPayloadBytes).toBe(0);
    const exhausted = createErasurePreflightBudget();
    exhausted.metadataBytes = ERASURE_PREFLIGHT_LIMITS.metadataBytes;
    await expect(custody.readCommitted(receipt, exhausted)).rejects.toBeInstanceOf(ErasurePreflightUnsupported);
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

test('D3 preflight reserves reverse-reference refresh before suppression', async () => {
  for (const count of [32, 64]) await fixture(async f => {
    const owner = resource(), selected: string[] = [];
    for (let index = 0; index < count; index++) {
      const contribution = f.contribution(owner, `distinct private body ${index}`);
      selected.push(contribution.id);
      for (let other = 0; other < 3; other++) {
        const id = randomUUID();
        f.graph.revisions.set(id, { kind: 'text_contribution_draft', owner,
          manifest: `urn:rezics:sha256:${contribution.digest}` });
        f.graph.suppressed.add(resourceIri(id));
      }
    }
    if (count === 64) {
      await expect(f.call(f.input(owner, selected))).rejects.toBeInstanceOf(ErasurePreflightUnsupported);
      expect(f.graph.commands).toEqual([]);
      expect((await f.relay.query('SELECT id FROM relay.erasure')).rows).toEqual([]);
      expect(f.objects.deletes).toEqual([]);
    } else {
      const result = await f.call(f.input(owner, selected));
      expect(result.report.suppression).toBe('suppressed');
      expect(result.report.targets.filter(target => target.kind === 'object'
        && target.completionState === 'completed')).toHaveLength(16);
    }
  });
});

test('D3 a maximal completed closure reserves a repair share for one replanted remote key', async () => {
  await fixture(async f => {
    const owner = resource(), revision = await f.draft(owner), input = f.input(owner, [revision]);
    const admitted = await f.access.register({ actingSubject: owner, scope: `erasure:${owner}`,
      action: 'erasure.request', idempotencyKey: input.idempotencyKey, requestDigest: contentErasureDigest(input) });
    const keys = Array.from({ length: 255 }, (_, index) => hash(Buffer.from(`completed object ${index}`)));
    const entry = await journalErasure(f.relay, { operationId: `erasure:${admitted.id}`, requestDigest: admitted.requestDigest,
      kind: 'revision', principalId: admitted.principalId, admissionId: admitted.id, authorityEpoch: admitted.authorityEpoch,
      targets: [{ kind: 'content_revision', ref: revision }, ...keys.map(digest => ({ kind: 'object' as const, ref: `sha256:${digest}` }))] });
    for (let index = 0; index < keys.length; index++) await completeErasureTarget(f.relay, entry.erasureId,
      index + 2, hash(Buffer.from(keys[index]!)));
    f.objects.data.set(`sha256/${keys[254]}`, Buffer.from('replanted last key'));
    const result = await f.call(input);
    expect(result.report.stage).toBe('reconciling');
    expect(f.objects.deletes).toEqual([`sha256/${keys[254]}`]);
    expect(f.objects.data.size).toBe(0);
    expect((await f.relay.query('SELECT live_completion_pending FROM relay.erasure WHERE id=$1',
      [entry.erasureId])).rows).toEqual([{ live_completion_pending: false }]);
  });
});

test('D3 suppression receives only the remaining shared deadline', async () => {
  await fixture(async f => {
    const owner = resource(), revision = await f.draft(owner);
    const query = f.graph.query.bind(f.graph), command = f.graph.commandWithReceipt.bind(f.graph);
    f.graph.query = async sql => {
      if (sql.includes('SELECT DISTINCT ?graph ?unit ?target')) await new Promise(resolve => setTimeout(resolve, 8_000));
      return query(sql);
    };
    const deadlines: number[] = [];
    f.graph.commandWithReceipt = async envelope => {
      deadlines.push(envelope.deadlineMs!);
      await new Promise(resolve => setTimeout(resolve, Math.min(envelope.deadlineMs!, 6_000)));
      if (envelope.deadlineMs! < 6_000) return { status: 'deadline' };
      return command(envelope);
    };
    await expect(f.call(f.input(owner, [revision]))).rejects.toThrow();
    expect(deadlines.length).toBeGreaterThan(0);
    expect(deadlines.every(deadline => deadline <= 2_000)).toBe(true);
    expect(f.graph.commands).toEqual([]);
    expect((await f.pool.query('SELECT availability FROM content.revision WHERE id=$1', [revision])).rows)
      .toEqual([{ availability: 'available' }]);
  });
}, 30_000);


function referenceFenceObserver(pool: Pool, digest: string, attempted: () => void): Pool {
  return new Proxy(pool, { get(target, property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, method) {
        if (method === 'query') return async (sql: string, values?: unknown[]) => {
          if (sql.includes('rezics-payload-reference:') && values?.[0] === digest) attempted();
          return connection.query(sql, values);
        };
        const value = Reflect.get(connection, method, connection);
        return typeof value === 'function' ? value.bind(connection) : value;
      } }) as PoolClient;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Pool;
}

for (const kind of ['original', 'revision', 'rendition'] as const) for (const stale of [false, true])
  test(`Media ${kind} writer ${stale ? 'refuses a changed owner after' : 'waits through'} the held deletion fence`, async () => {
  await fixture(async f => {
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#429fde' } }).png().toBuffer();
    const initial = await media(f, image), { store, upload } = initial;
    const actor = (await f.pool.query<{ owner: string }>('SELECT owner FROM media.asset WHERE id=$1', [upload.asset])).rows[0]!.owner;
    const reservation = kind === 'rendition' ? null : await store.reserveUpload({ admissionId: randomUUID(),
      principalId: randomUUID(), actingSubject: actor, authorityEpoch: '1', requestDigest: sha256(randomUUID()) },
    { asset: upload.asset, disclosure: 'private', mediaType: 'image/png', byteLength: image.length, sha256: hash(image) });
    const verdict = { status: 'activated' as const, sha256: hash(image), byteLength: image.length,
      mediaType: 'image/png' as const, width: 16, height: 16 };
    if (kind === 'revision') await store.settleUpload(reservation!.upload, verdict,
      signal => f.objects.namespace(reservation!.objectNamespace).put(image, signal));
    let lease: Awaited<ReturnType<typeof store.renditions.leaseNext>> = null;
    const output = { bytes: Buffer.from('exact derived bytes'), type: 'image/webp' as 'image/webp' | 'image/avif', width: 16, height: 16 };
    if (kind === 'rendition') {
      const target = resource();
      const selection = await store.selectAvatar({ admissionId: randomUUID(), principalId: randomUUID(),
        actingSubject: actor, authorityEpoch: '1', requestDigest: sha256(randomUUID()) },
      { target, context: 'urn:rezics:media:context:default', expectedSelection: null, asset: upload.asset, crop: null });
      const use = (await f.pool.query<{ use_id: string }>('SELECT use_id FROM media.selection_revision WHERE id=$1', [selection.id])).rows[0]!.use_id;
      await store.renditions.queue(await store.renditions.requestBasis(use), { width: 16, height: 16 });
      lease = await store.renditions.leaseNext();
      expect(lease).not.toBeNull();
      output.type = lease!.profile.includes('-avif-') ? 'image/avif' : 'image/webp';
    }
    const digest = kind === 'rendition' ? hash(output.bytes) : hash(image);
    let entered!: () => void, release!: () => void, attempted!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const pause = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { attempted = resolve; });
    const holder = withReferenceFence(f.relay, digest, async () => { entered(); await pause; });
    await ready;
    const before = (await f.pool.query('SELECT id,byte_digest FROM media.representation WHERE asset_id=$1 ORDER BY id', [upload.asset])).rows;
    const observed = referenceFenceObserver(f.pool, digest, attempted);
    const writerStore = new MediaStore(observed, new ContentCore(observed));
    let persisted = false;
    const write = kind === 'original' ? writerStore.settleUpload(reservation!.upload, verdict, async signal => {
      persisted = true; return f.objects.namespace(reservation!.objectNamespace).put(image, signal);
    }) : kind === 'revision' ? writerStore.recordAssetRevision(reservation!.upload)
      : writerStore.renditions.settle(lease!, output, async signal => {
        persisted = true; return f.objects.namespace(upload.objectNamespace).put(output.bytes, signal);
      });
    try {
      expect(await Promise.race([waiting.then(() => 'waiting'), write.then(() => 'finished')])).toBe('waiting');
      expect(persisted).toBe(false);
      expect((await f.accessPool.query('SELECT id,byte_digest FROM media.representation WHERE asset_id=$1 ORDER BY id', [upload.asset])).rows).toEqual(before);
      expect((await f.accessPool.query('SELECT draft_head FROM content.variant WHERE id=$1', [assetVariant(upload.asset)])).rows)
        .toEqual([{ draft_head: initial.revision }]);
      const stateStore = new MediaStore(f.accessPool, new ContentCore(f.accessPool));
      if (stale) await stateStore.changeState({ admissionId: randomUUID(), principalId: randomUUID(),
        actingSubject: actor, authorityEpoch: '1', requestDigest: sha256(randomUUID()) },
      { asset: upload.asset, expectedState: (await stateStore.readAsset(upload.asset))!.state,
        disclosure: 'private', lifecycle: 'deleted' });
    } finally { release(); await holder; }
    if (stale) {
      if (kind === 'rendition') expect(await write).toBe(false);
      else await expect(write).rejects.toBeInstanceOf(MediaStale);
      expect(persisted).toBe(false);
      expect((await f.accessPool.query('SELECT id,byte_digest FROM media.representation WHERE asset_id=$1 ORDER BY id', [upload.asset])).rows).toEqual(before);
      return;
    }
    const result = await write;
    if (kind === 'rendition') expect(result).toBe(true);
    else if (kind === 'original') expect(result).toMatchObject({ status: 'activated' });
    else expect(result).toMatchObject({ revision: expect.any(String) });
    expect((await f.pool.query('SELECT 1 FROM media.representation WHERE asset_id=$1 AND byte_digest=$2', [upload.asset, digest])).rowCount).toBeGreaterThan(0);
  });
});

test('erasure holds the digest fence while a cooperating Content writer waits for its transaction', async () => {
  await fixture(async f => {
    const owner = resource(), contribution = f.contribution(owner);
    const payload = readFileSync(join(f.objectDirectory, contribution.payload), 'utf8');
    let attempted!: () => void;
    const waiting = new Promise<void>(resolve => { attempted = resolve; });
    let writer: Promise<unknown> | undefined, linked = false;
    const writerPool = boundedPool({ ...cluster!.connection, database: f.pool.options.database, max: 2 });
    const observed = referenceFenceObserver(writerPool, contribution.payload, attempted);
    f.objects.beforeDelete = async () => {
      expect((await writerPool.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('rezics-payload-reference:' || $1,0)) AS locked",
        [contribution.payload])).rows[0]?.locked).toBe(false);
      writer = new ContentCore(observed).saveDraft({ operationId: randomUUID(),
        variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: resource(),
          language: { kind: 'zxx' }, direction: 'none' }, expectedHead: null,
        model: 'fixture', sourceRevision: null, provenance: {}, serializedJson: payload },
      client => withReferenceFence(client, contribution.payload, async () => { linked = true; }));
      await waiting;
      expect(linked).toBe(false);
    };
    try {
      const erased = await f.call(f.input(owner, [contribution.id]));
      await writer;
      expect(linked).toBe(true);
      expect((await f.pool.query('SELECT 1 FROM content.revision WHERE byte_digest=$1 AND availability=\'available\'',
        [contribution.payload])).rowCount).toBe(1);
      expect(erased.report.stage).toBe('reconciling');
    } finally { await writer?.catch(() => undefined); await writerPool.end(); }
  });
});


test('a writer environment refuses an unavailable reference fence at construction', async () => {
  await fixture(async f => {
    expect(createWorkActivationEnvironment(f.env).referenceFencePool).toBe(f.pool);
    expect(() => createWorkActivationEnvironment({ ...f.env, referenceFencePool: undefined }))
      .toThrow('reference fence pool is required when constructing a writer environment');
    expect(() => createWorkActivationEnvironment({ ...f.env, referenceFencePool: {} as Pool }))
      .toThrow('reference fence pool is required when constructing a writer environment');
    expect(f.graph.commands).toEqual([]);
  });
});


test('a borrowed reference fence remains held until its writer transaction commits', async () => {
  await fixture(async f => {
    const client = await f.pool.connect(), digest = sha256('borrowed existing bytes');
    try {
      await client.query('BEGIN');
      await withReferenceFence(client, digest, async borrowed => { expect(borrowed).toBe(client); });
      const lock = () => f.relay.query<{ held: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('rezics-payload-reference:' || $1,0)) AS held", [digest]);
      expect((await lock()).rows[0]?.held).toBe(false);
      await client.query('COMMIT');
      expect((await lock()).rows[0]?.held).toBe(true);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});


test('Media erasure removes its quarantine copy when another asset retains identical image bytes', async () => {
  await fixture(async f => {
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#682b9e' } }).png().toBuffer();
    const erased = await media(f, image), retained = await media(f, image);
    const result = await f.call(f.input(assetIri(erased.upload.asset), [erased.revision]));
    expect(result.report.stage).toBe('reconciling');
    expect(result.report.targets.every(target => target.completionState === 'completed')).toBe(true);
    expect(f.objects.data.has(`${erased.upload.quarantineKey}/sha256/${hash(image)}`)).toBe(false);
    expect(f.objects.data.has(`${erased.upload.objectNamespace}sha256/${hash(image)}`)).toBe(false);
    expect(f.objects.data.has(`${retained.upload.quarantineKey}/sha256/${hash(image)}`)).toBe(true);
    expect(f.objects.data.has(`${retained.upload.objectNamespace}sha256/${hash(image)}`)).toBe(true);
    expect((await f.core.readExactBatch([retained.revision], async ids => new Set(ids)))[0]?.status).toBe('available');
    expect((await retained.store.readAsset(retained.upload.asset))?.lifecycle).toBe('active');
  });
});
