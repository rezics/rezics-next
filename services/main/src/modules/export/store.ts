import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { RegisteredAdmission } from '../access/admission.ts';
import type { GraphTerminalProof } from '../access/admission.ts';
import { advanceContentSequence, ContentSequenceUnavailable } from '../content-sequence.ts';
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
  data_epoch: string; sequence: string; payload: Record<string, unknown>;
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

/** Content 121/180 writer: one immutable manifest and one exact owner receipt per admission. */
export class ExportStore {
  constructor(private readonly pool: Pool) {}

  private async readIn(client: PoolClient, principalId: string, manifestId: string): Promise<SealedExport> {
    const row = (await client.query<ManifestRecord>(`SELECT m.id, m.request_digest, m.admission_id,
      m.manifest_digest, m.data_epoch, m.sequence::text, m.payload
      FROM export.manifest m WHERE m.id = $1 AND m.principal_id = $2 AND m.state = 'sealed'`,
    [manifestId, principalId])).rows[0];
    if (!row) throw new ExportNotFound('sealed export is unavailable');
    if (!row.payload || !row.data_epoch || !row.sequence) {
      throw new ExportUnavailable('sealed export is unavailable');
    }
    const terminal = (await client.query<{ request_digest: string; action: string; outcome: string }>(
      `SELECT request_digest, action, outcome FROM content.receipt
       WHERE data_epoch = $1 AND sequence = $2::bigint AND operation_id = $3`,
      [row.data_epoch, row.sequence, operation(row.admission_id)])).rows[0];
    if (!terminal || terminal.request_digest !== row.request_digest
      || terminal.action !== 'export.create' || terminal.outcome !== 'succeeded'
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
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      // The unique principal/key index serializes same-key writers. The admission
      // identity also binds the Access action and digest to this immutable row.
      const prior = (await client.query<{ id: string; request_digest: string; admission_id: string;
        manifest_digest: string }>(`SELECT id, request_digest, admission_id, manifest_digest
        FROM export.manifest WHERE principal_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [admission.principalId, admission.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== admission.requestDigest || prior.admission_id !== admission.id
          || prior.manifest_digest !== manifestDigest) throw new ExportConflict('export key binds another intent');
        const saved = await this.readIn(client, admission.principalId, prior.id);
        await client.query('COMMIT');
        return { ...saved, replayed: true };
      }
      const owner = await advanceContentSequence(client, {
        operationId: operation(admission.id), requestDigest: admission.requestDigest,
        action: 'export.create', outcome: 'succeeded', eventType: 'export.manifest.sealed',
        recipe: 'export-v1', payload: {},
      });
      const id = randomUUID();
      await client.query(`INSERT INTO export.manifest (id, principal_id, idempotency_key,
        request_digest, admission_id, authority_epoch, target_profile, use_scope, state,
        completeness, license_scope, license_expression, member_count, residual_count,
        manifest_digest, data_epoch, sequence, payload, sealed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staged',$9,$10,$11,0,0,$12,$13,$14,$15,NULL)`,
      [id, admission.principalId, admission.idempotencyKey, admission.requestDigest, admission.id,
        admission.authorityEpoch, plan.targetProfile, plan.useScope, plan.completeness,
        plan.licenseScope, plan.licenseExpression, manifestDigest, owner.dataEpoch,
        owner.sequence, JSON.stringify(core)]);
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
      const saved = await this.readIn(client, admission.principalId, id);
      await client.query('COMMIT');
      return saved;
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
          return { ...await this.readIn(client, admission.principalId, prior.id), replayed: true };
        }
        throw new ExportConflict('concurrent export key or owner position');
      }
      if (code === '23514' || code === '23503') throw new ExportConflict('export owner rejected its input');
      throw error;
    } finally { client.release(); }
  }

  /** Seal a refused or stale Access admission from a real Content receipt. */
  async cancel(admission: RegisteredAdmission): Promise<GraphTerminalProof> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const existing = (await client.query<{ request_digest: string; outcome: string;
        data_epoch: string; sequence: string }>(`SELECT request_digest, outcome, data_epoch,
        sequence::text FROM content.receipt WHERE operation_id = $1`, [operation(admission.id)])).rows[0];
      if (existing) {
        if (existing.request_digest !== admission.requestDigest) throw new ExportConflict('export receipt changed');
        await client.query('COMMIT');
        return exportTerminal(admission, { dataEpoch: existing.data_epoch, sequence: existing.sequence },
          existing.outcome === 'succeeded' ? 'succeeded' : 'cancelled');
      }
      const owner = await advanceContentSequence(client, {
        operationId: operation(admission.id), requestDigest: admission.requestDigest,
        action: 'export.create', outcome: 'rejected', eventType: 'export.create.cancelled',
        reason: 'export input or authority did not permit sealing', recipe: 'export-v1', payload: {},
      });
      await client.query('COMMIT');
      return exportTerminal(admission, owner, 'cancelled');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ContentSequenceUnavailable) throw new ExportUnavailable(error.message);
      if ((error as { code?: string }).code === '23505') {
        const existing = (await client.query<{ request_digest: string; outcome: string;
          data_epoch: string; sequence: string }>(`SELECT request_digest, outcome, data_epoch,
          sequence::text FROM content.receipt WHERE operation_id = $1`, [operation(admission.id)])).rows[0];
        if (existing?.request_digest === admission.requestDigest) {
          return exportTerminal(admission, { dataEpoch: existing.data_epoch, sequence: existing.sequence },
            existing.outcome === 'succeeded' ? 'succeeded' : 'cancelled');
        }
        throw new ExportConflict('export terminal receipt changed concurrently');
      }
      throw error;
    } finally { client.release(); }
  }
}
