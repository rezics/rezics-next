import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { readAddress } from '../address/client.ts';
import { readSpacePage } from '../address/space-read.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { messages } from './messages.ts';
import type { RealmReadClient } from './read.ts';
import { RealmMembersRoute } from './routes.tsx';
import { RealmNotFound } from './states.tsx';

const origin = 'https://recorded.invalid';

/** Supply the existing address/private-landing readers, keeping public reads anonymous. */
export function closureRosterClient(fetcher: typeof fetch, actingSubject?: string): RealmReadClient {
  return {
    main: browserMainApi(origin, { anonymous: true, fetcher }),
    personal: browserMainApi(origin, { anonymous: !actingSubject, fetcher }),
    signedIn: Boolean(actingSubject), actingSubject, fetch: fetcher,
    resolution: {
      resolveAddress: (scope, key, locale) => readAddress({ scope, key }, locale, origin,
        new Headers(), undefined, true, fetcher),
      readPrivateRealm: (ref, locale, address) => readSpacePage(ref, locale, {
        address, origin, ...(actingSubject ? { token: 'recorded', actingSubject } : {}),
        read: (path, personal) => fetcher(`${origin}${BFF_PREFIX}${path}`, {
          credentials: personal ? 'same-origin' : 'omit',
          headers: { 'accept-language': locale, 'x-rezics-display-languages': locale },
        }),
      }),
    },
  };
}

/** Next's missing boundary uses the same concealed component for a closed or absent Realm. */
export async function closureRosterRoute(client: RealmReadClient, realm: string, cursor?: string) {
  try {
    return await RealmMembersRoute({ params: Promise.resolve({ locale: 'en', realm }),
      searchParams: Promise.resolve(cursor ? { cursor } : {}) }, client);
  } catch (error) {
    if (!(error instanceof Error) || !/NEXT_HTTP_ERROR_FALLBACK;404|notFound\(\) is not available in stories/.test(error.message)) throw error;
    return <RealmNotFound messages={messages} />;
  }
}

export function rosterSample(record: AnswerRecord, persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(sample => sample.label === label);
  if (!found) throw new Error(`Missing roster sample: ${persona}/${label}`);
  return found;
}

export function RecordedClosureRoster({ record, persona = 'visitor', live = false, retained = false, loading = false }: {
  record: AnswerRecord; persona?: AnswerPersona; live?: boolean; retained?: boolean; loading?: boolean;
}) {
  const [view, setView] = useState<ReactNode>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    setView(null); setError(null);
    const samples = record.personas[persona].filter(sample => sample.label.startsWith(live ? 'live-page-' : 'members-'));
    const replay = recordedFetch(record, persona, samples.map(sample => ({ label: sample.label,
      state: loading && sample.label === (live ? 'live-page-address' : 'members-address') ? 'loading'
        : sample.status >= 400 ? 'error' : 'populated' })), { pathPrefix: BFF_PREFIX });
    const fetcher = (async (input, init) => {
      try { return await replay.fetcher(input, init); }
      catch (failure) {
        if (active) setError(failure instanceof Error ? failure : new Error(String(failure)));
        throw failure;
      }
    }) as typeof fetch;
    const address = rosterSample(record, persona, live ? 'live-page-address' : 'members-address');
    const realm = new URL(address.path, origin).searchParams.get('key')!;
    const actor = new URL(rosterSample(record, persona, 'members-private-header').path, origin).searchParams.get('actingSubject') ?? undefined;
    const cursor = retained ? new URL(rosterSample(record, persona, 'closed-retained').path, origin).searchParams.get('after')! : undefined;
    void closureRosterRoute(closureRosterClient(fetcher, actor), realm, cursor)
      .then(result => { if (active) setView(result); })
      .catch(failure => { if (active) setError(failure instanceof Error ? failure : new Error(String(failure))); });
    return () => { active = false; replay.dispose(); };
  }, [record, persona, live, retained, loading]);
  if (error) throw error;
  return view ?? <p role="status" aria-busy="true">{shellMessages.loading}</p>;
}
