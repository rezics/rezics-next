import { expect } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
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
import { authorCreditFixture, nativeId } from '../../../tests/qa/fixtures/author-credit.ts';
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
  let authenticated: Awaited<ReturnType<typeof authorCreditFixture>> | undefined;
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
    authenticated = await authorCreditFixture(
      {
        ...apps,
        FUSEKI_URL: live.url,
        MAIN_OBJECT_DIRECTORY: objects.directory,
        ACCOUNT_DATABASE_URL: databases.urls.account,
        ACCESS_DATABASE_URL: databases.urls.access,
        CONTENT_DATABASE_URL: databases.urls.content,
      },
      objects.directory,
      'openid work:create work:edit work:read owner:operate',
    );
    const custody = new ReceiptCustody(
      new PostgresReceiptCustodyStore(source.access),
      objects,
      native,
      qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!,
      proofRetirementSender(live.url, qa.composeEnv.FUSEKI_COMMAND_TOKEN!),
    );
    const env: WorkActivationEnvironment = {
      ...authenticated.env,
      fuseki: native,
      workObjects: objects,
      receiptCustody: custody,
    };
    await ensureModelGeneration(env);
    const key = randomUUID();
    const created = await authenticated.json<{ work: string }>(
      await authenticated.call(
        'POST',
        '/v1/works',
        await authenticated.catalogueBody(
          {
            profile: 'metadata-only-v1',
            title: 'Owner restore erasure fixture',
            language: 'en',
            actingSubject: authenticated.actor,
          },
          key,
        ),
        key,
      ),
      201,
    );
    await authenticated.grant(`work:edit:${created.work}`, 'work.edit');
    const principal = await authenticated.account.verifier.verify(
      new Request('http://main.local', {
        headers: { authorization: `Bearer ${authenticated.account.tokenA}` },
      }),
      ['work:edit'],
    );
    const metadata = async (intent: MetadataIntent) => {
      const registered = await authenticated!.access.register({
        principal,
        actingSubject: authenticated!.actor,
        scope: `work:edit:${created.work}`,
        action: 'work.edit',
        idempotencyKey: randomUUID(),
        requestDigest: metadataDigest(intent),
      });
      const claimed = await authenticated!.access.claim(
        registered.id,
        registered.requestDigest,
        principal,
      );
      expect(await commitMetadata(env, claimed, intent)).toBe(true);
      return (await readMetadataReceipt(env, claimed.id))!;
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
    const command = await metadata({
      work: created.work,
      expectedHead: null,
      state: checkedMetadataState({
        kind: 'edition',
        id: nativeId(),
        status: 'active',
        title: { value: 'Retained native edition', language: 'en' },
        contentLanguage: 'en',
        editionStatement: null,
        publisher: null,
        publicationYear: null,
        isbn13: null,
      }),
    });
    await custody.retire(command.receipt);
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
    expect(
      (
        await native.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      VALUES ?reference { rv:revision rv:contentRevision }
      GRAPH <urn:rezics:search:public> { ?unit ?reference <urn:rezics:content:revision:${revisionId}> }
    }`)
      ).boolean,
    ).toBe(true);
    const laterRevisionId = await save('later retained journal fixture payload');
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
      principalId: authenticated.principalId,
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
    expect(BigInt(original.sequence)).toBeGreaterThan(0n);
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
      await source.relay.query<{ graph_position: object;
        relay_position: { streamScope: string; dataEpoch: string; sequence: string } }>(
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
    const captureCurrentAuthority = async (retainedRelay: Pool) => {
      const current = await captureGraphRecoveryCoverage(
        native,
        source.account,
        source.access,
        retainedRelay,
        consumer,
        source.content,
        { directory: objects.directory, workObjects: objects },
      );
      return {
        sealedCoverage: JSON.stringify(
          sealRecoveryPayload(current, restoreKey, 'graph-recovery-coverage'),
        ),
        hmacKey: restoreKey,
      };
    };
    let index = 0;
    const copy = async (options: { originalProof?: 'missing' | 'corrupt' } = {}) => {
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
        recovering = (await owners.account.query<{ recovering: boolean }>(
          'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering ?? true;
        if (recovering) await Bun.sleep(100);
      }
      expect(recovering).toBe(false);
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
        routingEpoch: (BigInt(lineage.routingEpoch) + 1n).toString(),
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
      let originalGraph = options.originalProof === 'missing' ? undefined : { fuseki: native, lineage };
      let proofGraph: Awaited<ReturnType<typeof standaloneFuseki>> | undefined;
      if (options.originalProof === 'corrupt') {
        const proofVolume = volume(`proof-${ordinal}`);
        live.runner.stop(); copyGraph(liveVolume, proofVolume); await live.runner.start();
        proofGraph = await standaloneFuseki(qa.dockerEnv, {
          name: `rezics-owner-erasure-${suffix}-proof-${ordinal}`, image: image,
          volume: proofVolume, secrets: fusekiSecrets(qa.composeEnv),
        });
        containers.push(proofGraph);
        proofGraph.runner.stop();
        proofGraph.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
cat > /tmp/owner-erasure-corrupt-proof.ru <<'OWNER_ERASURE_CORRUPT_PROOF'
PREFIX rv: <https://rezics.com/vocab/>
DELETE { GRAPH <urn:rezics:graph:receipts> { <${original.receipt}> rv:sequence ?n } }
INSERT { GRAPH <urn:rezics:graph:receipts> { <${original.receipt}> rv:sequence 0 } }
WHERE { GRAPH <urn:rezics:graph:receipts> { <${original.receipt}> rv:sequence ?n } }
OWNER_ERASURE_CORRUPT_PROOF
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/tmp/owner-erasure-corrupt-proof.ru`);
        await proofGraph.runner.start();
        originalGraph = { fuseki: new FusekiClient(proofGraph.url,
          qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN, qa.composeEnv.FUSEKI_COMMAND_TOKEN), lineage };
      }
      const resources: RestoreResources = {
        accountPool: owners.account,
        accessPool: owners.access,
        contentPool: owners.content,
        restoredRelayPool: owners.relay,
        hmacKey: restoreKey,
        objectStore: { directory: restoredDirectory, workObjects: restoredObjects },
        erasures: {
          authority,
          ...(originalGraph ? { originalGraph } : {}),
          signingKey: qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!,
          maintenance: heldErasureMaintenanceClient(
            graph.url,
            qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN!,
          ),
        },
      };
      const operations = new OwnerOperations(retainedRelay, restoredEnv, resources);
      const app = createMainApp(fuseki, {
        environment: restoredEnv,
        account: authenticated!.account.verifier,
        access: new AccessAdmissionRegistry(owners.access),
        content: new ContentCore(owners.content),
        ownerOperations: operations,
      });
      const request = (key = randomUUID(), token = authenticated!.account.tokenA) =>
        app.handle(
          new Request('http://main.local/v1/owners/reconciliations', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              'idempotency-key': key,
            },
            body: JSON.stringify({
              profile: 'owner-reconciliation-v1',
              kind: 'restore',
              sealedCoverage: authority.sealedCoverage,
              sealedDeletionSets: [],
            }),
          }),
        );
      const ready = () => app.handle(new Request('http://main.local/health/ready'));
      const dispose = async () => {
        graph.remove();
        proofGraph?.remove();
        for (const owner of [...Object.values(owners), retainedRelay]) await closePool(owner);
        execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-t', '10', '-w', 'stop'], {
          timeout: 15_000,
        });
        pgCopies.splice(pgCopies.indexOf(data), 1);
      };
      expect(Date.now() - copyStarted).toBeLessThan(600_000);
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
        dispose,
      };
    };
    expect(Date.now() - preparationStarted).toBeLessThan(600_000);
    return {
      source,
      native,
      custody,
      coverage,
      authority,
      generation,
      original,
      erased,
      revisionId,
      laterRevisionId,
      work: created.work,
      retired,
      backupObjects,
      backupLabel,
      historicalManifest,
      historicalPayload: manifest.payload.slice(7),
      modelShape: prepared.envelope.validations[0]!.sha256,
      principal,
      actor: authenticated.actor,
      published,
      principalId: authenticated.principalId,
      copy,
      captureCurrentAuthority,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
