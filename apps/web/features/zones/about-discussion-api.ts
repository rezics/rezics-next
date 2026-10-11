import { direction } from '@rezics/main/language';
import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import type { ThreadRead } from '../feed/thread.ts';

export interface AboutDiscussionBasis {
  realm: string;
  about: string;
  targetRevision: string;
  zone: string;
  path: string;
  routeRevision: string;
}
export interface AboutPostIntent {
  key: string;
  basis: AboutDiscussionBasis;
  actingSubject: string;
  body: string;
  language: string;
  spoiler: boolean;
}
export type AboutPostOutcome =
  | { kind: 'posted'; reply: string }
  | { kind: 'pending' }
  | { kind: 'recovery' }
  | { kind: 'refused' }
  | { kind: 'stale' };
export interface AboutDiscussionApi {
  post(intent: AboutPostIntent): Promise<AboutPostOutcome>;
}
const uuid = (iri: string) => iri.slice(-36);

/** One command per attempt. The complete intent and key stay unchanged on recovery. */
export function mainAboutDiscussionApi(main: () => MainClient = browserMainApi): AboutDiscussionApi {
  return { async post(intent) {
    try {
      const { realm, ...basis } = intent.basis;
      const answer = await main().v1.realms({ realm: uuid(realm) })['about-posts'].post({
        profile: 'realm-about-post-v1', ...basis, actingSubject: intent.actingSubject,
        body: intent.body, language: intent.language, direction: direction(intent.language, intent.body),
        spoiler: intent.spoiler,
      }, { headers: { 'idempotency-key': intent.key } });
      // 202 carries no receipt: a successful transport is not a settled post.
      if (answer.response.status === 202) return { kind: 'pending' };
      if (answer.error) {
        if (answer.error.status === 409) return { kind: 'stale' };
        // Expired authentication does not establish the previous attempt's
        // outcome. Keep its key for recovery after signing in again.
        if ([400, 403, 404, 410, 422].includes(answer.error.status)) return { kind: 'refused' };
        return { kind: 'recovery' };
      }
      return answer.data && 'reply' in answer.data
        ? { kind: 'posted', reply: answer.data.reply } : { kind: 'recovery' };
    } catch { return { kind: 'recovery' }; }
  } };
}

export type AboutDiscussionMode = 'open' | 'sign-in' | 'identity' | 'join' | 'reviewed' | 'unavailable' | 'closed';
export type AboutDiscussionRead =
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; basis: AboutDiscussionBasis; thread: ThreadRead | null;
      realmName?: { value: string; language: string; direction: 'ltr' | 'rtl' };
      mode: AboutDiscussionMode; actingSubject: string | null };

/** Reads the current route, never the Zone's cached frame attachment or reading-position route. */
export async function readAboutDiscussion(main: MainClient, input: {
  zone: string; path: string; signedIn: boolean; actingSubject?: string; personal: boolean; postingOpen?: boolean;
}): Promise<AboutDiscussionRead> {
  try {
    const query = { actingSubject: input.actingSubject };
    const routeRead = await main.v1.zones({ id: uuid(input.zone) }).routes.get({ query: { ...query, path: input.path } });
    const route = routeRead.data;
    if (!route || routeRead.error) return { kind: 'unavailable' };
    if (!route.realm) return { kind: 'none' };
    const about = route.kind === 'home' ? route.page?.reference.resourceId
      : route.kind === 'detail' || route.kind === 'document' ? route.resource.id : undefined;
    // An index or an unpublished home has no page resource the command can address.
    if (!about) return { kind: 'none' };
    const realm = uuid(route.realm);
    const [target, lookup, header, joining] = await Promise.all([
      main.v1.resources({ resource: uuid(about) }).page.get({ query }),
      main.v1.realms({ realm })['about-thread'].get({ query: { ...query, about } }),
      main.v1.realms({ realm }).get({ query }),
      input.actingSubject ? main.v1.realms({ realm }).joining.get({ query: { actingSubject: input.actingSubject } }) : null,
    ]);
    if (!target.data || target.error || !lookup.data || lookup.error || !header.data || header.error)
      return { kind: 'unavailable' };
    let thread: ThreadRead | null = null;
    if (lookup.data.thread) {
      const read = await main.v1.realms({ realm }).threads({ reply: uuid(lookup.data.thread.reply) }).get({ query });
      if (!read.data || read.error) return { kind: 'unavailable' };
      thread = read.data;
    }
    const mode: AboutDiscussionMode = !input.signedIn ? 'sign-in'
      : input.postingOpen === false ? 'closed'
      : !input.actingSubject || !input.personal ? 'identity'
      : header.data.reviewMode === 'mandatory' ? 'reviewed'
      : header.data.reviewMode === 'trusted-members'
        ? !joining || joining.error || !joining.data ? 'unavailable'
          : joining.data.state === 'joined' ? 'open' : 'join'
        : 'open';
    return { kind: 'ready', basis: { realm: route.realm, about,
      targetRevision: target.data.target.revision, zone: `https://rezics.com/id/${uuid(route.zone)}`,
      path: route.path, routeRevision: route.revision }, thread, mode,
      realmName: header.data.name, actingSubject: input.actingSubject ?? null };
  } catch { return { kind: 'unavailable' }; }
}
