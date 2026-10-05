import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { RegisteredAdmission } from '../access/admission.ts';
import type { GraphTerminalProof } from '../access/admission.ts';
import { ContentUnavailable } from '../../../../content/src/errors.ts';
import { advanceContentSequence, ContentSequenceUnavailable, settledContentPosition } from '../content-sequence.ts';
import { canonicalExport, type ExportPlan } from './planner.ts';

export class ExportConflict extends Error {}
export class ExportDenied extends Error {}
export class ExportNotFound extends Error {}
export class ExportUnavailable extends Error {}

export interface SealedExport {
  manifestId: string;
  manifestDigest: string;
  plan: ExportPlan;
  position: { owner: 'content'; dataEpoch: string; sequence: string };
  replayed: boolean;
}

interface ManifestRecord {
  id: string; request_digest: string; admission_id: string; manifest_digest: string;
  data_epoch: string | null; sequence: string | null; payload: Record<string, unknown>;
  terminal_digest: string | null; terminal_action: string | null; terminal_outcome: string | null;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const operation = (admissionId: string) => `export:${admissionId}`;

export function exportTerminal(admission: RegisteredAdmission,
  position: { dataEpoch: string; sequence: string }, outcome: GraphTerminalProof['outcome']): GraphTerminalProof {
  return { outcome, receipt: `urn:rezics:receipt:${digest(`${admission.id}\0export-create-v1`)}`,
    admissionId: admission.id, requestDigest: admission.requestDigest,
    authorityEpoch: admission.authorityEpoch, scope: admission.scope,
    dataEpoch: position.dataEpoch, sequence: position.sequence };
}

/** Content 121/180 writer: one immutable manifest and one exact owner receipt per admission.
 * The manifest names its receipt by operation; the sequencer numbers that receipt. */
export class ExportStore {
  constructor(private readonly pool: Pool) {}

  private async positionOf(admissionId: string) {
    try { return await settledContentPosition(this.pool, operation(admissionId)); }
    catch (error) {
      if (error instanceof ContentUnavailable) throw new ExportUnavailable(error.message);
      throw error;
    }
  }

  private async readIn(client: PoolClient, principalId: string, manifestId: string): Promise<SealedExport> {
    const row = (await client.query<ManifestRecord>(`SELECT m.id, m.request_digest, m.admission_id,
      m.manifest_digest, r.data_epoch, r.sequence::text, m.payload, r.request_digest AS terminal_digest,
      r.action AS terminal_action, r.outcome AS terminal_outcome
      FROM export.manifest m LEFT JOIN content.receipt r ON r.operation_id = 'export:' || m.admission_id
      WHERE m.id = $1 AND m.principal_id = $2 AND m.state = 'sealed'`,
    [manifestId, principalId])).rows[0];
    if (!row) throw new ExportNotFound('sealed export is unavailable');
    if (!row.payload || !row.data_epoch || !row.sequence) {
      throw new ExportUnavailable('sealed export is unavailable');
    }
    if (row.terminal_digest !== row.request_digest
      || row.terminal_action !== 'export.create' || row.terminal_outcome !== 'succeeded'
      || digest(canonicalExport(row.payload)) !== row.manifest_digest) {
      throw new ExportUnavailable('export terminal proof differs');
    }
    const core = row.payload as Omit<ExportPlan, 'manifestDigest' | 'work'>;
    return { manifestId: row.id, manifestDigest: row.manifest_digest,
      plan: { ...core, manifestDigest: row.manifest_digest,
        work: { members: core.members.length, residuals: core.residuals.length,
          bases: core.bases.length, basisLinks: core.bases.reduce((n, b) => n + b.memberOrdinals.length, 0),
          bytes: Buffer.byteLength(canonicalExport(core)) } },
      position: { owner: 'content', dataEpoch: row.data_epoch, sequence: row.sequence }, replayed: false };
  }

  async read(principalId: string, manifestId: string): Promise<SealedExport> {
    const client = await this.pool.connect();
    try { return await this.readIn(client, principalId, manifestId); }
    finally { client.release(); }
  }

  async readByAdmission(principalId: string, admissionId: string): Promise<SealedExport | null> {
    const row = (await this.pool.query<{ id: string }>(`SELECT id FROM export.manifest
      WHERE principal_id = $1 AND admission_id = $2 AND state = 'sealed' LIMIT 2`,
    [principalId, admissionId])).rows;
    if (row.length > 1) throw new ExportUnavailable('admission has multiple manifests');
    return row[0] ? this.read(principalId, row[0].id) : null;
  }

  async seal(admission: RegisteredAdmission, plan: ExportPlan): Promise<SealedExport> {
    if (admission.action !== 'export.create' || !['claimed', 'sealed'].includes(admission.state)
      || plan.licenseScope === 'blocked') throw new ExportDenied('export was not admitted for sealing');
    const { manifestDigest, work: _work, ...core } = plan;
    if (digest(canonicalExport(core)) !== manifestDigest) throw new ExportConflict('export plan changed');
    const client = await this.pool.connect().catch(() => { throw new ExportUnavailable('Content owner is unavailable'); });
    let sealed: { id: string; replayed: boolean };
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      // The unique principal/key index serializes same-key writers. The admission
      // identity also binds the Access action and digest to this immutable row.
      const prior = (await client.query<{ id: string; request_digest: string; admission_id: string;
        manifest_digest: string }>(`SELECT id, request_digest, admission_id, manifest_digest
        FROM export.manifest WHERE principal_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [admission.principalId, admission.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== admission.requestDigest || prior.admission_id !== admission.id
          || prior.manifest_digest !== manifestDigest) throw new ExportConflict('export key binds another intent');
        await client.query('COMMIT');
        sealed = { id: prior.id, replayed: true };
      } else sealed = { id: await this.record(client, admission, plan, core, manifestDigest), replayed: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ContentSequenceUnavailable) throw new ExportUnavailable(error.message);
      const code = (error as { code?: string }).code;
      if (code === '23505') {
        const prior = (await client.query<{ id: string; request_digest: string; admission_id: string;
          manifest_digest: string }>(`SELECT id, request_digest, admission_id, manifest_digest
          FROM export.manifest WHERE principal_id = $1 AND idempotency_key = $2`,
        [admission.principalId, admission.idempotencyKey])).rows[0];
        if (prior && prior.request_digest === admission.requestDigest
          && prior.admission_id === admission.id && prior.manifest_digest === manifestDigest) {
          sealed = { id: prior.id, replayed: true };
        } else throw new ExportConflict('concurrent export key or owner position');
      } else if (code === '23514' || code === '23503') throw new ExportConflict('export owner rejected its input');
      else throw error;
    } finally { client.release(); }
    // The Access admission is sealed from this exact Content receipt position.
    await this.positionOf(admission.id);
    return { ...await this.read(admission.principalId, sealed.id), replayed: sealed.replayed };
  }

  /** The new manifest id; commits the caller's transaction. */
  private async record(client: PoolClient, admission: RegisteredAdmission, plan: ExportPlan,
    core: Omit<ExportPlan, 'manifestDigest' | 'work'>, manifestDigest: string): Promise<string> {
    await advanceContentSequence(client, {
      operationId: operation(admission.id), requestDigest: admission.requestDigest,
      action: 'export.create', outcome: 'succeeded', eventType: 'export.manifest.sealed',
      recipe: 'export-v1', payload: {},
    });
    const id = randomUUID();
    await client.query(`INSERT INTO export.manifest (id, principal_id, idempotency_key,
      request_digest, admission_id, authority_epoch, target_profile, use_scope, state,
      completeness, license_scope, license_expression, member_count, residual_count,
      manifest_digest, payload, sealed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staged',$9,$10,$11,0,0,$12,$13,NULL)`,
    [id, admission.principalId, admission.idempotencyKey, admission.requestDigest, admission.id,
      admission.authorityEpoch, plan.targetProfile, plan.useScope, plan.completeness,
      plan.licenseScope, plan.licenseExpression, manifestDigest, JSON.stringify(core)]);
    for (const item of plan.members) {
      await client.query(`INSERT INTO export.member (manifest_id, ordinal, source_owner, source_namespace,
        source_grain, exact_ref, content_revision_id, ref_digest, owner_data_epoch, owner_sequence,
        source_position, target_grain, mapping)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11,$12,$13)`,
      [id, item.ordinal, item.sourceOwner, item.sourceNamespace, item.sourceGrain, item.exactRef,
        item.contentRevisionId, item.refDigest, item.ownerDataEpoch, item.ownerSequence,
        item.sourcePosition, item.targetGrain, item.mapping]);
    }
    for (const item of plan.residuals) {
      await client.query(`INSERT INTO export.residual (manifest_id, ordinal, member_ordinal, kind, path, detail)
        VALUES ($1,$2,$3,$4,$5,$6)`, [id, item.ordinal, item.memberOrdinal, item.kind,
        item.path, JSON.stringify(item.detail)]);
    }
    for (const item of plan.bases) {
      await client.query(`INSERT INTO export.rights_basis (manifest_id, ordinal, basis_kind,
        basis_ref, license_expression, notice, obligations) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, item.ordinal, item.basisKind, item.basisRef, item.licenseExpression,
        item.notice, item.obligations]);
      for (const memberOrdinal of item.memberOrdinals) {
        await client.query(`INSERT INTO export.member_basis (manifest_id, member_ordinal, basis_ordinal)
          VALUES ($1,$2,$3)`, [id, memberOrdinal, item.ordinal]);
      }
    }
    await client.query(`UPDATE export.manifest SET state = 'sealed', sealed_at = clock_timestamp(),
      member_count = $2, residual_count = $3 WHERE id = $1`,
    [id, plan.members.length, plan.residuals.length]);
    await client.query('COMMIT');
    return id;
  }

  /** Seal a refused or stale Access admission from a real Content receipt. */
  async cancel(admission: RegisteredAdmission): Promise<GraphTerminalProof> {
    const client = await this.pool.connect();
    let outcome: GraphTerminalProof['outcome'];
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      const existing = (await client.query<{ request_digest: string; outcome: string }>(
        `SELECT request_digest, outcome FROM content.receipt WHERE operation_id = $1`,
        [operation(admission.id)])).rows[0];
      if (existing) {
        if (existing.request_digest !== admission.requestDigest) throw new ExportConflict('export receipt changed');
        outcome = existing.outcome === 'succeeded' ? 'succeeded' : 'cancelled';
      } else {
        await advanceContentSequence(client, {
          operationId: operation(admission.id), requestDigest: admission.requestDigest,
          action: 'export.create', outcome: 'rejected', eventType: 'export.create.cancelled',
          reason: 'export input or authority did not permit sealing', recipe: 'export-v1', payload: {},
        });
        outcome = 'cancelled';
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ContentSequenceUnavailable) throw new ExportUnavailable(error.message);
      if ((error as { code?: string }).code !== '23505') throw error;
      const existing = (await client.query<{ request_digest: string; outcome: string }>(
        `SELECT request_digest, outcome FROM content.receipt WHERE operation_id = $1`,
        [operation(admission.id)])).rows[0];
      if (existing?.request_digest !== admission.requestDigest) {
        throw new ExportConflict('export terminal receipt changed concurrently');
      }
      outcome = existing.outcome === 'succeeded' ? 'succeeded' : 'cancelled';
    } finally { client.release(); }
    return exportTerminal(admission, await this.positionOf(admission.id), outcome);
  }
}
