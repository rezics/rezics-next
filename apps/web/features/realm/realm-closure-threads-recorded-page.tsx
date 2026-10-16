import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { RealmDiscussionsRoute } from './discussions-route.tsx';
import { messages } from './messages.ts';
import { rankingVisitHost } from './ranking-visit.tsx';
import { RealmNotFound } from './states.tsx';
import { RealmThreadRoute } from './thread-route.tsx';

export type ClosureEntry = 'closed-list' | 'closed-thread' | 'closed-descendant' | 'absent-list' | 'live-list' | 'live-thread';
export function threadsSample(record: AnswerRecord, persona: AnswerPersona, label: string) {
  const sample = record.personas[persona].find(item => item.label === label);
  if (!sample) throw new Error(`Missing discussion sample: ${persona}/${label}`);
  return sample;
}

/** Both routes keep their real frame, session, conditional readers and missing boundary. */
export async function closureThreadsRoute(fetcher: typeof fetch, signedIn: boolean, realm: string, thread?: string) {
  const host = rankingVisitHost(fetcher, signedIn);
  const send = host.fetch;
  host.fetch = ((input, init) => send(typeof input === 'string' ? new URL(input, host.origin) : input, init)) as typeof fetch;
  const props = { params: Promise.resolve({ locale: 'en', realm, thread: thread ?? '' }), searchParams: Promise.resolve({}) };
  try {
    return await (thread ? RealmThreadRoute(props, host) : RealmDiscussionsRoute(props, host));
  } catch (error) {
    if (!(error instanceof Error) || !/NEXT_HTTP_ERROR_FALLBACK;404|notFound\(\) is not available in stories/.test(error.message)) throw error;
    return <RealmNotFound messages={messages} />;
  }
}

export function closureThreadsReplay(record: AnswerRecord, persona: AnswerPersona, entry: ClosureEntry, loading = false, onMismatch?: (error: unknown) => void) {
  const samples = record.personas[persona].filter(item => new RegExp(`^${entry}-\\d+$`).test(item.label));
  if (!samples.length) throw new Error(`Missing discussion visit: ${persona}/${entry}`);
  const realmPath = samples.find(item => /^\/v1\/realms\/[^/?]+(?:\?|$)/.test(item.path))!.path;
  const realm = realmPath.split('/')[3]!.split('?')[0]!;
  const proof = threadsSample(record, persona, entry.startsWith('live') ? 'live-thread-identity'
    : entry === 'closed-descendant' ? 'closed-discussion-proof-4' : 'closed-discussion-proof-3');
  const thread = entry.endsWith('list') ? undefined : proof.path.split('/threads/')[1]!.split('?')[0];
  const replay = recordedFetch(record, persona, samples.map((item, index) => ({ label: item.label,
    state: loading && index === 0 ? 'loading' : item.status >= 400 ? 'error' : 'populated',
  })), { pathPrefix: BFF_PREFIX, sequence: true });
  const requests: { url: string; credentials?: RequestCredentials }[] = [];
  let mismatch: unknown;
  const fetcher = (async (input, init) => {
    requests.push({ url: new Request(input, init).url, credentials: init?.credentials });
    try { return await replay.fetcher(input, init); }
    catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) { mismatch = error; onMismatch?.(error); }
      throw error;
    }
  }) as typeof fetch;
  return { samples, requests, dispose: replay.dispose, async read() {
    const page = await closureThreadsRoute(fetcher, persona !== 'visitor', realm, thread);
    if (mismatch) throw mismatch;
    return page;
  } };
}

export function RecordedClosureThreads({ record, persona = 'visitor', entry = 'closed-list', loading = false }: {
  record: AnswerRecord; persona?: AnswerPersona; entry?: ClosureEntry; loading?: boolean;
}) {
  const [result, setResult] = useState<{ record: AnswerRecord; persona: AnswerPersona; entry: ClosureEntry; loading: boolean; page: ReactNode } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let active = true;
    setError(null);
    const replay = closureThreadsReplay(record, persona, entry, loading, failure => { if (active) setError(failure); });
    void replay.read().then(page => { if (active) setResult({ record, persona, entry, loading, page }); },
      failure => { if (active) setError(failure); });
    return () => { active = false; replay.dispose(); };
  }, [record, persona, entry, loading]);
  if (error) throw error;
  return result?.record === record && result.persona === persona && result.entry === entry && result.loading === loading
    ? result.page : <p role="status" aria-busy="true">{shellMessages.loading}</p>;
}
