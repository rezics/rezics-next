import { settle } from '../feed/types.ts';
import type { OnboardingChoices } from '../feed/types.ts';
import { shellReader } from '../shell/communities-read.ts';

/**
 * What the setup starts from: Main's content languages and topics for the
 * page's locale, and the languages the reader already keeps in their person
 * settings. Each is null when Main cannot answer, and the flow still works.
 */
export async function readWelcome(locale: string): Promise<{ actingSubject: string | null; avatarQuery: string;
  choices: OnboardingChoices | null; savedLanguages: string[] | null }> {
  const reader = await shellReader();
  if (!reader.actingSubject) return { actingSubject: null, avatarQuery: '', choices: null, savedLanguages: null };
  const [choices, settings] = await Promise.all([
    settle(() => reader.anonymous.v1.onboarding.choices.get({ query: { locale } })),
    settle(() => reader.main.v1.me['person-preferences'].get({ query: { actingSubject: reader.actingSubject! } }))]);
  return { actingSubject: reader.actingSubject, avatarQuery: reader.avatarQuery,
    choices: choices.ok ? choices.data : null, savedLanguages: settings.ok ? settings.data.contentLanguages : null };
}
