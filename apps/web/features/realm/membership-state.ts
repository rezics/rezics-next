import type { MainClient } from '../discover/types.ts';

// The reader's place in a Realm: whether they joined (G-314's consent-based
// joining) and whether they follow it into Home (G-282's follows). Shared by
// the server read, the header control and its stories.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Realm = ReturnType<MainClient['v1']['realms']>;

/** Main's joining policy for the reader: whether they may join on their own and on which terms. */
export type JoinPolicy = Omit<Ok<Realm['joining']['get']>, 'realm'>;

export interface Membership {
  /** Null when Main has no joining policy for this Realm or could not read it. */
  policy: JoinPolicy | null;
  /** Null when the follow could not be read. */
  following: boolean | null;
  /** The follow relation's revision, Main's compare-and-set basis. */
  followRevision: string | null;
}

/**
 * What the header offers. Joined readers see that they joined; readers who
 * may join on their own are asked to Join; everyone else can Follow the
 * Realm into Home.
 */
export type MembershipOffer = 'joined' | 'join' | 'follow';

export function offerOf(membership: Membership): MembershipOffer {
  const policy = membership.policy;
  if (policy?.state === 'joined') return 'joined';
  return policy?.selfJoin && policy.open ? 'join' : 'follow';
}

const uuid = (iri: string) => iri.slice(-36);

/** The signed-in reader's membership and follow, read with their token. Either read may fail on its own. */
export async function readMembership(main: MainClient, realm: string, actingSubject: string): Promise<Membership> {
  const [policy, follow] = await Promise.all([
    main.v1.realms({ realm: uuid(realm) }).joining.get({ query: { actingSubject } }).catch(() => null),
    main.v1.follows({ id: uuid(realm) }).get({ query: { kind: 'realm', actingSubject } }).catch(() => null),
  ]);
  const read = policy?.data ? (({ realm: _, ...rest }) => rest)(policy.data) : null;
  return { policy: read, following: follow?.data ? follow.data.following ?? false : null,
    followRevision: follow?.data?.revision ?? null };
}
