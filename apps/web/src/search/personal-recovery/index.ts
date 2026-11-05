/** Read settlement only. Native command delivery belongs to the caller. */
export type PersonalReadState = {
  status: 'current' | 'pending' | 'failed' | 'retryable' | 'restart-required' | 'closed';
};
export type PersonalReadOutcome = Exclude<PersonalReadState['status'], 'pending'>;

/** Pure, bounded receiving state; adapters supply reads, cancellation and publication. */
export function createPersonalReadRecovery() {
  let state: PersonalReadState = { status: 'current' };
  let revision = 0;
  return {
    snapshot: () => state,
    begin(): number | undefined {
      if (state.status === 'pending' || state.status === 'closed' || state.status === 'restart-required') return;
      state = { status: 'pending' };
      return ++revision;
    },
    settle(owner: number, status: PersonalReadOutcome): boolean {
      if (owner !== revision || state.status !== 'pending') return false;
      state = { status };
      return true;
    },
    close() {
      revision++;
      state = { status: 'closed' };
    },
  };
}
