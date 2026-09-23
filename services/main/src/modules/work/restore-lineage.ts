import { DATASET, GRAPHS, RV, iri, lit, type GraphLineage } from './activate.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { Pool, QueryResult } from 'pg';
import { createHash } from 'node:crypto';

export class RestoreLineageConflict extends Error {}
export class RecoveryHold extends Error {}

export interface RestoreLineageCutover {
  prior: GraphLineage & { sequence: string };
  next: GraphLineage;
}

export interface RecoveryCoverage {
  priorDataEpoch: string;
  priorSequence: string;
  accessOutboxCount: string;
  accessOutboxDigest: string;
}

interface AccessOutboxRow {
  id: string;
  kind: string;
  admission_id: string | null;
  scope_id: string;
  authority_epoch: string;
}

/** Stable offline digest of the complete Access outbox at one PostgreSQL snapshot. */
export async function accessOutboxCoverage(pool: Pool): Promise<{ count: string; digest: string }> {
  const client = await pool.connect();
  const digest = createHash('sha256');
  let count = 0n;
  let lastId: string | null = null;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    while (true) {
      const result: QueryResult<AccessOutboxRow> = await client.query<AccessOutboxRow>(
        `SELECT id, kind, admission_id, scope_id, authority_epoch FROM access.outbox
         WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 1000`, [lastId]);
      for (const row of result.rows) {
        digest.update(JSON.stringify([row.id, row.kind, row.admission_id,
          row.scope_id, row.authority_epoch]));
        digest.update('\n');
        count++;
        lastId = row.id;
      }
      if (result.rows.length < 1000) break;
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
  return { count: count.toString(), digest: digest.digest('hex') };
}

export async function assertGraphAdmissionOpen(fuseki: FusekiClient, lineage: GraphLineage): Promise<void> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} .
    FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
  } }`);
  if (result.boolean !== true) throw new RecoveryHold('graph admission is held or lineage differs');
}

async function control(fuseki: FusekiClient): Promise<{ dataEpoch: string; routingEpoch: string; sequence: string }> {
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?epoch ?routing ?sequence WHERE { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing ; rv:sequence ?sequence .
    } }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.epoch || !rows[0]?.routing || !rows[0]?.sequence) {
    throw new RestoreLineageConflict('product control record is unavailable or ambiguous');
  }
  return { dataEpoch: rows[0].epoch.value, routingEpoch: rows[0].routing.value,
    sequence: rows[0].sequence.value };
}

/** Run only on a fenced, isolated restored dataset before product admission. */
export async function cutoverRestoredGraphLineage(
  fuseki: FusekiClient, cutover: RestoreLineageCutover,
): Promise<{ lineage: GraphLineage; sequence: '0' | string; replayed: boolean }> {
  const { prior, next } = cutover;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(prior.dataEpoch) || !uuid.test(next.dataEpoch)
    || prior.dataEpoch === next.dataEpoch || !/^[0-9]+$/.test(prior.sequence)
    || !/^[0-9]+$/.test(prior.routingEpoch) || !/^[0-9]+$/.test(next.routingEpoch)
    || BigInt(next.routingEpoch) <= BigInt(prior.routingEpoch)) {
    throw new RestoreLineageConflict('invalid restore lineage transition');
  }
  const before = await control(fuseki);
  if (before.dataEpoch === next.dataEpoch && before.routingEpoch === next.routingEpoch) {
    return { lineage: next, sequence: before.sequence, replayed: true };
  }
  if (before.dataEpoch !== prior.dataEpoch || before.routingEpoch !== prior.routingEpoch
    || before.sequence !== prior.sequence) {
    throw new RestoreLineageConflict('restored graph cut differs from recorded position');
  }
  const marker = `urn:rezics:restore:${next.dataEpoch}`;
  let updateError: unknown;
  try { await fuseki.update(`PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(prior.dataEpoch)} ;
      rv:routingEpoch ${lit(prior.routingEpoch)} ; rv:sequence ?oldSequence . } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(next.dataEpoch)} ;
      rv:routingEpoch ${lit(next.routingEpoch)} ; rv:sequence 0 ;
      rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
      ${iri(marker)} a rv:RestoreCutover ; rv:priorDataEpoch ${lit(prior.dataEpoch)} ;
        rv:priorSequence ?oldSequence ; rv:dataEpoch ${lit(next.dataEpoch)} . } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(prior.dataEpoch)} ;
      rv:routingEpoch ${lit(prior.routingEpoch)} ; rv:sequence ?oldSequence . }
      FILTER(?oldSequence = ${prior.sequence})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} ?p ?o } }
    }`); }
  catch (error) { updateError = error; }
  const after = await control(fuseki);
  if (after.dataEpoch !== next.dataEpoch || after.routingEpoch !== next.routingEpoch
    || after.sequence !== '0') {
    throw new RestoreLineageConflict(updateError
      ? 'restore lineage update outcome is unknown' : 'restored graph lineage was not activated');
  }
  return { lineage: next, sequence: '0', replayed: false };
}

/** Release only after an independently retained authority/receipt frontier is compared. */
export async function releaseRestoredGraphHold(
  fuseki: FusekiClient, accessPool: Pool, lineage: GraphLineage, coverage: RecoveryCoverage,
): Promise<void> {
  if (!/^[0-9]+$/.test(coverage.priorSequence)
    || !/^[0-9]+$/.test(coverage.accessOutboxCount)
    || !/^[0-9a-f]{64}$/.test(coverage.accessOutboxDigest)) {
    throw new RestoreLineageConflict('invalid recovery coverage');
  }
  const outbox = await accessOutboxCoverage(accessPool);
  if (outbox.count !== coverage.accessOutboxCount || outbox.digest !== coverage.accessOutboxDigest) {
    throw new RestoreLineageConflict('Access outbox differs from recovery coverage');
  }
  const marker = `urn:rezics:restore:${lineage.dataEpoch}`;
  const held = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
      rv:sequence 0 ; rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
    ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ;
      rv:priorSequence ${coverage.priorSequence} .
  } }`);
  if (held.boolean !== true) throw new RestoreLineageConflict('graph cut differs from recovery coverage');
  let updateError: unknown;
  try { await fuseki.update(`PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
    WHERE { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
        rv:sequence 0 ; rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
      ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ;
        rv:priorSequence ${coverage.priorSequence} .
    } }`); }
  catch (error) { updateError = error; }
  try { await assertGraphAdmissionOpen(fuseki, lineage); }
  catch {
    throw new RestoreLineageConflict(updateError
      ? 'recovery release outcome is unknown' : 'recovery hold was not released');
  }
}
