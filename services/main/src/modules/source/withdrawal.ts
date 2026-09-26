import type { Pool } from 'pg';

export class FieldWithdrawalInvalid extends Error {}
export class FieldWithdrawalConflict extends Error {}
export class FieldWithdrawalPending extends Error {}
export class FieldWithdrawalUnavailable extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IRI = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const id = (value: string) => IRI.exec(value)?.[1] ?? (UUID.test(value) ? value : null);
const iri = (value: string) => `https://rezics.com/id/${value}`;

interface SupportRow {
  id: string; principal_id: string; target: string; slot: string; occurrence: string | null;
  context: string; record_id: string; settled_step_id: string | null; pending_step_id: string | null;
  conversion_id: string | null; mapping_revision: string | null; grain: string | null;
  source_field: string | null; source_occurrence: string | null; value_digest: string | null;
  native_revision: string | null; graph_receipt: string | null;
  head_guarantee: 'transaction-guarded' | 'verified-before-commit' | null;
  outcome: string | null; created_at: Date;
  withdrawal_id: string | null; withdrawal_key: string | null; withdrawal_reason: string | null;
  withdrawn_at: Date | null;
}

export interface FieldSupportResult {
  profile: 'source-field-support-v1'; state: 'recorded' | 'withdrawn'; support: string;
  supportIdentity: string; target: string; slot: string; occurrence: string | null;
  context: string; sourceRecord: string; conversion: string; mappingRevision: string;
  grain: string; sourceField: string; sourceOccurrence: string | null; valueDigest: string;
  nativeRevision: string | null; graphReceipt: string | null;
  headGuarantee: 'transaction-guarded' | 'verified-before-commit';
  outcome: 'applied' | 'attached' | 'returned';
  createdAt: string;
  withdrawal: null | { profile: 'source-field-withdrawal-v1'; state: 'withdrawn';
    withdrawal: string; support: string; supportIdentity: string; reason: string; createdAt: string;
    nativeEffect: 'none' };
}

const readSql = `SELECT s.*, h.settled_step_id, h.pending_step_id, st.conversion_id,
  st.mapping_revision, st.grain, st.source_field, st.source_occurrence, st.value_digest,
  out.native_revision, out.graph_receipt, out.head_guarantee, out.outcome,
  w.id AS withdrawal_id, w.idempotency_key AS withdrawal_key,
  w.reason AS withdrawal_reason, w.created_at AS withdrawn_at
  FROM source.field_support s JOIN source.field_support_head h ON h.support_id = s.id
  LEFT JOIN source.field_support_step st ON st.id = h.settled_step_id
  LEFT JOIN source.field_support_outcome out ON out.step_id = st.id
  LEFT JOIN source.field_support_withdrawal w ON w.support_id = s.id
  WHERE s.id = $1 AND s.principal_id = $2`;

/** Three indexed native-family identity probes; no target or history enumeration. */
export const nativeSupportLookupSql = `
  SELECT 'title' AS kind, b.work FROM source.native_work_binding b
    WHERE b.id = $1 AND b.principal_id = $2
  UNION ALL SELECT 'title' AS kind, a.work FROM source.native_work_support_attachment a
    WHERE a.id = $1 AND a.principal_id = $2
  UNION ALL SELECT 'author-credit' AS kind, c.work FROM source.author_credit_intent c
    WHERE c.id = $1 AND c.principal_id = $2
  LIMIT 2`;

function result(row: SupportRow): FieldSupportResult {
  if (!row.settled_step_id || !row.conversion_id || !row.mapping_revision || !row.grain
    || !row.source_field || !row.value_digest || !row.head_guarantee
    || !['applied', 'attached', 'returned'].includes(row.outcome ?? '')) {
    throw new FieldWithdrawalUnavailable('support has no settled native evidence');
  }
  const support = iri(row.id), supportIdentity = iri(row.settled_step_id);
  return { profile: 'source-field-support-v1', state: row.withdrawal_id ? 'withdrawn' : 'recorded',
    support, supportIdentity, target: row.target, slot: row.slot, occurrence: row.occurrence,
    context: row.context, sourceRecord: iri(row.record_id), conversion: iri(row.conversion_id),
    mappingRevision: row.mapping_revision, grain: row.grain, sourceField: row.source_field,
    sourceOccurrence: row.source_occurrence, valueDigest: row.value_digest,
    nativeRevision: row.native_revision, graphReceipt: row.graph_receipt,
    headGuarantee: row.head_guarantee,
    outcome: row.outcome as FieldSupportResult['outcome'], createdAt: row.created_at.toISOString(),
    withdrawal: row.withdrawal_id && row.withdrawal_reason && row.withdrawn_at ? {
      profile: 'source-field-withdrawal-v1', state: 'withdrawn',
      withdrawal: iri(row.withdrawal_id), support, supportIdentity,
      reason: row.withdrawal_reason, createdAt: row.withdrawn_at.toISOString(),
      nativeEffect: 'none',
    } : null };
}

/** One primary-key row lock, bounded joins and one immutable insert per support. */
export class SourceFieldWithdrawalStore {
  constructor(private readonly pool: Pool) {}

  /** Locate legacy native supports by their immutable owner key, never by a provider alias. */
  async locateNative(principalId: string, support: string): Promise<{
    kind: 'title' | 'author-credit'; work: string;
  } | null> {
    const supportId = id(support);
    if (!UUID.test(principalId) || !supportId) throw new FieldWithdrawalInvalid('invalid support identity');
    const rows = (await this.pool.query<{ kind: 'title' | 'author-credit'; work: string }>(
      nativeSupportLookupSql, [supportId, principalId])).rows;
    if (rows.length > 1) throw new FieldWithdrawalUnavailable('support identity is ambiguous');
    return rows[0] ?? null;
  }

  async read(principalId: string, support: string): Promise<FieldSupportResult | null> {
    const supportId = id(support);
    if (!UUID.test(principalId) || !supportId) throw new FieldWithdrawalInvalid('invalid support identity');
    const row = (await this.pool.query<SupportRow>(readSql, [supportId, principalId])).rows[0];
    if (!row) return null;
    const value = result(row);
    const evidence = (await this.pool.query<{ valid: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM source.field_support_step st
      JOIN source.conversion c ON c.id = st.conversion_id AND c.principal_id = st.principal_id
      JOIN source.observation o ON o.id = c.observation_id
      JOIN source.field_disposition d ON d.mapping_revision = st.mapping_revision
        AND d.grain = st.grain AND d.field_key = st.source_field
      WHERE st.id = $1 AND o.record_id = $2 AND d.native_target = $3
        AND d.disposition IN ('native', 'lossy')) AS valid`,
    [row.settled_step_id, row.record_id, row.slot])).rows[0];
    if (!evidence?.valid) throw new FieldWithdrawalUnavailable('source evidence is unavailable');
    return value;
  }

  async withdraw(principalId: string, key: string, input: { support: string;
    expectedSupport: string; reason: string }): Promise<{ support: FieldSupportResult; replayed: boolean } | null> {
    const supportId = id(input.support), expected = id(input.expectedSupport);
    if (!UUID.test(principalId) || !KEY.test(key) || !supportId || !expected
      || input.reason.trim() !== input.reason || input.reason.length < 1 || input.reason.length > 500
      || /[\u0000-\u001f\u007f]/.test(input.reason)) {
      throw new FieldWithdrawalInvalid('invalid field withdrawal');
    }
    const client = await this.pool.connect();
    let replayed = false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL transaction_timeout = '5s'");
      const row = (await client.query<SupportRow>(`${readSql} FOR UPDATE OF h`,
        [supportId, principalId])).rows[0];
      if (!row) { await client.query('COMMIT'); return null; }
      // Read again after acquiring the head lock. A query that waited for another
      // transaction may have joined withdrawal rows from its earlier snapshot.
      const prior = (await client.query<{ idempotency_key: string; reason: string;
        expected_step_id: string | null }>(`SELECT idempotency_key, reason, expected_step_id
        FROM source.field_support_withdrawal WHERE support_id = $1`, [supportId])).rows[0];
      if (prior) {
        if (prior.idempotency_key !== key || prior.reason !== input.reason
          || prior.expected_step_id !== expected) {
          throw new FieldWithdrawalConflict('withdrawal intent differs');
        }
        replayed = true;
      } else {
        if (row.pending_step_id) throw new FieldWithdrawalPending('field support step needs reconciliation');
        if (row.settled_step_id !== expected || !row.outcome || row.outcome === 'not-applied') {
          throw new FieldWithdrawalConflict('field support identity changed');
        }
        await client.query(`INSERT INTO source.field_support_withdrawal
          (id, support_id, principal_id, expected_step_id, idempotency_key, reason)
          VALUES ($1,$2,$3,$4,$5,$6)`,
        [Bun.randomUUIDv7(), supportId, principalId, expected, key, input.reason]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof FieldWithdrawalConflict || error instanceof FieldWithdrawalPending) throw error;
      if (['23505', '23514', '55P03', '57014'].includes((error as { code?: string }).code ?? '')) {
        throw new FieldWithdrawalConflict('field support changed during withdrawal');
      }
      throw error;
    } finally { client.release(); }
    const support = await this.read(principalId, supportId);
    if (!support?.withdrawal) throw new FieldWithdrawalUnavailable('withdrawal receipt is unavailable');
    return { support, replayed };
  }
}
