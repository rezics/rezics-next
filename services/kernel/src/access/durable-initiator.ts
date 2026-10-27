import { finishDurableRateIdentity } from './write-rate-identity.ts';
import { accessEvidence, throwEvidenceFailure } from './evidence.ts';
import { throwAccessUnavailable } from './unavailable.ts';
import type { Pool } from 'pg';
import { commandAccessContext } from './command-admission.ts';
import { discardDurableIdentity, restoreOperationIdentity } from './durable-identity.ts';
import { deadlineClient, within } from './authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf } from '../route/route.ts';
import { permissionEvidenceDeadline } from './permission.ts';
import type { CurrentConsentReader } from './auth-consent.ts';
import type { AuthorizationAnchor } from './resource-authorization.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Access, AccessClient, AccessContext, AccountActor } from '../request/access.ts';

/** sourceId is the immutable actual native workflow/source binding, never new
 * authority supplied by a caller.
 */
export type DurableOperationAnchor = Readonly<{ route: number; id: string; kind: string; sourceId: string }>;

/** Committed allowlisted snapshot only. All fields, including the actor and its
 * captured scope ceiling, must remain immutable. No bearer, refresh token,
 * session cookie or private account profile belongs in this record.
 *
 * The native creator MUST authenticate and authorize through Access, committing
 * this immutable operation and its exact source in the same native command.
 * The owning module reads operation.route/id, validates the full route/id/kind/
 * sourceId/initiator/actor/recordedTransactionId tuple and independently verifies
 * the actual source payload/target against sourceDigest. originalAccount records
 * its original decimal floor and operator; originalDelegation records the exact
 * native assignment's transaction_id/issued_valid::text (or null). creation holds
 * the native receipt's command kind/key/request digest and creation target.
 * The exact receipt at partitionOf(operation.route), account principal
 * initiatorAccountId, MUST match transaction and request digest, and its response
 * durableInitiator MUST equal SHA-256 of RFC 8785 canonical JSON of this entire
 * allowlisted record. The reader verifies that receipt independently; the helper
 * repeats it. Missing/collected evidence, copied rows/sources/transactions or
 * changed bindings deny, never history-scan or grant permanent authority.
 * Return exactly these fields, without extra policy results or private data.
 *
 * Wire constraints: every ID is a lowercase routable UUIDv7/v8; explicit routes
 * must equal the ID's embedded route. kind, commandKind and idempotencyKey are
 * 1..255 non-space printable ASCII characters. actor is exactly an AccountActor
 * with kind='account', accountId=initiatorAccountId, clientId of 1..1024 non-space
 * printable ASCII characters, a positive safe-integer authnEpoch and at most 100
 * OAuth scope tokens (each 1..128 ASCII characters, excluding space, quote and
 * backslash). requestedBy is null or the exact native
 * urn:rezics:request:<principal UUID>:<request UUID> (at most 128 characters).
 * Digests are 64 lowercase hexadecimal characters. minimumAuthnEpoch is the
 * original positive canonical decimal floor (at most 19 digits); operator is
 * null or a routable UUID. originalDelegation is null iff requestedBy is null;
 * otherwise its transactionId is routable and issuedValid is the original
 * canonical PostgreSQL issued_valid::text, at most 256 characters. Every nested
 * object has exactly the exported keys; the entire record must be cloneable and
 * RFC 8785 canonicalizable. No current or reconstructed values replace snapshots.
 */
export type DurableInitiatorRecord = Readonly<{
  operation: DurableOperationAnchor;
  initiatorAccountId: string;
  actor: AccountActor;
  recordedTransactionId: string;
  /** SHA-256 of the owning module's exact immutable source and target payload.
   * The reader independently recomputes/checks this against its native source.
   */
  sourceDigest: string;
  /** Exact original native assignment creation, or null for no requestedBy.
   * Snapshot transaction_id and canonical issued_valid::text at creation.
   * Its immutable principal/request/assigned actor tuple is actor.requestedBy
   * plus actor.accountId. Replacement assignments can never inherit authority.
   */
  originalDelegation: Readonly<{ transactionId: string; issuedValid: string }> | null;
  /** Original authenticated account snapshot, captured by the native creator.
   * Decimal floor (not the token epoch) and operator remain immutable.
   */
  originalAccount: Readonly<{ minimumAuthnEpoch: string; operatorAccountId: string | null }>;
  /** Exact native creation receipt locator at partitionOf(operation.route).
   * commandKind/key are the actual writer's receipt PK; requestDigest is its
   * lowercase SHA-256 hex. target is the immutable creation authorization target.
   * The command's JSON response MUST contain durableInitiator = SHA-256 of RFC
   * 8785 canonical JSON of this ENTIRE allowlisted record (including transaction,
   * originalAccount, sourceDigest and creation). No extra record fields allowed.
   * The helper independently verifies that exact receipt, digest and transaction;
   * missing/collected receipts fail closed, never scan history for replacements.
   */
  creation: Readonly<{
    commandKind: string;
    idempotencyKey: string;
    requestDigest: string;
    target: Readonly<{ route: number; id: string }>;
  }>;
}>;

/** Trusted server composition over the owning module's real immutable row,
 * never supplied by request or DBOS data. The reader queries exact route/id,
 * checks kind/source/initiator/transaction, verifies module-specific committed
 * command provenance and immutable source binding, and returns only committed
 * allowlisted fields. Domain SQL stays module-owned. A permission callback,
 * raw caller actor, unverified shape or fixture Map cannot supply authority.
 *
 * REQUIRED reader/writer contract (all fields appear on the returned record):
 * - Read the real immutable operation at exact operation.route/id, matching ALL
 *   route/id/kind/sourceId, initiatorAccountId, actor and recordedTransactionId.
 * - Independently read the exact immutable native source at sourceId, verifying
 *   its operation/transaction, source payload AND creation target against
 *   sourceDigest. Never accept a copied source or a row-shaped callback result.
 * - Verify the actual native creation command at creation.commandKind and
 *   creation.idempotencyKey, partitionOf(operation.route), account principal
 *   initiatorAccountId. Verify creation.requestDigest and recordedTransactionId
 *   against that exact receipt; no history/transaction scan or replacement.
 * - The native creator must authenticate/authorize through Access and commit the
 *   source and operation in that command. Record only its original actor/scopes,
 *   originalAccount.minimumAuthnEpoch (decimal) and operatorAccountId snapshot.
 *   Capture originalDelegation = null for no requestedBy; otherwise independently
 *   verify its native principal-created assignment and record its transaction_id
 *   and canonical issued_valid::text. These creation fields remain immutable;
 *   the helper rejects replacement/missing/revoked or currently invalid rows.
 * - Its receipt response durableInitiator MUST be lowercase SHA-256 of RFC 8785
 *   canonical JSON of the ENTIRE allowlisted DurableInitiatorRecord, with exactly
 *   the exported fields. This binds the full tuple/source/target, original actor,
 *   floor/operator, original delegation and exact receipt locator/digest/
 *   transaction independently.
 *   The common helper repeats that exact receipt verification. Missing evidence,
 *   including a collected receipt, denies; receipts never confer permanent or
 *   replacement authority. Domains own evidence availability/retention.
 * - Return ONLY these allowlisted immutable fields, no bearer/private profile,
 *   permission result, unverified fixture or mutable policy snapshot.
 * - Satisfy every wire constraint documented on DurableInitiatorRecord: routable
 *   IDs and matching routes, exact nested keys, ASCII/token lengths and counts,
 *   account actor/epoch, exact requestedBy URN, lowercase digests, canonical
 *   original floor/operator and original delegation transaction/range snapshot.
 *   Return cloneable/canonicalizable data without replacing creation snapshots.
 */
export type DurableInitiatorReader = (
  client: AccessClient,
  operation: DurableOperationAnchor,
  time: AuthoritativeTime,
) => Promise<DurableInitiatorRecord | null>;

export type InitiatorRestoreInput = Readonly<{
  operation: DurableOperationAnchor;
  action: string;
  /** Validates the actual step authority resource, beyond operation existence. */
  anchor: AuthorizationAnchor;
  /** Same pool as installed, finite deadline, no target transaction held. */
  context: AccessContext;
}>;

export type InitiatorRestorerConfig = Readonly<{
  pool: Pool;
  access: Access;
  readOperation: DurableInitiatorReader;
  /** Trusted Auth-owned exact current consent reader; required on every call.
   * Supply an own data-property function, never an inherited property/getter.
   */
  readConsent: CurrentConsentReader;
}>;

export type InitiatorRestorer = Readonly<{
  restoreInitiator(operation: InitiatorRestoreInput, time: AuthoritativeTime): Promise<AccountActor>;
}>;

export class DurableInitiatorUnavailableError extends Error {
  constructor() {
    super('Durable initiator restoration is unavailable');
    this.name = 'DurableInitiatorUnavailableError';
  }
}

/** Restore inside CommandAuthorization.prepare, at the SAME live attempt T,
 * before target checkout. Every retry, step and receipt replay must invoke this
 * method anew. It evaluates the installed native formula on the independently
 * checked authority anchor; returned identity is valid only for this action/T,
 * pool and this step's deadline/native evidence budget. Same-attempt exact target
 * checks still run that formula, never an authority exemption.
 * Use the installed native Access instance and its exact pool, with a future
 * finite context.deadline; restoration evidence lasts at most 1,000 ms.
 *
 * Auth-owned current consent is mandatory on EVERY invocation. Scopes are the
 * intersection of recorded and current scopes, never grants. The immutable
 * original floor/operator snapshot must still match the independently read
 * current active/unfenced account; original bearer expiry is irrelevant here.
 * No bearer, signing, generic JSON identity registration or approval bypass.
 * Mechanical completion of committed platform decisions does not use this port;
 * later person-attributed actions do (see README for the exact distinction).
 *
 * Missing configuration denies before inspecting input/time or doing any I/O.
 * Untrusted/forged/changed provenance never reaches native identity admission.
 */
export function createInitiatorRestorer(config: InitiatorRestorerConfig): InitiatorRestorer {
  return Object.freeze<InitiatorRestorer>({
    async restoreInitiator(input, time) {
      let actor: AccountActor | undefined;
      try {
        // Do not inspect caller inputs, pool or Access when the trusted Auth
        // current-consent port is missing. Getters cannot provide configuration.
        if (typeof Object.getOwnPropertyDescriptor(config, 'readConsent')?.value !== 'function')
          throw new DurableInitiatorUnavailableError();
        const installed = {
          pool: config.pool,
          access: config.access,
          readOperation: config.readOperation,
          readConsent: config.readConsent,
        };
        const step = Object.freeze({
          operation: Object.freeze({ ...input.operation }),
          action: input.action,
          anchor: Object.freeze({
            resource: Object.freeze({ ...input.anchor.resource }),
            validate: input.anchor.validate.bind(input.anchor),
          }),
          context: Object.freeze({ pool: input.context.pool, deadline: input.context.deadline }),
        });
        actor = await restoreOperationIdentity(installed, step, time);
        const { access, pool } = installed;
        const resource = step.anchor.resource;
        const attempt = Object.freeze({
          time,
          partition: partitionOf(resource.route),
          basis: Object.freeze({
            actorAccountId: actor.accountId,
            clientId: actor.clientId,
            requestedBy: actor.requestedBy,
          }),
        });
        const context = commandAccessContext(step.context, attempt);
        const evidence = await access.prepare?.(actor, step.action, resource, context);
        const deadline = Math.min(context.deadline, permissionEvidenceDeadline(evidence) ?? -Infinity);
        const restored = actor;
        await within(deadline, () =>
          withConnection(pool, async (client) => {
            const bounded = deadlineClient(client, deadline);
            if (
              !(await accessEvidence(
                () => step.anchor.validate(bounded, time),
                () => new DurableInitiatorUnavailableError(),
                deadline,
              )) ||
              !(await access.authorize(bounded, restored, step.action, resource, evidence, time))
            )
              throw new DurableInitiatorUnavailableError();
          }),
        );
        finishDurableRateIdentity(actor, true);
        return actor;
      } catch (error) {
        if (actor) {
          finishDurableRateIdentity(actor, false);
          discardDurableIdentity(config.access, actor);
        }
        throwAccessUnavailable(error);
        throwEvidenceFailure(error);
        throw new DurableInitiatorUnavailableError();
      }
    },
  });
}
