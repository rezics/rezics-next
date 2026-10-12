import type { DecisionReceipt } from './commands.ts';
import type { AttemptStorage } from './safety-pending.ts';
import type { ModerationDecisionCommand, ModerationItem } from './types.ts';

export function isolatedAttemptStorage(): AttemptStorage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); } };
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
