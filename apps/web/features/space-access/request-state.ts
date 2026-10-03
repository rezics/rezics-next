import type { Outcome } from '../manage/commands.ts';
import type { JoinCommand, JoinDecisionReceipt, JoinReceipt, JoinWithdraw, OwnJoinRequest, SpaceAccessApi } from '../manage/settings-api.ts';

export type RequestReceipt = Pick<JoinReceipt, 'requestId' | 'requestGeneration' | 'state'>
  | Pick<JoinDecisionReceipt, 'requestId' | 'requestGeneration' | 'state'>;
export interface RequestJournal {
  draftReason: string;
  requestIntent: { command: JoinCommand; key: string } | null;
  withdrawIntent: { request: string; command: JoinWithdraw; key: string } | null;
}
export const emptyRequestJournal = (): RequestJournal => ({ draftReason: '', requestIntent: null, withdrawIntent: null });
export const requestStorageKey = (realm: string, actor: string) => `rezics:join-request:${realm}:${actor}`;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const generation = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value);
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const reason = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
const key = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9:_./-]{1,128}$/.test(value);

/** Persist drafts and exact retry intents only. Legacy cached receipts are
 * deliberately discarded: Main's /mine read owns status on every reload. */
export function parseRequestJournal(raw: string | null, actor: string): RequestJournal {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!record(value)) return emptyRequestJournal();
    if (value.draftReason !== undefined && (typeof value.draftReason !== 'string' || value.draftReason.length > 2000)) return emptyRequestJournal();
    const request = value.requestIntent;
    const withdraw = value.withdrawIntent;
    if (request !== null && (!record(request) || !key(request.key) || !record(request.command)
      || request.command.actingSubject !== actor || !generation(request.command.expectedMembershipGeneration)
      || !generation(request.command.expectedPolicyRevision) || typeof request.command.termsRevision !== 'string'
      || !request.command.termsRevision || request.command.termsRevision.length > 128 || !reason(request.command.reason))) return emptyRequestJournal();
    if (withdraw !== null && (!record(withdraw) || !key(withdraw.key) || !uuid(withdraw.request) || !record(withdraw.command)
      || withdraw.command.actingSubject !== actor || !generation(withdraw.command.expectedRequestGeneration)
      || !reason(withdraw.command.reason))) return emptyRequestJournal();
    return { draftReason: value.draftReason ?? '', requestIntent: request, withdrawIntent: withdraw } as RequestJournal;
  } catch { return emptyRequestJournal(); }
}

/** /mine orders by UUID, not time. Traverse its complete history before choosing
 * the pending request, or newest terminal request by creation time. A moved
 * history restarts once; unavailable or incomplete reads never become status. */
export async function readOwnRequest(api: Pick<SpaceAccessApi, 'mine'>): Promise<Outcome<OwnJoinRequest | null>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let cursor: string | null = null;
    let latest: OwnJoinRequest | null = null;
    const seen = new Set<string>();
    for (;;) {
      const result = await api.mine(cursor);
      if (!result.ok) {
        if (result.failure === 'stale' && attempt === 0) break;
        // Main intentionally shares the unavailable Realm answer with no own
        // history. Only a first-page 404 means there is no request to display.
        if (result.failure === 'missing' && cursor === null) return { ok: true, data: null };
        return result;
      }
      for (const item of result.data.items) {
        if (!latest || item.state === 'pending' && latest.state !== 'pending'
          || (item.state === 'pending') === (latest.state === 'pending')
            && (item.createdAt > latest.createdAt || item.createdAt === latest.createdAt && item.id > latest.id)) latest = item;
      }
      if (result.data.complete) return { ok: true, data: latest };
      const next = result.data.nextCursor;
      if (!next || seen.has(next)) return { ok: false, failure: 'unavailable' };
      seen.add(next); cursor = next;
    }
  }
  return { ok: false, failure: 'stale' };
}

/** Acceptance is request history; Main's current basis says whether membership
 * still exists. A former member can request admission again without deleting
 * the earlier decision. A failed basis read never becomes an available action. */
export interface CurrentRequest {
  entry: OwnJoinRequest | null;
  state: OwnJoinRequest['state'] | 'available';
}
export async function readCurrentRequest(
  api: Pick<SpaceAccessApi, 'mine' | 'basis'>,
): Promise<Outcome<CurrentRequest>> {
  const request = await readOwnRequest(api);
  if (!request.ok) return request;
  const entry = request.data;
  if (entry?.state !== 'accepted') return { ok: true, data: { entry, state: entry?.state ?? 'available' } };
  const basis = await api.basis();
  if (!basis.ok) return basis;
  return { ok: true, data: { entry, state: basis.data.state === 'joined' ? 'accepted' : 'available' } };
}

/** Completed history resolves its matching retry, while an inactive decision
 * cannot erase a later rejoining draft or uncertain command. */
export function journalAfterStatus(saved: RequestJournal, current: OwnJoinRequest | null, active = true): RequestJournal {
  const command = saved.requestIntent?.command;
  const matching = current && command
    && current.reason === command.reason && current.membershipGeneration === command.expectedMembershipGeneration
    && current.policyRevision === command.expectedPolicyRevision && current.termsRevision === command.termsRevision;
  const resolved = current && (current.state === 'pending' || active && current.state === 'accepted' || matching);
  return { draftReason: current?.state === 'pending' || current?.state === 'accepted'
      && (active || matching && saved.draftReason === command?.reason) ? '' : saved.draftReason,
    requestIntent: resolved ? null : saved.requestIntent,
    withdrawIntent: current?.state === 'pending' && saved.withdrawIntent?.request === current.id
      && saved.withdrawIntent.command.expectedRequestGeneration === current.requestGeneration ? saved.withdrawIntent : null };
}
