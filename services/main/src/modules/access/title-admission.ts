import { createHash, createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AdmissionDenied, type RegisteredAdmission } from './admission.ts';
import type { CommandEnvelope } from '../../infrastructure/fuseki.ts';
import { titleCandidateIssuerBindings, type VerifiedTitleCandidate } from '../outbox/receipt-custody.ts';

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

/** Fresh authority is checked on the existing receipt session, including the SQL actor and exact retained bytes. */
export async function issueTitleCandidateAdmission(client: PoolClient, candidate: VerifiedTitleCandidate,
  key = Bun.env.FUSEKI_TITLE_ADMISSION_KEY): Promise<TitleAdmissionProof> {
  return issueCandidateAdmission(client, candidate, false, key);
}

/** Recreates only the original proof for native lookup. The lookup branch can never create an acceptance. */
export async function issueHistoricalTitleCandidateAdmission(client: PoolClient, candidate: VerifiedTitleCandidate,
  key = Bun.env.FUSEKI_TITLE_ADMISSION_KEY): Promise<TitleAdmissionProof> {
  return issueCandidateAdmission(client, candidate, true, key);
}

async function issueCandidateAdmission(client: PoolClient, candidate: VerifiedTitleCandidate,
  historical: boolean, key: string | undefined): Promise<TitleAdmissionProof> {
  if (!key || !/^[0-9a-f]{64}$/.test(key)) throw new Error('title admission signer is unavailable');
  const verified = titleCandidateIssuerBindings(candidate, client), frame = verified.frame;
  const row = (await client.query<{ action: string; scope_id: string; request_digest: string;
    authority_epoch: string; expires_at: Date; principal_id: string; acting_subject: string | null;
    state: string; unexpired: boolean }>(`SELECT action,scope_id,request_digest,authority_epoch,
      expires_at,principal_id,acting_subject,state,expires_at > clock_timestamp() AS unexpired
      FROM access.admission WHERE id = $1`, [frame.admission.id])).rows[0];
  if (!row || row.action !== 'work.edit' || row.action !== frame.admission.action
    || row.scope_id !== `work:edit:${frame.intent.work}` || row.scope_id !== frame.admission.scope
    || row.request_digest !== frame.digest || row.authority_epoch !== frame.admission.authorityEpoch
    || row.expires_at.toISOString() !== frame.admission.expiresAt
    || row.principal_id !== frame.actor.principalId || row.acting_subject !== frame.actor.actingSubject
    || (historical ? !['claimed', 'sealed'].includes(row.state) : row.state !== 'claimed' || !row.unexpired)) {
    throw new AdmissionDenied('title candidate has no matching original Access actor and admission');
  }
  const custody = (await client.query<{ request_digest: string; payload_sha256: string; payload: Buffer;
    revision: string; terminal: unknown; outbox: unknown; reconciled: boolean; retired: boolean }>(
    `SELECT request_digest,payload_sha256,payload,revision,terminal,outbox,
      reconciled_at IS NOT NULL AS reconciled,retired_at IS NOT NULL AS retired
      FROM access.command_custody WHERE receipt = $1`, [frame.receipt])).rows[0];
  if (!custody || custody.request_digest !== frame.digest || custody.payload_sha256 !== verified.custodySha256
    || createHash('sha256').update(custody.payload).digest('hex') !== verified.custodySha256
    || !Buffer.from(custody.payload).equals(verified.payload) || custody.revision !== frame.planned.revision
    || custody.terminal !== null || custody.outbox !== null || custody.reconciled || custody.retired
    || createHash('sha256').update(verified.frameJson).digest('hex') !== verified.frameSha256) {
    throw new AdmissionDenied('title candidate original SQL custody differs');
  }
  const payload = JSON.stringify(['rezics-human-title-candidate-admission-v1', frame.admission.id,
    row.action, row.scope_id, row.authority_epoch, frame.receipt, frame.digest, verified.frameSha256,
    verified.custodySha256, row.principal_id, row.acting_subject, row.expires_at.toISOString()]);
  return { payload, signature: createHmac('sha256', key).update(payload).digest('hex') };
}
