import { randomUUID } from 'node:crypto';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AccountAssertionUnavailable, type VerifiedAccountAssertion }
  from '../account/verify-assertion.ts';
import { ActingContextStale } from '../access/contexts.ts';
import { suggestVanity } from '../agent/vanity.ts';

export interface PersonOnboardingResult {
  profile: 'person-onboarding-v1'; agent: string; state: 'pending' | 'active' | 'compensating' | 'compensated';
  suggestedHandle: string; sessionAgent: string | null; replayed: boolean;
}

/** A principal-key provision is O(1); the existing Session Agent discovery is
 * bounded to 50 contexts and the preference write checks one eligible Agent. */
export async function ensurePersonOnboarding(work: MainWorkDependencies, request: Request,
  sessionKey: string): Promise<PersonOnboardingResult> {
  if (!work.agentProvisioning || !work.sessionAgents) {
    throw new AccountAssertionUnavailable('onboarding owner is unavailable');
  }
  const principal = await work.account.verify(request, ['agent:create', 'work:create']) as VerifiedAccountAssertion;
  const displayName = principal.accountDisplayName?.trim();
  if (!displayName || displayName.length > 200 || /[\u0000-\u001f\u007f]/.test(displayName)) {
    throw new AccountAssertionUnavailable('Account display name is unavailable');
  }
  const provision = await work.agentProvisioning.provision(work.account, request,
    { kind: 'person', displayName }, `system:person-onboarding:${randomUUID()}`, true);
  let selected: string | null = null;
  if (provision.state === 'active') {
    const read = await work.sessionAgents.readSession(principal, sessionKey);
    selected = read.sessionAgent.actingSubject;
    if (!selected) {
      try {
        const write = await work.sessionAgents.setSession(principal, sessionKey, {
          actingSubject: provision.agent, expectedRevision: read.sessionAgent.revision,
          idempotencyKey: `system:person-onboarding:${read.sessionAgent.revision ?? 'initial'}`,
        });
        selected = write.actingSubject;
      } catch (error) {
        if (!(error instanceof ActingContextStale)) throw error;
        selected = (await work.sessionAgents.readSession(principal, sessionKey)).sessionAgent.actingSubject;
      }
    }
  }
  return { profile: 'person-onboarding-v1', agent: provision.agent, state: provision.state,
    suggestedHandle: suggestVanity(displayName), sessionAgent: selected,
    replayed: provision.replayed };
}
