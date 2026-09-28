import { mainApiWithToken } from '../api/main.ts';

export interface OnboardingResult {
  agent: string;
  state: 'pending' | 'active' | 'compensating' | 'compensated';
  suggestedHandle: string;
  sessionAgent: string | null;
  replayed: boolean;
}

export type OnboardingOutcome =
  | { kind: 'active'; person: OnboardingResult; firstVisit: boolean }
  | { kind: 'pending' | 'unavailable' };

async function postOnboarding(token: string, sessionKey: string): Promise<OnboardingResult | null> {
  const response = await mainApiWithToken(token).v1.me.onboarding.post(
    { profile: 'person-onboarding-v1' }, { headers: { 'x-session-key': sessionKey } });
  return response.error ? null : response.data;
}

/** Main is idempotent per principal. A short 202 retry covers ordinary graph
 * activation without keeping the OAuth callback waiting indefinitely. */
export async function ensureOnboarding(token: string, sessionKey: string,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  post: (token: string, sessionKey: string) => Promise<OnboardingResult | null> = postOnboarding):
  Promise<OnboardingOutcome> {
  let firstVisit = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const person = await post(token, sessionKey);
      if (!person) return { kind: 'unavailable' };
      if (attempt === 0) firstVisit = !person.replayed;
      if (person.state === 'active') return { kind: 'active', person, firstVisit };
      if (person.state === 'compensated') return { kind: 'unavailable' };
    } catch { return { kind: 'unavailable' }; }
    if (attempt < 2) await pause(300 * (attempt + 1));
  }
  return { kind: 'pending' };
}

/**
 * Where a sign-in lands. A new person chooses a handle, then sets up Home
 * (languages, topics, communities), then reaches where they were going.
 */
export function onboardingDestination(outcome: OnboardingOutcome,
  selectedBefore: boolean, next: string, locale: string): string {
  if (selectedBefore || outcome.kind === 'active' && !outcome.firstVisit) return next;
  const setup = `/${locale}/welcome?next=${encodeURIComponent(next)}`;
  return `/${locale}/onboarding?next=${encodeURIComponent(setup)}`;
}
