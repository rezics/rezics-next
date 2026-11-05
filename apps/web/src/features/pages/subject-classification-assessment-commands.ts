import type {
  ClassificationAssessment,
  ClassificationAssociationIdentity,
  ClassificationSetResult,
} from './subject-classification-assessment';
import { classificationAssociationKey, isClassificationUuid } from './subject-classification-assessment';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ClassificationCommandKind = 'set' | 'withdraw';

export type ClassificationCommandOperands =
  | Readonly<{
      kind: 'set';
      assessment: ClassificationAssessment;
      falsePositive: boolean;
    }>
  | Readonly<{ kind: 'withdraw' }>;

export type ClassificationCommand = Readonly<{
  identity: ClassificationAssociationIdentity;
  expectedReader: string;
  csrfToken: string;
  idempotencyKey: string;
  operands: ClassificationCommandOperands;
}>;

export type ClassificationCommandOutcome =
  | { kind: 'accepted'; command: ClassificationCommand; result: ClassificationSetResult | null }
  | { kind: 'pending'; command: ClassificationCommand; result: ClassificationSetResult | null }
  | { kind: 'uncertain'; command: ClassificationCommand }
  | { kind: 'conflict'; command: ClassificationCommand }
  | { kind: 'denied'; command: ClassificationCommand }
  | { kind: 'concealed'; command: ClassificationCommand }
  | { kind: 'unavailable'; command: ClassificationCommand }
  | { kind: 'stale'; command: ClassificationCommand };

export function classificationCommandKey(command: ClassificationCommand): string {
  return JSON.stringify([
    classificationAssociationKey(command.identity),
    command.expectedReader,
    command.csrfToken,
    command.idempotencyKey,
    command.operands,
  ]);
}

export function sameClassificationCommand(left: ClassificationCommand, right: ClassificationCommand): boolean {
  return classificationCommandKey(left) === classificationCommandKey(right);
}

export function captureClassificationCommand(input: {
  identity: ClassificationAssociationIdentity;
  expectedReader: string;
  csrfToken: string;
  idempotencyKey?: string;
  operands: ClassificationCommandOperands;
}): ClassificationCommand {
  if (!input.expectedReader || input.expectedReader.length > 128)
    throw new Error('Classification command reader unavailable');
  if (!input.csrfToken) throw new Error('Classification command credential unavailable');
  const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
  if (!uuid.test(idempotencyKey)) throw new Error('Classification command key unavailable');
  return Object.freeze({
    identity: Object.freeze({ ...input.identity }),
    expectedReader: input.expectedReader,
    csrfToken: input.csrfToken,
    idempotencyKey,
    operands: Object.freeze(
      input.operands.kind === 'withdraw'
        ? { kind: 'withdraw' as const }
        : {
            kind: 'set' as const,
            assessment: input.operands.assessment,
            falsePositive: input.operands.falsePositive,
          },
    ),
  });
}

/** Explicit retry must replay this object: sender, credentials, key and exact operands stay unchanged. */
export function replayClassificationCommand(command: ClassificationCommand): ClassificationCommand {
  return captureClassificationCommand({
    identity: command.identity,
    expectedReader: command.expectedReader,
    csrfToken: command.csrfToken,
    idempotencyKey: command.idempotencyKey,
    operands: command.operands,
  });
}

export function admitClassificationCommand(value: unknown): ClassificationCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid classification command');
  const input = value as Record<string, unknown>;
  if (
    typeof input.expectedReader !== 'string' ||
    !input.expectedReader ||
    input.expectedReader.length > 128 ||
    typeof input.csrfToken !== 'string' ||
    !input.csrfToken ||
    typeof input.idempotencyKey !== 'string' ||
    !uuid.test(input.idempotencyKey) ||
    !input.identity ||
    typeof input.identity !== 'object' ||
    !input.operands ||
    typeof input.operands !== 'object'
  )
    throw new Error('Invalid classification command');
  const identity = input.identity as Record<string, unknown>;
  if (
    !isClassificationUuid(identity.subjectId) ||
    !isClassificationUuid(identity.associationId) ||
    !isClassificationUuid(identity.targetId) ||
    !isClassificationUuid(identity.contextId) ||
    typeof identity.property !== 'string' ||
    !identity.property ||
    identity.property.length > 256 ||
    typeof identity.qualifiersKey !== 'string' ||
    identity.qualifiersKey.length > 8192 ||
    !Number.isSafeInteger(identity.spoilerLevel) ||
    (identity.spoilerLevel as number) < 0 ||
    (identity.spoilerLevel as number) > 2 ||
    (identity.release !== undefined && (typeof identity.release !== 'string' || identity.release.length > 128)) ||
    (identity.revision !== undefined && (!Number.isSafeInteger(identity.revision) || (identity.revision as number) < 1))
  )
    throw new Error('Invalid classification command identity');
  const operands = input.operands as Record<string, unknown>;
  const captured = captureClassificationCommand({
    identity: {
      subjectId: identity.subjectId,
      associationId: identity.associationId,
      property: identity.property,
      targetId: identity.targetId,
      contextId: identity.contextId,
      qualifiersKey: identity.qualifiersKey,
      spoilerLevel: identity.spoilerLevel as number,
      ...(typeof identity.release === 'string' ? { release: identity.release } : {}),
      ...(typeof identity.revision === 'number' ? { revision: identity.revision } : {}),
    },
    expectedReader: input.expectedReader,
    csrfToken: input.csrfToken,
    idempotencyKey: input.idempotencyKey,
    operands:
      operands.kind === 'withdraw'
        ? { kind: 'withdraw' }
        : operands.kind === 'set' &&
            (operands.assessment === 'support' || operands.assessment === 'oppose') &&
            (operands.falsePositive === true || operands.falsePositive === false)
          ? { kind: 'set', assessment: operands.assessment, falsePositive: operands.falsePositive }
          : (() => {
              throw new Error('Invalid classification command operands');
            })(),
  });
  return captured;
}

export function commandMatchesVisit(
  command: ClassificationCommand,
  visit: {
    identity: ClassificationAssociationIdentity | null;
    reader: string | null;
    csrfToken: string | null;
  },
): boolean {
  if (!visit.identity || !visit.reader || !visit.csrfToken) return false;
  return (
    command.expectedReader === visit.reader &&
    command.csrfToken === visit.csrfToken &&
    classificationAssociationKey(command.identity) === classificationAssociationKey(visit.identity)
  );
}

export function outcomePreservesCommand(outcome: ClassificationCommandOutcome): ClassificationCommand {
  return outcome.command;
}

export function commandAcknowledgedPending(result: ClassificationSetResult | null): boolean {
  return result?.delivery === 'enqueued';
}

export function newClassificationEditAllowed(outcome: ClassificationCommandOutcome | null): boolean {
  if (!outcome) return true;
  return outcome.kind !== 'uncertain' && outcome.kind !== 'pending';
}
