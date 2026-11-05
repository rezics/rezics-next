/** Presentation only. Never put credentials, identities, route data or native capabilities here. */
export type LoginMethod = 'password' | 'passkey' | 'autofill';
export type LoginPhase = 'options' | 'prompt' | 'dispatched' | 'acknowledged' | 'unknown' | 'refused' | 'cancelled';
export type LoginPhaseObserver = (phase: LoginPhase) => void;
export type LoginReturnRecord = Readonly<{ method: LoginMethod; phase: LoginPhase }>;
export type LoginReturnHistory = readonly LoginReturnRecord[];

export function observeLogin(observer: LoginPhaseObserver | undefined, phase: LoginPhase) {
  try {
    observer?.(phase);
  } catch {
    // A presentation observer cannot change native authentication semantics.
  }
}

export function loginResultPhase(result: { ok: boolean; reason?: string }): LoginPhase {
  return result.ok ? 'acknowledged' : result.reason === 'unavailable' ? 'unknown' : 'refused';
}

export function unconfirmedLogin(record: LoginReturnRecord) {
  return record.phase === 'dispatched' || record.phase === 'unknown';
}

/** Keep the first unresolved operation and the most recent interruption, with a fixed two-record ceiling. */
export function retainLoginHistory(history: LoginReturnHistory, record: LoginReturnRecord): LoginReturnHistory {
  if (history.includes(record)) return history;
  const unresolved = history.find(unconfirmedLogin);
  return unresolved ? [unresolved, record] : [record];
}
