/** Mounted presentation only. Exact submitted identity stays in the installed continuation. */
export type MembershipHistoryKind = 'unsent' | 'unresolved' | 'acknowledged' | 'refused';
export type MembershipHistory = readonly MembershipHistoryKind[];

/** Keep the first unknown independently of the latest local outcome, at most two records. */
export function retainMembershipHistory(history: MembershipHistory, next: MembershipHistoryKind): MembershipHistory {
  if (next === 'unresolved') return history.includes('unresolved') ? history : ['unresolved', ...history.slice(-1)];
  return history.includes('unresolved') ? ['unresolved', next] : [next];
}
