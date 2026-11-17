import { sessionCsrfToken } from '../../session/browser-state';
import { addRealmMember } from '../space-actions';
import type { MemberAdditionIntent, MemberAdditionResult } from './source';

/** Adapt the existing accepted-202 membership command without sending local interval proof as wire data. */
export async function addSelectedRealmMember(
  intent: MemberAdditionIntent,
  csrfToken = sessionCsrfToken(),
): Promise<MemberAdditionResult> {
  if (!csrfToken) return { kind: 'rejected' };
  return addRealmMember({
    headers: { 'X-CSRF-Token': csrfToken },
    data: {
      realmId: intent.realmId,
      accountId: intent.accountId,
      idempotencyKey: intent.idempotencyKey,
    },
  });
}
