import type {
  NativeCreationContext,
  NativeCreationContextRequest,
  ReadNativeCreationContext,
} from '@rezics/auth-contract';
export type { NativeCreationContext } from '@rezics/auth-contract';

export type NativeCreationPort = { readNativeCreationContext?: ReadNativeCreationContext };

export function creationContextUnavailable(
  reason: 'producer-missing' | 'historical-provenance' | 'opening-provenance',
): never {
  throw Object.assign(new Error(`Native creation context unavailable: ${reason}`), { status: 503 as const });
}

const bounded = (value: unknown, limit = 1024): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limit && !value.includes('\0');
const nullable = (value: unknown) => value === null || bounded(value);

/** Consume only the real trusted composition port; public operation fields can
 * neither install attribution nor stand in for a missing producer. */
export async function readApprovedCreationContext(
  ports: NativeCreationPort,
  input: NativeCreationContextRequest,
  binding: { operationKey: string; digest: string; commandKeyPrefix: string } | undefined,
): Promise<NativeCreationContext> {
  if (!ports.readNativeCreationContext) creationContextUnavailable('producer-missing');
  const result = await ports.readNativeCreationContext(input);
  if (result.kind === 'unavailable') creationContextUnavailable(result.reason);
  const c = result.context;
  if (
    input.operation.kind !== 'automated' ||
    !binding ||
    !bounded(c.actorAccountId) ||
    !nullable(c.actingHumanId) ||
    !nullable(c.operatorAccountId) ||
    !nullable(c.principalAccountId) ||
    !bounded(c.sourceClientId) ||
    !bounded(c.approvalReference, 4096) ||
    !bounded(c.commandKey, 4096) ||
    !bounded(c.operationKey, 128) ||
    !/^[a-f0-9]{64}$/.test(c.operationDigest) ||
    c.approvalReference !== input.approvalReference ||
    c.operationKey !== input.operationKey ||
    c.operationKey !== binding.operationKey ||
    c.operationDigest !== binding.digest ||
    c.commandKey !== binding.commandKeyPrefix ||
    c.operation.kind !== 'automated' ||
    c.operation.action !== 'account:manage' ||
    c.operation.targetResourceId !== input.operation.operatorAccountId ||
    c.operation.targetClientId !== null
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
