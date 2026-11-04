import { accessCheck, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { ProblemError } from '../http/problem.ts';
import { MAX_BOARD_PINS, readBoardPinRevision, readBoardPins } from './board-projection.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import {
  ContentNotFoundError,
  discloseBoardPageThreads,
  prepareBoardPageDecisions,
  readBoardPageCandidateSnapshot,
  type ContentReadDependencies,
  type ThreadView,
} from './reads.ts';

export const BOARD_PIN_ADVICE_SELECTION_LIMIT = 25;
export const BOARD_PIN_ADVICE_RESPONSE_BYTES = 16_384;
const contentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const revision = /^(0|[1-9][0-9]{0,18})$/;
export type BoardPinAdviceReference = Readonly<{
  threadId: string;
  placeId: string;
  sourceRevisionId: string;
}>;
export type BoardPinAdviceInput = Readonly<{
  selected: readonly BoardPinAdviceReference[];
  pinRevision?: string;
}>;
export type BoardPinAdvice =
  | Readonly<{ state: 'stale' }>
  | Readonly<{
      state: 'ready';
      viewer: Readonly<{ kind: 'account'; id: string }>;
      boardId: string;
      pinRevision: string;
      management: 'allowed' | 'denied';
      threads: readonly Readonly<{ threadId: string; pinned: boolean; actions: readonly ('pin' | 'unpin')[] }>[];
    }>;

type Source = BoardPinAdviceReference & Readonly<{ witness: string }>;
/** Private observations; pin identities never cross the response boundary. */
export type BoardPinAdviceObservation = Readonly<{
  boardId: string;
  boardWitness: string;
  pinRevision: string;
  pinIds: readonly string[];
  management: boolean;
  sources: readonly Source[];
  epochs: ReadonlyMap<number, number>;
}>;

/** Reject the raw cohort, including exact duplicates, before any preparation or I/O. */
export function normalizeBoardPinAdviceSelection(
  boardId: string,
  selected: readonly BoardPinAdviceReference[],
): readonly BoardPinAdviceReference[] {
  const invalid = () => new ProblemError('invalid_request');
  if (!contentId.test(boardId) || !Array.isArray(selected) || selected.length > BOARD_PIN_ADVICE_SELECTION_LIMIT)
    throw invalid();
  const seen = new Set<string>();
  return Object.freeze(
    selected.map((reference) => {
      if (
        !reference ||
        typeof reference !== 'object' ||
        Object.keys(reference).length !== 3 ||
        !contentId.test(reference.threadId) ||
        !contentId.test(reference.sourceRevisionId) ||
        reference.placeId !== boardId ||
        routeOf(reference.threadId) !== routeOf(reference.sourceRevisionId) ||
        seen.has(reference.threadId)
      )
        throw invalid();
      seen.add(reference.threadId);
      return Object.freeze({
        threadId: reference.threadId,
        placeId: reference.placeId,
        sourceRevisionId: reference.sourceRevisionId,
      });
    }),
  );
}

export function projectBoardPinAdvice(
  viewerId: string,
  selected: readonly BoardPinAdviceReference[],
  before: BoardPinAdviceObservation,
  after: BoardPinAdviceObservation,
  expectedPinRevision?: string,
): BoardPinAdvice {
  const references = normalizeBoardPinAdviceSelection(before.boardId, selected);
  // A missing/concealed/erased selected record has the ordinary exact-read 404.
  if (before.sources.length !== references.length || after.sources.length !== references.length)
    throw new ContentNotFoundError();
  if (
    before.boardId !== after.boardId ||
    before.boardWitness !== after.boardWitness ||
    before.pinRevision !== after.pinRevision ||
    (expectedPinRevision !== undefined && after.pinRevision !== expectedPinRevision) ||
    [...before.epochs].some(([partition, epoch]) => after.epochs.get(partition) !== epoch) ||
    references.some((reference, index) =>
      [before.sources[index], after.sources[index]].some(
        (source) =>
          !source ||
          source.threadId !== reference.threadId ||
          source.placeId !== reference.placeId ||
          source.sourceRevisionId !== reference.sourceRevisionId ||
          source.witness !== before.sources[index]?.witness,
      ),
    )
  )
    return { state: 'stale' };
  // Revocation is denial even if an earlier observation was permitted.
  const allowed = before.management && after.management;
  const pinned = new Set(after.pinIds);
  const value: BoardPinAdvice = {
    state: 'ready',
    viewer: { kind: 'account', id: viewerId },
    boardId: after.boardId,
    pinRevision: after.pinRevision,
    management: allowed ? 'allowed' : 'denied',
    threads: references.map(({ threadId }) => ({
      threadId,
      pinned: pinned.has(threadId),
      actions: !allowed ? [] : pinned.has(threadId) ? ['unpin'] : pinned.size < MAX_BOARD_PINS ? ['pin'] : [],
    })),
  };
  // The upstream cap is 25 references with UUID operands and a bigint revision.
  // This is a final invariant, not a bound applied after unbounded hydration.
  if (Buffer.byteLength(JSON.stringify(value)) > BOARD_PIN_ADVICE_RESPONSE_BYTES)
    throw new ProblemError('content_too_large');
  return value;
}

function boardWitness(board: { id: string; realmId: string | null; securityRevision: string; visibility: string }) {
  return JSON.stringify([board.id, board.realmId, board.securityRevision, board.visibility]);
}
function sourceOf(thread: ThreadView): Source | null {
  const post = thread.firstPost;
  if (thread.availability !== 'available' || post.availability !== 'available' || !('revisionId' in post)) return null;
  return {
    threadId: thread.id,
    placeId: thread.boardId,
    sourceRevisionId: post.revisionId,
    witness: JSON.stringify([
      thread.securityRevision,
      thread.visibility,
      post.id,
      post.securityRevision,
      post.revisionId,
      post.sha256,
    ]),
  };
}
function epochs(anchors: readonly AnchoredPosition[]) {
  const result = new Map<number, number>();
  for (const anchor of anchors) {
    const previous = result.get(anchor.partition.partitionNo);
    if (previous !== undefined && previous !== anchor.epoch) throw new ProblemError('dependency_unavailable');
    result.set(anchor.partition.partitionNo, anchor.epoch);
  }
  return result;
}

/** Additive selected composition. It never assembles a Board page or runs a pin command. */
export async function readSelectedBoardPinAdvice(
  dependencies: ContentReadDependencies,
  boardId: string,
  input: BoardPinAdviceInput,
  context: ReadContext & { actor: Extract<Actor, { kind: 'account' }> },
): Promise<Readonly<{ value: BoardPinAdvice; anchors: readonly AnchoredPosition[] }>> {
  const selected = normalizeBoardPinAdviceSelection(boardId, input.selected);
  if (input.pinRevision !== undefined && !revision.test(input.pinRevision)) throw new ProblemError('invalid_request');
  const expectedRevision = input.pinRevision;
  const snapshot = async (baseline?: { realmId: string | null }) => {
    const decisions = await prepareBoardPageDecisions(dependencies, context);
    const curator = baseline
      ? await accessCheck(
          dependencies.access,
          context.actor,
          'moderation:takedown',
          { route: routeOf(baseline.realmId ?? boardId)!, id: baseline.realmId ?? boardId },
          { pool: dependencies.pool, deadline: context.deadline },
        )
      : null;
    const observed = await readBoardPageCandidateSnapshot(
      dependencies,
      boardId,
      context,
      decisions,
      async (client) => ({
        pinRevision: await readBoardPinRevision(client, boardId),
        pinIds: baseline ? await readBoardPins(client, boardId) : [],
        management: curator ? await curator(client) : false,
      }),
    );
    if (!observed || observed.candidate.pinRevision === null) throw new ContentNotFoundError();
    return { ...observed, decisions };
  };
  // Discover the native parent before preparing its precise curation operand.
  const parent = await snapshot();
  const before = await snapshot(parent.board);
  if (
    boardWitness(parent.board) !== boardWitness(before.board) ||
    parent.candidate.pinRevision !== before.candidate.pinRevision ||
    (expectedRevision !== undefined && before.candidate.pinRevision !== expectedRevision)
  )
    return { value: { state: 'stale' }, anchors: [before.anchor.anchor] };
  const ids = selected.map(({ threadId }) => threadId);
  const round = async () => {
    const result = await discloseBoardPageThreads(
      dependencies,
      boardId,
      before.board,
      ids,
      new Map(),
      context,
      await prepareBoardPageDecisions(dependencies, context),
    );
    // Release raw documents before the next foreign preparation/observation.
    return {
      parentAllowed: result.parentAllowed,
      sources: result.items.flatMap(({ value }) => {
        const current = value && sourceOf(value);
        return current ? [current] : [];
      }),
      anchors: [result.boardAnchor, ...result.items.map((item) => item.anchor)],
    };
  };
  const initial = await round();
  const final = await round();
  if (!initial.parentAllowed || !final.parentAllowed) throw new ContentNotFoundError();
  // Prepare fresh authority only after all selected source/disclosure work has released.
  // The grant result and pin generation/state are evaluated in the same final native snapshot.
  const after = await snapshot(before.board);
  const anchors = [
    parent.anchor.anchor,
    before.anchor.anchor,
    ...initial.anchors,
    ...final.anchors,
    after.anchor.anchor,
  ];
  const observation = (board: typeof before, source: typeof initial): BoardPinAdviceObservation => ({
    boardId,
    boardWitness: boardWitness(board.board),
    pinRevision: board.candidate.pinRevision!,
    pinIds: board.candidate.pinIds,
    management: board.candidate.management,
    sources: source.sources,
    epochs: epochs([board.anchor.anchor, ...source.anchors]),
  });
  return {
    value: projectBoardPinAdvice(
      context.actor.accountId,
      selected,
      observation(before, initial),
      observation(after, final),
      expectedRevision,
    ),
    anchors,
  };
}
