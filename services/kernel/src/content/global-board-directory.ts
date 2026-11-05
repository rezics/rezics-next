import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../tokens/list-cursor.ts';
import type { ContentBoardDependencies } from './boards.ts';
import type { AnchoredPosition, BoardView, ReadContext } from './model.ts';
import { readBoard } from './reads.ts';
import pageGlobalBoards from './global-board-directory-page.sql';
import pageGlobalBoardsByPurpose from './global-board-directory-purpose-page.sql';

export type GlobalBoardDirectoryInput = {
  purpose?: 'discussion' | 'reviews';
  cursor?: string;
  limit?: number;
};
export type GlobalBoardDirectoryResponse = { boards: BoardView[]; next: string | null };
export type GlobalBoardDirectoryPage = GlobalBoardDirectoryResponse & { anchors: AnchoredPosition[] };

export class InvalidGlobalBoardDirectoryCursorError extends Error {
  constructor() {
    super('Invalid Global board directory cursor');
    this.name = 'InvalidGlobalBoardDirectoryCursorError';
  }
}

// This definition covers a cross-partition native range, not a partition's epoch.
const DEFINITION_EPOCH = 1;
const CANDIDATES_PER_ITEM = 4;
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
type SourceKey = { route: number; boardId: string };

function binding(purpose: GlobalBoardDirectoryInput['purpose'], limit: number): ListCursorBinding {
  return { route: 'GET /v1/boards', viewer: null, query: { purpose: purpose ?? null, limit } };
}

async function position(
  dependencies: ContentBoardDependencies,
  scope: ListCursorBinding,
  now: Date,
  token?: string,
): Promise<SourceKey | null> {
  if (token === undefined) return null;
  const decoded = await decodeListCursor(dependencies.tokens, scope, token, now);
  if (!decoded.ok || decoded.epoch !== DEFINITION_EPOCH || decoded.after.length !== 2)
    throw new InvalidGlobalBoardDirectoryCursorError();
  const [route, boardId] = decoded.after;
  if (
    typeof route !== 'number' ||
    !Number.isInteger(route) ||
    route < 0 ||
    route > 65535 ||
    typeof boardId !== 'string' ||
    routeOf(boardId) !== route
  )
    throw new InvalidGlobalBoardDirectoryCursorError();
  return { route, boardId };
}

function isPublicGlobal(board: BoardView | null, purpose: GlobalBoardDirectoryInput['purpose']): board is BoardView {
  return (
    board !== null &&
    board.realmId === null &&
    board.visibility === 'published' &&
    board.availability === 'available' &&
    (purpose === undefined || board.purpose === purpose)
  );
}

/** One native candidate range followed by independent current anonymous disclosure.
 * No grants, Concepts, Realm inventories or thread lists discover destinations. */
export async function listGlobalBoards(
  dependencies: ContentBoardDependencies,
  context: Pick<ReadContext, 'deadline'>,
  input: GlobalBoardDirectoryInput = {},
): Promise<GlobalBoardDirectoryPage> {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Page limit must be 1 to 100');
  if (input.purpose !== undefined && input.purpose !== 'discussion' && input.purpose !== 'reviews')
    throw new TypeError('Invalid board purpose');
  const now = new Date((dependencies.cursorNow ?? Date.now)());
  const scope = binding(input.purpose, limit);
  const start = await position(dependencies, scope, now, input.cursor);
  const budget = CANDIDATES_PER_ITEM * limit;
  const candidates = await within(context.deadline, () =>
    withConnection(dependencies.pool, (connection) => {
      const client = deadlineClient(connection, context.deadline);
      const parameters = { after_route: start?.route ?? -1, after_board: start?.boardId ?? ZERO_ID, limit: budget };
      // Separate exact statements let the purpose-leading index seek directly,
      // without filtering another purpose's unbounded source range.
      return input.purpose === undefined
        ? pageGlobalBoards.run(client, parameters)
        : pageGlobalBoardsByPurpose.run(client, { ...parameters, purpose: input.purpose });
    }),
  );

  const reader: ReadContext = { actor: { kind: 'anonymous' }, deadline: context.deadline };
  const anchors: AnchoredPosition[] = [];
  const selected: BoardView[] = [];
  let examined = 0;
  let after = start;
  for (const candidate of candidates) {
    if (selected.length === limit) break;
    after = { route: candidate.route, boardId: candidate.board_id };
    examined++;
    // Index membership supplies an identity, never a read permission or DTO.
    const disclosed = await readBoard(dependencies, candidate.board_id, reader);
    anchors.push(disclosed.anchor);
    if (isPublicGlobal(disclosed.value, input.purpose)) selected.push(disclosed.value);
  }

  const boards: BoardView[] = [];
  for (const baseline of selected) {
    // FINAL: repeat the native source and anonymous Access checks after selection.
    // Do not refill a page after a privacy reduction or adopt a changed revision.
    const final = await readBoard(dependencies, baseline.id, reader);
    anchors.push(final.anchor);
    if (
      isPublicGlobal(final.value, input.purpose) &&
      final.value.securityRevision === baseline.securityRevision &&
      final.value.purpose === baseline.purpose
    )
      boards.push(final.value);
  }
  const more = examined < candidates.length || candidates.length === budget;
  return {
    boards,
    next:
      more && after
        ? await encodeListCursor(
            dependencies.tokens,
            scope,
            { epoch: DEFINITION_EPOCH, after: [after.route, after.boardId] },
            now,
          )
        : null,
    anchors,
  };
}
