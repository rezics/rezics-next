import type { Pool, PoolClient } from 'pg';

export interface ThemeActivationRecord {
  theme: string;
  revision: string;
  predecessor: string | null;
  approvalGeneration: string;
  owner: string;
  dependencyDigest: string;
  capabilityDigest: string;
  capabilities: ThemeCapabilities;
  origin: string;
  runtime: 'worker-isolated-v1';
  approvalId: string;
  approvedBy: string;
  approvedAt: string;
  approvalExpiresAt: string;
  graphReceipt: string;
  graphDataEpoch: string;
  graphSequence: string;
}

export interface ThemeCapabilities {
  data: 'public-only';
  secrets: false;
  networkOrigins: string[];
  cpuMs: number;
  memoryMiB: number;
}

export class ThemeStoreUnavailable extends Error {}
export class ThemeStoreConflict extends Error {}

interface ThemeRow {
  theme_id: string;
  revision_id: string;
  predecessor_id: string | null;
  approval_generation: string;
  owner: string;
  dependency_digest: string;
  capability_digest: string;
  capabilities: ThemeCapabilities;
  origin: string;
  runtime: 'worker-isolated-v1';
  approval_id: string;
  approved_by: string;
  approved_at: Date;
  approval_expires_at: Date;
  graph_receipt: string;
  graph_data_epoch: string;
  graph_sequence: string;
}

function fromRow(row: ThemeRow): ThemeActivationRecord {
  return { theme: row.theme_id, revision: row.revision_id,
    predecessor: row.predecessor_id, approvalGeneration: row.approval_generation,
    owner: row.owner, dependencyDigest: row.dependency_digest,
    capabilityDigest: row.capability_digest, capabilities: row.capabilities,
    origin: row.origin, runtime: row.runtime, approvalId: row.approval_id,
    approvedBy: row.approved_by, approvedAt: row.approved_at.toISOString(),
    approvalExpiresAt: row.approval_expires_at.toISOString(), graphReceipt: row.graph_receipt,
    graphDataEpoch: row.graph_data_epoch, graphSequence: row.graph_sequence };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]));
  return value;
}

function stableRecord(record: ThemeActivationRecord): unknown {
  // Jena may serialize xsd:dateTime without trailing fractional zeroes; PostgreSQL
  // returns the same instant with three millisecond digits.
  const approvedAt = Date.parse(record.approvedAt);
  const approvalExpiresAt = Date.parse(record.approvalExpiresAt);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(approvalExpiresAt)) {
    throw new ThemeStoreConflict('theme approval timestamps are invalid');
  }
  return stable({ ...record, approvedAt, approvalExpiresAt });
}

/** Content retains the latest monotone approval basis alongside immutable history. */
export class ThemeStore {
  statements = 0;
  constructor(private readonly pool: Pool) {}

  private query<T extends Record<string, unknown>>(client: Pool | PoolClient,
    sql: string, values: unknown[] = []) {
    this.statements++;
    return client.query<T>(sql, values);
  }

  async read(theme: string): Promise<ThemeActivationRecord | null> {
    const result = await this.query<ThemeRow & Record<string, unknown>>(this.pool, `SELECT
      a.theme_id::text, a.revision_id::text, a.predecessor_id::text, a.approval_generation::text,
      a.owner, a.dependency_digest, a.capability_digest, a.capabilities, a.origin, a.runtime,
      a.approval_id::text, a.approved_by, a.approved_at, a.approval_expires_at,
      a.graph_receipt, a.graph_data_epoch::text, a.graph_sequence::text
      FROM content.theme_activation_head h JOIN content.theme_activation a
        ON a.theme_id = h.theme_id AND a.revision_id = h.revision_id
      WHERE h.theme_id = $1`, [theme]);
    if ((result.rowCount ?? result.rows.length) > 1) throw new ThemeStoreUnavailable('ambiguous theme activation head');
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  /**
   * Project a graph terminal receipt into Content. This is idempotent; the
   * advisory lock and guarded head update make parallel retries single-winner.
   */
  async record(record: ThemeActivationRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      this.statements++;
      await client.query("SET LOCAL lock_timeout = '2s'");
      this.statements++;
      await client.query("SET LOCAL statement_timeout = '5s'");
      this.statements++;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [record.theme]);
      const saved = await this.query<ThemeRow & Record<string, unknown>>(client, `SELECT
        theme_id::text, revision_id::text, predecessor_id::text, approval_generation::text,
        owner, dependency_digest, capability_digest, capabilities, origin, runtime,
        approval_id::text, approved_by, approved_at, approval_expires_at,
        graph_receipt, graph_data_epoch::text, graph_sequence::text
        FROM content.theme_activation WHERE graph_receipt = $1`, [record.graphReceipt]);
      if ((saved.rowCount ?? saved.rows.length) === 1) {
        const existing = fromRow(saved.rows[0]!);
        if (JSON.stringify(stableRecord(existing)) !== JSON.stringify(stableRecord(record))) {
          throw new ThemeStoreConflict('graph receipt is already projected with different theme state');
        }
        await client.query('COMMIT');
        return;
      }
      if ((saved.rowCount ?? saved.rows.length) > 1) throw new ThemeStoreUnavailable('ambiguous theme graph receipt');
      const head = await this.query<{ revision_id: string; approval_generation: string } & Record<string, unknown>>(
        client, `SELECT revision_id::text, approval_generation::text
          FROM content.theme_activation_head WHERE theme_id = $1 FOR UPDATE`, [record.theme]);
      const current = head.rows[0];
      if ((current?.revision_id ?? null) !== (record.predecessor ?? null)
        || Number(current?.approval_generation ?? 0) + 1 !== Number(record.approvalGeneration)) {
        throw new ThemeStoreConflict('Content theme head differs from the graph predecessor');
      }
      await this.query(client, `INSERT INTO content.theme_activation
        (theme_id, revision_id, predecessor_id, approval_generation, owner, dependency_digest,
         capability_digest, capabilities, origin, runtime, approval_id, approved_by, approved_at,
         approval_expires_at, graph_receipt, graph_data_epoch, graph_sequence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [
        record.theme, record.revision, record.predecessor, record.approvalGeneration, record.owner,
        record.dependencyDigest, record.capabilityDigest, JSON.stringify(record.capabilities), record.origin,
        record.runtime, record.approvalId, record.approvedBy, record.approvedAt,
        record.approvalExpiresAt, record.graphReceipt, record.graphDataEpoch, record.graphSequence,
      ]);
      if (!current) {
        await this.query(client, `INSERT INTO content.theme_activation_head
          (theme_id, revision_id, approval_generation) VALUES ($1,$2,$3)`,
        [record.theme, record.revision, record.approvalGeneration]);
      } else {
        const advanced = await this.query(client, `UPDATE content.theme_activation_head
          SET revision_id = $2, approval_generation = $3, updated_at = clock_timestamp()
          WHERE theme_id = $1 AND revision_id = $4 AND approval_generation = $5`, [
          record.theme, record.revision, record.approvalGeneration,
          current.revision_id, current.approval_generation,
        ]);
        if (advanced.rowCount !== 1) throw new ThemeStoreConflict('Content theme head changed during projection');
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve first failure */ }
      throw error;
    } finally { client.release(); }
  }
}
