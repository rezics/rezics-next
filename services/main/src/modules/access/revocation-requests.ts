// IAM07/IAM29 revocation requests. Revoking one source advances the scope epoch
// in the same transaction; a strong request also fixes the admitted command and
// private-read work that must end before completion is acknowledged.
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import {
  agentPattern, generationPattern, PolicyConflict, PolicyDenied, PolicyInvalid, PolicyStale,
  PolicyUnavailable, uuidPattern,
} from './policy-errors.ts';
import {
  advanceScopeEpoch, inAccessTransaction, requireActivePrincipal, requireMandate,
  requireRecoveryOpen,
} from './policy-transaction.ts';
import {
  REVOCATION_AFFECTED_WORK_LIMIT, type RevocationReceiptRow, type RevocationRow,
} from './revocation-schema.ts';

export const REVOKE_ACTION = 'access.revoke';

export interface RevocationRequest {
  revocationId: string; issuerSubject: string; mode: 'ordinary' | 'strong'; scopeId: string;
  expectedAuthorityEpoch: string;
  target: { kind: 'permission_grant' | 'representation'; id: string; expectedGeneration: string };
}
export interface RevocationView {
  revocationId: string; mode: 'ordinary' | 'strong'; state: 'draining' | 'completed';
  target: { kind: string; id: string; generation: string }; scopeId: string;
  fenceAuthorityEpoch: string; affectedWork: number; pending: number;
}

const targets = {
  permission_grant: { table: 'permission_grant', issuer: 'issuer_subject', scope: 'scope_id',
    admission: 'represented_grant_id', lease: 'grant_id' },
  representation: { table: 'representation', issuer: 'subject_id', scope: null,
    admission: 'represented_representation_id', lease: 'representation_id' },
} as const;

async function pendingWork(client: PoolClient, revocationId: string): Promise<number> {
  return Number((await client.query<{ n: string }>(`SELECT
      (SELECT count(*) FROM access.revocation_affected_work w JOIN access.admission a
        ON a.id = w.admission_id WHERE w.revocation_id = $1 AND a.state <> 'sealed')
    + (SELECT count(*) FROM access.revocation_affected_work w JOIN access.search_read_lease l
        ON l.id = w.search_read_lease_id WHERE w.revocation_id = $1
          AND l.state IN ('admitted', 'delivering'))
    + (SELECT count(*) FROM access.revocation_affected_work w JOIN access.download_read_lease l
        ON l.id = w.download_read_lease_id WHERE w.revocation_id = $1
          AND l.state IN ('admitted', 'delivering')) AS n`, [revocationId])).rows[0]!.n);
}

function view(row: RevocationRow, pending: number): RevocationView {
  const id = row.permission_grant_id ?? row.representation_id ?? '';
  return { revocationId: row.id, mode: row.mode, state: row.state, scopeId: row.scope_id,
    target: { kind: row.target_kind, id, generation: row.target_generation },
    fenceAuthorityEpoch: row.fence_authority_epoch, affectedWork: row.affected_work, pending };
}

export class AccessRevocations {
  constructor(private readonly pool: Pool) {}

  async revoke(principal: VerifiedPrincipal, request: RevocationRequest,
    receipt: { idempotencyKey: string; requestDigest: string }): Promise<RevocationView & { replayed: boolean }> {
    const shape = targets[request.target.kind];
    if (!shape || !uuidPattern.test(request.revocationId) || !uuidPattern.test(request.target.id)
      || !agentPattern.test(request.issuerSubject) || !['ordinary', 'strong'].includes(request.mode)
      || !generationPattern.test(request.target.expectedGeneration)
      || !generationPattern.test(request.expectedAuthorityEpoch) || !request.scopeId
      || request.scopeId.length > 256 || !receipt.idempotencyKey || receipt.idempotencyKey.length > 128
      || receipt.idempotencyKey.includes('\0') || !/^[0-9a-f]{64}$/.test(receipt.requestDigest)) {
      throw new PolicyInvalid('invalid revocation request');
    }
    return inAccessTransaction(this.pool, 'read committed', async client => {
      const recoveryGeneration = await requireRecoveryOpen(client, true);
      const identity = await requireActivePrincipal(client, principal);
      // A closed scope still accepts a revocation: fencing never needs an open gate.
      const gate = (await client.query<{ authority_epoch: string }>(`SELECT authority_epoch
        FROM access.scope_gate WHERE id = $1 FOR UPDATE`, [request.scopeId])).rows[0];
      if (!gate) throw new PolicyDenied('scope is unavailable');
      await requireMandate(client, identity.id, request.issuerSubject, REVOKE_ACTION);
      const prior = (await client.query<RevocationReceiptRow>(`SELECT * FROM access.revocation_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [identity.id, receipt.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== receipt.requestDigest || prior.revocation_id !== request.revocationId) {
          throw new PolicyConflict('revocation key binds another intent');
        }
        const row = (await client.query<RevocationRow>('SELECT * FROM access.revocation WHERE id = $1',
          [prior.revocation_id])).rows[0]!;
        return { ...view(row, await pendingWork(client, row.id)), replayed: true };
      }
      if (gate.authority_epoch !== request.expectedAuthorityEpoch) throw new PolicyStale('scope authority changed');
      const target = (await client.query<{ active: boolean; generation: string; issuer: string;
        scope: string | null }>(`SELECT active, generation, ${shape.issuer} AS issuer,
          ${shape.scope ?? 'NULL::text'} AS scope FROM access.${shape.table} WHERE id = $1 FOR UPDATE`,
      [request.target.id])).rows[0];
      if (!target || target.issuer !== request.issuerSubject) throw new PolicyDenied('source is unavailable to issuer');
      if (target.scope !== null && target.scope !== request.scopeId) throw new PolicyInvalid('source is in another scope');
      if (target.generation !== request.target.expectedGeneration) throw new PolicyStale('source changed');
      const earlier = await client.query(`SELECT 1 FROM access.revocation WHERE ${request.target.kind}_id = $1`,
        [request.target.id]);
      if (earlier.rows[0]) throw new PolicyConflict('source already has a revocation');
      const generation = target.active ? (await client.query<{ generation: string }>(`UPDATE
        access.${shape.table} SET active = false WHERE id = $1 RETURNING generation`,
      [request.target.id])).rows[0]!.generation : target.generation;
      if (generation === '0') throw new PolicyStale('source was never admitted');
      const fence = await advanceScopeEpoch(client, request.scopeId);
      let admissions: string[] = [];
      let reads: string[] = [];
      let downloads: string[] = [];
      if (request.mode === 'strong') {
        admissions = (await client.query<{ id: string }>(`SELECT id FROM access.admission
          WHERE ${shape.admission} = $1 AND state <> 'sealed' ORDER BY id
          LIMIT ${REVOCATION_AFFECTED_WORK_LIMIT + 1}`, [request.target.id])).rows.map(row => row.id);
        reads = (await client.query<{ id: string }>(`SELECT id FROM access.search_read_lease
          WHERE ${shape.lease} = $1 AND state IN ('admitted', 'delivering') ORDER BY id
          LIMIT ${REVOCATION_AFFECTED_WORK_LIMIT + 1}`, [request.target.id])).rows.map(row => row.id);
        downloads = (await client.query<{ id: string }>(`SELECT id FROM access.download_read_lease
          WHERE ${shape.lease} = $1 AND state IN ('admitted', 'delivering') ORDER BY id
          LIMIT ${REVOCATION_AFFECTED_WORK_LIMIT + 1}`, [request.target.id])).rows.map(row => row.id);
        if (admissions.length + reads.length + downloads.length > REVOCATION_AFFECTED_WORK_LIMIT) {
          throw new PolicyUnavailable('strong revocation exceeds its drain budget');
        }
      }
      const affected = admissions.length + reads.length + downloads.length;
      await client.query(`INSERT INTO access.revocation (id, principal_id, issuer_subject, mode,
          target_kind, ${request.target.kind}_id, target_generation, scope_id, fence_authority_epoch,
          recovery_generation, affected_work, state, completed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          CASE WHEN $12 = 'completed' THEN clock_timestamp() END)`,
      [request.revocationId, identity.id, request.issuerSubject, request.mode, request.target.kind,
        request.target.id, generation, request.scopeId, fence, recoveryGeneration, affected,
        affected > 0 ? 'draining' : 'completed']);
      if (affected > 0) {
        await client.query(`INSERT INTO access.revocation_affected_work (revocation_id, ordinal,
            admission_id, search_read_lease_id, download_read_lease_id)
          SELECT $1, w.ordinal, w.admission_id, w.search_read_lease_id, w.download_read_lease_id
          FROM jsonb_to_recordset($2::jsonb) AS w(ordinal smallint, admission_id uuid,
            search_read_lease_id uuid, download_read_lease_id uuid)`, [request.revocationId, JSON.stringify([
          ...admissions.map(id => ({ admission_id: id, search_read_lease_id: null, download_read_lease_id: null })),
          ...reads.map(id => ({ admission_id: null, search_read_lease_id: id, download_read_lease_id: null })),
          ...downloads.map(id => ({ admission_id: null, search_read_lease_id: null, download_read_lease_id: id })),
        ].map((row, index) => ({ ordinal: index + 1, ...row })))]);
        // No byte of an undelivered read may start after the fence; delivering
        // reads stay pending until their matched receipt or abort.
        await client.query(`UPDATE access.search_read_lease SET state = 'aborted',
          finished_at = clock_timestamp() WHERE id = ANY($1::uuid[]) AND state = 'admitted'`, [reads]);
        await client.query(`UPDATE access.download_read_lease SET state = 'aborted',
          finished_at = clock_timestamp() WHERE id = ANY($1::uuid[]) AND state = 'admitted'`, [downloads]);
      }
      await client.query(`INSERT INTO access.revocation_receipt (principal_id, idempotency_key,
          request_digest, revocation_id, result_authority_epoch) VALUES ($1, $2, $3, $4, $5)`,
      [identity.id, receipt.idempotencyKey, receipt.requestDigest, request.revocationId, fence]);
      const row = (await client.query<RevocationRow>('SELECT * FROM access.revocation WHERE id = $1',
        [request.revocationId])).rows[0]!;
      return { ...view(row, await pendingWork(client, row.id)), replayed: false };
    });
  }

  /** Completion is acknowledged only when the fixed drain list is terminal. */
  async read(principal: VerifiedPrincipal, issuerSubject: string, revocationId: string): Promise<RevocationView> {
    if (!agentPattern.test(issuerSubject) || !uuidPattern.test(revocationId)) {
      throw new PolicyInvalid('invalid revocation read');
    }
    return inAccessTransaction(this.pool, 'read committed', async client => {
      await requireRecoveryOpen(client, true);
      const identity = await requireActivePrincipal(client, principal);
      await requireMandate(client, identity.id, issuerSubject, REVOKE_ACTION);
      let row = (await client.query<RevocationRow>(`SELECT * FROM access.revocation
        WHERE id = $1 AND issuer_subject = $2 FOR UPDATE`, [revocationId, issuerSubject])).rows[0];
      if (!row) throw new PolicyDenied('revocation is unavailable to issuer');
      const pending = await pendingWork(client, row.id);
      if (row.state === 'draining' && pending === 0) {
        row = (await client.query<RevocationRow>(`UPDATE access.revocation SET state = 'completed',
          completed_at = clock_timestamp() WHERE id = $1 RETURNING *`, [row.id])).rows[0]!;
      }
      return view(row, pending);
    });
  }
}
