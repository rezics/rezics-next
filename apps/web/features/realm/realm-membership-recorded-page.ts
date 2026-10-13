import type { ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { joinRequestsBody } from '../../app/[locale]/manage/r/[realm]/requests/page.tsx';
import { realmManagementFrame } from '../../app/[locale]/manage/r/[realm]/layout.tsx';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { readAgentProfile } from '../auth/agent-profile.ts';
import { agentOptions, identityOptions, resolveSessionAgent, type AgentOption } from '../auth/acting-identity.ts';
import { discoverActingContexts, discoverAgents, readMainSessionAgent } from '../auth/session.ts';
import type { MainClient } from '../discover/types.ts';
import { spaceAccessApi } from '../manage/settings-api.ts';
import { readRequestsAtAddress } from '../manage/settings-api.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { loadRealmView, privateJoinPage, RealmFrame, type RealmReplay } from './realm-page.tsx';
import { realmHref } from './route.ts';

const recordedOrigin = 'https://recorded.invalid';
/** Opaque session key. Recorded reads match the path, not this header. */
const recordedSessionKey = '00000000-0000-4000-8000-000000000001';
const recordedToken = 'recorded';

/** Which production route the story reaches. Basis is not one of them. */
export type MembershipSurface = 'landing' | 'joined' | 'requests';

export function recordedSample(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].filter(sample => sample.label === label);
  if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${label}`);
  return found[0]!;
}

export function recordedRealmId(path: string): string | null {
  return new URL(path, recordedOrigin).pathname.match(/\/v1\/(?:realms|spaces)\/([0-9a-f-]{36})/)?.[1] ?? null;
}

export function recordedSubject(path: string): string | null {
  return new URL(path, recordedOrigin).searchParams.get('actingSubject');
}

/** Realm named by the selected samples. Agent profile paths name no Realm. */
export function recordedIdentity(record: AnswerRecord, persona: AnswerPersona, selections: readonly RecordedSelection[]):
  { realm: string; actingSubject: string | null } {
  let realm: string | null = null;
  let actingSubject: string | null = null;
  for (const item of selections) {
    const sample = recordedSample(record, persona, item.label);
    realm ??= recordedRealmId(sample.path);
    actingSubject ??= recordedSubject(sample.path);
  }
  if (!realm) throw new Error(`Recorded ${record.row}/${persona} selections name no Realm`);
  return { realm, actingSubject };
}

export function recordedRead(fetcher: typeof fetch): RealmReplay['read'] {
  return (path: string) => fetcher(new URL(`${BFF_PREFIX}${path}`, recordedOrigin));
}

export function recordedReplay(fetcher: typeof fetch, signedIn: boolean): RealmReplay {
  return {
    fetch: fetcher, read: recordedRead(fetcher), personal: browserMainApi(recordedOrigin, { fetcher }),
    origin: recordedOrigin, signedIn, ...(signedIn ? { token: recordedToken } : {}), languages: 'en',
  };
}

/**
 * The management session's acting Person, from the same reads `readSession` makes
 * after the cookie record. Stories have no session cookie, so the token is explicit.
 */
export async function recordedManagementAgent(fetcher: typeof fetch, locale: UiLocale):
  Promise<{ agent: AgentOption; actingSubject: string }> {
  const [discovery, listed, state] = await Promise.all([
    discoverActingContexts(recordedToken, fetcher),
    discoverAgents(recordedToken, locale, fetcher),
    readMainSessionAgent(recordedToken, recordedSessionKey, fetcher),
  ]);
  const publishing = discovery ? agentOptions(discovery) : [];
  const identities = listed ? identityOptions(listed, publishing) : null;
  const resolved = resolveSessionAgent(identities, state?.sessionAgent.eligible ? state.sessionAgent.actingSubject : null);
  if (resolved.status !== 'selected') throw new Error('Recorded management session has no acting Person');
  const profile = await readAgentProfile(resolved.agent.iri, recordedToken, fetcher);
  if (profile) {
    resolved.agent.label = profile.displayName;
    resolved.agent.avatarUrl = profile.avatarUrl;
  }
  return { agent: resolved.agent, actingSubject: resolved.agent.iri };
}

/** The community route: `loadRealmView`, then its join page or Zone frame. */
export async function recordedRealmRoute(replay: RealmReplay, realm: string, locale: UiLocale): Promise<ReactNode> {
  // The signed-in shell reads the session before the Realm view. There is no session cookie to replay.
  if (replay.signedIn) await recordedManagementAgent(replay.fetch, locale);
  const view = await loadRealmView(realm, locale, {}, 'community', replay);
  if (view.kind === 'missing' || view.kind === 'unavailable') {
    throw new Error(`Recorded Realm resolved to ${view.kind}`);
  }
  if (view.kind === 'join') {
    // Signed out, this route does not read the session. The server reader builds a process-backed
    // client; the story already knows there is no acting Person.
    return privateJoinPage(view.page, locale, realmHref(locale, realm), { actingSubject: null });
  }
  // Resolve the server frame here. The story renders its result; it does not host a second reader.
  return RealmFrame({ view, tab: 'discussions', locale, search: {}, children: null });
}

/** The request route inside its management frame. Both use the production readers. */
export async function recordedRequestsRoute(main: MainClient, fetcher: typeof fetch, realm: string, locale: UiLocale):
  Promise<ReactNode> {
  const { agent, actingSubject } = await recordedManagementAgent(fetcher, locale);
  const href = `/manage/r/${realm}/requests`;
  const body = await joinRequestsBody({
    main, realm, actingSubject, locale, signInHref: '/auth/start', href,
    apiFor: (space, resolved) => spaceAccessApi(() => main, space, resolved, actingSubject),
  });
  return realmManagementFrame({ main, realm, address: realm, actingSubject, agent, locale, token: recordedToken, children: body });
}

export { readRequestsAtAddress };
