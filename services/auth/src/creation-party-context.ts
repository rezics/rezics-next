import type {
  NativeCreationContext,
  NativeCreationContextRequest,
  NativeCreationContextResult,
  ReadNativeCreationContext,
} from '@rezics/auth-contract';
export type { NativeCreationContext } from '@rezics/auth-contract';

// Literal projection of createStage and its exact provisioning-receipt copy.
// Versions describe original custody, never consumer retirement or completion.
export const NATIVE_CREATION_PARTY_PRODUCERS = [
  {
    table: 'auth_registration_stage',
    key: 'registration_id',
    versions: { creation_context_version: 1, erasure_actor_version: 1 },
    accountPhases: [
      { kind: 'subject', table: 'auth_registration_stage', role: 'erasure_actor_id' },
      { kind: 'subject', table: 'auth_registration_stage', role: 'erasure_human_id' },
      { kind: 'subject', table: 'auth_registration_stage', role: 'erasure_native_operator_id' },
      { kind: 'subject', table: 'auth_registration_stage', role: 'erasure_principal_id' },
      { kind: 'subject', table: 'auth_registration_stage', role: 'erasure_client_owner_id' },
      { kind: 'subject', table: 'auth_registration_stage', role: 'erasure_source_client_owner_id' },
    ],
    clientPhases: [
      { table: 'auth_registration_stage', role: 'erasure_client_id' },
      { table: 'auth_registration_stage', role: 'erasure_source_client_id' },
    ],
  },
  {
    table: 'auth_provisioning_receipt',
    key: 'idempotency_key',
    versions: { creation_context_version: 1, erasure_actor_version: 1 },
    accountPhases: [
      { kind: 'subject', table: 'auth_provisioning_receipt', role: 'erasure_actor_id' },
      { kind: 'subject', table: 'auth_provisioning_receipt', role: 'erasure_human_id' },
      { kind: 'subject', table: 'auth_provisioning_receipt', role: 'erasure_native_operator_id' },
      { kind: 'subject', table: 'auth_provisioning_receipt', role: 'erasure_principal_id' },
      { kind: 'subject', table: 'auth_provisioning_receipt', role: 'erasure_client_owner_id' },
      { kind: 'subject', table: 'auth_provisioning_receipt', role: 'erasure_source_client_owner_id' },
    ],
    clientPhases: [
      { table: 'auth_provisioning_receipt', role: 'erasure_client_id' },
      { table: 'auth_provisioning_receipt', role: 'erasure_source_client_id' },
    ],
  },
] as const;

export type NativeCreationPort = { readNativeCreationContext?: ReadNativeCreationContext };

export function creationContextUnavailable(
  reason: 'producer-missing' | 'historical-provenance' | 'opening-provenance',
): never {
  throw Object.assign(new Error(`Native creation context unavailable: ${reason}`), { status: 503 as const });
}

const bounded = (value: unknown, limit = 1024): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limit && !value.includes('\0');
const nullable = (value: unknown) => value === null || bounded(value);

/** Shared by registration stages and workflow requests. Consume only the real
 * trusted composition port; public operation fields can neither install
 * attribution nor stand in for a missing producer. */
export async function readApprovedCreationContext(
  ports: NativeCreationPort,
  input: NativeCreationContextRequest,
  binding: { operationKey: string; digest: string; commandKeyPrefix: string } | undefined,
): Promise<NativeCreationContext> {
  if (typeof ports.readNativeCreationContext !== 'function') creationContextUnavailable('producer-missing');
  const result: NativeCreationContextResult = await ports.readNativeCreationContext(input);
  if (result.kind === 'unavailable') creationContextUnavailable(result.reason);
  const c = result.context;
  if (
    !c?.operation ||
    !binding ||
    !bounded(c.actorAccountId) ||
    !nullable(c.actingHumanId) ||
    !nullable(c.operatorAccountId) ||
    !nullable(c.principalAccountId) ||
    !bounded(c.sourceClientId) ||
    !bounded(c.approvalReference, 4096) ||
    !bounded(c.commandKey, 4096) ||
    // Preserve automation's original byte bound and workflow requests' existing
    // character-bounded keys, which may contain multiple UTF-8 bytes per character.
    !bounded(c.operationKey, input.operation.kind === 'automated' ? 128 : 1024) ||
    !/^[a-f0-9]{64}$/.test(c.operationDigest) ||
    c.approvalReference !== input.approvalReference ||
    c.operationKey !== input.operationKey ||
    c.operationKey !== binding.operationKey ||
    c.operationDigest !== binding.digest ||
    c.commandKey !== binding.commandKeyPrefix ||
    c.operation.kind !== input.operation.kind ||
    !bounded(c.operation.action) ||
    !bounded(c.operation.targetResourceId) ||
    c.operation.targetClientId !== (input.operation.kind === 'client-reduction' ? input.operation.clientId : null) ||
    // Keep automation's original exact permission target checks. Other workflow
    // variants are resolved by the same native full-operation/key/digest reader;
    // this projection does not evaluate or widen their authorization formula.
    (input.operation.kind === 'automated' &&
      (c.operation.action !== 'account:manage' || c.operation.targetResourceId !== input.operation.operatorAccountId))
  )
    throw Object.assign(new Error('Native creation context binding refused'), { status: 403 as const });
  // Take an exact, closed snapshot. Never persist additional runtime fields or
  // the input operation's business payload through this attribution projection.
  return Object.freeze({
    actorAccountId: c.actorAccountId,
    actingHumanId: c.actingHumanId,
    operatorAccountId: c.operatorAccountId,
    principalAccountId: c.principalAccountId,
    sourceClientId: c.sourceClientId,
    approvalReference: c.approvalReference,
    commandKey: c.commandKey,
    operationKey: c.operationKey,
    operationDigest: c.operationDigest,
    operation: Object.freeze({
      kind: c.operation.kind,
      action: c.operation.action,
      targetResourceId: c.operation.targetResourceId,
      targetClientId: c.operation.targetClientId,
    }),
  });
}

/** Canonical native fields only, independent of PostgreSQL JSONB key ordering. */
export const nativeCreationBinding = (c: NativeCreationContext) => [
  c.actorAccountId,
  c.actingHumanId,
  c.operatorAccountId,
  c.principalAccountId,
  c.sourceClientId,
  c.approvalReference,
  c.commandKey,
  c.operationKey,
  c.operationDigest,
  c.operation.kind,
  c.operation.action,
  c.operation.targetResourceId,
  c.operation.targetClientId,
];
