import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence, releaseAccessRecoveryFence,
  type RegisteredAdmission } from '../access/admission.ts';
import { sealClassificationDecisionAdmission } from '../classification/decision.ts';
import { commandReceiptIri, readCommandReceipt } from '../context/command.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { sealMetadataWorkAdmission } from '../work/seal.ts';
import { convertPopulatedStatements } from './populated-conversion.ts';
import { StatementSeek } from './seek.ts';

const upgrade = (epoch: string) => `urn:rezics:maintenance:statement-upgrade:${hash(epoch)}`;
export const STATEMENT_UPGRADE_COST = { admissionsPerBatch: 32, responseBytes: 64 * 1024 } as const;

/** Model alignment may append a zero-event graph position after conversion.
 * Consume the ordinary bounded seek projection before restarting stopped Main;
 * this never enumerates a populated inventory to repair missing coverage. */
export async function ensureStatementSeekCurrent(env: WorkActivationEnvironment,pool: Pool) {
  const seek = new StatementSeek(pool,env);
  while (await seek.projectOnce()) { /* contiguous bounded outbox batches */ }
  const coverage = await seek.coverage();
  if (!coverage?.complete || !(await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ${coverage.through_sequence} }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
  }`,STATEMENT_UPGRADE_COST.responseBytes)).boolean)
    throw new Error('Statement seek coverage is incomplete before Main restart');
}

/** A completed upgrade remains current while the ordinary seek worker advances
 * subsequent positions. Its completion marker is scoped to the restored epoch. */
export async function statementUpgradeCurrent(fuseki: FusekiClient, epoch: string, pool: Pool) {
  const table = await pool.query<{ present: boolean }>(
    "SELECT to_regclass('access.statement_seek_coverage') IS NOT NULL AS present");
  if (!table.rows[0]?.present) return false;
  const coverage = await pool.query(`SELECT 1 FROM access.statement_seek_coverage
    WHERE data_epoch=$1 AND complete AND EXISTS (SELECT 1 FROM access.recovery_fence WHERE id AND open)`, [epoch]);
  if (!coverage.rowCount) return false;
  return (await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:dataEpoch ${lit(epoch)} .
    ${iri(upgrade(epoch))} rv:outcome rv:Succeeded .
    FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
    FILTER NOT EXISTS { ${iri(upgrade(epoch))} rv:statementUpgradeFence true }
  } }`, STATEMENT_UPGRADE_COST.responseBytes)).boolean === true;
}

/** These retired commands have no dispatch path or live receipt-family entry.
 * Maintenance seals the original receipt identity without changing source facts
 * or advancing the graph stream. An existing terminal result is retained. */
async function sealRetiredAdmission(env: WorkActivationEnvironment, client: PoolClient, admission: RegisteredAdmission) {
  const family = admission.action === 'statement.migrate' ? 'statement-migrate-v1' : 'statement-cutover-v1';
  const receipt = commandReceiptIri(admission.id, family);
  await env.fuseki.update(`PREFIX rv: <${RV}> INSERT { GRAPH ${iri(GRAPHS.receipts)} {
    ${iri(receipt)} a rv:OperationReceipt ; rv:commandFamily ${lit(family)} ; rv:outcome rv:Cancelled ;
      rv:reason rv:Unavailable ; rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
      rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?sequence .
  } } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?sequence }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } } }`);
  const proof = await readCommandReceipt(env, admission.id, family);
  if (!proof || proof.admissionId !== admission.id || proof.scope !== admission.scope
    || proof.requestDigest !== admission.requestDigest || proof.authorityEpoch !== admission.authorityEpoch
    || (proof.outcome === 'succeeded' && admission.state !== 'claimed'))
    throw new Error('Retired Statement admission has no matching terminal receipt');
  await client.query('BEGIN');
  try {
    const sealed = await client.query(`UPDATE access.admission SET state='sealed',graph_receipt=$2,
      graph_outcome=$3,graph_data_epoch=$4,graph_sequence=$5,sealed_at=clock_timestamp()
      WHERE id=$1 AND state=$6 AND request_digest=$7 AND authority_epoch=$8 AND scope_id=$9 RETURNING id`,
    [admission.id,proof.receipt,proof.outcome,proof.dataEpoch,proof.sequence,admission.state,
      proof.requestDigest,proof.authorityEpoch,proof.scope]);
    if (sealed.rowCount !== 1) throw new Error('Retired Statement admission changed during upgrade');
    await client.query(`INSERT INTO access.outbox(id,kind,admission_id,scope_id,authority_epoch)
      VALUES ($1,'admission.sealed',$2,$3,$4)`, [Bun.randomUUIDv7(),admission.id,admission.scope,admission.authorityEpoch]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function settleAdmissions(env: WorkActivationEnvironment, pool: Pool, client: PoolClient) {
  const access = new AccessAdmissionRegistry(pool);
  for (;;) {
    const rows = await client.query<{ id: string; scope_id: string; principal_id: string; acting_subject: string;
      action: string; idempotency_key: string; request_digest: string; authority_epoch: string; expires_at: Date;
      state: RegisteredAdmission['state'] }>(`SELECT id,scope_id,principal_id,acting_subject,action,
        idempotency_key,request_digest,authority_epoch,expires_at,state FROM access.admission
      WHERE action IN ('work.create','classification.decision.set','statement.migrate','statement.cutover')
      AND state<>'sealed' ORDER BY id LIMIT ${STATEMENT_UPGRADE_COST.admissionsPerBatch}`);
    if (!rows.rowCount) return;
    for (const row of rows.rows) {
      const admission: RegisteredAdmission = {id: row.id,scope: row.scope_id,principalId: row.principal_id,
        actingSubject: row.acting_subject,action: row.action,idempotencyKey: row.idempotency_key,
        requestDigest: row.request_digest,authorityEpoch: row.authority_epoch,expiresAt: row.expires_at.toISOString(),
        state: row.state,dispatchEligible: false,replayed: true};
      if (admission.action === 'statement.migrate' || admission.action === 'statement.cutover')
        await sealRetiredAdmission(env,client,admission);
      else await access.recordGraphOutcome(admission.id, admission.action === 'work.create'
        ? await sealMetadataWorkAdmission(env,admission) : await sealClassificationDecisionAdmission(env,admission));
    }
  }
}

/** prepare-storage calls this after SQL migration 1389 and graph initialization,
 * while Main and Relay are stopped. Failure retains both fences; only the
 * durable marker belonging to this upgrade permits a retry to release them. */
export async function upgradeStoredStatements(env: WorkActivationEnvironment, pool: Pool) {
  const client = await pool.connect();
  const marker = upgrade(env.lineage.dataEpoch);
  const lockKey = `rezics-statement-upgrade:${env.lineage.dataEpoch}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lockKey]);
    const lineage = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} } }`);
    if (!lineage.boolean) throw new Error('Statement upgrade lineage differs from the prepared stack');
    if (await statementUpgradeCurrent(env.fuseki,env.lineage.dataEpoch,pool))
      return {status: 'complete' as const,converted: 0,replayed: 0,noop: true};
    const owned = (await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:restoreHold true .
      ${iri(marker)} rv:statementUpgradeFence true } }`)).boolean;
    if (!owned) {
      const held = (await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreHold true } }`)).boolean;
      const access = await client.query<{open: boolean}>('SELECT open FROM access.recovery_fence WHERE id');
      if (held || access.rows[0]?.open !== true) throw new Error('Statement upgrade cannot take an unrelated recovery fence');
      await settleAdmissions(env,pool,client);
      await env.fuseki.update(`PREFIX rv: <${RV}> INSERT { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreHold true . ${iri(marker)} rv:statementUpgradeFence true .
      } } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } } }`);
      const acquired = (await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
        ${iri(marker)} rv:statementUpgradeFence true . ${iri(DATASET)} rv:restoreHold true } }`)).boolean;
      if (!acquired) throw new Error('Statement upgrade graph fence was not acquired');
    }
    const generation = await engageAccessRecoveryFence(pool);
    const result = await convertPopulatedStatements(env,pool);
    const position = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:restoreHold true ; rv:sequence ?sequence . ${iri(marker)} rv:statementUpgradeFence true }
    } LIMIT 2`)).results?.bindings ?? [];
    const coverage = await new StatementSeek(pool,env).coverage();
    if (position.length !== 1 || !coverage?.complete || coverage.through_sequence !== position[0]?.sequence?.value)
      throw new Error('Statement upgrade seek coverage is incomplete; writer fences retained');
    await env.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.control)} {
      ${iri(marker)} rv:outcome rv:Succeeded } }`);
    await releaseAccessRecoveryFence(pool,generation);
    await env.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:restoreHold true . ${iri(marker)} rv:statementUpgradeFence true }
    } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:restoreHold true . ${iri(marker)} rv:statementUpgradeFence true ; rv:outcome rv:Succeeded } }`);
    if (!await statementUpgradeCurrent(env.fuseki,env.lineage.dataEpoch,pool))
      throw new Error('Statement upgrade fence release is incomplete');
    return {status: 'complete' as const,...result,noop: false};
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockKey]); }
    finally { client.release(); }
  }
}
