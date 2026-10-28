/**
 * WEB_PERSONAL_DRIVER is an absolute path or file URL exporting
 * createWebPersonalDriver(): Promise<WebPersonalDriver>. Each factory call owns
 * an isolated migrated PostgreSQL database, real Auth-issued sessions, production
 * createAccess, createKernel.handle and the durable-work worker, the production
 * Auth app, and the production web Worker with its real session store. Both apps
 * point at that kernel. Setup failures clean up; close removes only owned resources.
 *
 * Requests are real HTTP to the served production web Worker (and served Auth app
 * during authentication), never calls to fake clients, recorded responses or route
 * handlers in isolation. Browser contexts keep real cookies and execute the served
 * pages and their server functions (the BFF). No injected bearer, session-store
 * write, intercepted response or test-only page substitutes for signing in.
 * Responses below are original HTTP Responses, with unchanged status, headers and
 * body. DOM observations are extracted from rendered visible content, not API data
 * spliced into a page model. Actions select the real controls and submit the actual
 * page forms/server functions, preserving CSRF, idempotency and revision handling.
 *
 * provision consumes fixtures/web-personal.json. It maps logical keys to native IDs
 * and writes fixture subjects, grants, Collections, Zone mounts and offers through
 * the kernel API under an activated bundled released definitions version. No SQL
 * fixture insertion, test-only definitions, inferred word counts or universal state
 * strings. Profile choices come from that release. Accounts/credentials may be
 * provisioned during setup; personal facts start empty and are created by UI actions.
 * Alice and Bob have consented website scopes but no grant to each other's facts.
 * Governance and seller accounts have only fixture-scoped setup authority.
 * The suspended persona follows native `suspended` from
 * services/kernel/test/support/personas.ts: suspend('alice') retains her pre-suspension
 * credentials, now revoked (401 invalid_token), and cookies. No SQL-made token or
 * fake persona is permitted; correct-password sign-in is 403 ACCOUNT_SUSPENDED
 * and creates no session.
 *
 * facts is independent read-only authoritative database observation, not a cache of
 * requested actions or a replacement for served-page assertions. transport is
 * production-boundary tracing, not reconstructed authorization. Neither implements
 * business transitions. Payment delivery uses the native verified provider boundary;
 * settle runs only this fixture's real queued workflows, never their effects by hand.
 *
 * Cost — personal outcome suite
 * Touches: no product read-path change; this is a red specification.
 * Bound: each case reads/writes the finite JSON fixture; traversal is capped below.
 * Growth check: none here; native binding measures served requests per page.
 */
export type Persona = 'alice' | 'bob' | 'anonymous' | 'newcomer';
export type Surface = 'library' | 'state' | 'collection' | 'zone';
export interface PersonalFixture {
  definitionsVersion: string;
  accounts: { alice: string; bob: string };
  subjects: Record<string, { id: string; title: string }>;
  /** Actual accepted IDs from the released Book/Recipe library profiles. */
  choices: {
    bookState: string;
    otherBookState: string;
    recipeState: string;
    copyKind: string;
    copyStatus: string;
    progressUnit: string;
  };
  collectionId: string;
  zoneId: string;
  offerId: string;
  entitlementTarget: string;
  protected: { realmId: string; boardId: string; threadId: string };
  /** An actual valid image; source bytes, not a forged completion result. */
  image: { name: string; mimeType: string; bytes: Uint8Array };
}
export type Target =
  | { kind: 'members'; surface: Surface; limit: number; state?: string }
  | { kind: 'subject'; subjectId: string }
  | { kind: 'offer'; offerId: string }
  | { kind: 'order'; orderId: string; checkoutReturn?: boolean }
  | { kind: 'security' }
  | { kind: 'thread'; threadId: string };

/** Observations only: IDs are parsed from the actual rendered links/controls. */
export interface PageObservation {
  url: string;
  text: string;
  heading: string;
  signedInAccountId: string | null;
  /** Only the members region; canonical IDs in displayed order, not every page link. */
  memberSubjectIds: string[];
  nextHref: string | null;
  filterBarVisible: boolean;
  /** Visible readiness UI tied to the native preparing contract, never an empty success. */
  preparing: boolean;
  personal: { state: string | null; labels: string[]; copies: number; progress: number | null };
  order: null | {
    id: string;
    settlement: 'pending' | 'paid' | 'failed';
    receiptHref: string | null;
    entitlementVisible: boolean;
  };
  security: { stepUpRequired: boolean; changed: boolean };
}
export interface Visit {
  response: Response;
  page: PageObservation;
}
export type Action =
  | { kind: 'track'; subjectId: string; state: string }
  | { kind: 'label'; subjectId: string; name: string }
  | { kind: 'copy'; subjectId: string; copyKind: string; status: string; note: string }
  | { kind: 'progress'; subjectId: string; unit: string; value: number; note: string }
  | { kind: 'publish-collection' }
  | { kind: 'filter'; wordCountGreaterThan: number; tagSubjectId: string; type: 'schema:Book' }
  | { kind: 'upload-and-attach'; threadId: string; image: PersonalFixture['image']; text: string }
  | { kind: 'reply'; threadId: string; text: string }
  | { kind: 'start-checkout' }
  | { kind: 'change-security-setting' };
export interface PersonalFacts {
  entries: { subjectId: string; state: string }[];
  labels: { subjectId: string; name: string }[];
  copies: { subjectId: string; kind: string; status: string; note: string }[];
  progress: { subjectId: string; unit: string; value: number; note: string }[];
  collectionMembers: string[];
  zoneMembers: string[];
  media: { id: string; complete: boolean; attachedThreadId: string | null; downloadHref: string; sha256: string }[];
  posts: { authorId: string; text: string }[];
  orders: { id: string; offerId: string; settlement: 'pending' | 'paid' | 'failed'; receiptId: string | null }[];
  entitlements: { targetId: string; orderId: string }[];
  securitySettingChanged: boolean;
}
export interface TransportObservation {
  /** Each BFF-to-kernel HTTP request since the last observation, captured at Access. */
  requests: { method: string; path: string; actorId: string | null; authenticated: boolean; authorized: boolean }[];
}
export interface AuthVisit extends Visit {
  /** Browser-observed Auth page URLs in order, then the web return when successful. */
  visitedUrls: string[];
  /** Actual HTTP responses for forms and redirects, unchanged, in network order. */
  responses: Response[];
  session: { accountId: string | null; freshAuthentication: boolean; websiteConsent: boolean };
}
export interface WebPersonalDriver {
  close(): Promise<void>;
  provision(data: unknown): Promise<PersonalFixture>;
  /** No automatic login; callers explicitly exercise the served Auth flow. */
  visit(persona: Persona, target: Target): Promise<Visit>;
  /** Follow an exact link emitted by the last rendered page, using the same cookies. */
  follow(persona: Persona, href: string): Promise<Visit>;
  /** Run an action on the currently served page; do not call kernel APIs directly. */
  act(persona: Persona, action: Action): Promise<Visit>;
  /**
   * Real served forms: signup uses a previously unregistered newcomer; sign-in
   * uses the fixture credentials; consent explicitly reviews/approves the website
   * client (including its standing first-party consent); step-up confirms the
   * stale session at Auth; sign-out ends both the website and Auth sessions.
   * Preserve the exact requested web return target through the redirect chain.
   * A refused sign-in still submits the correct fixture password through the served
   * Auth form. Return its /signin response in responses, the current Auth page and
   * observed session state (accountId null, freshAuthentication/websiteConsent false
   * when no session exists); do not follow a success return or fabricate a session.
   * The security target opens the security setting from web, via Auth as needed.
   */
  auth(
    persona: Exclude<Persona, 'anonymous'>,
    journey: 'sign-up' | 'sign-in' | 'consent' | 'step-up' | 'sign-out',
    returnTo: Target,
  ): Promise<AuthVisit>;
  /** Origins of the actual servers, used to assert redirect destinations. */
  origins: { web: string; auth: string };
  facts(persona: 'alice' | 'bob' | 'newcomer'): Promise<PersonalFacts>;
  transport(): Promise<TransportObservation>;
  /** Advance the trusted Auth/kernel test clock, without editing session evidence.
   * Keep sessions valid while making their actual authentication older than 600s. */
  ageAuthentication(seconds: number): Promise<void>;
  /** Governance API actions, retaining the browser's old cookies/credentials. */
  revokeSession(persona: 'alice'): Promise<Response>;
  suspend(persona: 'alice'): Promise<Response>;
  /** Independent grantor grants read only on the protected fixture, via native API. */
  grantIndependentRead(persona: 'alice'): Promise<Response>;
  /** Ban through native moderation API; do not wait for membership-removal work. */
  ban(persona: 'alice'): Promise<Response>;
  /** Download exact served media/receipt URL over HTTP with this persona's cookies. */
  download(persona: Persona, href: string): Promise<Response>;
  /** Hold native payment delivery until explicitly released; checkout redirects settle nothing. */
  payment(orderId: string, outcome: 'paid' | 'failed'): Promise<void>;
  settle(): Promise<void>;
}
export type CreateWebPersonalDriver = () => Promise<WebPersonalDriver>;
