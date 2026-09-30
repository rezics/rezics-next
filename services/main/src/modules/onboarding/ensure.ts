import { randomUUID } from 'node:crypto';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { AccountAssertionUnavailable } from '../account/verify-assertion.ts';
import { ActingContextStale } from '../access/contexts.ts';
import { suggestVanity } from '../agent/vanity.ts';

export interface PersonOnboardingResult {
  profile: 'person-onboarding-v1'; agent: string; state: 'pending' | 'active' | 'compensating' | 'compensated';
  suggestedHandle: string; sessionAgent: string | null; replayed: boolean;
}

export class PublicNameRequired extends Error {
  readonly code = 'public_name_required';
  constructor() { super('Choose a public name to create your Person'); }
}

/** A principal-key provision is O(1); the existing Session Agent discovery is
 * bounded to 50 contexts and the preference write checks one eligible Agent.
 * Name discovery uses at most two indexed reads and never writes. */
export async function ensurePersonOnboarding(work: MainWorkDependencies, request: Request,
  sessionKey: string, publicName?: string): Promise<PersonOnboardingResult> {
  if (!work.agentProvisioning || !work.sessionAgents || !work.onboardingPersons) {
    throw new AccountAssertionUnavailable('onboarding owner is unavailable');
  }
  const principal = await work.account.verify(request, ['agent:create', 'work:create']);
  const displayName = await work.onboardingPersons.activeName(principal) ?? publicName;
  // This guard precedes the saga: an unnamed first sign-in has no public effect.
  if (displayName === undefined) throw new PublicNameRequired();
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
  const savedName = await work.onboardingPersons.provisionName(provision.agent);
  if (savedName === null) throw new AccountAssertionUnavailable('Person provision is unavailable');
  return { profile: 'person-onboarding-v1', agent: provision.agent, state: provision.state,
    suggestedHandle: suggestVanity(savedName), sessionAgent: selected,
    replayed: provision.replayed };
}
