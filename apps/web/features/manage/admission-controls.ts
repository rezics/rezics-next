import type { Outcome } from './commands.ts';
import type { JoinDecision, JoinDecisionReceipt, JoinWithdraw, RequestPage, SpaceAccessApi } from './settings-api.ts';

/** A successful confirm clears its intent before status is read from Main again. */
export async function confirmWithdrawal(api: SpaceAccessApi,
  intent: { request: string; command: JoinWithdraw; key: string },
  received: (receipt: JoinDecisionReceipt) => void, refresh: () => Promise<void>) {
  const result = await api.withdraw(intent.request, intent.command, intent.key);
  if (result.ok) { received(result.data); await refresh(); }
  return result;
}

/** Receipt feedback precedes the fresh inbox; its old opaque cursor is never reused. */
export async function confirmAdmissionDecision(api: SpaceAccessApi,
  intent: { request: string; command: JoinDecision; key: string }, search: string,
  received: (receipt: JoinDecisionReceipt) => void,
  refreshed: (page: Outcome<RequestPage>) => void) {
  const result = await api.decide(intent.request, intent.command, intent.key);
  if (result.ok) { received(result.data); refreshed(await api.requests(null, search)); }
  return result;
}
