/** A Realm ban or unban, read from the receipt the member already owns.
 * The acting subject stays on the receipt for audit and recipient selection;
 * it is not part of this notice. */
export interface MembershipSanction {
  action: 'ban' | 'unban';
  bannedUntil: string | null;
  permanent: boolean;
}

export function membershipSanction(row: {
  member_action?: string | null;
  result?: { banned?: unknown; bannedUntil?: unknown } | null;
}): MembershipSanction | null {
  const bannedUntil = typeof row.result?.bannedUntil === 'string' ? row.result.bannedUntil : null;
  if (row.member_action === 'unban') return { action: 'unban', bannedUntil: null, permanent: false };
  if (row.member_action === 'ban') return { action: 'ban', bannedUntil, permanent: bannedUntil === null };
  // Receipts written before member_action still record an active ban on the result.
  if ((row.member_action === null || row.member_action === undefined) && row.result?.banned === true) {
    return { action: 'ban', bannedUntil, permanent: bannedUntil === null };
  }
  return null;
}
