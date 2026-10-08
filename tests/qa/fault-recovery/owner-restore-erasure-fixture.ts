import { expect } from 'bun:test';
import { Elysia } from 'elysia';
import { decodeJwt } from 'jose';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  ObjectIntegrityError,
  ObjectUnavailable,
  type ImmutableObjects,
} from '../../../services/main/src/infrastructure/immutable-objects.ts';
import {
  AccessAdmissionRegistry,
  engageAccessRecoveryFence,
} from '../../../services/main/src/modules/access/admission.ts';
import { AccessDownloadLeases } from '../../../services/main/src/modules/access/download-leases.ts';
import { ContentSearchReadAccess } from '../../../services/main/src/modules/search-disclosure/content-read-lease.ts';
import { applyContentErasure } from '../../../services/main/src/modules/erasure/content.ts';
import {
  heldErasureMaintenanceClient,
  readGraphErasureProof,
  suppressGraphContentRevisions,
} from '../../../services/main/src/modules/erasure/graph.ts';
import {
  ensureRetentionDomain,
  journalErasure,
  markErasureSuppressed,
  recordErasureInventory,
} from '../../../services/main/src/modules/erasure/journal.ts';
import { retainErasureCoverage } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { proofRetirementSender } from '../../../services/main/src/modules/graph/slim-command.ts';
import {
  PostgresReceiptCustodyStore,
  ReceiptCustody,
} from '../../../services/main/src/modules/outbox/receipt-custody.ts';
import type { PreparedCommand } from '../../../services/main/src/modules/outbox/receipt-custody.ts';
import {
  initializeRelayCheckpoint,
  relayMainOutboxOnce,
} from '../../../services/main/src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import {
  OwnerOperations,
  type RestoreResources,
} from '../../../services/main/src/modules/owner/operations.ts';
import { ensureModelGeneration } from '../../../services/main/src/modules/semantic/command.ts';
import {
  DATASET,
  GRAPHS,
  RV,
  hash,
  initializeFreshGraph,
  type WorkActivationEnvironment,
} from '../../../services/main/src/modules/work/activate.ts';
import {
  commitMetadata,
  readMetadataReceipt,
} from '../../../services/main/src/modules/work/metadata-command.ts';
import {
  checkedMetadataState,
  metadataDigest,
  type MetadataIntent,
} from '../../../services/main/src/modules/work/metadata-schema.ts';
import {
  captureGraphRecoveryCoverage,
  cutoverRestoredGraphLineage,
  RestoreLineageConflict,
  type RecoveryCoverage,
} from '../../../services/main/src/modules/work/restore-lineage.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import {
  accessOutboxCoverage,
  accessStateCoverage,
} from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import {
  finishOperatorRestore,
  type OperatorRestoreReleaseContext,
  type RestoreChecks,
} from '../../../scripts/ops/restore.ts';
import { RecoveryBudget } from '../../../scripts/ops/recovery-set.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { healthRoutes } from '../../../services/main/src/routes/health.ts';
import { ownerRoutes } from '../../../services/main/src/routes/owners.ts';
import { ratingAccount } from '../../../tests/qa/support/rating-account.ts';
import { createAdmittedMetadataWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { cloneQaOwnerDatabases } from '../../../tests/qa/support/fake-delivery.ts';
import { copyRecoveryTree } from '../../../tests/qa/support/recovery-copy.ts';
import { seedContent } from '../../../tests/qa/load/corpus.ts';
import {
  freePort,
  fusekiSecrets,
  pinnedImage,
  qaStack,
  requireFaultTier,
  standaloneFuseki,
} from '../../../tests/qa/fault-recovery/search-ops-support.ts';

export const restoreKey = 'e6'.repeat(32);

class DirectoryObjects implements ImmutableObjects {
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }
  async put(bytes: Uint8Array): Promise<string> {
    const digest = hash(bytes);
    writeFileSync(join(this.directory, digest), bytes);
    return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(this.directory, digest));
    } catch {
      throw new ObjectUnavailable('retained fixture object is missing');
    }
    if (hash(bytes) !== digest)
      throw new ObjectIntegrityError('retained fixture object is corrupt');
    return bytes;
  }
}

/** One real owner/native cut, one physical backup, isolated writable replay copies. */
export async function ownerRestoreErasureFixture() {
  const preparationStarted = Date.now();
  const { runId } = requireFaultTier();
  const root = resolve(import.meta.dir, '../../..');
  const qa = qaStack(runId);
  const image = pinnedImage();
  const apps = readEnv(join(qa.directory, 'apps.env'));
  const databases = await cloneQaOwnerDatabases(runId, ['account', 'access', 'content', 'relay']);
  const suffix = randomBytes(6).toString('hex');
  const directory = join(root, '.temp', `owner-erasure-restore-${suffix}`);
  const socketDirectory = join(root, '.temp', 's');
  const backupObjects = join(directory, 'objects-cut');
  const pgBackup = join(directory, 'postgres-cut');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const pools = new Set<Pool>();
  const pool = (url: string) => {
    const value = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2_000 });
    pools.add(value);
    return value;
  };
  const closePool = async (value: Pool) => {
    await value.end();
    pools.delete(value);
  };
  const source = {
    account: pool(databases.urls.account),
    access: pool(databases.urls.access),
    content: pool(databases.urls.content),
    relay: pool(databases.urls.relay),
  };
  const volumes: string[] = [],
    copies: string[] = [],
    pgCopies: string[] = [];
  const containers: Awaited<ReturnType<typeof standaloneFuseki>>[] = [];
  const docker = (args: string[], timeout = 60_000) => {
    const result = spawnSync('docker', args, { env: qa.dockerEnv, encoding: 'utf8', timeout });
    if (result.status !== 0 || result.error)
      throw new Error(`isolated recovery Docker step failed: ${result.stderr.slice(-1500)}`);
    return result.stdout.trim();
  };
  const volume = (label: string) => {
    const name = `rezics-owner-erasure-${suffix}-${label}`;
    docker(['volume', 'create', name]);
    volumes.push(name);
    return name;
  };
  const copyGraph = (from: string, to: string) =>
    docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '0:0',
      '--volume',
      `${from}:/from:ro`,
      '--volume',
      `${to}:/to`,
      '--entrypoint',
      'sh',
      image,
      '-ec',
      'cp -a /from/rezics /to/rezics',
    ]);
  const admin = async (sql: string) => {
    const client = new Client({
      connectionString: `postgres://postgres:${encodeURIComponent(qa.composeEnv.POSTGRES_PASSWORD!)}@127.0.0.1:${qa.composeEnv.POSTGRES_PORT}/postgres`,
    });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  const objects = new DirectoryObjects(join(directory, 'objects-live'));
  let authenticated: Awaited<ReturnType<typeof ratingAccount>> | undefined;
  const close = async () => {
    await authenticated?.close();
    for (const container of containers) container.remove();
    await Promise.allSettled([...pools].map((value) => value.end()));
    for (const data of pgCopies) {
      if (spawnSync('pg_ctl', ['-D', data, 'status'], { timeout: 5_000 }).status === 0) {
        execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-t', '10', '-w', 'stop'], {
          timeout: 15_000,
        });
      }
    }
    for (const name of copies.reverse())
      await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await databases.close();
    for (const name of volumes) docker(['volume', 'rm', '-f', name], 30_000);
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    await migrateContent(source.content);
    expect(
      (await source.content.query("SELECT to_regclass('content.receipt') IS NOT NULL AS present"))
        .rows,
    ).toEqual([{ present: true }]);
    const liveVolume = volume('live'),
      cutVolume = volume('cut');
    const live = await standaloneFuseki(qa.dockerEnv, {
      name: `rezics-owner-erasure-${suffix}-live`,
      image: image,
      volume: liveVolume,
      secrets: fusekiSecrets(qa.composeEnv),
    });
    containers.push(live);
    const native = new FusekiClient(
      live.url,
      qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN,
      qa.composeEnv.FUSEKI_COMMAND_TOKEN,
    );
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
    await initializeFreshGraph(native, lineage);
    authenticated = await ratingAccount(
      { ...apps, ACCOUNT_DATABASE_URL: databases.urls.account },
      'openid work:create work:edit work:read owner:operate',
    );
    const refreshTime = (token: string) => {
      const { exp } = decodeJwt(token);
      if (!Number.isSafeInteger(exp)) throw new Error('actual OAuth token expiry is unavailable');
      return exp! * 1_000 - 30_000;
    };
    let ownerToken = authenticated.tokenA;
    let ownerTokenRefreshAt = refreshTime(ownerToken);
    const currentOwnerToken = async () => {
      // Decoded expiry schedules refresh only. The actual Account verifier
      // authenticates and introspects every request in the Owner route.
      if (Date.now() >= ownerTokenRefreshAt) {
        ownerToken = await authenticated!.tokenFor(authenticated!.a);
        ownerTokenRefreshAt = refreshTime(ownerToken);
      }
      return ownerToken;
    };
    const actor = `https://rezics.com/id/${randomUUID()}`,
      principalId = randomUUID();
    const principal = await authenticated.verifier.verify(
      new Request('http://main.local', {
        headers: { authorization: `Bearer ${authenticated.tokenA}` },
      }),
      ['work:edit'],
    );
    await source.access.query(
      'INSERT INTO access.principal(id,account_issuer,account_subject) VALUES($1,$2,$3)',
      [principalId, principal.issuer, principal.subject],
    );
    await source.access.query("INSERT INTO access.authority_subject(id,kind) VALUES($1,'agent')", [
      actor,
    ]);
    const registry = new AccessAdmissionRegistry(
      source.access,
      qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY,
    );
    const grant = async (scope: string, action: string) => {
      await source.access.query(
        'INSERT INTO access.scope_gate(id) VALUES($1) ON CONFLICT DO NOTHING',
        [scope],
      );
      await source.access.query(
        `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES($1,$2,$3,$4,now()+interval '1 hour')`,
        [randomUUID(), principalId, actor, action],
      );
      await source.access.query(
        `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES($1,$2,$2,$3,$4,now()+interval '1 hour')`,
        [randomUUID(), actor, scope, action],
      );
    };
    await grant('work:create:root', 'work.create');
    const custody = new ReceiptCustody(
      new PostgresReceiptCustodyStore(source.access),
      objects,
      native,
      qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!,
      proofRetirementSender(live.url, qa.composeEnv.FUSEKI_COMMAND_TOKEN!),
    );
    const env: WorkActivationEnvironment = {
      fuseki: native,
      lineage,
      objectDirectory: objects.directory,
      workObjects: objects,
      receiptCustody: custody,
      titleAdmissionKey: qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY,
    };
    await ensureModelGeneration(env);
    const created = await createAdmittedMetadataWork(
      env,
      authenticated.verifier,
      registry,
      new Request('http://main.local/v1/works', {
        headers: { authorization: `Bearer ${authenticated.tokenA}` },
      }),
      {
        title: 'Owner restore erasure fixture',
        language: 'en',
        actingSubject: actor,
        idempotencyKey: randomUUID(),
      },
    );
    await grant(`work:edit:${created.work}`, 'work.edit');
    const metadata = async (intent: MetadataIntent) => {
      const registered = await registry.register({
        principal,
        actingSubject: actor,
        scope: `work:edit:${created.work}`,
        action: 'work.edit',
        idempotencyKey: randomUUID(),
        requestDigest: metadataDigest(intent),
      });
      const claimed = await registry.claim(registered.id, registered.requestDigest, principal);
      expect(await commitMetadata(env, claimed, intent)).toBe(true);
      const terminal = await readMetadataReceipt(env, claimed.id);
      if (!terminal || terminal.outcome !== 'succeeded')
        throw new Error('Native metadata did not produce its successful terminal');
      await registry.recordGraphOutcome(claimed.id, terminal);
      return terminal;
    };
    await metadata({
      work: created.work,
      expectedHead: null,
      state: checkedMetadataState({
        kind: 'header',
        originalTitle: { value: 'Owner restore erasure fixture', language: 'en' },
        localized: [],
      }),
    });
    const core = new ContentCore(source.content);
    const save = async (body: string) => {
      const saved = await core.saveDraft({
        operationId: randomUUID(),
        variant: {
          id: `urn:rezics:variant:${randomUUID()}`,
          resourceId: created.work,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' },
          direction: 'ltr',
        },
        expectedHead: null,
        model: 'content-shape-v1',
        sourceRevision: null,
        provenance: { fixture: 'owner-restore-erasure' },
        serializedJson: JSON.stringify({ body }),
      });
      if (saved.outcome !== 'succeeded' || !saved.revisionId)
        throw new Error('Content fixture save failed');
      return saved.revisionId;
    };
    const published = await seedContent(
      env,
      source.content,
      source.access,
      created.work,
      'erased native HTTP fixture payload',
    );
    const revisionId = published.revisionId;
    const cursor = new ContentProjectionCursor(source.content);
    const projectionConsumer = `owner-erasure-${suffix}`;
    await cursor.initialize(projectionConsumer);
    const high = await core.ownerPosition();
    for (
      let event = 0;
      event < 32 && (await cursor.read(projectionConsumer)).sequence !== high.sequence;
      event++
    ) {
      if (!(await relayContentProjectionOnce(env, core, cursor, projectionConsumer))) {
        throw new Error('actual Content projection ended before its owner cut');
      }
    }
    expect((await cursor.read(projectionConsumer)).sequence).toBe(high.sequence);
    expect(
      (
        await native.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      VALUES ?reference { rv:revision rv:contentRevision }
      GRAPH <urn:rezics:search:public> { ?unit ?reference <urn:rezics:content:revision:${revisionId}> }
    }`)
      ).boolean,
    ).toBe(true);
    const laterRevisionId = await save('later retained journal fixture payload');
    // Reuse C6's stopped disposable source cut: subsequent positions are
    // allocated by real native commands, with diagnostic and Main cuts unequal.
    live.runner.stop();
    live.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
cat > /tmp/owner-erasure-source.ru <<'OWNER_ERASURE_SOURCE'
PREFIX rv: <https://rezics.com/vocab/>
CLEAR GRAPH <urn:rezics:graph:outbox> ;
DELETE { GRAPH <urn:rezics:graph:control> {
  <urn:rezics:dataset:product> rv:sequence ?old . <${MAIN_RELAY_STREAM_SCOPE}> ?p ?o } }
INSERT { GRAPH <urn:rezics:graph:control> {
  <urn:rezics:dataset:product> rv:sequence 896 .
  <${MAIN_RELAY_STREAM_SCOPE}> rv:dataEpoch "${lineage.dataEpoch}" ; rv:streamSequence 0 ; rv:legacyThroughSequence 0 } }
WHERE { GRAPH <urn:rezics:graph:control> {
  <urn:rezics:dataset:product> rv:sequence ?old . OPTIONAL { <${MAIN_RELAY_STREAM_SCOPE}> ?p ?o } } }
OWNER_ERASURE_SOURCE
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/tmp/owner-erasure-source.ru`);
    await live.runner.start();
    const component = `https://rezics.com/id/${randomUUID()}`;
    const edition = (title: string) =>
      checkedMetadataState({
        kind: 'edition',
        id: component,
        status: 'active',
        title: { value: title, language: 'en' },
        contentLanguage: 'en',
        editionStatement: null,
        publisher: null,
        publicationYear: null,
        isbn13: null,
      });
    const command = await metadata({
      work: created.work,
      expectedHead: null,
      state: edition('Retained native edition 1'),
    });
    const second = await metadata({
      work: created.work,
      expectedHead: command.revision!,
      state: edition('Retained native edition 2'),
    });
    const third = await metadata({
      work: created.work,
      expectedHead: second.revision!,
      state: edition('Retained native edition 3'),
    });
    for (const receipt of [command.receipt, second.receipt, third.receipt])
      await custody.retire(receipt);
    const retired = (
      await source.access.query<{
        payload_sha256: string;
        payload: Buffer;
        retired: boolean;
        data_epoch: string;
        stream_sequence: string;
      }>(
        'SELECT payload_sha256,payload,retired_at IS NOT NULL AS retired,data_epoch,stream_sequence::text FROM access.command_custody WHERE receipt=$1',
        [command.receipt],
      )
    ).rows[0]!;
    const prepared = JSON.parse(retired.payload.toString('utf8')) as PreparedCommand;
    const historicalManifest = prepared.manifest.slice(-64);
    const manifest = JSON.parse(
      readFileSync(join(objects.directory, historicalManifest), 'utf8'),
    ) as { payload: string };
    expect(retired.retired).toBe(true);
    expect(
      (
        await native.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH <urn:rezics:graph:receipts> { <${command.receipt}> a rv:CommitProof } }`)
      ).boolean,
    ).toBe(false);
    const consumer = `owner-erasure-restore:${suffix}`;
    await initializeRelayCheckpoint(source.relay, consumer, lineage.dataEpoch);
    const drain = async (relay: Pool, relayConsumer = consumer) => {
      for (let batch = 0; batch < 32; batch++) {
        if (!(await relayMainOutboxOnce(native, relay, relayConsumer, { ownerOutbox: custody })))
          return;
      }
      throw new Error('fixture relay handoff exceeded its bound');
    };
    await drain(source.relay);
    await grant(`work:read:${created.work}`, 'work.read');
    const leaseTemplates = {
      download: (
        await new AccessDownloadLeases(source.access).admit(
          principal,
          actor,
          created.work,
          randomUUID(),
        )
      ).id,
      search: (
        await new ContentSearchReadAccess(source.access).admit(
          principal,
          actor,
          created.work,
          published.variantId,
        )
      ).id,
    };
    const availableBeforeErasure = (
      await new ContentCore(source.content).readExactBatch(
        [revisionId],
        async (ids) => new Set(ids),
      )
    )[0]!;
    expect(availableBeforeErasure.status).toBe('available');
    if (availableBeforeErasure.status !== 'available')
      throw new Error('source publication bytes are unavailable before erasure');
    expect(hash(availableBeforeErasure.serializedJson)).toBe(
      availableBeforeErasure.reference.byteDigest,
    );
    expect(Buffer.byteLength(availableBeforeErasure.serializedJson, 'utf8')).toBe(
      availableBeforeErasure.reference.byteLength,
    );
    expect(availableBeforeErasure.serializedJson).toContain('erased native HTTP fixture payload');
    const generation = await engageAccessRecoveryFence(source.access);
    let coverage: RecoveryCoverage | undefined;
    for (let attempt = 0; attempt < 8 && !coverage; attempt++) {
      try {
        coverage = await captureGraphRecoveryCoverage(
          native,
          source.account,
          source.access,
          source.relay,
          consumer,
          source.content,
          { directory: objects.directory, workObjects: objects },
        );
      } catch (error) {
        if (
          !(error instanceof RestoreLineageConflict) ||
          !error.message.includes('Account WAL frontier') ||
          attempt === 7
        )
          throw error;
        await Bun.sleep(100);
      }
    }
    if (!coverage?.objects) throw new Error('fixture signed owner coverage is unavailable');
    const authority = {
      sealedCoverage: JSON.stringify(
        sealRecoveryPayload(coverage, restoreKey, 'graph-recovery-coverage'),
      ),
      hmacKey: restoreKey,
    };
    await retainRecoveryCoverageHead(source.relay, authority.sealedCoverage, restoreKey);
    await retainErasureCoverage(source.relay, consumer);
    // Retaining the first signed capture advances the real cluster WAL while
    // the quiesced owner rows and graph cut remain unchanged. Capture the
    // second frontier before erasure makes historical Content unavailable.
    const newerCoverage = await captureGraphRecoveryCoverage(
      native,
      source.account,
      source.access,
      source.relay,
      consumer,
      source.content,
      { directory: objects.directory, workObjects: objects },
    );
    const { accountPg: capturedPg, ...capturedOwners } = coverage;
    const { accountPg: newerPg, ...newerOwners } = newerCoverage;
    expect(newerOwners).toEqual(capturedOwners);
    expect(newerPg.systemIdentifier).toBe(capturedPg.systemIdentifier);
    expect(
      (
        await source.account.query('SELECT $2::pg_lsn > $1::pg_lsn AS advanced', [
          capturedPg.flushedLsn,
          newerPg.flushedLsn,
        ])
      ).rows,
    ).toEqual([{ advanced: true }]);
    const newerAuthority = {
      sealedCoverage: JSON.stringify(
        sealRecoveryPayload(newerCoverage, restoreKey, 'graph-recovery-coverage'),
      ),
      hmacKey: restoreKey,
    };
    cpSync(objects.directory, backupObjects, { recursive: true });
    live.runner.stop();
    copyGraph(liveVolume, cutVolume);
    await live.runner.start();
    // Reuse the owner-cut drill's physical backup mechanism. The graph cut is
    // copied separately, so its original live graph can produce genuine later proof.
    const remote = `/tmp/rezics-owner-erasure-${suffix}`;
    try {
      const copied = qa.compose(
        [
          'exec',
          '-T',
          '-u',
          'postgres',
          'postgres',
          'sh',
          '-ec',
          `PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5 pg_basebackup -h 127.0.0.1 -p 5432 -U postgres -w -D ${remote} -Fp -Xs --checkpoint=fast`,
        ],
        65_000,
      );
      if (copied.status !== 0)
        throw new Error(`physical fixture backup failed: ${copied.output.slice(-2000)}`);
      const container = qa.compose(['ps', '-q', 'postgres']).output.trim();
      if (!/^[0-9a-f]{12,64}$/.test(container))
        throw new Error('QA PostgreSQL container is unavailable');
      docker(['cp', `${container}:${remote}`, pgBackup]);
      execFileSync('pg_verifybackup', ['--no-parse-wal', pgBackup], { timeout: 15_000 });
    } finally {
      const removed = qa.compose(
        ['exec', '-T', '-u', 'postgres', 'postgres', 'rm', '-rf', remote],
        10_000,
      );
      if (removed.status !== 0) throw new Error('physical fixture backup cleanup failed');
    }
    const erased = await journalErasure(source.relay, {
      operationId: randomUUID(),
      requestDigest: hash(revisionId),
      kind: 'revision',
      principalId: principalId,
      admissionId: randomUUID(),
      authorityEpoch: generation,
      targets: [{ kind: 'content_revision', ref: revisionId }],
    });
    await suppressGraphContentRevisions(native, lineage, erased.erasureId, erased.erasureEpoch, [
      revisionId,
    ]);
    const original = await readGraphErasureProof(
      native,
      lineage,
      erased.erasureId,
      erased.erasureEpoch,
      [revisionId],
    );
    expect(original.sequence).toBe('900');
    await applyContentErasure(source.content, {
      erasureId: erased.erasureId,
      erasureEpoch: erased.erasureEpoch,
      resourceId: created.work,
      revisionIds: [revisionId],
      graphProof: original,
      preservationAccess: source.access,
    });
    await markErasureSuppressed(source.relay, erased.erasureId);
    await drain(source.relay);
    const retainedProof = (
      await source.relay.query<{
        graph_position: object;
        relay_position: { streamScope: string; dataEpoch: string; sequence: string };
      }>(
        `SELECT envelope->'data'->'sourcePosition' AS graph_position,
         envelope->'data'->'relayPosition' AS relay_position FROM relay.delivered_event
       WHERE envelope->>'type'='com.rezics.erasure.graph-suppressed.v1'
         AND envelope->'data'->'receipt'->'systemProof'->>'erasureId'=$1`,
        [erased.erasureId],
      )
    ).rows;
    expect(retainedProof).toHaveLength(1);
    expect(retainedProof[0]!.graph_position).toEqual({
      datasetId: 'product',
      dataEpoch: original.dataEpoch,
      sequence: original.sequence,
    });
    expect(retainedProof[0]!.relay_position.streamScope).toBe(MAIN_RELAY_STREAM_SCOPE);
    expect(retainedProof[0]!.relay_position.sequence).toBe('4');
    expect(retainedProof[0]!.relay_position.dataEpoch).toBe(original.dataEpoch);
    expect(original.sequence).not.toBe(retainedProof[0]!.relay_position.sequence);
    expect(original.sequence).not.toBe(erased.erasureEpoch);
    const backupLabel = `content:backup:owner-erasure:${suffix}`;
    await ensureRetentionDomain(source.relay, {
      label: backupLabel,
      owner: 'content',
      store: 'postgresql',
      custody: 'backup',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    await recordErasureInventory(source.relay, erased.erasureId, {
      owners: ['content'],
      liveRetentionReason: 'Original physical cut remains retained after logical suppression',
    });
    const retainedRelayTemplate = await databases.snapshot('relay', () => closePool(source.relay));
    let index = 0;
    const copy = async () => {
      const copyStarted = Date.now(),
        ordinal = ++index;
      const retainedDatabase = `qa_owner_erasure_${suffix}_${ordinal}`;
      const relayTemplate = new URL(retainedRelayTemplate).pathname.slice(1);
      if (!/^[a-z0-9_]+$/.test(relayTemplate)) throw new Error('invalid retained relay template');
      await admin(`CREATE DATABASE ${retainedDatabase} WITH TEMPLATE ${relayTemplate} OWNER relay`);
      copies.push(retainedDatabase);
      const relayUrl = new URL(retainedRelayTemplate);
      relayUrl.pathname = `/${retainedDatabase}`;
      const retainedRelay = pool(relayUrl.toString());
      const data = join(directory, `postgres-${ordinal}`);
      pgCopies.push(data);
      copyRecoveryTree(pgBackup, data);
      appendFileSync(
        join(data, 'postgresql.auto.conf'),
        "\narchive_mode = off\nrestore_command = 'false'\n",
      );
      writeFileSync(join(data, 'recovery.signal'), '');
      const port = await freePort();
      execFileSync(
        'pg_ctl',
        [
          '-D',
          data,
          '-l',
          join(directory, `postgres-${ordinal}.log`),
          '-o',
          `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`,
          '-t',
          '60',
          '-w',
          'start',
        ],
        { timeout: 65_000 },
      );
      const restoredPool = (owner: keyof typeof source) => {
        const url = new URL(databases.urls[owner]);
        url.hostname = '127.0.0.1';
        url.port = String(port);
        url.username = 'postgres';
        url.password = qa.composeEnv.POSTGRES_PASSWORD!;
        return pool(url.toString());
      };
      const owners = {
        account: restoredPool('account'),
        access: restoredPool('access'),
        content: restoredPool('content'),
        relay: restoredPool('relay'),
      };
      let recovering = true;
      for (let attempt = 0; attempt < 100 && recovering; attempt++) {
        recovering =
          (
            await owners.account.query<{ recovering: boolean }>(
              'SELECT pg_is_in_recovery() AS recovering',
            )
          ).rows[0]?.recovering ?? true;
        if (recovering) await Bun.sleep(100);
      }
      expect(recovering).toBe(false);
      // Recovery connects as postgres while ordinary owner roles stay offline.
      await owners.account.query(
        'ALTER ROLE account NOLOGIN; ALTER ROLE access NOLOGIN; ALTER ROLE content NOLOGIN; ALTER ROLE relay NOLOGIN',
      );
      const restoredVolume = volume(`copy-${ordinal}`);
      copyGraph(cutVolume, restoredVolume);
      const graph = await standaloneFuseki(qa.dockerEnv, {
        name: `rezics-owner-erasure-${suffix}-copy-${ordinal}`,
        image: image,
        volume: restoredVolume,
        secrets: fusekiSecrets(qa.composeEnv),
      });
      containers.push(graph);
      const fuseki = new FusekiClient(
        graph.url,
        qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN,
        qa.composeEnv.FUSEKI_COMMAND_TOKEN,
      );
      const restoredLineage = {
        dataEpoch: randomUUID(),
        routingEpoch: /^[0-9]+$/.test(lineage.routingEpoch)
          ? (BigInt(lineage.routingEpoch) + 1n).toString()
          : randomUUID(),
      };
      await cutoverRestoredGraphLineage(fuseki, {
        prior: { ...lineage, sequence: coverage!.priorSequence },
        next: restoredLineage,
      });
      const restoredDirectory = join(directory, `objects-${ordinal}`);
      cpSync(backupObjects, restoredDirectory, { recursive: true });
      const restoredObjects = new DirectoryObjects(restoredDirectory);
      const restoredCustody = new ReceiptCustody(
        new PostgresReceiptCustodyStore(owners.access),
        restoredObjects,
        fuseki,
        qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!,
        proofRetirementSender(graph.url, qa.composeEnv.FUSEKI_COMMAND_TOKEN!),
      );
      const restoredEnv: WorkActivationEnvironment = {
        fuseki,
        lineage: restoredLineage,
        objectDirectory: restoredDirectory,
        workObjects: restoredObjects,
        receiptCustody: restoredCustody,
      };
      const resources: RestoreResources = {
        accountPool: owners.account,
        accessPool: owners.access,
        contentPool: owners.content,
        restoredRelayPool: owners.relay,
        hmacKey: restoreKey,
        objectStore: { directory: restoredDirectory, workObjects: restoredObjects },
        erasures: {
          authority,
          originalSource: 'retained-native-event',
          signingKey: qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!,
          maintenance: heldErasureMaintenanceClient(
            graph.url,
            qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN!,
          ),
        },
      };
      const operations = new OwnerOperations(retainedRelay, restoredEnv, resources);
      const work: MainWorkDependencies = {
        environment: restoredEnv,
        account: authenticated!.verifier,
        access: new AccessAdmissionRegistry(owners.access),
        content: new ContentCore(owners.content),
        ownerOperations: operations,
      };
      const app = new Elysia().use(ownerRoutes(work)).use(healthRoutes(fuseki, work));
      const request = async (
        key: string = randomUUID(),
        token?: string,
        body: Parameters<RestoreChecks['reconcile']>[1] = {
          profile: 'owner-reconciliation-v1',
          kind: 'restore',
          sealedCoverage: authority.sealedCoverage,
          sealedDeletionSets: [],
        },
      ) => {
        const bearer = token ?? (await currentOwnerToken());
        return app.handle(
          new Request('http://main.local/v1/owners/reconciliations', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${bearer}`,
              'content-type': 'application/json',
              'idempotency-key': key,
            },
            body: JSON.stringify(body),
          }),
        );
      };
      const ready = () => app.handle(new Request('http://main.local/health/ready'));
      const faultRetained = async (
        sql: string | readonly { sql: string; values?: unknown[] }[],
        values: unknown[] = [],
      ) => {
        const url = new URL(relayUrl);
        url.username = 'postgres';
        url.password = qa.composeEnv.POSTGRES_PASSWORD!;
        const client = new Client({ connectionString: url.toString() });
        await client.connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL session_replication_role = replica');
          const statements = typeof sql === 'string' ? [{ sql, values }] : sql;
          if (!statements.length) throw new Error('retained test fault has no SQL statements');
          const first = await client.query(statements[0]!.sql, statements[0]!.values ?? []);
          for (const statement of statements.slice(1))
            await client.query(statement.sql, statement.values ?? []);
          await client.query('COMMIT');
          return first;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          await client.end();
        }
      };
      const dispose = async () => {
        graph.remove();
        for (const owner of [...Object.values(owners), retainedRelay]) await closePool(owner);
        execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-t', '10', '-w', 'stop'], {
          timeout: 15_000,
        });
        pgCopies.splice(pgCopies.indexOf(data), 1);
      };
      const copyElapsedMs = Date.now() - copyStarted;
      console.info('owner restore erasure copy ready', { ordinal, elapsedMs: copyElapsedMs });
      expect(copyElapsedMs).toBeLessThan(600_000);
      return {
        app,
        owners,
        retainedRelay,
        resources,
        fuseki,
        lineage: restoredLineage,
        directory: restoredDirectory,
        custody: restoredCustody,
        request,
        ready,
        faultRetained,
        dispose,
      };
    };
    const preparationElapsedMs = Date.now() - preparationStarted;
    console.info('owner restore erasure cut ready', { elapsedMs: preparationElapsedMs });
    expect(preparationElapsedMs).toBeLessThan(600_000);
    return {
      source,
      native,
      custody,
      coverage,
      authority,
      newerAuthority,
      generation,
      original,
      erased,
      revisionId,
      availableBeforeErasure,
      laterRevisionId,
      work: created.work,
      retired,
      backupObjects,
      backupLabel,
      historicalManifest,
      historicalPayload: manifest.payload.slice(7),
      modelShape: prepared.envelope.validations[0]!.sha256,
      principal,
      actor: actor,
      published,
      principalId: principalId,
      leaseTemplates,
      stopOriginal: () => live.runner.stop(),
      copy,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type Fixture = Awaited<ReturnType<typeof ownerRestoreErasureFixture>>;
export type Copy = Awaited<ReturnType<Fixture['copy']>>;

export function operatorContext(fixture: Fixture, copy: Copy): OperatorRestoreReleaseContext {
  return {
    budget: new RecoveryBudget(),
    fuseki: copy.fuseki,
    apps: {
      MAIN_DATA_EPOCH: copy.lineage.dataEpoch,
      MAIN_ROUTING_EPOCH: copy.lineage.routingEpoch,
    },
    manifest: {
      sealedCoverage: fixture.authority.sealedCoverage,
      sealedDeletionSets: [],
      fenceGeneration: fixture.generation,
    },
    pools: copy.owners,
  };
}

export async function ownerLogins(copy: Copy) {
  return (
    await copy.owners.account.query<{ rolname: string; rolcanlogin: boolean }>(
      "SELECT rolname,rolcanlogin FROM pg_roles WHERE rolname IN ('account','access','content','relay') ORDER BY rolname",
    )
  ).rows;
}

export async function outerOperation(copy: Copy, key: string) {
  const record = (
    await copy.retainedRelay.query<{ id: string; state: string; hold_reason: string | null }>(
      'SELECT id,state,hold_reason FROM relay.owner_reconciliation WHERE operation_id=$1',
      ['owner:reconcile:' + key],
    )
  ).rows[0]!;
  const bindings = (
    await copy.retainedRelay.query<{ item_ref: string }>(
      `SELECT item_ref FROM relay.owner_reconciliation_item WHERE reconciliation_id=$1
       AND item_ref ~ '^restore-(qualification|release):' ORDER BY ordinal`,
      [record.id],
    )
  ).rows.map((row) => row.item_ref);
  const erasures = (
    await copy.retainedRelay.query<{ id: string; state: string; outcome_digest: string }>(
      'SELECT id,state,outcome_digest FROM relay.owner_reconciliation WHERE operation_id=$1',
      ['owner:reconcile:' + key + ':erasures'],
    )
  ).rows[0];
  return {
    ...record,
    erasures,
    qualifications: bindings.filter((ref) => ref.startsWith('restore-qualification:')),
    releases: bindings.filter((ref) => ref.startsWith('restore-release:')),
  };
}

export async function graphReleased(copy: Copy) {
  return (
    await copy.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> {
      <${DATASET}> rv:dataEpoch "${copy.lineage.dataEpoch}" ; rv:sequence 0 .
      FILTER NOT EXISTS { <${DATASET}> rv:restoreHold true } } }`)
  ).boolean;
}

export async function accessFence(copy: Copy) {
  return (
    await copy.owners.access.query<{ open: boolean; generation: string }>(
      'SELECT open,generation::text AS generation FROM access.recovery_fence WHERE id=true',
    )
  ).rows;
}

/** Same operator command and key for every attempt; only the reconcile call may fail. */
export function operatorAttempt(fixture: Fixture, copy: Copy, key: string) {
  return finishOperatorRestore(
    operatorContext(fixture, copy),
    { reconcile: (_context, body, attempt) => copy.request(attempt, undefined, body) },
    key,
    () => {},
  );
}

export async function failOuterOutcome(copy: Copy, key: string) {
  await copy.faultRetained([
    {
      sql: `CREATE FUNCTION relay.g1351_fail_outer_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.state = 'reconciled' AND NEW.operation_id = 'owner:reconcile:${key}' THEN
            RAISE EXCEPTION 'fault: outer restore outcome write' USING ERRCODE = 'XX000';
          END IF;
          RETURN NEW;
        END $$`,
    },
    {
      sql: `CREATE TRIGGER g1351_fail_outer_outcome BEFORE UPDATE ON relay.owner_reconciliation
        FOR EACH ROW EXECUTE FUNCTION relay.g1351_fail_outer_outcome()`,
    },
  ]);
}

export async function repairOuterOutcome(copy: Copy) {
  await copy.faultRetained([
    { sql: 'DROP TRIGGER g1351_fail_outer_outcome ON relay.owner_reconciliation' },
    { sql: 'DROP FUNCTION relay.g1351_fail_outer_outcome()' },
  ]);
}

export const FAILED = /Owner reconciliation did not verify the restore \(50[0-9]/;

/** A lost outer outcome: both owners committed and only the outcome write failed. */
export async function lostOutcome(fixture: Fixture, copy: Copy) {
  const key = randomUUID();
  await failOuterOutcome(copy, key);
  await expect(operatorAttempt(fixture, copy, key)).rejects.toThrow(FAILED);
  await repairOuterOutcome(copy);
  const lost = await outerOperation(copy, key);
  expect(lost).toMatchObject({ state: 'running' });
  expect(lost.releases).toHaveLength(1);
  expect(await accessFence(copy)).toEqual([
    { open: true, generation: (BigInt(fixture.generation) + 1n).toString() },
  ]);
  return { key, lost };
}

/**
 * A refused completion cannot close a release that already committed, so the
 * actual surfaces are asserted: the operation settles as held, the verified
 * restore evidence and owner logins stay closed, the operator command fails and
 * Access/graph keep the committed release.
 */
export async function expectRefusedCompletion(
  fixture: Fixture,
  copy: Copy,
  key: string,
  reason: RegExp,
) {
  const response = await copy.request(key);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { state: string; disposition: string };
  expect(body.state).toBe('held');
  expect(['conflict', 'unavailable', 'corrupt']).toContain(body.disposition);
  const held = await outerOperation(copy, key);
  expect(held.state).toBe('held');
  expect(held.hold_reason).toMatch(reason);
  await expect(operatorAttempt(fixture, copy, key)).rejects.toThrow(
    'Owner reconciliation did not verify the restore',
  );
  expect((await ownerLogins(copy)).map((row) => row.rolcanlogin)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(await graphReleased(copy)).toBe(true);
  expect(await accessFence(copy)).toEqual([
    { open: true, generation: (BigInt(fixture.generation) + 1n).toString() },
  ]);
  expect((await copy.ready()).status).toBe(200);
  await expect(
    new AccessAdmissionRegistry(copy.owners.access).activePrincipalId(fixture.principal),
  ).resolves.toBeDefined();
  return held;
}

export async function replicaAccess(copy: Copy, sql: string, values: unknown[] = []) {
  const client = await copy.owners.access.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    const result = await client.query(sql, values);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function failAccessCommit(copy: Copy) {
  const client = await copy.owners.access.connect();
  try {
    await client.query(`CREATE FUNCTION access.g1351_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fault: Access commit' USING ERRCODE = 'XX000'; END $$`);
    await client.query(`CREATE CONSTRAINT TRIGGER g1351_fail_commit AFTER UPDATE ON access.recovery_fence
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.open) EXECUTE FUNCTION access.g1351_fail_commit()`);
  } finally {
    client.release();
  }
}

export async function repairAccessCommit(copy: Copy) {
  const client = await copy.owners.access.connect();
  try {
    await client.query('DROP TRIGGER g1351_fail_commit ON access.recovery_fence');
    await client.query('DROP FUNCTION access.g1351_fail_commit()');
  } finally {
    client.release();
  }
}

export async function liveAccess(copy: Copy) {
  const client = await copy.owners.access.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const state = await accessStateCoverage(copy.owners.access, client);
    const outbox = await accessOutboxCoverage(copy.owners.access, client);
    await client.query('COMMIT');
    return { state, outbox };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
