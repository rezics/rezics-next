import type { ProgressFailure, ProgressRecorded, ProgressRecordInput } from '../progress-reads';
import {
  INDEPENDENT_MEASURE_SEAM,
  operandsFor,
  type IndependentCommand,
  type IndependentOutcome,
  type MeasureEdit,
} from './contract';
import { progressWriteOutcome } from '../configured-profile-controls/commands';

export type MeasureSender = (input: {
  data: ProgressRecordInput;
  headers: HeadersInit;
}) => Promise<ProgressRecorded | ProgressFailure>;

export function captureMeasureCommand(credential: HeadersInit, operands: ProgressRecordInput): IndependentCommand {
  return {
    sender: 'recordProgressSession',
    credential,
    key: operands.idempotencyKey,
    operands: { ...operands },
  };
}

export type BoundMeasureCommand = IndependentCommand & { dispatch: MeasureSender };

export function bindMeasureCommand(command: IndependentCommand, sender: MeasureSender): BoundMeasureCommand {
  return { ...command, dispatch: sender };
}

export async function dispatchMeasureCommand(
  command: BoundMeasureCommand,
  current: () => boolean,
): Promise<ProgressRecorded | ProgressFailure | undefined> {
  const result = await command.dispatch({ data: command.operands, headers: command.credential });
  return current() ? result : undefined;
}

export function outcomeFromResult(
  command: IndependentCommand,
  result: ProgressRecorded | ProgressFailure,
  remaining: MeasureEdit[],
): IndependentOutcome {
  if (result.ok) {
    return remaining.length
      ? { state: 'partial', revision: result.session.revision, snapshot: result.session, remaining, failed: command }
      : { state: 'acknowledged', revision: result.session.revision, snapshot: result.session, remaining };
  }
  const mapped = progressWriteOutcome(result);
  if (mapped.state === 'conflict') return { state: 'conflict', command, revision: command.operands.revision };
  if (mapped.state === 'unsupported') return { state: 'unsupported', command };
  if (mapped.state === 'refused') return { state: 'refused', command };
  if (mapped.state === 'invalid') return { state: 'invalid', command };
  return { state: 'unavailable', command, seam: INDEPENDENT_MEASURE_SEAM };
}

export function uncertainOutcome(command: IndependentCommand): IndependentOutcome {
  return { state: 'uncertain', command };
}

/** Sequence dirty units against the shared returned revision. Stop on the first non-ack. */
export async function submitIndependentEdits(
  sessionId: string,
  revision: number,
  edits: MeasureEdit[],
  credential: HeadersInit,
  current: () => boolean,
  sender: MeasureSender,
  keys: string[] = edits.map(() => crypto.randomUUID()),
  captured: BoundMeasureCommand[] = [],
): Promise<{ outcome: IndependentOutcome; commands: BoundMeasureCommand[] }> {
  let currentRevision = revision;
  let lastSnapshot: ProgressRecorded['session'] | undefined;
  const commands = captured;
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index]!;
    if (!current()) {
      const retry = commands[commands.length - 1];
      return {
        outcome: retry
          ? uncertainOutcome(retry)
          : {
              state: 'unavailable',
              command: captureMeasureCommand(credential, operandsFor(sessionId, currentRevision, keys[index]!, edit)),
              seam: INDEPENDENT_MEASURE_SEAM,
            },
        commands,
      };
    }
    const existing = commands[index];
    const command =
      existing ??
      bindMeasureCommand(
        captureMeasureCommand(credential, operandsFor(sessionId, currentRevision, keys[index]!, edit)),
        sender,
      );
    if (!existing) commands.push(command);
    else if (command.operands.revision !== currentRevision) {
      return { outcome: { state: 'conflict', command, revision: currentRevision }, commands };
    }
    let result: ProgressRecorded | ProgressFailure | undefined;
    try {
      result = await dispatchMeasureCommand(command, current);
    } catch {
      return { outcome: uncertainOutcome(command), commands };
    }
    if (!result) return { outcome: uncertainOutcome(command), commands };
    if (!result.ok) {
      const remaining = edits.slice(index);
      const failed = outcomeFromResult(command, result, remaining);
      if (failed.state === 'conflict' || failed.state === 'unavailable' || failed.state === 'uncertain') {
        if (lastSnapshot && index > 0) {
          return {
            outcome: {
              state: 'partial',
              revision: lastSnapshot.revision,
              snapshot: lastSnapshot,
              remaining,
              failed: command,
            },
            commands,
          };
        }
      }
      return { outcome: failed, commands };
    }
    lastSnapshot = result.session;
    currentRevision = result.session.revision;
  }
  return {
    outcome: lastSnapshot
      ? { state: 'acknowledged', revision: lastSnapshot.revision, snapshot: lastSnapshot, remaining: [] }
      : {
          state: 'invalid',
          command:
            commands[0] ??
            captureMeasureCommand(
              credential,
              operandsFor(sessionId, revision, keys[0] ?? crypto.randomUUID(), edits[0]!),
            ),
        },
    commands,
  };
}

export function retryOriginal(command: BoundMeasureCommand, current: () => boolean) {
  return dispatchMeasureCommand(command, current);
}
