import { cookies } from 'next/headers';
import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { sessionAgentState } from '../auth/session.ts';
import { readRealm } from '../discover/read.ts';
import type { ConceptState } from './state.ts';
import type { ConceptFollowState, ConceptRead, FacetList, Loaded } from './types.ts';
import { readConceptWorks, settle } from './works-read.ts';

// Reads for `/concepts/{id}`. Each returns a `Loaded` result instead of
// throwing, so one region's failure leaves the rest of the page; reads are
// cached per request, so the page and its metadata share one Main call.

/**
 * Who reads. A signed-in person whose session Agent is eligible follows as
 * that Agent; anyone else reads publicly. Concept pages are public: only the
 * follow state is read as the reader.
 */
export const conceptReader = cache(async () => {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  const state = token ? await sessionAgentState() : null;
  const actingSubject = state?.sessionAgent.eligible ? state.sessionAgent.actingSubject ?? undefined : undefined;
  return { signedIn: Boolean(token), actingSubject, main: mainApiWithToken(actingSubject ? token : undefined),
    /** Cover bytes go through the BFF, which sends the token, so Main needs the Agent too. */
    avatarQuery: actingSubject ? `?actingSubject=${encodeURIComponent(actingSubject)}` : '' };
});

/** What the Concept is: its name, definition, broader and narrower Concepts. */
export const readConcept = cache((id: string, locale: UiLocale): Promise<Loaded<ConceptRead>> =>
  settle(() => mainApiWithToken(undefined).v1.concepts({ id }).get({ query: { language: locale } })));

export const readFirstWorks = cache((state: ConceptState, locale: UiLocale) =>
  readConceptWorks(mainApiWithToken(undefined), state, locale));

/** Followers, and as a signed-in reader whether they follow the Concept. */
export const readConceptFollow = cache(async (id: string, locale: UiLocale): Promise<Loaded<ConceptFollowState>> => {
  const { main, actingSubject } = await conceptReader();
  return settle(() => main.v1.follows({ id }).get({ query: { kind: 'concept', language: locale, actingSubject } }));
});

/** Main's Facets, whose labels name each kind of value; the same for every reader until a deploy. */
export const readFacets = cache((): Promise<Loaded<FacetList>> =>
  settle(() => mainApiWithToken(undefined).v1.facets.get()));

/** The name of the community whose accepted values a page lists. */
export const readScopeRealm = cache(async (realm: string, locale: UiLocale) => {
  const read = await readRealm(mainApiWithToken(undefined), realm, locale);
  return read.ok ? read.data.name : null;
});
