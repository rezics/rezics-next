import { queryOptions } from '@tanstack/react-query';
import { personalRead, publicRead } from '../../kernel/query';
import {
  addAssessmentCost,
  classificationAssociationKey,
  emptyAssessmentCost,
  sameClassificationAssociation,
  type ClassificationAggregateOutcome,
  type ClassificationAssociationIdentity,
  type ClassificationAssessmentCost,
  type ClassificationOwnOutcome,
} from './subject-classification-assessment';
import {
  newClassificationEditAllowed,
  replayClassificationCommand,
  type ClassificationCommand,
  type ClassificationCommandOutcome,
} from './subject-classification-assessment-commands';
import {
  assessmentVisitKey,
  readSubjectClassificationAssessment,
  type ClassificationAssessmentRead,
} from './subject-classification-assessment-actions';

export type ClassificationAssessmentSession = 'unknown' | 'unavailable' | 'signed-out' | 'signed-in';

export type ClassificationAssessmentSnapshot = Readonly<{
  visit: string;
  identity: ClassificationAssociationIdentity | null;
  reader: string | null;
  session: ClassificationAssessmentSession;
  own: ClassificationOwnOutcome;
  aggregate: ClassificationAggregateOutcome;
  command: ClassificationCommandOutcome | null;
  cost: ClassificationAssessmentCost;
}>;

export type ClassificationAssessmentTransport = {
  read: (input: {
    identity: ClassificationAssociationIdentity;
    locale: string;
    expectedReader: string | null;
  }) => Promise<ClassificationAssessmentRead>;
  write: (command: ClassificationCommand) => Promise<ClassificationCommandOutcome>;
};

const defaultTransport: ClassificationAssessmentTransport = {
  read: (data) => readSubjectClassificationAssessment({ data }),
  write: (command) =>
    import('./subject-classification-assessment-actions').then(({ changeSubjectClassificationAssessment }) =>
      changeSubjectClassificationAssessment({ data: command }),
    ),
};

export function emptyClassificationSnapshot(
  session: ClassificationAssessmentSession,
  identity: ClassificationAssociationIdentity | null = null,
  reader: string | null = null,
): ClassificationAssessmentSnapshot {
  return {
    visit: identity ? assessmentVisitKey(identity, reader) : `idle:${reader ?? ''}`,
    identity,
    reader,
    session,
    own: session === 'signed-out' ? { kind: 'signed-out' } : { kind: 'preparing' },
    aggregate: { kind: 'preparing' },
    command: null,
    cost: emptyAssessmentCost(),
  };
}

export function retireClassificationSnapshot(
  previous: ClassificationAssessmentSnapshot | null,
  next: { identity: ClassificationAssociationIdentity | null; reader: string | null; session: ClassificationAssessmentSession },
): ClassificationAssessmentSnapshot {
  if (
    previous &&
    previous.session === next.session &&
    previous.reader === next.reader &&
    sameClassificationAssociation(previous.identity, next.identity)
  )
    return previous;
  return emptyClassificationSnapshot(next.session, next.identity, next.reader);
}

export function concealClassificationSnapshot(snapshot: ClassificationAssessmentSnapshot): ClassificationAssessmentSnapshot {
  return {
    ...emptyClassificationSnapshot(snapshot.session, snapshot.identity, snapshot.reader),
    own: { kind: 'concealed' },
    aggregate: { kind: 'concealed' },
    command: null,
  };
}

export function applyClassificationRead(
  snapshot: ClassificationAssessmentSnapshot,
  read: ClassificationAssessmentRead,
): ClassificationAssessmentSnapshot {
  if (!snapshot.identity || !sameClassificationAssociation(snapshot.identity, read.identity))
    return concealClassificationSnapshot(snapshot);
  if (snapshot.reader !== null && read.reader !== snapshot.reader) return concealClassificationSnapshot(snapshot);
  if (snapshot.command?.kind === 'uncertain') {
    return {
      ...snapshot,
      own: { kind: 'pending', value: snapshot.command.command.operands.kind === 'withdraw'
        ? {
            associationId: snapshot.identity.associationId,
            hasBallot: false,
            assessment: null,
            falsePositive: false,
            revision: null,
            pending: true,
          }
        : {
            associationId: snapshot.identity.associationId,
            hasBallot: true,
            assessment: snapshot.command.command.operands.assessment,
            falsePositive: snapshot.command.command.operands.falsePositive,
            revision: null,
            pending: true,
          } },
      aggregate: read.aggregate.kind === 'ready' ? read.aggregate : snapshot.aggregate,
      cost: addAssessmentCost(snapshot.cost, read.cost),
    };
  }
  return {
    visit: snapshot.visit,
    identity: snapshot.identity,
    reader: read.reader,
    session: snapshot.session,
    own: read.own,
    aggregate: read.aggregate,
    command: snapshot.command?.kind === 'pending' && read.own.kind === 'pending' ? snapshot.command : read.own.kind === 'acknowledged' || read.own.kind === 'absent' ? null : snapshot.command,
    cost: addAssessmentCost(snapshot.cost, read.cost),
  };
}

export function applyClassificationCommand(
  snapshot: ClassificationAssessmentSnapshot,
  outcome: ClassificationCommandOutcome,
): ClassificationAssessmentSnapshot {
  if (!snapshot.identity || classificationAssociationKey(snapshot.identity) !== classificationAssociationKey(outcome.command.identity))
    return concealClassificationSnapshot(snapshot);
  if (snapshot.reader !== outcome.command.expectedReader) return concealClassificationSnapshot(snapshot);
  if (outcome.kind === 'uncertain') return { ...snapshot, command: outcome, own: { kind: 'pending', value: pendingOwn(outcome.command) } };
  if (outcome.kind === 'pending')
    return {
      ...snapshot,
      command: outcome,
      own: { kind: 'pending', value: pendingOwn(outcome.command, outcome.result?.revision ?? null) },
    };
  if (outcome.kind === 'accepted')
    return {
      ...snapshot,
      command: null,
      own: {
        kind: outcome.command.operands.kind === 'withdraw' ? 'absent' : 'pending',
        value: pendingOwn(outcome.command, outcome.result?.revision ?? null),
      },
    };
  if (outcome.kind === 'conflict') return { ...snapshot, command: outcome, own: { kind: 'conflict' } };
  if (outcome.kind === 'denied') return { ...snapshot, command: outcome, own: { kind: 'denied' }, aggregate: { kind: 'denied' } };
  if (outcome.kind === 'concealed') return concealClassificationSnapshot(snapshot);
  return { ...snapshot, command: outcome, own: { kind: 'unavailable' } };
}

function pendingOwn(command: ClassificationCommand, revision: string | null = null) {
  if (command.operands.kind === 'withdraw')
    return {
      associationId: command.identity.associationId,
      hasBallot: false,
      assessment: null,
      falsePositive: false,
      revision,
      pending: true,
    };
  return {
    associationId: command.identity.associationId,
    hasBallot: true,
    assessment: command.operands.assessment,
    falsePositive: command.operands.falsePositive,
    revision,
    pending: true,
  };
}

export function retryableClassificationCommand(snapshot: ClassificationAssessmentSnapshot): ClassificationCommand | null {
  if (snapshot.command?.kind !== 'uncertain') return null;
  return replayClassificationCommand(snapshot.command.command);
}

export function canEditClassification(snapshot: ClassificationAssessmentSnapshot): boolean {
  if (snapshot.session !== 'signed-in' || !snapshot.identity) return false;
  if (snapshot.own.kind === 'denied' || snapshot.own.kind === 'concealed' || snapshot.own.kind === 'unavailable')
    return false;
  return newClassificationEditAllowed(snapshot.command);
}

export function classificationOwnQuery(
  identity: ClassificationAssociationIdentity,
  locale: string,
  reader: string | null,
  visit: string,
  transport: ClassificationAssessmentTransport = defaultTransport,
) {
  return queryOptions({
    ...personalRead,
    queryKey: ['subject-classification-own', classificationAssociationKey(identity), locale, reader, visit] as const,
    retry: false,
    queryFn: () => transport.read({ identity, locale, expectedReader: reader }),
  });
}

export function classificationAggregateQuery(
  identity: ClassificationAssociationIdentity,
  locale: string,
  visit: string,
  transport: ClassificationAssessmentTransport = defaultTransport,
) {
  return queryOptions({
    ...publicRead,
    queryKey: ['subject-classification-aggregate', classificationAssociationKey(identity), locale, visit] as const,
    retry: false,
    queryFn: () => transport.read({ identity, locale, expectedReader: null }),
  });
}

export async function dispatchClassificationCommand(
  snapshot: ClassificationAssessmentSnapshot,
  command: ClassificationCommand,
  transport: ClassificationAssessmentTransport = defaultTransport,
): Promise<ClassificationAssessmentSnapshot> {
  if (!canEditClassification(snapshot) && snapshot.command?.kind !== 'uncertain') return snapshot;
  const sent = snapshot.command?.kind === 'uncertain' ? replayClassificationCommand(snapshot.command.command) : command;
  const outcome = await transport.write(sent);
  return applyClassificationCommand(snapshot, outcome);
}

export function measureClassificationVisit(input: {
  association: ClassificationAssociationIdentity | null;
  own: ClassificationOwnOutcome;
  aggregate: ClassificationAggregateOutcome;
  sourceRows: number;
  nativeCalls: number;
}): ClassificationAssessmentCost {
  const values =
    (input.association ? 1 : 0) +
    (input.own.kind === 'acknowledged' || input.own.kind === 'absent' || input.own.kind === 'pending' ? 1 : 0) +
    (input.aggregate.kind === 'ready' ? 1 : 0) +
    Math.min(2, Math.max(0, input.sourceRows));
  return {
    nativeCalls: input.nativeCalls,
    valuesProcessed: values,
    bytesRetained:
      JSON.stringify(input.association ?? null).length +
      JSON.stringify(input.own).length +
      JSON.stringify(input.aggregate).length +
      Math.min(2, Math.max(0, input.sourceRows)) * 256,
  };
}
