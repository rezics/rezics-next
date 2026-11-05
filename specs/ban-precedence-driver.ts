/**
 * BAN_PRECEDENCE_DRIVER is an absolute path/file URL exporting
 * createBanPrecedenceDriver(): Promise<BanPrecedenceDriver>.
 * TEST binding for membership-and-ban-protection, not a permission adapter.
 * Each factory owns an isolated migrated database, real Auth/Access and
 * createKernel.handle. Callers come from services/kernel/test/support/personas.ts;
 * no forged claims, fake Access, policy models, canned responses or raw grant SQL.
 * That shared fixture is required when binding this currently unbound suite.
 * Setup failure cleans partial resources; close removes only this factory's work.
 *
 * A Realm ban beats every independent read grant into that Realm's non-public
 * resources, including organization grants and delegation for the banned member.
 * Public reads retain the anonymous floor. Lifting a ban reveals the underlying
 * grants again without regranting, rejoining, refreshing credentials or waiting
 * for cleanup. Authenticated actors here are active; suspension is out of scope.
 */
export const BAN_PRECEDENCE_MISSING_DRIVER = 'Ban precedence outcome driver is required';

export type GrantKind = 'direct' | 'organization' | 'delegation';
export type Credential = string; // actual original Auth-issued bearer
export interface Principal {
  accountId: string;
  credential: Credential;
}
export interface ReadProbe {
  /** Real ordinary GET route, including its query/cursor when applicable. */
  path: string;
  /** Persisted ID or unique authored text that must occur in a successful read. */
  marker: string;
}
export interface ReadSurface {
  board: ReadProbe;
  thread: ReadProbe;
  post: ReadProbe;
  threads: ReadProbe;
  posts: ReadProbe;
}
export interface BanPrecedenceFixture {
  realmId: string;
  member: Principal;
  /** Active automated actor with a genuine delegation request for member. */
  delegate: Principal;
  /** Non-moderator with a separate independent grant, unaffected by member's ban. */
  reader: Principal;
  /** Active unrelated caller with scopes but no private read grants. */
  outsider: Principal;
  privateReads: ReadSurface;
  publicReads: ReadSurface;
  /** Both posts were authored by member before the ban, in the above surfaces. */
  pastPosts: { public: ReadProbe; private: ReadProbe };
}
export interface BanPrecedenceDriver {
  /**
   * Ordinary commands create a Realm with public and non-public board resources,
   * member's membership and past posts, and nonempty thread/post pages.
   * Visibility and other readers' permissions remain fixed throughout each test.
   * All private probes require the independent board grant, including descendants.
   * No Global/staff/owner bypass belongs to member or delegate.
   * reader has the same read coverage; outsider and anonymous lack private access.
   * A second public board supplies the same read surfaces under the public floor.
   * Return actual route URLs/IDs and persisted markers, never expected responses.
   */
  fixture(): Promise<BanPrecedenceFixture>;
  /**
   * Use ordinary grant commands, returning the original command Response.
   * direct: member receives the board's read authority independently of membership.
   * organization: a separate organization holds it, and member has its eligible
   * native organization role; no direct grant to member substitutes for this path.
   * delegation: member has principal authority, delegate has actor authority and
   * matching client consent/scopes plus the genuine principal request reference.
   * The delegated bearer is already issued and is used unchanged for every read.
   * These grants survive both ban and lift; neither command rewrites them.
   */
  grantRead(fixture: BanPrecedenceFixture, kind: GrantKind): Promise<Response>;
  /**
   * Ordinary moderator ban command on this Realm/member, with this exact reason.
   * Return after its authoritative commit, without draining membership cleanup.
   */
  ban(fixture: BanPrecedenceFixture, reason: string): Promise<Response>;
  /** Ordinary lift command; no rejoin, grant repair, credential refresh or settle. */
  lift(fixture: BanPrecedenceFixture): Promise<Response>;
  /**
   * Real HTTP GET through production Auth/Access, returning the original Response
   * unchanged (status, headers and JSON). null means no authentication header.
   * No response filtering, DTO remapping, error normalization or retry/poll loop.
   */
  request(credential: Credential | null, path: string): Promise<Response>;
  close(): Promise<void>;
}
