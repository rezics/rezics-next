import { direction } from '@rezics/main/language';
import { browserMainApi } from '../api/browser.ts';
import { platformClosed, type OperationGate } from '../api/platform-access.ts';
import type { MainClient } from '../discover/types.ts';
import type { ThreadRead } from '../feed/thread.ts';
import { attachedDiscussionAbout, zoneDiscussionEntry } from './zone-discussion-recorded-page.ts';

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
  | { kind: 'closed' }
  | { kind: 'refused' }
  | { kind: 'stale' };
export interface AboutDiscussionApi {
  post(intent: AboutPostIntent): Promise<AboutPostOutcome>;
}
const uuid = (iri: string) => iri.slice(-36);

/** One command per attempt. The complete intent and key stay unchanged on recovery.
 * Production supplies its current viewer gate; isolated tests and stories can omit it. */
export function mainAboutDiscussionApi(main: () => MainClient = browserMainApi,
  operationOpen: OperationGate = () => true): AboutDiscussionApi {
  return { async post(intent) {
    if (operationOpen('postV1RealmsByRealmAbout-posts')) {
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
          // The grant gate runs before the intent owner. Its refusal cannot
          // establish the outcome of a previous attempt under this key.
          if (platformClosed(answer.error.status, answer.error.value)) return { kind: 'closed' };
          if (answer.error.status === 409) return { kind: 'stale' };
          // Expired authentication does not establish the previous attempt's
          // outcome. Keep its key for recovery after signing in again.
          if ([400, 403, 404, 410, 422].includes(answer.error.status)) return { kind: 'refused' };
          return { kind: 'recovery' };
        }
        return answer.data && 'reply' in answer.data
          ? { kind: 'posted', reply: answer.data.reply } : { kind: 'recovery' };
      } catch { return { kind: 'recovery' }; }
    }
    return { kind: 'closed' };
  } };
}

export type AboutDiscussionMode = 'open' | 'sign-in' | 'identity' | 'join' | 'reviewed' | 'unavailable' | 'closed';
export type AboutDiscussionRead =
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; basis: AboutDiscussionBasis; thread: ThreadRead | null;
      realmName?: { value: string; language: string; direction: 'ltr' | 'rtl' };
      mode: AboutDiscussionMode; actingSubject: string | null };
export type AboutDiscussionTargetReader =
  (resource: string) => Promise<{ resource: string; revision: string } | null>;

/** Reads the current route, never the Zone's cached frame attachment or reading-position route. */
export async function readAboutDiscussion(main: MainClient, input: {
  zone: string; path: string; signedIn: boolean; actingSubject?: string; personal: boolean; postingOpen?: boolean;
}, readCurrentTarget?: AboutDiscussionTargetReader): Promise<AboutDiscussionRead> {
  try {
    // Eden keeps object key order. Recorded requests name the page or about first, then the actor.
    const actor = input.actingSubject === undefined ? {} : { actingSubject: input.actingSubject };
    const routeRead = await main.v1.zones({ id: uuid(input.zone) }).routes.get({
      query: { path: input.path, ...actor },
    });
    const route = routeRead.data;
    if (!route || routeRead.error) {
      console.error(JSON.stringify({ event: 'zone_discussion_read_failed', operation: 'zone.routes',
        zone: input.zone, path: input.path, actingSubject: input.actingSubject, error: routeRead.error }));
      return { kind: 'unavailable' };
    }
    if (!route.realm) return { kind: 'none' };
    const about = attachedDiscussionAbout(route);
    // An index or an unpublished home has no page resource the command can address.
    if (!about) return { kind: 'none' };
    const realm = uuid(route.realm);
    const [target, lookup, header, joining] = await Promise.all([
      readCurrentTarget ? readCurrentTarget(about)
        : main.v1.resources({ resource: uuid(about) }).page.get({ query: { ...actor } })
          .then(read => read.error ? null : read.data?.target ?? null),
      main.v1.realms({ realm })['about-thread'].get({ query: { about, ...actor } }),
      main.v1.realms({ realm }).get({ query: { ...actor } }),
      input.actingSubject ? main.v1.realms({ realm }).joining.get({ query: { actingSubject: input.actingSubject } }) : null,
    ]);
    const frameReady = Boolean(target && target.resource === about && lookup.data && !lookup.error
      && header.data && !header.error);
    if (!frameReady) console.error(JSON.stringify({ event: 'zone_discussion_read_failed',
      realm: route.realm, about, actingSubject: input.actingSubject,
      target, lookup: lookup.error, header: header.error }));
    let thread: { ok: true; data: ThreadRead } | { ok: false } | null = null;
    if (frameReady && lookup.data?.thread) {
      const read = await main.v1.realms({ realm }).threads({ reply: uuid(lookup.data.thread.reply) }).get({
        query: { ...actor },
      });
      thread = !read.data || read.error ? { ok: false } : { ok: true, data: read.data };
    }
    return zoneDiscussionEntry({
      route: { realm: route.realm, zone: route.zone, path: route.path, revision: route.revision },
      about, target: target && target.resource === about ? target : null,
      lookup: lookup.data && !lookup.error ? { ok: true, thread: lookup.data.thread ?? null } : { ok: false },
      header: header.data && !header.error
        ? { ok: true, name: header.data.name, reviewMode: header.data.reviewMode } : { ok: false },
      joining: joining === null ? null : joining.data && !joining.error
        ? { ok: true, state: joining.data.state } : { ok: false },
      thread, signedIn: input.signedIn, actingSubject: input.actingSubject, personal: input.personal,
      postingOpen: input.postingOpen,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'zone_discussion_read_failed', zone: input.zone, path: input.path,
      error: error instanceof Error ? { name: error.name, message: error.message } : null }));
    return { kind: 'unavailable' };
  }
}
