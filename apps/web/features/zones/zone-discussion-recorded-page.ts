import type { ThreadRead } from '../feed/thread.ts';
import type { AboutDiscussionMode, AboutDiscussionRead } from './about-discussion-api.ts';

const referenceId = (iri: string) => iri.slice(-36);

export interface ZoneDiscussionRoute {
  realm: string;
  zone: string;
  path: string;
  revision: string;
}
export interface ZoneDiscussionTarget {
  resource: string;
  revision: string;
}
type RealmName = NonNullable<Extract<AboutDiscussionRead, { kind: 'ready' }>['realmName']>;
type ThreadPointer = { reply: string; rootRevision: string };

/** The mounted page a Zone route's discussion addresses. An index or a home without a page has none. */
export function attachedDiscussionAbout(route: {
  kind: string;
  page?: { reference: { resourceId: string } } | null;
  resource?: { id: string } | null;
}): string | undefined {
  return route.kind === 'home'
    ? route.page?.reference.resourceId
    : route.kind === 'detail' || route.kind === 'document'
      ? route.resource?.id
      : undefined;
}

export interface ZoneDiscussionEntryInput {
  route: ZoneDiscussionRoute;
  about: string;
  target: ZoneDiscussionTarget | null;
  lookup: { ok: true; thread: ThreadPointer | null } | { ok: false };
  header: { ok: true; name?: RealmName; reviewMode: string } | { ok: false };
  joining: { ok: true; state: string } | { ok: false } | null;
  /** The body read for a lookup that names a thread. Null when that read was not made. */
  thread: { ok: true; data: ThreadRead } | { ok: false } | null;
  signedIn: boolean;
  actingSubject?: string;
  personal: boolean;
  postingOpen?: boolean;
}

/** Membership, review and a missing body decide what the Zone entry may show.
 * A failed lookup or a thread pointer without its body stays unavailable, never an empty discussion. */
export function zoneDiscussionEntry(input: ZoneDiscussionEntryInput): AboutDiscussionRead {
  if (
    !input.target ||
    input.target.resource !== input.about ||
    !input.lookup.ok ||
    !input.header.ok
  )
    return { kind: 'unavailable' };
  if (input.lookup.thread && !input.thread?.ok) return { kind: 'unavailable' };
  const header = input.header;
  const joining = input.joining;
  const mode: AboutDiscussionMode = !input.signedIn
    ? 'sign-in'
    : input.postingOpen === false
      ? 'closed'
      : !input.actingSubject || !input.personal
        ? 'identity'
        : header.reviewMode === 'mandatory'
          ? 'reviewed'
          : header.reviewMode === 'trusted-members'
            ? !joining || !joining.ok
              ? 'unavailable'
              : joining.state === 'joined'
                ? 'open'
                : 'join'
            : 'open';
  return {
    kind: 'ready',
    basis: {
      realm: input.route.realm,
      about: input.about,
      targetRevision: input.target.revision,
      zone: `https://rezics.com/id/${referenceId(input.route.zone)}`,
      path: input.route.path,
      routeRevision: input.route.revision,
    },
    thread: input.lookup.thread && input.thread?.ok ? input.thread.data : null,
    mode,
    realmName: header.name,
    actingSubject: input.actingSubject ?? null,
  };
}
