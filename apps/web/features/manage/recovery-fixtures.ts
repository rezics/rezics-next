import type { DecisionReceipt } from './commands.ts';
import type { AttemptStorage } from './safety-pending.ts';
import type { ModerationDecisionCommand, ModerationItem } from './types.ts';

export const recoveryPrincipal = 'storybook:account-one';
export function isolatedAttemptStorage(principal = recoveryPrincipal): AttemptStorage {
  const values = new Map<string, string>();
  const locks = new Map<string, Promise<void>>();
  return { principal, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); },
    async lock<T>(name: string, action: () => T): Promise<T> {
      const before = locks.get(name) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>(resolve => { release = resolve; });
      locks.set(name, before.then(() => next));
      await before;
      try { return action(); } finally { release(); }
    } };
}

export const recoveryReasons: ModerationDecisionCommand['reasons'] = {
  facts: 'The retained report establishes a breach.', scope: 'The reported revision.', duration: 'Until restored.',
  automation: false, contentLanguage: 'en', appealRoute: '/v1/public-reports/{caseId}/correspondence',
};

export function decisionReceipt(item: ModerationItem, status: DecisionReceipt['operation']['status'] = 'completed'): DecisionReceipt {
  const completed = status === 'completed';
  return { profile: item.kind === 'rights_complaint' ? 'rights-restriction-v1' : 'moderation-decision-v1',
    decisionId: '00000000-0000-4000-8000-000000003001', caseId: item.id, caseGeneration: '2',
    outcome: 'restrict', replayed: completed, enforcement: [], operation: {
      operationId: '00000000-0000-4000-8000-000000003001', status, continuation: completed ? null : 'resume',
      items: [{ ordinal: 1, target: item.target.resource, state: completed ? 'confirmed' : 'pending',
        receipt: completed ? 'owner-receipt' : null, continuation: null, error: null }],
    } };
}
