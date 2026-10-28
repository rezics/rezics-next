import { accessClock } from './access-clock.ts';
import { commandAccessContext } from './command-admission.ts';
import { authoritativeTimeValue, type CommandAttempt } from '../command/command.ts';
import credentialFloorRead from './auth-barriers-credential-read.sql';
import canonicalize from 'canonicalize';
import { routeOf } from '../route/route.ts';
import { seal, unseal } from '../tokens/seal.ts';
import { readAccount, type Account } from './account-data.ts';
import operatorAccount from './operator-account.sql';
import consumedOperator from './auth-credential-capability-operator-read.sql';
import consumedWorkflow from './auth-credential-capability-workflow-read.sql';
import reservationRead from './operator-reservation.sql';
import memberRead from './operator-member.sql';
import { createCredentialFloorHook } from './auth-barriers.ts';
import { requireAccessDeadline } from './unavailable.ts';
import type {
  AuthSessionPort,
  CredentialApprovalPorts,
  CredentialFloorAuthorizationInput,
  CredentialEffectBinding as OperatorCredentialBinding,
  CredentialFloorPurpose,
  CredentialEffectAuthorization,
  CredentialFloorBinding,
  CredentialEffectExpectation,
  CredentialFloorPort,
  CredentialFloorReceipt,
  TrustedAccessPorts,
} from '@rezics/auth-contract';
import { credentialRequestDeadline } from '@rezics/auth-contract';
import type { Pool } from 'pg';
import type { Access, AccessContext, AccountActor, Resource } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { AuthBindingDeniedError, AuthBindingUnavailableError, type AuthAuthorizationReceipt } from './auth-bindings.ts';
import type { createOperatorCommands } from './operator.ts';
import { credentialWorkflowApprovals, type createWorkflowApprovals } from './workflow-approvals.ts';

/** Nonsecret exact binding plus the native opening's selected-row locator.
 * References are locators only, never proof of current authority. Own-human and
 * automated paths use their real native owners; never fake a self-operator row.
 */
type OpeningBinding<Binding> = Pick<
  Binding & CredentialFloorBinding,
  'operationKey' | 'effectReference' | 'effectDigest' | 'subjectAccountId' | 'purpose'
>;
export type CredentialOpeningLocator =
  | (OpeningBinding<CredentialFloorBinding> & { kind: 'workflow-approval'; reference: string })
  | (OpeningBinding<OperatorCredentialBinding> & {
      kind: 'operator-opening';
      operatorAccountId: string;
      receiptId: string;
    });

/** Trusted Auth-host composition, with installed Access and real native commands.
 * Auth retains its database, secrets, signing keys and runtime. referenceKeys are
 * kernel locator keys: one to three entries, byte IDs, >=32 bytes, current present.
 * accessTokenForProof accepts only this Auth instance's exact live callback proof;
 * feed its JWT immediately to ordinary installed Access authentication and never
 * retain either. verifyCredentialEffect is Auth's committed point-read closure,
 * not a caller hash, stage minter or kernel access to Auth storage.
 */
export type CredentialCapabilityConfig = {
  pool: Pool;
  access: Access;
  operators: ReturnType<typeof createOperatorCommands>;
  workflowApprovals: ReturnType<typeof createWorkflowApprovals>;
  referenceKeys: KeyRing;
  accessTokenForProof: AuthSessionPort['internal']['accessTokenForProof'];
  verifyCredentialEffect(
    reference: string,
    expected: CredentialEffectExpectation<CredentialFloorPurpose>,
  ): Promise<CredentialFloorBinding>;
};

type CredentialRevalidationInput = Parameters<NonNullable<TrustedAccessPorts['revalidateCredentialEffect']>>[0] & {
  /** Auth's saved committing opening identity; required for result disclosure. */
  committedOpeningReceiptId?: string;
};

export type CredentialCapability = Required<
  Pick<CredentialApprovalPorts<CredentialFloorPurpose>, 'approveCredentialEffect'>
> & {
  revalidateCredentialEffect(input: CredentialRevalidationInput): Promise<void>;
  /** Seal only a verified native exact opening locator; no caller approval minting.
   */
  createOpeningReference(opening: CredentialOpeningLocator): string;
  /** Credential-only consumer. Reject legacy unbound input, session/device approval
   * and broad credential-management alone. Auth verifies the committed stage; the
   * exact purpose/key/reference/digest/subject must match the narrowed native row
   * and returned CredentialEffectAuthorization before Auth writes.
   */
  consumeAuthAuthorization<Purpose extends CredentialFloorPurpose>(
    input: Omit<CredentialFloorAuthorizationInput, 'purpose'> & { purpose: Purpose },
  ): Promise<
    Omit<AuthAuthorizationReceipt, 'authorization'> & { authorization: CredentialEffectAuthorization<Purpose> }
  >;
  /** Credential-only committed floor hook; never consent/recovery relabelling.
   */
  advanceCredentialFloor: CredentialFloorPort;
};

function configured(value: unknown): asserts value {
  if (!value) throw new TypeError('Invalid credential capability configuration');
}

function requestDeadline(deadline: number | undefined): number {
  if (typeof deadline !== 'number' || !Number.isFinite(deadline))
    throw new AuthBindingUnavailableError('consumeAuthAuthorization');
  requireAccessDeadline(deadline);
  return deadline;
}

/** Native exact credential capability. Configuration is validated synchronously
 * without calling a dependency. Legacy unbound inputs fail unavailable before I/O.
 *
 * Native requirements: own-human means current human equals the actor subject;
 * account:manage on that exact account uses actor grant AND consented client scope
 * AND principal grant when present. Explicit deny/missing evidence deny; no owner
 * bypass. Use workflow_approval with a CLOSED credential descriptor consumed once
 * by CAS. Organizations never hold credentials, automation never acts as operator.
 *
 * For automation, authorizeOpening/consumeOpening on the operator anchor enforce
 * current human, eligible operator, current relation/reservation/version, applicable
 * organization membership, exact human/client/scopes and every recorded floor.
 * Narrow credential-management in its native transaction AND consume CAS to ONE
 * exact purpose/key/Auth-verified commitment. Reuse operator_opening_receipt with
 * credential binding columns; a broad opening alone fails. Four separate purposes
 * never substitute for each other, sessions or devices in either direction.
 *
 * Operator opening expiry is min(native created T + 60s, bearer expiry carried
 * into kernel time), checked against command T. The evidence read window bounds
 * creation reads, not the opening lifetime. Retention never renews rows. Every
 * consume/retry re-runs the SAME formula, current state, fences, floors and operator
 * checks, including before disclosure of an exact saved Auth result.
 * Revalidate at the Auth commit boundary: revocation after consumption spends the
 * opening without mutation. An opening without exact committed Auth success fails
 * closed; NEW authenticated approval may resume only the same immutable operation.
 *
 * Floor advancement binds Auth's stage, consumed opening, expected previous floor,
 * key and purpose; return a real committed native receipt for the exact next floor
 * with fence preserved. Password replacement/remove-password/remove-key advance
 * before mutation and revoke <=64 sessions; add-key/first password do not. Keep
 * Auth's mutation/revocation/exact success receipt atomic in Auth, never in kernel.
 *
 * Access/DBOS persist only nonsecret locators, no password/private key/cookie/JWT
 * or permission context. Fixed selected rows/statements and logarithmic buffers:
 * O(log R + (1+K) log G), R=N+U*t+M. No history/opening/session scans. Native tasks
 * prove checkGrowth at 1x/8x/64x separately for same-subject consumed openings, old
 * Auth effects and unrelated owners. Migration versions use date -u +%Y%m%d%H%M%S
 * at creation; temporary artifacts use worktree-relative .temp/ only.
 */
export function createCredentialCapability(config: CredentialCapabilityConfig): CredentialCapability {
  configured(config && typeof config === 'object' && !Array.isArray(config));
  configured(typeof config.pool?.query === 'function' && typeof config.pool?.connect === 'function');
  configured(
    typeof config.access?.authenticate === 'function' &&
      typeof config.access?.prepare === 'function' &&
      typeof config.access?.authorize === 'function',
  );
  configured(
    typeof config.operators?.authorizeOpening === 'function' && typeof config.operators?.consumeOpening === 'function',
  );
  configured(
    typeof config.workflowApprovals?.approve === 'function' &&
      typeof config.workflowApprovals?.resolve === 'function' &&
      typeof config.workflowApprovals?.resolveForCaller === 'function',
  );
  configured(typeof config.accessTokenForProof === 'function' && typeof config.verifyCredentialEffect === 'function');
  const ring = config.referenceKeys;
  configured(ring?.keys instanceof Map && ring.keys.size > 0 && ring.keys.size <= 3);
  configured(ring.keys.has(ring.current));
  for (const [id, key] of ring.keys)
    configured(Number.isInteger(id) && id >= 0 && id <= 255 && key instanceof Uint8Array && key.byteLength >= 32);
  const { pool, access, operators, workflowApprovals, verifyCredentialEffect, accessTokenForProof } = config;
  const referenceKeys = {
    current: ring.current,
    keys: new Map([...ring.keys].map(([id, key]) => [id, new Uint8Array(key)])),
  };
  async function stage(reference: ReturnType<typeof pick>, actor: AccountActor): Promise<CredentialFloorBinding> {
    const expected = {
      operationKey: reference.operationKey,
      subjectAccountId: reference.subjectAccountId,
      purpose: reference.purpose,
      actingHumanId: actor.accountId,
      clientId: actor.clientId,
      scopes: [...actor.scopes],
      effectDigest: reference.effectDigest,
    };
    const result = await verifyCredentialEffect(reference.effectReference, expected);
    allowed(
      result &&
        result.effectReference === reference.effectReference &&
        result.operationKey === expected.operationKey &&
        result.subjectAccountId === expected.subjectAccountId &&
        result.purpose === expected.purpose &&
        result.effectDigest === expected.effectDigest &&
        result.actingHumanId === expected.actingHumanId &&
        result.clientId === expected.clientId &&
        same(result.scopes, expected.scopes) &&
        ((result.credentialRowId === null && result.credentialRowVersion === null) ||
          (typeof result.credentialRowId === 'string' &&
            result.credentialRowId.length > 0 &&
            typeof result.credentialRowVersion === 'string' &&
            result.credentialRowVersion.length > 0)),
    );
    return structuredClone(result);
  }
  async function validateNative(
    input: Parameters<CredentialFloorPort>[0],
    prior: CredentialFloorReceipt | null,
    attempt?: CommandAttempt,
    selected?: NativeConsumed,
  ) {
    const deadline = requestDeadline(input.deadline);
    const { stage: binding, consumedOpening: opening, expectedPreviousFloor: previous } = input;
    allowed(
      opening &&
        binding &&
        binding.subjectAccountId === opening.subjectAccountId &&
        binding.operationKey === opening.operationKey &&
        binding.effectReference === opening.effectReference &&
        binding.effectDigest === opening.effectDigest &&
        binding.purpose === opening.purpose &&
        binding.actingHumanId === opening.actingHumanId &&
        binding.clientId === opening.clientId &&
        same(binding.scopes, opening.scopes) &&
        opening.subjectEpoch === previous,
    );
    const reference = locator({
      ...pick(binding),
      ...(opening.operatorAccountId === null
        ? { kind: 'workflow-approval', reference: 'floor' }
        : { kind: 'operator-opening', operatorAccountId: opening.operatorAccountId, receiptId: opening.receiptId }),
    });
    // Native rows, not the caller's consumedOpening object, establish provenance.
    const row = selected
      ? { data: selected }
      : opening.operatorAccountId === null
        ? await consumedWorkflow.run(pool, {
            route: routeOf(opening.receiptId)!,
            receipt_id: opening.receiptId,
            at: accessClock(access)().toISOString(),
          })
        : await consumedOperator.run(pool, {
            route: routeOf(opening.operatorAccountId)!,
            operator_id: opening.operatorAccountId,
            receipt_id: opening.receiptId,
            at: accessClock(access)().toISOString(),
          });
    allowed(row && row.data && typeof row.data === 'object');
    const native = row.data as unknown as NativeConsumed;
    const own = opening.operatorAccountId === null;
    const nativeBinding = own
      ? native.operation
      : {
          operationKey: native.credential_operation_key,
          effectReference: native.credential_effect_reference,
          effectDigest: native.credential_effect_digest,
          purpose: native.credential_purpose,
          subjectAccountId: native.subject_account_id,
        };
    allowed(
      nativeBinding &&
        same(pick(nativeBinding), pick(binding)) &&
        native.client_id === opening.clientId &&
        same(native.scopes, opening.scopes) &&
        native.requested_by === null &&
        (own ? native.actor_id : native.acting_human_id) === opening.actingHumanId &&
        Number(own ? native.authn_epoch : native.human_authn_epoch) === opening.humanEpoch &&
        Date.parse(native.expires_at) === Date.parse(opening.expiresAt) &&
        Date.parse(native.expires_at) > accessClock(access)().getTime() &&
        Number(own ? native.operation?.subjectEpoch : native.subject_epoch_floor) === previous,
    );
    if (prior)
      allowed(
        prior.accountId === binding.subjectAccountId &&
          prior.openingReceiptId === opening.receiptId &&
          prior.operationKey === binding.operationKey &&
          prior.purpose === binding.purpose &&
          prior.effectReference === binding.effectReference &&
          prior.effectDigest === binding.effectDigest &&
          prior.previousFloor === previous &&
          prior.minimumAuthnEpoch === previous + 1,
      );
    const subject = await operatorAccount.run(pool, {
      route: routeOf(binding.subjectAccountId)!,
      account_id: binding.subjectAccountId,
    });
    allowed(
      subject &&
        subject.kind === 'actor' &&
        subject.state === 'active' &&
        !subject.fenced &&
        subject.operatorAccountId === opening.operatorAccountId &&
        Number(subject.minimumAuthnEpoch) === (prior ? previous + 1 : previous) &&
        (!prior || subject.fenced === prior.fenced),
    );
    const human = await readAccount(pool, routeOf(opening.actingHumanId)!, opening.actingHumanId);
    allowed(
      human && human.kind === 'actor' && human.state === 'active' && !human.fenced && human.operatorAccountId === null,
    );
    // Only the exact committed own-human barrier permits this in-flight floor
    // continuation to use its next floor; it grants no consume or session authority.
    const continuation = own && prior !== null;
    allowed(
      BigInt(opening.humanEpoch) >= human.minimumAuthnEpoch ||
        (continuation && human.minimumAuthnEpoch === BigInt(previous + 1)),
    );
    const actor: AccountActor = Object.freeze({
      kind: 'account',
      accountId: opening.actingHumanId,
      clientId: opening.clientId,
      scopes: Object.freeze([...opening.scopes]),
      requestedBy: null,
      authnEpoch: continuation ? previous + 1 : opening.humanEpoch,
    });
    const verified = await stage(reference, actor);
    allowed(same(verified, binding));
    let resource: Resource = { route: routeOf(subject.accountId)!, id: subject.accountId };
    if (!own) {
      operatorBinding(binding);
      allowed(
        native.purpose === 'credential-management' &&
          native.action === 'account:manage' &&
          subject.version === String(native.relation_version) &&
          subject.reservationId === native.reservation_id &&
          human.minimumAuthnEpoch === BigInt(native.human_epoch_floor),
      );
      const operator = await operatorAccount.run(pool, {
        route: routeOf(opening.operatorAccountId!)!,
        account_id: opening.operatorAccountId!,
      });
      allowed(
        operator &&
          operator.state === 'active' &&
          !operator.fenced &&
          operator.operatorAccountId === null &&
          operator.minimumAuthnEpoch === String(native.operator_epoch_floor),
      );
      const held = await reservationRead.run(pool, {
        route: routeOf(operator.accountId)!,
        operator_id: operator.accountId,
        reservation_id: subject.reservationId!,
      });
      allowed(held?.subjectAccountId === subject.accountId);
      if (operator.kind === 'organization') {
        const membership = await memberRead.run(pool, {
          route: routeOf(operator.accountId)!,
          organization_id: operator.accountId,
          human_id: human.accountId,
          at: attempt ? authoritativeTimeValue(attempt.time) : accessClock(access)().toISOString(),
        });
        allowed(membership.length === 1);
      } else allowed(operator.kind === 'actor' && operator.accountId === human.accountId);
      resource = { route: routeOf(operator.accountId)!, id: operator.accountId };
    } else allowed(subject.accountId === human.accountId);
    const boundary = { pool, deadline };
    const context = attempt ? commandAccessContext(boundary, attempt) : boundary;
    const proof = Object.freeze({}) as CredentialFloorIdentity;
    floorIdentities.set(proof, { actor, account: human, pool });
    try {
      allowed(await floorBridges.get(access)?.(proof, resource, context));
    } finally {
      floorIdentities.delete(proof);
    }
  }
  const advanceCredentialFloor = createCredentialFloorHook({ pool, access, validate: validateNative });
  async function authenticate(
    human: Parameters<CredentialCapability['approveCredentialEffect']>[0]['human'],
    deadline: number,
  ) {
    const actor = await access.authenticate(await accessTokenForProof(human), { pool, deadline });
    allowed(
      actor.accountId === human.account_id &&
        actor.clientId === human.client_id &&
        actor.authnEpoch === human.authn_epoch &&
        actor.requestedBy === null &&
        same(actor.scopes, human.scope),
    );
    return actor;
  }
  return {
    async approveCredentialEffect({ stage: binding, human, deadline: suppliedDeadline }) {
      const deadline = requestDeadline(suppliedDeadline ?? credentialRequestDeadline(human));
      const actor = await authenticate(human, deadline);
      allowed(same(await stage(binding, actor), binding));
      const subject = await readAccount(pool, routeOf(binding.subjectAccountId)!, binding.subjectAccountId);
      allowed(subject && subject.kind === 'actor' && subject.state === 'active' && !subject.fenced);
      const context = { pool, deadline };
      let opening: CredentialOpeningLocator;
      let expiresAt: string;
      if (subject.operatorAccountId === null) {
        allowed(subject.accountId === actor.accountId);
        const approved = await credentialWorkflowApprovals(workflowApprovals).approveCredentialForActor(
          actor,
          binding,
          context,
        );
        opening = { ...pick(binding), kind: 'workflow-approval', reference: approved.reference };
        expiresAt = approved.expiresAt;
      } else {
        operatorBinding(binding);
        const account = await readAccount(pool, routeOf(actor.accountId)!, actor.accountId);
        const approved = await operators.authorizeOpening(
          { actor, account, deadline: context.deadline },
          {
            operatorAccountId: subject.operatorAccountId,
            subjectAccountId: subject.accountId,
            purpose: 'credential-management',
            credential: binding,
            key: `credential:${crypto.randomUUID()}`,
          },
        );
        opening = {
          ...pick(binding),
          kind: 'operator-opening',
          operatorAccountId: subject.operatorAccountId,
          receiptId: approved.value.receiptId,
        };
        expiresAt = approved.value.expiresAt;
      }
      return { reference: seal(referenceKeys, SCOPE, locator(opening)), expiresAt };
    },
    async revalidateCredentialEffect(input) {
      const deadline = requestDeadline(input.deadline ?? credentialRequestDeadline(input.human));
      const reference = locator(unseal(referenceKeys, SCOPE, input.authorization));
      allowed(same(pick(reference), pick(input.stage)));
      const own = reference.kind === 'workflow-approval';
      const row =
        reference.kind === 'workflow-approval'
          ? await credentialWorkflowApprovals(workflowApprovals).readConsumedCredential(reference.reference, {
              pool,
              deadline,
            })
          : await consumedOperator.run(pool, {
              route: routeOf(reference.operatorAccountId)!,
              operator_id: reference.operatorAccountId,
              receipt_id: reference.receiptId,
              at: accessClock(access)().toISOString(),
            });
      allowed(row?.data);
      const native = row.data as unknown as NativeConsumed;
      const receiptId = reference.kind === 'workflow-approval' ? native.approval_id : reference.receiptId;
      const opening: CredentialEffectAuthorization<CredentialFloorPurpose> = {
        ...pick(input.stage),
        receiptId,
        operatorAccountId: reference.kind === 'workflow-approval' ? null : reference.operatorAccountId,
        actingHumanId: own ? native.actor_id : native.acting_human_id,
        clientId: native.client_id,
        scopes: native.scopes,
        humanEpoch: Number(own ? native.authn_epoch : native.human_authn_epoch),
        subjectEpoch: Number(own ? native.operation?.subjectEpoch : native.subject_epoch_floor),
        expiresAt: new Date(native.expires_at).toISOString(),
      };
      allowed(
        input.human.account_id === opening.actingHumanId &&
          input.human.client_id === opening.clientId &&
          same(input.human.scope, opening.scopes) &&
          input.human.authn_epoch === opening.humanEpoch,
      );
      if (input.replay)
        allowed(!input.consumedOpening && !input.floorReceipt && input.committedOpeningReceiptId === opening.receiptId);
      else allowed(input.consumedOpening && same(input.consumedOpening, opening));
      let prior: CredentialFloorReceipt | null = null;
      if (input.floorReceipt) {
        allowed(
          !input.replay &&
            (input.stage.purpose === 'remove-password' ||
              input.stage.purpose === 'remove-key' ||
              input.stage.purpose === 'remove-passkey' ||
              (input.stage.purpose === 'set-password' && input.stage.credentialRowId !== null)),
        );
        const committed = await credentialFloorRead.run(pool, {
          route: routeOf(opening.subjectAccountId)!,
          account_id: opening.subjectAccountId,
          opening_receipt_id: receiptId,
        });
        allowed(committed);
        prior = {
          ...committed,
          purpose: committed.purpose as CredentialFloorReceipt['purpose'],
          previousFloor: Number(committed.previousFloor),
          minimumAuthnEpoch: Number(committed.minimumAuthnEpoch),
        };
        allowed(same(prior, input.floorReceipt));
      }
      // After an own-human barrier Auth's source session is revoked. Only the
      // exact committed native receipt can continue this one in-flight callback.
      if (!(own && prior)) await authenticate(input.human, deadline);
      await validateNative(
        {
          deadline,
          stage: input.stage,
          consumedOpening: opening,
          expectedPreviousFloor: opening.subjectEpoch,
          key: input.stage.operationKey,
          purpose: input.stage.purpose,
        },
        prior,
        undefined,
        native,
      );
    },
    createOpeningReference(opening) {
      return seal(referenceKeys, SCOPE, locator(opening));
    },
    async consumeAuthAuthorization(input) {
      // The deprecated variant never reaches a proof, locator or storage reader.
      if (
        !input ||
        !purposes.includes(input.purpose) ||
        typeof input.operationKey !== 'string' ||
        !input.operationKey ||
        typeof input.effectReference !== 'string' ||
        !input.effectReference
      )
        throw new AuthBindingUnavailableError('consumeAuthAuthorization');
      const deadline = requestDeadline(input.deadline ?? credentialRequestDeadline(input.human));
      const reference = locator(unseal(referenceKeys, SCOPE, input.authorization));
      allowed(
        reference.subjectAccountId === input.subjectAccountId &&
          reference.purpose === input.purpose &&
          reference.operationKey === input.operationKey &&
          reference.effectReference === input.effectReference,
      );
      const actor = await access.authenticate(await accessTokenForProof(input.human), { pool, deadline });
      allowed(
        actor.accountId === input.human.account_id &&
          actor.clientId === input.human.client_id &&
          actor.authnEpoch === input.human.authn_epoch &&
          actor.requestedBy === null &&
          same(actor.scopes, input.human.scope),
      );
      const binding = await stage(reference, actor);
      const subject = await operatorAccount.run(pool, {
        route: routeOf(input.subjectAccountId)!,
        account_id: input.subjectAccountId,
      });
      allowed(
        subject &&
          subject.kind === 'actor' &&
          subject.state === 'active' &&
          !subject.fenced &&
          Number.isSafeInteger(Number(subject.minimumAuthnEpoch)) &&
          Number(subject.minimumAuthnEpoch) > 0,
      );
      let operatorOpening: AuthAuthorizationReceipt['operatorOpening'] = null;
      let receiptId: string;
      let expiresAt: string;
      if (subject.operatorAccountId === null) {
        allowed(subject.accountId === actor.accountId && reference.kind === 'workflow-approval');
        const consumed = await credentialWorkflowApprovals(workflowApprovals).consumeCredential(
          reference.reference,
          binding,
          actor,
          {
            pool,
            deadline,
          },
        );
        receiptId = consumed.receiptId;
        expiresAt = consumed.expiresAt;
        allowed(consumed.subjectEpoch === Number(subject.minimumAuthnEpoch));
      } else {
        allowed(reference.kind === 'operator-opening' && reference.operatorAccountId === subject.operatorAccountId);
        operatorBinding(binding);
        const account = await readAccount(pool, routeOf(actor.accountId)!, actor.accountId);
        const consumed = await operators.consumeOpening(
          { actor, account, deadline },
          {
            operatorAccountId: reference.operatorAccountId,
            subjectAccountId: subject.accountId,
            receiptId: reference.receiptId,
            purpose: 'credential-management',
            credential: binding,
            key: `auth-credential:${reference.receiptId}`,
          },
        );
        allowed(!consumed.replayed);
        operatorOpening = consumed.value;
        receiptId = operatorOpening.receiptId;
        expiresAt = operatorOpening.expiresAt;
      }
      const after = await operatorAccount.run(pool, {
        route: routeOf(subject.accountId)!,
        account_id: subject.accountId,
      });
      allowed(
        after &&
          after.state === 'active' &&
          after.kind === 'actor' &&
          !after.fenced &&
          after.operatorAccountId === subject.operatorAccountId &&
          after.version === subject.version &&
          after.reservationId === subject.reservationId &&
          after.minimumAuthnEpoch === subject.minimumAuthnEpoch &&
          Date.parse(expiresAt) > accessClock(access)().getTime(),
      );
      return {
        operatorOpening,
        authorization: {
          ...pick(binding),
          purpose: input.purpose,
          receiptId,
          actingHumanId: actor.accountId,
          operatorAccountId: subject.operatorAccountId,
          clientId: actor.clientId,
          scopes: [...actor.scopes],
          humanEpoch: actor.authnEpoch,
          subjectEpoch: Number(subject.minimumAuthnEpoch),
          expiresAt: new Date(expiresAt).toISOString(),
        },
      };
    },
    advanceCredentialFloor,
  };
}

export type { PasskeyPurpose, CredentialFloorPurpose } from '@rezics/auth-contract';

function operatorBinding(binding: CredentialFloorBinding): asserts binding is OperatorCredentialBinding {
  allowed(binding.purpose !== 'add-passkey' && binding.purpose !== 'remove-passkey');
}

const SCOPE = 'access.credential-opening.v1';
const purposes = ['set-password', 'remove-password', 'add-key', 'remove-key', 'add-passkey', 'remove-passkey'];
function allowed(value: unknown): asserts value {
  if (!value) throw new AuthBindingDeniedError();
}
const same = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);
function pick<Purpose extends CredentialFloorPurpose>(
  value: Pick<
    OperatorCredentialBinding<Purpose>,
    'operationKey' | 'effectReference' | 'effectDigest' | 'subjectAccountId' | 'purpose'
  >,
) {
  return {
    operationKey: value.operationKey,
    effectReference: value.effectReference,
    effectDigest: value.effectDigest,
    subjectAccountId: value.subjectAccountId,
    purpose: value.purpose,
  };
}
function locator(value: unknown): CredentialOpeningLocator {
  allowed(value && typeof value === 'object' && !Array.isArray(value));
  const row = value as CredentialOpeningLocator;
  const fields = [
    'kind',
    'operationKey',
    'effectReference',
    'effectDigest',
    'subjectAccountId',
    'purpose',
    ...(row.kind === 'workflow-approval' ? ['reference'] : ['operatorAccountId', 'receiptId']),
  ];
  allowed(
    same(Object.keys(row).sort(), fields.sort()) &&
      typeof row.operationKey === 'string' &&
      row.operationKey.length > 0 &&
      row.operationKey.length <= 255 &&
      typeof row.effectReference === 'string' &&
      row.effectReference.length > 0 &&
      row.effectReference.length <= 4096 &&
      /^[a-f0-9]{64}$/.test(row.effectDigest) &&
      routeOf(row.subjectAccountId) !== null &&
      purposes.includes(row.purpose),
  );
  if (row.kind === 'workflow-approval')
    allowed(typeof row.reference === 'string' && row.reference.length > 0 && row.reference.length <= 4096);
  else
    allowed(
      row.kind === 'operator-opening' &&
        !['add-passkey', 'remove-passkey'].includes(row.purpose) &&
        routeOf(row.operatorAccountId) !== null &&
        routeOf(row.receiptId) !== null &&
        row.operatorAccountId !== row.subjectAccountId,
    );
  return structuredClone(row);
}
type NativeConsumed = {
  approval_id: string;
  operation?: Pick<
    CredentialFloorBinding,
    'operationKey' | 'effectReference' | 'effectDigest' | 'subjectAccountId' | 'purpose'
  > & { subjectEpoch: number };
  credential_operation_key: string;
  credential_effect_reference: string;
  credential_effect_digest: string;
  credential_purpose: OperatorCredentialBinding['purpose'];
  subject_account_id: string;
  client_id: string;
  scopes: string[];
  requested_by: string | null;
  actor_id: string;
  acting_human_id: string;
  authn_epoch: number;
  human_authn_epoch: number;
  expires_at: string;
  subject_epoch_floor: number;
  human_epoch_floor: number;
  purpose: string;
  action: string;
  relation_version: number;
  reservation_id: string;
  operator_epoch_floor: number;
};

declare const floorIdentity: unique symbol;
export type CredentialFloorIdentity = { readonly [floorIdentity]: true };
const floorIdentities = new WeakMap<CredentialFloorIdentity, { actor: AccountActor; account: Account; pool: Pool }>();
const floorBridges = new WeakMap<
  Access,
  (proof: CredentialFloorIdentity, resource: Resource, context: AccessContext) => Promise<boolean>
>();
/** Installed once by the ordinary Access factory; no actor JSON registration. */
export function installCredentialFloorBridge(
  access: Access,
  bridge: (proof: CredentialFloorIdentity, resource: Resource, context: AccessContext) => Promise<boolean>,
) {
  if (floorBridges.has(access)) throw new Error('Credential floor bridge already installed');
  floorBridges.set(access, bridge);
}
/** Opaque evidence exists only after exact native consumed-row verification. */
export function credentialFloorIdentityClaims(proof: CredentialFloorIdentity, pool: Pool) {
  const claims = floorIdentities.get(proof);
  return claims?.pool === pool ? claims : undefined;
}
