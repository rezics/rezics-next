import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandOutcomeUnknown, FusekiClient, type CommandEnvelope, type CommandResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { ObjectUnavailable, S3ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { activateMetadataWork, GRAPHS, metadataWorkRequestDigest,
  PendingActivation, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { readWorkTerminalReceipt, workReceiptIri }
  from '../../../services/main/src/modules/work/receipt.ts';

class TrackingObjects extends S3ImmutableObjects {
  readonly puts: string[] = [];
  readonly discards: string[] = [];
  readonly manifests: string[] = [];

  override async put(bytes: Uint8Array): Promise<string> {
    const digest = await super.put(bytes);
    this.puts.push(digest);
    const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as { format?: string };
    if (value.format === 'rezics-manifest-v1') this.manifests.push(digest);
    return digest;
  }

  override async discard(digest: string): Promise<void> {
    await super.discard(digest);
    this.discards.push(digest);
  }
}

test('SYS09: rejected Work graph activation removes only its staged RustFS objects', async () => {
  const artifacts = Bun.env.REZICS_QA_ARTIFACT_DIR;
  if (!Bun.env.REZICS_QA_RUN_ID || !artifacts || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_S3_ENDPOINT || !Bun.env.MAIN_S3_BUCKET
    || !Bun.env.MAIN_S3_ACCESS_KEY || !Bun.env.MAIN_S3_SECRET_KEY) {
    throw new Error('Run through the isolated fault/recovery QA tier with Main and RustFS');
  }
  const id = randomUUID();
  const prefix = `semantic/work/sys09-${id}/`;
  const objects = new TrackingObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT,
    bucket: Bun.env.MAIN_S3_BUCKET, region: Bun.env.MAIN_S3_REGION,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY,
    prefix });
  await objects.initialize();

  const direct = new FusekiClient(Bun.env.FUSEKI_URL);
  const lineage = { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! };
  const environment: WorkActivationEnvironment = { fuseki: direct, lineage,
    objectDirectory: Bun.env.MAIN_OBJECT_DIRECTORY!, workObjects: objects };
  const successfulTitle = `SYS09 retained Work ${id}`;
  const successful = await activateMetadataWork(environment, { title: successfulTitle, admission: {
    id: randomUUID(), scope: 'work:create:root', action: 'work.create',
    idempotencyKey: `sys09-success-${id}`, requestDigest: metadataWorkRequestDigest(successfulTitle),
    authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } });
  const retainedDigests = [...objects.puts];
  const retainedManifests = [...objects.manifests];
  expect(retainedDigests).toHaveLength(4);
  for (const digest of retainedDigests) expect(Buffer.from(await objects.get(digest)).byteLength).toBeGreaterThan(0);

  let rejectedWork: string | undefined;
  let mutatedGraphCommand = false;
  class InvalidWorkGraphActivation extends FusekiClient {
    override async command(envelope: CommandEnvelope): Promise<CommandResult> {
      if (envelope.update.includes('a rv:WorkCreatedEvent')) {
        const work = envelope.update.match(/<([^>]+)> a schema:CreativeWork/)?.[1];
        if (!work) throw new Error('fault fixture could not identify the staged Work');
        rejectedWork = work;
        const update = envelope.update.replace(/rv:routingEpoch "[^"]+" ; rv:sequence/,
          'rv:routingEpoch "stale-route" ; rv:sequence');
        if (update === envelope.update) throw new Error('fault fixture could not stale the activation routing epoch');
        mutatedGraphCommand = true;
        return super.command({ ...envelope, update });
      }
      return super.command(envelope);
    }
  }
  const faultyEnvironment = { ...environment, fuseki: new InvalidWorkGraphActivation(
    Bun.env.FUSEKI_URL, Bun.env.FUSEKI_MAINTENANCE_TOKEN, Bun.env.FUSEKI_COMMAND_TOKEN) };
  const rejectedTitle = `SYS09 rejected Work ${id}`;
  const admissionId = randomUUID();
  const rejectedAdmission = { id: admissionId, scope: 'work:create:root', action: 'work.create',
    idempotencyKey: `sys09-rejected-${id}`, requestDigest: metadataWorkRequestDigest(rejectedTitle),
    authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const beforeFailedPut = objects.puts.length;
  const beforeFailedManifest = objects.manifests.length;
  await expect(activateMetadataWork(faultyEnvironment,
    { title: rejectedTitle, admission: rejectedAdmission })).rejects.toBeInstanceOf(PendingActivation);

  const failedDigests = objects.puts.slice(beforeFailedPut);
  const failedManifests = objects.manifests.slice(beforeFailedManifest);
  expect(mutatedGraphCommand).toBe(true);
  expect(rejectedWork).toBeTruthy();
  expect(failedDigests).toHaveLength(4);
  expect(failedManifests).toHaveLength(2);
  expect(objects.discards.slice(-4).sort()).toEqual([...failedDigests].sort());
  for (const digest of failedDigests) {
    await expect(objects.get(digest)).rejects.toBeInstanceOf(ObjectUnavailable);
  }
  for (const digest of retainedDigests) expect(Buffer.from(await objects.get(digest)).byteLength).toBeGreaterThan(0);

  const terminal = await readWorkTerminalReceipt(direct, admissionId);
  expect(terminal).toBeNull();
  expect((await direct.query(`ASK { GRAPH <${GRAPHS.current}> { <${rejectedWork}> ?p ?o } }`)).boolean).toBe(false);
  expect((await direct.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
    GRAPH <${GRAPHS.revisions}> { ?revision rv:manifest ?manifest .
      VALUES ?manifest { ${failedManifests.map(digest => `<urn:rezics:sha256:${digest}>`).join(' ')} }
    }
  }`)).boolean).toBe(false);
  expect((await readWorkTerminalReceipt(direct, successful.admissionId))?.outcome).toBe('succeeded');

  const recovered = await activateMetadataWork(environment,
    { title: rejectedTitle, admission: rejectedAdmission });
  expect(recovered.work).not.toBe(rejectedWork);
  expect((await readWorkTerminalReceipt(direct, admissionId))?.work).toBe(recovered.work);
  const recoveredDigests = objects.puts.slice(beforeFailedPut + failedDigests.length);
  expect(recoveredDigests).toHaveLength(4);
  for (const digest of recoveredDigests) expect(Buffer.from(await objects.get(digest)).byteLength).toBeGreaterThan(0);

  let lostCreateResponse = false;
  class LostCreateResponseFuseki extends FusekiClient {
    override async command(envelope: CommandEnvelope): Promise<CommandResult> {
      const result = await super.command(envelope);
      if (!lostCreateResponse && envelope.update.includes('a rv:WorkCreatedEvent')) {
        lostCreateResponse = true;
        throw new CommandOutcomeUnknown('injected lost Work activation response');
      }
      return result;
    }
  }
  const lostEnvironment = { ...environment, fuseki: new LostCreateResponseFuseki(
    Bun.env.FUSEKI_URL, Bun.env.FUSEKI_MAINTENANCE_TOKEN, Bun.env.FUSEKI_COMMAND_TOKEN) };
  const lostTitle = `SYS09 lost response ${id}`;
  const beforeLostPut = objects.puts.length;
  const beforeLostDiscard = objects.discards.length;
  const lost = await activateMetadataWork(lostEnvironment, { title: lostTitle, admission: {
    id: randomUUID(), scope: 'work:create:root', action: 'work.create',
    idempotencyKey: `sys09-lost-${id}`, requestDigest: metadataWorkRequestDigest(lostTitle),
    authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } });
  const lostDigests = objects.puts.slice(beforeLostPut);
  expect(lostCreateResponse).toBe(true);
  expect(lostDigests).toHaveLength(4);
  expect(objects.discards.length).toBe(beforeLostDiscard);
  for (const digest of lostDigests) expect(Buffer.from(await objects.get(digest)).byteLength).toBeGreaterThan(0);
  expect((await readWorkTerminalReceipt(direct, lost.admissionId))?.work).toBe(lost.work);

  let commandArrivals = 0;
  let releaseCommands!: () => void;
  const bothCommandsReady = new Promise<void>(resolve => { releaseCommands = resolve; });
  class ConcurrentSameKeyFuseki extends FusekiClient {
    override async command(envelope: CommandEnvelope): Promise<CommandResult> {
      if (envelope.update.includes('a rv:WorkCreatedEvent')) {
        commandArrivals++;
        if (commandArrivals === 2) releaseCommands();
        await bothCommandsReady;
      }
      return super.command(envelope);
    }
  }
  const concurrentEnvironment = { ...environment, fuseki: new ConcurrentSameKeyFuseki(
    Bun.env.FUSEKI_URL, Bun.env.FUSEKI_MAINTENANCE_TOKEN, Bun.env.FUSEKI_COMMAND_TOKEN) };
  const concurrentTitle = `SYS09 concurrent Work ${id}`;
  const concurrentAdmission = { id: randomUUID(), scope: 'work:create:root' as const,
    action: 'work.create' as const, idempotencyKey: `sys09-concurrent-${id}`,
    requestDigest: metadataWorkRequestDigest(concurrentTitle), authorityEpoch: '0',
    expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const beforeConcurrentPut = objects.puts.length;
  const beforeConcurrentManifest = objects.manifests.length;
  const beforeConcurrentDiscard = objects.discards.length;
  const concurrent = await Promise.all([0, 1].map(() => activateMetadataWork(concurrentEnvironment,
    { title: concurrentTitle, admission: concurrentAdmission })));
  const concurrentDigests = objects.puts.slice(beforeConcurrentPut);
  const concurrentManifests = objects.manifests.slice(beforeConcurrentManifest);
  const concurrentDiscards = objects.discards.slice(beforeConcurrentDiscard);
  expect(commandArrivals).toBe(2);
  expect(concurrent.map(result => result.work)).toEqual([concurrent[0]!.work, concurrent[0]!.work]);
  expect(concurrent.map(result => result.sequence)).toEqual([concurrent[0]!.sequence, concurrent[0]!.sequence]);
  expect(concurrent.map(result => result.replayed).sort()).toEqual([false, true]);
  expect(concurrentDigests).toHaveLength(8);
  expect(concurrentManifests).toHaveLength(4);
  expect(concurrentDiscards).toHaveLength(4);
  const discardedSet = new Set(concurrentDiscards);
  const winningDigests = concurrentDigests.filter(digest => !discardedSet.has(digest));
  const winningManifests = concurrentManifests.filter(digest => !discardedSet.has(digest)).sort();
  expect(winningDigests).toHaveLength(4);
  expect(winningManifests).toHaveLength(2);
  for (const digest of winningDigests) expect(Buffer.from(await objects.get(digest)).byteLength).toBeGreaterThan(0);
  for (const digest of concurrentDiscards) await expect(objects.get(digest)).rejects.toBeInstanceOf(ObjectUnavailable);
  const concurrentReceipt = await readWorkTerminalReceipt(direct, concurrentAdmission.id);
  expect(concurrentReceipt?.outcome).toBe('succeeded');
  if (!concurrentReceipt?.work || !concurrentReceipt.mainVersion) {
    throw new Error('concurrent Work receipt is missing its winning components');
  }
  const activeManifests = await direct.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?manifest WHERE {
    GRAPH <${GRAPHS.revisions}> { ?revision rv:component ?component ; rv:manifest ?manifest .
      VALUES ?component { <${concurrentReceipt.work}> <${concurrentReceipt.mainVersion}> }
    }
  } ORDER BY ?manifest`);
  const activeManifestDigests = (activeManifests.results?.bindings ?? [])
    .map(binding => binding.manifest?.value.split(':').at(-1) ?? '').sort();
  expect(activeManifestDigests).toEqual(winningManifests);

  writeFileSync(join(artifacts, 'fault-recovery-sys09.json'), JSON.stringify({
    acceptanceId: 'SYS09', dataEpoch: lineage.dataEpoch, successfulWork: successful.work,
    rejectedWork, rejectedReceipt: workReceiptIri(admissionId),
    retainedObjectCount: retainedDigests.length, retainedManifestCount: retainedManifests.length,
    recoveredWork: recovered.work, lostResponseWork: lost.work, concurrentWork: concurrentReceipt?.work,
    discardedObjectCount: objects.discards.length, graphActivationRejected: mutatedGraphCommand,
  }, null, 2) + '\n');
});
