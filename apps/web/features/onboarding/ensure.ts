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
  /** No Person exists and none was created: Main needs the owner's public name first. */
  | { kind: 'name-required' | 'invalid-name' | 'pending' | 'unavailable' };

/** Main's answer to one onboarding post: the Person, or why there is none. */
export type OnboardingPost = OnboardingResult | 'name-required' | 'invalid-name' | null;
export type OnboardingSender = (token: string, sessionKey: string, displayName?: string) =>
  Promise<OnboardingPost>;

/** Without `displayName` this only finds or continues the Person; it never
 * creates one from Account data. */
async function postOnboarding(token: string, sessionKey: string, displayName?: string): Promise<OnboardingPost> {
  const response = await mainApiWithToken(token).v1.me.onboarding.post(
    { profile: 'person-onboarding-v1', ...displayName === undefined ? {} : { displayName } },
    { headers: { 'x-session-key': sessionKey } });
  if (!response.error) return response.data;
  const code = (response.error.value as { code?: string } | undefined)?.code;
  // Main owns the name rules: its 400 or schema 422 for a typed name is the only "invalid".
  if (displayName !== undefined && (response.status === 400 || response.status === 422)) return 'invalid-name';
  return code === 'public_name_required' ? 'name-required' : null;
}

/** Main is idempotent per principal. A short 202 retry covers ordinary graph
 * activation without keeping the OAuth callback waiting indefinitely. */
export async function ensureOnboarding(token: string, sessionKey: string,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  post: OnboardingSender = postOnboarding, displayName?: string): Promise<OnboardingOutcome> {
  let firstVisit = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const person = await post(token, sessionKey, displayName);
      if (person === 'name-required' || person === 'invalid-name') return { kind: person };
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
 * Where a sign-in lands. A new person chooses a public name and a handle, then
 * sets up Home (languages, topics, communities), then reaches where they were
 * going. Without a Person the name comes first, whatever `selectedBefore` says.
 */
export function onboardingDestination(outcome: OnboardingOutcome,
  selectedBefore: boolean, next: string, locale: string): string {
  const returning = selectedBefore || outcome.kind === 'active' && !outcome.firstVisit;
  if (outcome.kind !== 'name-required' && returning) return next;
  const setup = `/${locale}/welcome?next=${encodeURIComponent(next)}`;
  return `/${locale}/onboarding?next=${encodeURIComponent(setup)}`;
}
