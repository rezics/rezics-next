import { mainApiWithToken } from '../../../apps/web/features/api/main.ts';
import { realmDiscussionReads } from '../../../apps/web/features/realm/discussion-read.ts';
import type { OutcomeRecorder } from './outcome-test.ts';
import type { PersonaName, PersonaSession } from './personas.ts';

/** Let the production reader construct every selection and continuation request. */
export function recordRealmDiscussion(recording: OutcomeRecorder, name: PersonaName,
  person: PersonaSession, realm: string) {
  return (label: string) => {
    const sample = recording.session(name, person);
    const fetcher = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      return sample(url.pathname.endsWith('/classification-context') ? `${label}-context` : label,
        init?.method ?? 'GET', `${url.pathname}${url.search}`, undefined, undefined,
        { headers: Object.fromEntries(headers) });
    }) as typeof fetch;
    return realmDiscussionReads(mainApiWithToken(person.actingSubject ? 'recorded-session' : undefined,
      { fetcher }), realm.slice(-36), person.actingSubject ?? undefined);
  };
}
