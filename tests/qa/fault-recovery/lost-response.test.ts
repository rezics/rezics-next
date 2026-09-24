import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { CommandOutcomeUnknown, FusekiClient, type CommandEnvelope, type CommandResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { activateMetadataWork, metadataWorkRequestDigest, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { readWorkTerminalReceipt, workReceiptIri }
  from '../../../services/main/src/modules/work/receipt.ts';

const RV = 'https://rezics.com/vocab/';
const PRODUCT = 'urn:rezics:dataset:product';

async function toxic(api: string, method: 'POST' | 'DELETE'): Promise<void> {
  const response = await fetch(`${api}/proxies/fuseki/toxics${method === 'DELETE' ? '/qa-lost-response' : ''}`,
    { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'qa-lost-response', type: 'limit_data', stream: 'downstream',
        toxicity: 1, attributes: { bytes: 0 } }) } : {}) });
  if (!response.ok) throw new Error(`Toxiproxy ${method} returned ${response.status}: ${await response.text()}`);
}

async function position(fuseki: FusekiClient): Promise<bigint> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
    GRAPH <urn:rezics:graph:control> { <${PRODUCT}> rv:sequence ?n }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.n) throw new Error('product sequence is missing or ambiguous');
  return BigInt(rows[0].n.value);
}

test('SYS02: a real lost Fuseki response resolves to one Main Work receipt and outbox batch', async () => {
  const api = Bun.env.TOXIPROXY_API_URL;
  const proxyUrl = Bun.env.TOXIPROXY_FUSEKI_URL;
  const directUrl = Bun.env.FUSEKI_URL;
  const artifacts = Bun.env.REZICS_QA_ARTIFACT_DIR;
  if (!Bun.env.REZICS_QA_RUN_ID || !api || !proxyUrl || !directUrl || !artifacts) {
    throw new Error('Run this test through the fault/recovery QA tier');
  }
  const direct = new FusekiClient(directUrl);
  const before = await position(direct);
  const probe = await fetch(`${api}/proxies/fuseki`);
  expect(probe.ok).toBe(true);
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try { expect((await pool.query('SELECT 1 AS ready')).rows[0]?.ready).toBe(1); }
  finally { await pool.end(); }
  expect((await fetch(`${Bun.env.MAIN_S3_ENDPOINT}/health`)).ok).toBe(true);

  let transportLost = false;
  let toxicInstalled = false;
  class FaultedFuseki extends FusekiClient {
    override async command(envelope: CommandEnvelope): Promise<CommandResult> {
      await toxic(api, 'POST');
      toxicInstalled = true;
      try { return await super.command(envelope); }
      catch (error) {
        if (error instanceof CommandOutcomeUnknown) transportLost = true;
        throw error;
      } finally {
        await toxic(api, 'DELETE');
        toxicInstalled = false;
      }
    }
  }
  const admissionId = crypto.randomUUID();
  const title = `Lost response ${admissionId}`;
  const admission = { id: admissionId, scope: 'work:create:root', action: 'work.create' as const,
    idempotencyKey: `fault-${admissionId}`, requestDigest: metadataWorkRequestDigest(title),
    authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const receipt = workReceiptIri(admissionId);
  const lineage = { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! };
  const env: WorkActivationEnvironment = { fuseki: new FaultedFuseki(proxyUrl), lineage,
    objectDirectory: Bun.env.MAIN_OBJECT_DIRECTORY! };
  const evidence: Record<string, unknown> = { acceptanceId: 'SYS02', receipt,
    beforeSequence: String(before), toxic: 'limit_data/downstream/0' };
  try {
    const created = await activateMetadataWork(env, { title, admission });
    evidence.transportLost = transportLost;
    evidence.created = { work: created.work, sequence: created.sequence };
    expect(transportLost).toBe(true);
    expect(BigInt(created.sequence)).toBe(before + 1n);
    expect(await position(direct)).toBe(before + 1n);
    const stored = await readWorkTerminalReceipt(direct, admissionId);
    expect(stored?.outcome).toBe('succeeded');
    expect(stored?.work).toBe(created.work);
    expect(stored?.sequence).toBe(created.sequence);
    const batches = await direct.query(`PREFIX rv: <${RV}> SELECT ?batch WHERE {
      GRAPH <urn:rezics:graph:outbox> { ?batch a rv:OutboxBatch ;
        rv:dataEpoch ${JSON.stringify(lineage.dataEpoch)} ; rv:sequence ${created.sequence} ;
        rv:eventCount 1 ; rv:event ?event . ?event rv:receipt <${receipt}> . }
    }`);
    expect(batches.results?.bindings.length).toBe(1);
    evidence.batch = batches.results?.bindings[0]?.batch?.value;
    const replayed = await activateMetadataWork({ ...env, fuseki: direct }, { title, admission });
    expect(replayed.replayed).toBe(true);
    expect(replayed.work).toBe(created.work);
    expect(replayed.sequence).toBe(created.sequence);
    expect(await position(direct)).toBe(before + 1n);
    evidence.replay = { work: replayed.work, sequence: replayed.sequence };
  } finally {
    if (toxicInstalled) await toxic(api, 'DELETE');
    evidence.transportLost = transportLost;
    evidence.afterSequence = String(await position(direct));
    writeFileSync(join(artifacts, 'fault-recovery-sys02.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
});
