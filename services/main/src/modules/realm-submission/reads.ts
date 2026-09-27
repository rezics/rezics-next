import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { baselineMemberProof } from '../access/baseline.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid } from '../work/read-session.ts';
import { SUBMISSION_COST, SubmissionMissing, SubmissionUnavailable, viewSubmission,
  type SubmissionRow, type SubmissionView } from './schema.ts';

/** Access-private pages use a durable Agent revision and one indexed keyset page.
 * Locks fence recovery, representation revocation and concurrent page mutation. */
export class RealmSubmissionReads {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(run: (client: PoolClient, recoveryGeneration: string) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${SUBMISSION_COST.statementTimeoutMs}ms'`);
      const fence = await client.query('SELECT generation FROM access.recovery_fence WHERE id AND open FOR SHARE');
      if (!fence.rowCount) throw new SubmissionUnavailable('Access recovery is in progress');
      const value = await run(client, String(fence.rows[0].generation));
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  private async authority(client: PoolClient, principal: VerifiedPrincipal, actor: string,
    realm?: string) {
    if (!realm && principal.emailVerified === true) {
      const identity = (await client.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
      [principal.issuer, principal.subject])).rows[0];
      if (identity && await baselineMemberProof(client, identity.id, actor)) return;
    }
    const row = (await client.query(`SELECT 1 FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id AND r.subject_id = $3
        AND r.active AND r.valid_until > clock_timestamp()
        AND ${realm ? "r.action IN ('review.decide','agent.control')" : "r.action = 'submission.submit'"}
      JOIN access.authority_subject s ON s.id = r.subject_id AND s.kind = 'agent' AND s.active
      ${realm ? `JOIN access.permission_grant g ON g.recipient_subject = s.id
        AND g.scope_id = $4 AND g.action = 'review.decide' AND g.active AND g.valid_until > clock_timestamp()
        JOIN access.scope_gate gate ON gate.id = g.scope_id AND gate.open AND gate.dispatch_open` : ''}
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
      LIMIT 1 FOR SHARE OF p, r, s${realm ? ', g, gate' : ''}`,
    [principal.issuer, principal.subject, actor, ...(realm ? [`review:decide:${realm}`] : [])])).rows[0];
    if (!row) throw new SubmissionMissing('Submissions are unavailable');
  }

  mine(principal: VerifiedPrincipal, options: { actingSubject: string; state?: SubmissionView['state'];
    limit?: number; cursor?: string }) {
    const limit = options.limit ?? SUBMISSION_COST.pageSize;
    if (!Number.isInteger(limit) || limit < 1 || limit > SUBMISSION_COST.pageSize) {
      throw new WorkReadInvalid('Invalid page size');
    }
    return this.transaction(async (client, recoveryGeneration) => {
      await this.authority(client, principal, options.actingSubject);
      await client.query(`INSERT INTO access.realm_submission_author_revision VALUES ($1, 0)
        ON CONFLICT DO NOTHING`, [options.actingSubject]);
      const revision = (await client.query<{ revision: string }>(`SELECT revision::text FROM
        access.realm_submission_author_revision WHERE agent = $1 FOR SHARE`, [options.actingSubject])).rows[0]!.revision;
      const position = { dataEpoch: `access:${recoveryGeneration}`, sequence: revision };
      const binding = ['my-realm-submissions', principal, options.actingSubject, options.state ?? null];
      const cursor = decodeReadCursor(options.cursor, binding, position);
      const rows = (await client.query<SubmissionRow & { opened_key: string }>(`SELECT *,
        to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS opened_key
        FROM access.realm_submission WHERE submitting_agent = $1
          AND ${options.state ? 'state = $2' : '$2::text IS NULL'}
          AND ($3::timestamptz IS NULL OR (opened_at, id) > ($3::timestamptz, $4::uuid))
        ORDER BY opened_at, id LIMIT $5`, [options.actingSubject, options.state ?? null,
        cursor?.after ?? null, cursor?.order ?? null, limit + 1])).rows;
      const chosen = rows.slice(0, limit);
      const last = chosen.at(-1);
      return { items: chosen.map(viewSubmission), sourcePosition: position,
        nextCursor: rows.length > limit && last
          ? encodeReadCursor(binding, position, last.opened_key, last.id) : null,
        count: { value: chosen.length, kind: 'exact-page' as const, total: null } };
    });
  }

  review(principal: VerifiedPrincipal, realm: string, id: string, actor: string) {
    return this.transaction(async client => {
      await this.authority(client, principal, actor, realm);
      const row = (await client.query<SubmissionRow>(`SELECT * FROM access.realm_submission
        WHERE realm = $1 AND id = $2`, [realm, id])).rows[0];
      if (!row) throw new SubmissionMissing('Submission is unavailable');
      return { submission: viewSubmission(row), internalNote: row.internal_note };
    });
  }
}
