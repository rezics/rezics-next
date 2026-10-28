/**
 * WEB_PUBLICATION_DRIVER is an absolute path or file URL exporting
 * createWebPublicationDriver(): Promise<WebPublicationDriver>.
 *
 * Each factory owns an isolated migrated PostgreSQL database, real Auth-issued
 * credentials, production createAccess, createKernel.handle and the durable-work
 * worker, plus the production web Worker built from apps/web. Its kernel origin
 * points at that native kernel, never a recorded/fake kernel fetch. Run required
 * native search/index and sitemap publication workers against those resources.
 * Failed setup cleans itself up; close removes only this factory's resources.
 *
 * provision writes specs/fixtures/web-publication.json through ordinary kernel
 * APIs under a released definitions version. No direct row inserts, synthetic
 * read responses, test-only definitions or serializer substitution are allowed.
 * Released FORM/diet/profile bindings must exist; missing producer support is a
 * failing native acceptance prerequisite, not permission to invent a property.
 * Logical keys map to created IDs and URLs, not driver-selected expected results.
 * Dates, order, classifications and privacy controls come from the JSON fixture.
 * Accounts receive actual consented scopes and independent API resource grants.
 * The suspended persona is the native `suspended` from
 * services/kernel/test/support/personas.ts: its bearer was issued before suspension
 * and now gets 401 invalid_token. No SQL-made token or fake persona is permitted.
 * Correct-password sign-in gets 403 ACCOUNT_SUSPENDED and creates no session.
 *
 * Every request() is real HTTP to that production web Worker, including documents,
 * hydration, robots and compressed sitemaps. Send actual session cookies/bearers
 * for the persona, preserve supplied headers, use redirect: manual and return the
 * original Response unchanged (status, headers and body). Never invoke a route
 * function directly, normalize an error, follow redirects or implement rendering.
 * URLs at the configured public origin map to the owned HTTP listener solely for
 * transport; their path/query is unchanged. No request may escape this fixture.
 * Native API setup/observations below are controls, not substitutes for web reads.
 *
 * Cost: Publication outcome suite
 * - Touches: No product read path is changed; executable red specification only.
 * - Bound: Each case reads this finite fixture. Sitemap export traverses native
 *   feed continuation to its end; served shard traversal is bounded by its inventory.
 * - Growth check: None here; the binding task measures served requests per page.
 */
export type Persona = 'anonymous' | 'alice' | 'bob' | 'editor' | 'suspended';
export type RelationView = 'editions' | 'contents' | 'cast' | 'crew' | 'inverse' | 'relations';
export type PublishedSubject = 'book' | 'recipe' | 'game' | 'release' | 'person' | 'organization' | 'automated';
export type SitemapKind = 'subject' | 'collection' | 'realm' | 'space' | 'board' | 'thread';

export interface PublicationFixture {
  /** The actual immutable release digest, with bundled Book/form/tag/diet support. */
  releaseDigest: string;
  publicOrigin: string;
  /** Created logical subject key -> canonical en URL; includes every relation target. */
  subjects: Record<string, string> & Record<PublishedSubject, string>;
  /** Full view URLs linked by the overview (inverse is linked by the person page). */
  views: Record<RelationView, string>;
  details: string;
  qualifiedCredit: string;
  staleBookZhHans: string;
  canonicalBookZhHans: string;
  verifiedSubject: string;
  verifiedProfile: string;
  publicPage: string;
  /** The web's real personal hydration endpoint for Alice's subject. */
  personalRead: string;
  /** Protected board read: Alice is banned despite an independent read grant. */
  bannedRead: string;
  privateCollection: string;
  unknownCollection: string;
  emptyPublicList: string;
  preparingView: string;
  unavailableView: string;
  searchZhHans: string;
  /** All eight locale URLs, including views/profiles; exact fixture inventory.
   * Derived from created resource identities + declared fixture eligibility only,
   * never scraped from a feed/sitemap or computed by the implementation under test.
   * At least one eligible and each applicable privacy control per kind, beyond one feed page.
   */
  sitemap: Record<SitemapKind, { eligible: { url: string; lastmod: string | null }[]; excluded: string[] }>;
}

export interface WebPublicationDriver {
  provision(data: typeof import('./fixtures/web-publication.json')): Promise<PublicationFixture>;
  request(url: string, persona?: Persona, headers?: Record<string, string>): Promise<Response>;
  /** Drain this fixture's actual durable projections, index and sitemap export,
   * following native feed continuation until next:null, even after empty pages.
   * No direct mutation of projections, rendered documents, feeds or cache entries.
   */
  settle(): Promise<void>;
  /** Editor proposes the fixture's competing sourced date via kernel API. */
  proposeCompetingDate(): Promise<void>;
  /** Revoke Alice's personal-read authority through production account/resource
   * APIs, keeping the same valid session. No simulated authorization decisions.
   */
  revokeAlice(): Promise<void>;
  /** Reconfigure/restart only the owned web Worker with this public origin.
   * Retain native data. Request Host remains unrelated to configured origin.
   */
  configurePublicOrigin(origin: string): Promise<void>;
  /** Real owner dependency outage or durable projection barrier, never a fake
   * response. The preparing view is cold and not yet projected; restoring lets
   * the real worker complete it. The unavailable view's required owner cannot
   * be reached during owner-read. Restoration is idempotent and close also restores.
   */
  interrupt(kind: 'subject-view' | 'owner-read'): Promise<() => Promise<void>>;
  /** Production kernel HTTP search response for exactly the served zh-Hans query,
   * including facets, captured independently of the web's response/rendering.
   * Native engine, real indexed released fixture; no expected-result reconstruction.
   */
  nativeSearch(): Promise<{ results: Response; facets: Response }>;
  close(): Promise<void>;
}
export type CreateWebPublicationDriver = () => Promise<WebPublicationDriver>;
