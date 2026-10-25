/** TEST ONLY. COMMAND_ADMISSION_DRIVER_MODULE is an absolute path/file URL
 * exporting createCommandAdmissionDriver(): Promise<CommandAdmissionDriver>.
 * Provision isolated migrated PostgreSQL fixtures; close removes fixtures and
 * stops owned servers/pools. Factory failure cleans partial setup. Errors throw;
 * only actual native authorization refusal maps to { outcome: 'denied' }.
 *
 * Transport real installed access/index.ts authentication, native command executor,
 * shared receipts and independent SQL observations. No private permission.ts
 * evaluator, substitute Access, policy model, synthetic effects/receipts, precheck
 * in this adapter, or content-local admission check satisfies this port.
 * Authentication is genuine local JWT/JWKS verification, never Auth introspection.
 * Preserve signed requested_by provenance through an actual principal-created
 * request assignment. Public JWKS acquisition is not token introspection.
 *
 * Fixture SQL may establish accounts/grants/assignments and commit transitions.
 * This is component evidence, not full lifecycle command/API proof. Domain command
 * effects must come from production commands. No production binding is supplied
 * here; binding is a separate task after the request-read contract decision.
 */
export type Actor = Readonly<{
  kind: 'account';
  accountId: string;
  clientId: string;
  scopes: readonly string[];
  requestedBy: string | null;
  authnEpoch: number;
}>;
export type Fixture = {
  /** Exact frozen object returned by this installed Access.authenticate, not a copy. */
  actor: Actor;
  /** Actual installed Access and pool objects, retained for identity checks. */
  access: object;
  pool: object;
  /** Set once to authenticationStartedAt + 180_000 before authentication. */
  deadline: number;
  authenticationStartedAt: number;
  /** Actual verified JWT exp in milliseconds; token must outlive the request. */
  tokenExpiresAt: number;
  bearer: string;
  action: string;
  resource: { route: number; id: string };
  /** Two distinct valid keys for the same fixed native mutation payload. */
  keys: readonly [string, string];
};
export type Outcome =
  | { outcome: 'denied' }
  | { outcome: 'permitted'; receiptId: string; replayed: boolean; value: unknown };
export type Attempt = {
  /** Direct references actually passed to the native executor's Access boundary. */
  actor: Actor;
  access: object;
  pool: object;
  /** Invocation time, for observing request liveness only, never ordering writes. */
  startedAt: number;
  /** Native authoritative command T, captured while live; null only if none minted. */
  at: string | null;
  result: Outcome;
};
export type Account = {
  state: 'active' | 'suspended' | 'deleted';
  fenced: boolean;
  minimumAuthnEpoch: string;
};
export type Snapshot = {
  /** Complete committed target business rows, including stable identities/values. */
  state: unknown;
  effects: unknown[];
  outbox: unknown[];
  /** Actual stored receipt identities, keys and unmodified response payloads. */
  receipts: { id: string; key: string; response: unknown }[];
};
export interface CommandAdmissionDriver {
  /** Independent fixtures, distinct actor/resource partitions. Fully allowed
   * actor grant AND consented JWT scope AND principal grant, with requested_by.
   * Repeated seed calls retain the SAME installed Access and pool for isolation
   * controls, with distinct accounts, target resources, keys and assignments.
   * Authenticate exactly once using installed Access and this SAME pool/context.
   * missing-scope obtains a genuinely signed token lacking only the needed scope;
   * it still authenticates. No caller-made Actor or reauthentication on execute.
   * A fixed native mutation emits one business effect and one shared receipt per
   * successful new key. Choose a normal mutation, without self-read replay bypass.
   */
  seed(mode?: 'missing-scope'): Promise<Fixture>;
  /** Invoke the real native mutation/executor with the unchanged fixture Actor,
   * Access, pool and deadline. Build ordinary product command authorization on
   * every invocation; do not cache an authorization closure in the adapter.
   * Preserve payload/key/digest for replay. Overrides deliberately exercise native
   * identity/pool checks: otherPool is a distinct Pool on the SAME migrated DB.
   * Never authenticate, copy/restore Actor, refresh token, or extend deadline here.
   */
  execute(f: Fixture, key: string, override?: { actor?: Actor; pool?: object }): Promise<Attempt>;
  otherPool(): Promise<object>;
  /** Change ONLY the named authoritative fact; await COMMIT before returning.
   * floor sets minimum_authn_epoch strictly above f.actor.authnEpoch with active
   * state and fence false. fence changes only authn_fenced. Suspension changes
   * state only, leaving token, grants, floor and fence intact. Grant revocations
   * remove only the required resource grant of actor or assigned principal.
   * Never mutate the cached authenticated row, Actor, or Access identity registry.
   */
  transition(f: Fixture, fact: 'suspended' | 'floor' | 'fence' | 'actor-grant' | 'principal-grant'): Promise<void>;
  /** Independent read-only account-anchor query, not cached authentication data. */
  account(f: Fixture): Promise<Account>;
  /** Independent stable-order SQL snapshots, scoped to this fixture's command
   * target. Include every receipt/effect/outbox row and complete business state;
   * exclude authority setup/transitions and denial bookkeeping. Never infer rows
   * from arguments/results or maintain adapter counters. */
  inspect(f: Fixture): Promise<Snapshot>;
  /** Independent fresh HTTP request through actual createKernel.handle using the
   * original bearer, installed Access and pool. This MUST authenticate again;
   * never inject f.actor. Return the complete unmodified production Response.
   * Use the same command/payload and supplied key, to expose accidental effects.
   */
  http(f: Fixture, key: string): Promise<Response>;
  close(): Promise<void>;
}
