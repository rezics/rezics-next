import { createHash, createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { AdmissionDenied, type RegisteredAdmission } from './admission.ts';
import type { CommandEnvelope } from '../../infrastructure/fuseki.ts';

export type TitleAction = 'work.edit' | 'work.title.apply' | 'work.title.return';
export interface TitleAdmissionProof { payload: string; signature: string }

/** Called only after the Account/Access command adapter has claimed an admission.
 * The privileged key is distinct from the ordinary Fuseki command credential. */
export async function issueTitleAdmission(pool: Pool, admission: RegisteredAdmission,
  command: CommandEnvelope, key?: string): Promise<TitleAdmissionProof> {
  const row = (await pool.query<{ action: string; scope_id: string; request_digest: string;
    authority_epoch: string; expires_at: Date }>(`SELECT action,scope_id,request_digest,
      authority_epoch,expires_at FROM access.admission WHERE id = $1 AND state = 'claimed'
      AND expires_at > clock_timestamp()`, [admission.id])).rows[0];
  if (!row || !['work.edit', 'work.title.apply', 'work.title.return'].includes(row.action)
    || row.action !== admission.action || row.scope_id !== admission.scope
    || row.request_digest !== command.digest || row.authority_epoch !== admission.authorityEpoch) {
    throw new AdmissionDenied('title command has no matching claimed Access admission');
  }
  return signTitleAdmission(admission, command, row.expires_at.toISOString(), key);
}

/** Also used by held-owner replay after verifying the sealed Access outcome. */
export function signTitleAdmission(admission: Pick<RegisteredAdmission, 'id' | 'action' | 'scope' | 'authorityEpoch'>,
  command: CommandEnvelope, expiresAt: string, key = Bun.env.FUSEKI_TITLE_ADMISSION_KEY): TitleAdmissionProof {
  if (!key || !/^[0-9a-f]{64}$/.test(key)) throw new Error('title admission signer is unavailable');
  const payload = JSON.stringify(['rezics-work-title-admission-v1', admission.id, admission.action,
    admission.scope, admission.authorityEpoch, command.receipt, command.digest,
    createHash('sha256').update(command.update).digest('hex'), expiresAt]);
  return { payload, signature: createHmac('sha256', key).update(payload).digest('hex') };
}
