import { addRealmMember } from '../space-actions';
import type { MemberAdditionIntent, MemberAdditionResult } from './source';

/** Adapt the existing accepted-202 membership command without sending local interval proof as wire data. */
export async function addSelectedRealmMember(intent: MemberAdditionIntent): Promise<MemberAdditionResult> {
  return addRealmMember({
    data: {
      realmId: intent.realmId,
      accountId: intent.accountId,
      idempotencyKey: intent.idempotencyKey,
    },
  });
}
