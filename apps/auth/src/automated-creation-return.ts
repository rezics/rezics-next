export type AutomatedCreationReturnFact = 'unknown' | 'interrupted' | 'acknowledged';
export type AutomatedCreationReturnHistory = readonly AutomatedCreationReturnFact[];

export const emptyAutomatedCreationReturnHistory: AutomatedCreationReturnHistory = Object.freeze([]);

/** Keep the first unresolved send beside the latest local interruption or native acknowledgement. */
export function recordAutomatedCreationReturnFact(
  history: AutomatedCreationReturnHistory,
  fact: AutomatedCreationReturnFact,
): AutomatedCreationReturnHistory {
  if (fact === 'unknown') {
    if (history.includes('unknown')) return history;
    const latest = history.find((entry) => entry !== 'unknown');
    return Object.freeze(latest ? ['unknown', latest] : ['unknown']);
  }
  const unresolved = history.includes('unknown') ? (['unknown'] as const) : [];
  if (history.length === unresolved.length + 1 && history.at(-1) === fact) return history;
  return Object.freeze([...unresolved, fact]);
}

/** A stored submitted marker is historical evidence, unless this mount already knows its native result. */
export function observeAutomatedCreationContinuation(
  history: AutomatedCreationReturnHistory,
  possiblySent: boolean,
): AutomatedCreationReturnHistory {
  if (!possiblySent || history.includes('unknown') || history.includes('acknowledged')) return history;
  return recordAutomatedCreationReturnFact(history, 'unknown');
}

/** Dismissal hides mounted copy only; it does not change the native continuation. */
export function dismissAutomatedCreationReturnHistory(
  history: AutomatedCreationReturnHistory,
): AutomatedCreationReturnHistory {
  return history.length ? emptyAutomatedCreationReturnHistory : history;
}
