import { createHash, createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { AdmissionDenied, type RegisteredAdmission } from './admission.ts';
import type { CommandEnvelope } from '../../infrastructure/fuseki.ts';
import type { TitleAdmissionProof } from './title-admission.ts';

const ACTIONS = new Set(['work.protection.tighten', 'work.protection.confirm',
  'work.protection.relax', 'work.correction.propose', 'work.correction.review']);

/** Access-owned proof signer for one exact protected Work command. */
export class ProtectionAdmissionSigner {
  constructor(private readonly pool: Pool, private readonly key = Bun.env.FUSEKI_TITLE_ADMISSION_KEY) {}

  async issue(admission: RegisteredAdmission, command: CommandEnvelope,
    proposerAdmissionId: string | null = null): Promise<TitleAdmissionProof> {
    const row = (await this.pool.query<{ action: string; scope_id: string; request_digest: string;
      authority_epoch: string; expires_at: Date; principal_id: string }>(`SELECT action,scope_id,request_digest,
        authority_epoch,expires_at,principal_id FROM access.admission WHERE id = $1 AND state = 'claimed'
        AND expires_at > clock_timestamp()`, [admission.id])).rows[0];
    if (!row || !ACTIONS.has(row.action) || row.action !== admission.action
      || row.scope_id !== admission.scope || row.request_digest !== command.digest
      || row.authority_epoch !== admission.authorityEpoch
      || (row.action === 'work.correction.review') !== (proposerAdmissionId !== null)) {
      throw new AdmissionDenied('protected Work command has no matching claimed Access admission');
    }
    if (proposerAdmissionId) {
      const proposer = (await this.pool.query<{ principal_id: string }>(`SELECT principal_id FROM access.admission
        WHERE id = $1 AND action = 'work.correction.propose' AND state = 'sealed' AND graph_outcome = 'succeeded'`,
      [proposerAdmissionId])).rows[0];
      if (!proposer || proposer.principal_id === row.principal_id) {
        throw new AdmissionDenied('correction review is not independent of its proposer');
      }
    }
    return signProtectionAdmission(admission, command, row.expires_at.toISOString(), proposerAdmissionId, this.key);
  }
}

/** Held-owner replay can re-sign only after reconciling its sealed Access proof. */
export function signProtectionAdmission(admission: Pick<RegisteredAdmission, 'id' | 'action' | 'scope' | 'authorityEpoch'>,
  command: CommandEnvelope, expiresAt: string, proposerAdmissionId: string | null,
  key = Bun.env.FUSEKI_TITLE_ADMISSION_KEY): TitleAdmissionProof {
  if (!key || !/^[0-9a-f]{64}$/.test(key)) throw new Error('protection admission signer is unavailable');
  const payload = JSON.stringify(['rezics-work-protection-admission-v1', admission.id, admission.action,
    admission.scope, admission.authorityEpoch, command.receipt, command.digest,
    createHash('sha256').update(command.update).digest('hex'), expiresAt, proposerAdmissionId ?? '']);
  return { payload, signature: createHmac('sha256', key).update(payload).digest('hex') };
}
