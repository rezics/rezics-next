import { isDeepStrictEqual } from 'node:util';
import { deadlineClient, within } from '../access/authenticate.ts';
import type { RealmParticipationReadDecision } from '../community/participation.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { Actor } from '../request/access.ts';
import { readPartition } from '../partition/partition.ts';
import type { AnchoredPosition, BoardView, ReadContext } from './model.ts';
import type { ContentCommandDependencies } from './commands.ts';
import {
  ContentNotFoundError,
  readBoard,
  readBoardPageActionEvidence,
  type ContentReadDependencies,
} from './reads.ts';
import type { SubjectThreadContext } from './subject-threads-context.ts';
import readSelectedBoard from './subject-entry-board.sql';

export type BoardEntryAdvice = 'allowed' | 'denied' | 'sign-in' | 'unavailable';
export type SubjectThreadEntryRequest = Readonly<{
  subjectId: string;
  placeId: string;
  kind: SubjectThreadContext['kind'];
  selectedBoardId?: string;
}>;
export type SubjectThreadEntry =
  | Readonly<{ state: 'not_selected'; request: SubjectThreadEntryRequest }>
  | Readonly<{ state: 'concealed' | 'unavailable'; request: SubjectThreadEntryRequest }>
  | Readonly<{
      state: 'current';
      request: SubjectThreadEntryRequest;
      board: BoardView;
      actions: Readonly<{ createThread: BoardEntryAdvice }>;
      observations: Readonly<{
        subject: SubjectThreadContext['subject']['source'];
        place: SubjectThreadContext['place'];
        board: Readonly<{ initial: SourcePosition; final: SourcePosition }>;
        access: Readonly<{ initial: readonly SourcePosition[]; final: readonly SourcePosition[] }>;
      }>;
    }>;
export type SourcePosition = Readonly<{ partition: number; epoch: number; position: string }>;

export type SubjectThreadEntryDependencies = ContentReadDependencies &
  Pick<ContentCommandDependencies, 'realmParticipation'>;

type SelectedBoardSource = Readonly<{
  boardId: string;
  subjectId: string;
  realmId: string | null;
  purpose: 'discussion' | 'reviews';
  anchor: AnchoredPosition;
}>;
type Participation = Readonly<{ status: BoardEntryAdvice; allowed: boolean }>;
type PreparedObservation = Readonly<{
  board: BoardView;
  boardAnchor: AnchoredPosition;
  source: SelectedBoardSource;
  participation: Participation;
  action: Awaited<ReturnType<typeof readBoardPageActionEvidence>>;
  advice: BoardEntryAdvice;
}>;
type EntryFinish = Readonly<{ entry: SubjectThreadEntry; anchors: readonly AnchoredPosition[] }>;

function sourcePosition(anchor: AnchoredPosition): SourcePosition {
  return {
    partition: anchor.partition.partitionNo,
    epoch: anchor.epoch,
    position: anchor.position.toString(),
  };
}

function samePosition(left: AnchoredPosition, right: AnchoredPosition): boolean {
  return (
    left.partition.partitionNo === right.partition.partitionNo &&
    left.epoch === right.epoch &&
    left.position === right.position
  );
}

function boardPlaceMatches(board: BoardView, place: SubjectThreadContext['place']): boolean {
  return board.realmId === (place.kind === 'realm' ? place.id : null);
}

function boardPurposeMatches(board: BoardView, kind: SubjectThreadContext['kind']): boolean {
  return board.purpose === (kind === 'discussion' ? 'discussion' : 'reviews');
}

function exactSelection(
  board: BoardView,
  source: SelectedBoardSource,
  context: SubjectThreadContext,
  selectedBoardId: string,
): boolean {
  return (
    board.id === selectedBoardId &&
    source.boardId === selectedBoardId &&
    source.subjectId === context.subject.id &&
    source.realmId === (context.place.kind === 'realm' ? context.place.id : null) &&
    boardPlaceMatches(board, context.place) &&
    boardPurposeMatches(board, context.kind)
  );
}

export function projectSubjectThreadCreateAdvice(
  actor: Actor,
  participation: BoardEntryAdvice,
  allowed: boolean,
): BoardEntryAdvice {
  if (actor.kind === 'anonymous') return 'sign-in';
  if (participation === 'unavailable') return 'unavailable';
  if (participation !== 'allowed') return 'denied';
  return allowed ? 'allowed' : 'denied';
}

function advice(actor: Actor, participation: Participation, allowed: boolean): BoardEntryAdvice {
  return projectSubjectThreadCreateAdvice(actor, participation.status, allowed);
}

async function participationAdvice(
  dependencies: SubjectThreadEntryDependencies,
  actor: Actor,
  board: BoardView,
  deadline: number,
): Promise<Participation> {
  if (actor.kind === 'anonymous') return { status: 'sign-in', allowed: false };
  if (board.realmId === null) return { status: 'allowed', allowed: true };
  if (!dependencies.realmParticipation) return { status: 'unavailable', allowed: false };
  const readDecision: RealmParticipationReadDecision = {};
  const allowed = await within(deadline, () =>
    dependencies.realmParticipation!(deadlineClient(dependencies.pool, deadline), {
      realmId: board.realmId!,
      actor,
      readDecision,
    }),
  );
  if (readDecision.readable === false) throw new ContentNotFoundError();
  return { status: allowed ? 'allowed' : 'denied', allowed };
}

function unavailable(error: unknown): boolean {
  return (
    error instanceof CommandUnavailableError ||
    (error instanceof ProblemError && error.code === 'dependency_unavailable') ||
    (error instanceof RangeError && error.message === 'Invalid read decision actions')
  );
}

async function readSelectedBoardSource(
  dependencies: SubjectThreadEntryDependencies,
  boardId: string,
  context: ReadContext,
): Promise<SelectedBoardSource | null> {
  const route = routeOf(boardId);
  if (route === null) return null;
  const partitionNo = partitionOf(route);
  return await within(context.deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout = '3000ms'");
        const partition = await readPartition(client, partitionNo);
        if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
        const parameters = { route, board_id: boardId };
        const rows = await client.query<(typeof readSelectedBoard)['~reylo']['element']>(
          readSelectedBoard.sql,
          readSelectedBoard.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        await client.query('COMMIT');
        const row = rows.rows[0];
        return row
          ? {
              boardId: row.board_id,
              subjectId: row.subject_id,
              realmId: row.realm_id,
              purpose: row.purpose,
              anchor: { partition, epoch: partition.epoch, position: partition.position },
            }
          : null;
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

function request(
  context: SubjectThreadContext,
  selectedBoardId: string | undefined,
): SubjectThreadEntryRequest {
  return {
    subjectId: context.subject.id,
    placeId: context.place.id,
    kind: context.kind,
    ...(selectedBoardId === undefined ? {} : { selectedBoardId }),
  };
}

function unavailableEntry(
  state: 'concealed' | 'unavailable',
  request: SubjectThreadEntryRequest,
): SubjectThreadEntry {
  return { state, request };
}

async function observe(
  dependencies: SubjectThreadEntryDependencies,
  boardId: string,
  subjectContext: SubjectThreadContext,
  context: ReadContext,
): Promise<Readonly<{ observation: PreparedObservation | null; state?: 'concealed' | 'unavailable'; anchors: readonly AnchoredPosition[] }>> {
  const anchors: AnchoredPosition[] = [];
  try {
    const selected = await readBoard(dependencies, boardId, context);
    anchors.push(selected.anchor);
    if (!selected.value) return { observation: null, state: 'concealed', anchors };
    const source = await readSelectedBoardSource(dependencies, boardId, context);
    if (!source) return { observation: null, state: 'concealed', anchors };
    anchors.push(source.anchor);
    if (!samePosition(selected.anchor, source.anchor) || !exactSelection(selected.value, source, subjectContext, boardId))
      return { observation: null, state: 'concealed', anchors };
    const participation = await participationAdvice(dependencies, context.actor, selected.value, context.deadline);
    const action = await readBoardPageActionEvidence(dependencies, boardId, selected.value, [], context);
    anchors.push(...action.anchors);
    return {
      observation: {
        board: selected.value,
        boardAnchor: selected.anchor,
        source,
        participation,
        action,
        advice: advice(context.actor, participation, action.createThread),
      },
      anchors,
    };
  } catch (error) {
    if (error instanceof ContentNotFoundError) return { observation: null, state: 'concealed', anchors };
    if (unavailable(error)) return { observation: null, state: 'unavailable', anchors };
    throw error;
  }
}

function matchesObservation(left: PreparedObservation, right: PreparedObservation): boolean {
  return (
    isDeepStrictEqual(left.board, right.board) &&
    samePosition(left.boardAnchor, right.boardAnchor) &&
    isDeepStrictEqual(left.source, right.source) &&
    isDeepStrictEqual(left.participation, right.participation) &&
    isDeepStrictEqual(left.action, right.action) &&
    left.advice === right.advice
  );
}

/** Prepares advice only for the caller's exact selected Board. The final read reuses
 * the Board page's read/action evidence factories after Subject cards and media work. */
export async function prepareSubjectThreadEntry(
  dependencies: SubjectThreadEntryDependencies,
  subjectContext: SubjectThreadContext,
  selectedBoardId: string | undefined,
  context: ReadContext,
): Promise<Readonly<{ initial: SubjectThreadEntry; finish(): Promise<EntryFinish> }>> {
  const selectedRequest = request(subjectContext, selectedBoardId);
  if (selectedBoardId === undefined) {
    const initial: SubjectThreadEntry = { state: 'not_selected', request: selectedRequest };
    return { initial, async finish() { return { entry: initial, anchors: [] }; } };
  }

  const initialRead = await observe(dependencies, selectedBoardId, subjectContext, context);
  if (!initialRead.observation) {
    const initial = unavailableEntry(initialRead.state ?? 'unavailable', selectedRequest);
    return { initial, async finish() { return { entry: initial, anchors: initialRead.anchors }; } };
  }
  const initialObservation = initialRead.observation;
  const initial: SubjectThreadEntry = {
    state: 'current',
    request: selectedRequest,
    board: initialObservation.board,
    actions: { createThread: initialObservation.advice },
    observations: {
      subject: subjectContext.subject.source,
      place: subjectContext.place,
      board: {
        initial: sourcePosition(initialObservation.source.anchor),
        final: sourcePosition(initialObservation.source.anchor),
      },
      access: {
        initial: initialObservation.action.anchors.map(sourcePosition),
        final: initialObservation.action.anchors.map(sourcePosition),
      },
    },
  };
  return {
    initial,
    async finish() {
      const finalRead = await observe(dependencies, selectedBoardId, subjectContext, context);
      const anchors = [...initialRead.anchors, ...finalRead.anchors];
      if (!finalRead.observation) {
        return {
          entry: unavailableEntry(finalRead.state ?? 'unavailable', selectedRequest),
          anchors,
        };
      }
      if (!matchesObservation(initialObservation, finalRead.observation))
        return { entry: unavailableEntry('unavailable', selectedRequest), anchors };
      return {
        entry: {
          state: 'current',
          request: selectedRequest,
          board: finalRead.observation.board,
          actions: { createThread: finalRead.observation.advice },
          observations: {
            subject: subjectContext.subject.source,
            place: subjectContext.place,
            board: {
              initial: sourcePosition(initialObservation.source.anchor),
              final: sourcePosition(finalRead.observation.source.anchor),
            },
            access: {
              initial: initialObservation.action.anchors.map(sourcePosition),
              final: finalRead.observation.action.anchors.map(sourcePosition),
            },
          },
        },
        anchors,
      };
    },
  };
}
