import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { preparedRatingReader } from './subject-ratings';
import {
  classificationAssociationKey,
  readClassificationAggregate,
  readClassificationOwnBallot,
  sameClassificationAssociation,
  writeClassificationBallot,
  type ClassificationAggregateOutcome,
  type ClassificationAssociationIdentity,
  type ClassificationAssessmentCost,
  type ClassificationOwnOutcome,
} from './subject-classification-assessment';
import {
  admitClassificationCommand,
  commandAcknowledgedPending,
  type ClassificationCommand,
  type ClassificationCommandOutcome,
} from './subject-classification-assessment-commands';

export type ClassificationAssessmentRead = Readonly<{
  reader: string | null;
  identity: ClassificationAssociationIdentity;
  own: ClassificationOwnOutcome;
  aggregate: ClassificationAggregateOutcome;
  cost: ClassificationAssessmentCost;
}>;

function addCost(
  left: ClassificationAssessmentCost,
  right: ClassificationAssessmentCost,
): ClassificationAssessmentCost {
  return {
    nativeCalls: left.nativeCalls + right.nativeCalls,
    valuesProcessed: left.valuesProcessed + right.valuesProcessed,
    bytesRetained: left.bytesRetained + right.bytesRetained,
  };
}

export async function loadClassificationAssessment(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  identity: ClassificationAssociationIdentity,
  expectedReader?: string | null,
): Promise<ClassificationAssessmentRead> {
  const own = await readClassificationOwnBallot(client, request, env, identity, expectedReader);
  const authorization = viewerCredential(request) ?? undefined;
  const aggregate = await readClassificationAggregate(client, identity, authorization);
  return {
    reader: own.reader,
    identity,
    own: own.outcome,
    aggregate: aggregate.outcome,
    cost: addCost(own.cost, aggregate.cost),
  };
}

export async function sendClassificationCommand(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  command: ClassificationCommand,
): Promise<ClassificationCommandOutcome> {
  try {
    await prepareSession(request, env);
    const authorization = viewerCredential(request);
    const reader = await preparedRatingReader(request, authorization);
    if (!authorization || reader !== command.expectedReader) return { kind: 'unavailable', command };
    const result = await writeClassificationBallot(
      client,
      command.identity,
      authorization,
      command.idempotencyKey,
      command.operands.kind === 'withdraw'
        ? { kind: 'withdraw' }
        : {
            kind: 'set',
            assessment: command.operands.assessment,
            falsePositive: command.operands.falsePositive,
          },
    );
    if (result.kind === 'accepted') {
      if (commandAcknowledgedPending(result.result)) return { kind: 'pending', command, result: result.result };
      return { kind: 'accepted', command, result: result.result };
    }
    return { kind: result.kind, command };
  } catch {
    return { kind: 'uncertain', command };
  }
}

const identityFields = (value: unknown): ClassificationAssociationIdentity => {
  const command = admitClassificationCommand({
    identity: value,
    expectedReader: 'placeholder',
    csrfToken: 'placeholder',
    idempotencyKey: '00000000-0000-4000-8000-000000000001',
    operands: { kind: 'withdraw' },
  });
  return command.identity;
};

export const readSubjectClassificationAssessment = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid classification read');
    const value = input as Record<string, unknown>;
    const identity = identityFields(value.identity);
    if (
      (value.expectedReader !== undefined &&
        value.expectedReader !== null &&
        (typeof value.expectedReader !== 'string' || !value.expectedReader || value.expectedReader.length > 128)) ||
      typeof value.locale !== 'string' ||
      value.locale.length > 35
    )
      throw new Error('Invalid classification read');
    return {
      identity,
      locale: value.locale,
      expectedReader: (value.expectedReader as string | null | undefined) ?? null,
    };
  })
  .handler(async ({ data }): Promise<ClassificationAssessmentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    try {
      const { env } = await import('cloudflare:workers');
      const { kernelClient } = await import('../../kernel/client');
      return loadClassificationAssessment(
        kernelClient(data.locale),
        request,
        env as Partial<SessionEnv>,
        data.identity,
        data.expectedReader,
      );
    } catch {
      return {
        reader: data.expectedReader,
        identity: data.identity,
        own: { kind: 'unavailable' },
        aggregate: { kind: 'unavailable' },
        cost: { nativeCalls: 0, valuesProcessed: 1, bytesRetained: 0 },
      };
    }
  });

export const changeSubjectClassificationAssessment = createServerFn({ method: 'POST' })
  .validator((input: unknown) => admitClassificationCommand(input))
  .handler(async ({ data }): Promise<ClassificationCommandOutcome> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    try {
      const { env } = await import('cloudflare:workers');
      const { kernelClient } = await import('../../kernel/client');
      return sendClassificationCommand(kernelClient(), request, env as Partial<SessionEnv>, data);
    } catch {
      return { kind: 'uncertain', command: data };
    }
  });

export function assessmentReadMatches(
  read: ClassificationAssessmentRead,
  identity: ClassificationAssociationIdentity,
  reader: string | null,
): boolean {
  return sameClassificationAssociation(read.identity, identity) && read.reader === reader;
}

export function assessmentVisitKey(identity: ClassificationAssociationIdentity, reader: string | null): string {
  return `${classificationAssociationKey(identity)}:${reader ?? ''}`;
}
