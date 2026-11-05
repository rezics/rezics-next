/**
 * Test-only binding contract. PERMISSION_DRIVER_MODULE must be an absolute path
 * or file URL exporting createPermissionDriver(): Promise<PermissionDriver>.
 * Each factory call owns an isolated fixture namespace and must clean it up.
 *
 * The eventual evidence must use real product operations, authoritative storage
 * (including PostgreSQL), and real Auth issuance/validation; Bun mocks and a
 * parallel permission evaluator are not product evidence. Fixture identifiers
 * and the read/write/grant:manage actions may be mapped to real product IDs and
 * registered operations. unknown:action must remain unregistered.
 * No table layout, token encoding, or HTTP/session transport is prescribed.
 */
export interface Account {
  id: string;
  kind: 'actor' | 'organization';
  operatorId?: string;
  state: 'active' | 'suspended' | 'deleted';
  minimumAuthnEpoch: number;
}

/** Test intervals are [start, end): start is included, end is excluded. */
export interface Validity {
  start: string;
  end: string;
}
export interface Grant {
  id: string;
  subject: { accountId: string } | { organizationId: string; role: 'owner' | 'member' };
  resourceId: string;
  actions: string[];
  effect: 'allow' | 'deny';
  valid: Validity;
}

export interface Facts {
  accounts: Account[];
  resources: string[];
  clients: { id: string; party: 'first' | 'third' }[];
  consents: { actorId: string; clientId: string; scopes: string[] }[];
  grants: Grant[];
  memberships: { organizationId: string; actorId: string; role: 'owner' | 'member'; valid: Validity }[];
  delegatedRequests: { id: string; createdBy: string; assignedTo: string }[];
}

export interface Login {
  actorId: string;
  clientId: string;
  scopes: string[];
  /** A reference to a record created by its principal's authenticated command. */
  requestedBy?: string;
}

/** Opaque to the suite; the adapter retains actual authenticated credentials. */
export interface Session {
  readonly handle: unknown;
}
export type Authentication = { outcome: 'authenticated'; session: Session } | { outcome: 'denied' };
export type Outcome = 'permitted' | 'denied';
export type Operation = { kind: 'resource'; resourceId: string; action: string } | { kind: 'grant'; grant: Grant };
export type Evidence =
  | 'accounts'
  | 'resources'
  | 'clients'
  | 'grants'
  | 'consents'
  | 'delegatedRequests'
  | 'memberships';

export interface PermissionDriver {
  /**
   * Replace authoritative facts in this namespace, preserving issued sessions.
   * This is privileged fixture setup, never caller-supplied authorization input.
   * Initial Auth credentials use epoch 1; raising the authoritative minimum does
   * not rewrite claims in sessions already issued. Facts are copied, not shared
   * mutable references. Runtime commands must not mutate the input fixture.
   * Delegated request fixtures must be created through the named creator's
   * authenticated command, not accepted as actor assertions at execution time.
   */
  replaceFacts(facts: Facts): Promise<void>;
  /**
   * Control the authoritative check clock, including database checks. Do not
   * expire/delete rows as time advances or accept time from an operation payload.
   * Keep Auth credentials valid across these small test-clock movements.
   */
  setAuthoritativeTime(instant: string): Promise<void>;
  /**
   * Use real fixture credentials belonging to actorId to issue through Auth.
   * scopes are requested scopes; none of these inputs are verified claims yet.
   */
  authenticate(login: Login): Promise<Authentication>;
  /**
   * Execute the real operation with session-derived identity/client/scope.
   * untrustedClaims models hostile request fields; it cannot change verified
   * claims. A denial must leave the attempted operation unapplied. Authentication
   * or authorization rejection maps to denied. A missing authoritative read denies;
   * an unavailable one answers retryable unavailability with nothing applied, which
   * the driver reports as denied. Unexpected adapter errors throw.
   * Grant operations exercise product grant administration, not fixture setup.
   */
  execute(session: Session, operation: Operation, untrustedClaims?: Partial<Login>): Promise<Outcome>;
  /**
   * Inject a not-found result or dependency failure at the real product's
   * authoritative read boundary. This avoids requiring dangling foreign keys
   * in PostgreSQL fixtures. Never replace the permission evaluator itself.
   */
  failEvidence(source: Evidence, failure: 'missing' | 'unavailable'): Promise<void>;
  close(): Promise<void>;
}
