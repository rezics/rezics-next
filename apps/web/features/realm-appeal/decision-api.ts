import { decisionStatus, send, type Outcome, type DecisionReceipt } from '../manage/commands.ts';
import type { DecisionBasis, MainClient, ModerationDecisionCommand } from '../manage/types.ts';

export type AppealDecision = { outcome: 'dismiss' | 'restore'; rationale: string; disclosure: 'private' | 'parties' };

/** Sanction decisions have no content targets, content rule, or evidence (the owner ignores those profile fields). */
export function appealDecisionCommand(basis: Pick<DecisionBasis, 'caseId' | 'generation'>, actor: string,
  input: AppealDecision, key: string): ModerationDecisionCommand {
  return { profile: 'moderation-decision-v1', caseId: basis.caseId, expectedGeneration: basis.generation,
    actingSubject: actor, outcome: input.outcome, rationale: input.rationale.trim(), disclosure: input.disclosure,
    idempotencyKey: key, targets: [], reversesDecisionId: null, answersStepId: null,
    rule: { ref: 'urn:rezics:realm-sanction-appeal', revision: '0', digest: '0'.repeat(64) },
    evidenceDigest: '0'.repeat(64), reasons: {
      facts: input.rationale.trim().slice(0, 4000), scope: 'Realm membership',
      duration: input.outcome === 'restore' ? 'Ban lifted immediately' : 'Original ban unchanged',
      automation: false, appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'und',
    } };
}

export async function resolveRealmAppeal(main: MainClient, command: ModerationDecisionCommand): Promise<Outcome<DecisionReceipt>> {
  const result = await send(() => main.v1.moderation.decisions.post(command,
    { headers: { 'idempotency-key': command.idempotencyKey } }));
  if (!result.ok) return result;
  if (result.data.caseId !== command.caseId || result.data.outcome !== command.outcome || !result.data.decisionId
    || decisionStatus(result.data) !== 'completed') {
    return { ok: false, failure: 'unavailable' };
  }
  return result;
}

/** Local authority only supplies these choices; Main checks the exact scope and live grants at Save. */
export function appealDecisionAuthority(permissions: readonly string[] | null) {
  const dismiss = permissions === null || permissions.includes('governance.moderate');
  return { dismiss, restore: dismiss && (permissions === null || permissions.includes('realm.members.manage')) };
}
