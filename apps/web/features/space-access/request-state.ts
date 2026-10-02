import type { JoinCommand, JoinDecisionReceipt, JoinReceipt, JoinWithdraw } from '../manage/settings-api.ts';

export type RequestReceipt = Pick<JoinReceipt, 'requestId' | 'requestGeneration' | 'state'>
  | Pick<JoinDecisionReceipt, 'requestId' | 'requestGeneration' | 'state'>;
export interface RequestJournal {
  draftReason: string;
  receipt: RequestReceipt | null;
  requestIntent: { command: JoinCommand; key: string } | null;
  withdrawIntent: { request: string; command: JoinWithdraw; key: string } | null;
}
export const emptyRequestJournal = (): RequestJournal => ({ draftReason: '', receipt: null, requestIntent: null, withdrawIntent: null });
export const requestStorageKey = (realm: string, actor: string) => `rezics:join-request:${realm}:${actor}`;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const generation = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value);
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const reason = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
const key = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9:_./-]{1,128}$/.test(value);

/** Browser storage retains receipts and exact retry intents, never live status.
 * Main currently has no requester status read; a cached pending receipt may have
 * been decided elsewhere. Only a fresh owner result can replace that state. */
export function parseRequestJournal(raw: string | null, actor: string): RequestJournal {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!record(value)) return emptyRequestJournal();
    if (value.draftReason !== undefined && (typeof value.draftReason !== 'string' || value.draftReason.length > 2000)) return emptyRequestJournal();
    const receipt = value.receipt;
    const request = value.requestIntent;
    const withdraw = value.withdrawIntent;
    if (receipt !== null && (!record(receipt) || !uuid(receipt.requestId) || !generation(receipt.requestGeneration)
      || !['pending', 'accepted', 'declined', 'withdrawn'].includes(String(receipt.state)))) return emptyRequestJournal();
    if (request !== null && (!record(request) || !key(request.key) || !record(request.command)
      || request.command.actingSubject !== actor || !generation(request.command.expectedMembershipGeneration)
      || !generation(request.command.expectedPolicyRevision) || typeof request.command.termsRevision !== 'string'
      || !request.command.termsRevision || request.command.termsRevision.length > 128 || !reason(request.command.reason))) return emptyRequestJournal();
    if (withdraw !== null && (!record(withdraw) || !key(withdraw.key) || !uuid(withdraw.request) || !record(withdraw.command)
      || withdraw.command.actingSubject !== actor || !generation(withdraw.command.expectedRequestGeneration)
      || !reason(withdraw.command.reason))) return emptyRequestJournal();
    return { ...value, draftReason: value.draftReason ?? '' } as unknown as RequestJournal;
  } catch { return emptyRequestJournal(); }
}
