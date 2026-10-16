import { cloneElement, isValidElement, useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { readAddress } from '../address/client.ts';
import { readSpacePage } from '../address/space-read.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { ZoneHomeContent } from '../zone-editor/home-content.tsx';
import { ZoneSiteRoute } from '../zones/site-route.tsx';
import { messages } from './messages.ts';
import type { RealmReadClient } from './read.ts';
import { RealmDecisionsRoute, RealmHomeRoute } from './routes.tsx';
import { RealmNotFound } from './states.tsx';

const origin = 'https://recorded.invalid';
export const directEntries = ['home', 'decisions', 'exact-decision', 'private-teaser', 'zone-entry'] as const;
export type DirectEntry = typeof directEntries[number];
export function directSample(record: AnswerRecord, persona: AnswerPersona, label: string) {
  const sample = record.personas[persona].find(item => item.label === label);
  if (!sample) throw new Error(`Missing direct-route sample: ${persona}/${label}`);
  return sample;
}

/** Request-scoped address/session inputs; the production readers retain their conditional reads. */
export function directClient(fetcher: typeof fetch, signedIn: boolean): RealmReadClient {
  const main = browserMainApi(origin, { anonymous: true, fetcher });
  const personal = browserMainApi(origin, { anonymous: !signedIn, fetcher });
  let session: ReturnType<typeof personal.v1.me['session-agent']['get']> | undefined;
  return { main, personal, signedIn, fetch: fetcher, resolution: {
    resolveAddress: (scope, key, locale) => readAddress({ scope, key }, locale, origin, new Headers(), undefined, true, fetcher),
    readPrivateRealm: async (ref, locale, address) => {
      const state = signedIn ? await (session ??= personal.v1.me['session-agent'].get()) : null;
      const actingSubject = state?.data?.sessionAgent.eligible ? state.data.sessionAgent.actingSubject ?? undefined : undefined;
      return readSpacePage(ref, locale, { address, origin,
        ...(signedIn ? { token: 'recorded', actingSubject } : {}),
        read: (path, authenticated) => fetcher(`${origin}${BFF_PREFIX}${path}`, {
          credentials: authenticated ? 'same-origin' : 'omit',
          headers: { 'accept-language': locale, 'x-rezics-display-languages': locale },
        }),
      });
    },
  } };
}

/** Resolve the async home component for Storybook's client renderer, preserving its production props. */
async function renderHome(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(renderHome));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === ZoneHomeContent) return renderHome(await ZoneHomeContent(node.props as Parameters<typeof ZoneHomeContent>[0]));
  return 'children' in node.props ? cloneElement(node, { children: await renderHome(node.props.children) }) : node;
}

export async function directRoute(record: AnswerRecord, persona: AnswerPersona, entry: DirectEntry, fetcher: typeof fetch) {
  const key = new URL(directSample(record, persona, `${entry}-address`).path, origin).searchParams.get('key')!;
  const client = directClient(fetcher, persona !== 'visitor');
  try {
    if (entry === 'zone-entry') {
      if (client.signedIn) {
        const state = await client.personal!.v1.me['session-agent'].get();
        client.actingSubject = state.data?.sessionAgent.eligible ? state.data.sessionAgent.actingSubject ?? undefined : undefined;
      }
      return renderHome(await ZoneSiteRoute({ params: Promise.resolve({ locale: 'en', space: key }),
        searchParams: Promise.resolve({}) }, client));
    }
    const decision = directSample(record, persona, 'closed-realm-decision').path.split('/decisions/')[1]!.split('?')[0]!;
    const props = { params: Promise.resolve({ locale: 'en', realm: key }),
      searchParams: Promise.resolve(entry === 'exact-decision' ? { decision } : {}) };
    return await (entry.includes('decision') ? RealmDecisionsRoute(props, client) : RealmHomeRoute(props, client));
  } catch (error) {
    if (!(error instanceof Error) || !/NEXT_HTTP_ERROR_FALLBACK;404|notFound\(\) is not available in stories/.test(error.message)) throw error;
    return <RealmNotFound messages={messages} />;
  }
}

export function directReplay(record: AnswerRecord, persona: AnswerPersona, entry: DirectEntry, loading = false) {
  const samples = record.personas[persona].filter(item => item.label.startsWith(`${entry}-`) && !item.label.includes('@'));
  return recordedFetch(record, persona, samples.map(item => ({ label: item.label,
    state: loading && item.label === `${entry}-address` ? 'loading' : item.status >= 400 ? 'error' : 'populated',
  })), { pathPrefix: BFF_PREFIX });
}

export function RecordedClosureDirect({ record, persona = 'visitor', entry = 'home', loading = false }: {
  record: AnswerRecord; persona?: AnswerPersona; entry?: DirectEntry; loading?: boolean;
}) {
  const [view, setView] = useState<ReactNode>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let active = true;
    setView(null); setError(null);
    const replay = directReplay(record, persona, entry, loading);
    void directRoute(record, persona, entry, replay.fetcher).then(result => { if (active) setView(result); })
      .catch(failure => { if (active) setError(failure); });
    return () => { active = false; replay.dispose(); };
  }, [record, persona, entry, loading]);
  if (error) throw error;
  return view ?? <p role="status" aria-busy="true">{shellMessages.loading}</p>;
}
