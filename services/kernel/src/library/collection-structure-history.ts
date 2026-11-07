import type { Pool } from 'pg';
import { deadlineClient } from './access-port.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { AccountActor, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { CollectionResourceView } from './collection-reads.ts';
import historyHead from './collection-structure-history-head.sql';
import historyPage from './collection-structure-history-page.sql';
import historySelected from './collection-structure-history-selected.sql';

const MAX_CURSOR_LENGTH = 4096;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_COMPARE = 2;
const pageOperation = 'collection.structureHistory.page';
const addressOperation = 'collection.structureHistory.change';

const changeKinds = [
  'added',
  'note_changed',
  'moved',
  'deleted',
  'restored',
  'transferred_in',
  'transferred_out',
] as const;

export type CollectionStructureHistoryKind = (typeof changeKinds)[number];
export type CollectionStructureHistoryPlacement =
  | { state: 'known'; beforeMemberId: string | null; afterMemberId: string | null }
  | { state: 'unavailable' };
export type CollectionStructureHistoryState = {
  presence: 'live' | 'deleted' | 'not_in_collection';
  memberRevision: string;
  note: string | null;
  addedAt: string | null;
  deletedAt: string | null;
  placement: CollectionStructureHistoryPlacement;
};
export type CollectionStructureHistoryChange = {
  address: string;
  operation: CollectionStructureHistoryKind;
  recordedAt: string;
  occurrenceId: string;
  memberRevision: string;
  before: CollectionStructureHistoryState | null;
  after: CollectionStructureHistoryState | null;
  subjectContext: { state: 'withheld' };
};
export type CollectionStructureHistoryCoverage = {
  retainedChanges: number;
  firstRetainedChangeNo: string | null;
  latestRecordedChangeNo: string | null;
  hasPrunedGaps: boolean;
  historyBeforeTracking: 'unknown_before_installation' | 'collection_created_after_installation';
};
export type CollectionStructureHistoryBasis = {
  throughChangeNo: string;
  hadUnknownPrehistory: boolean;
  hadPrunedGaps: boolean;
};
export type CollectionStructureHistoryPage = {
  collectionId: string;
  changes: CollectionStructureHistoryChange[];
  next: string | null;
  coverage: CollectionStructureHistoryCoverage;
  basis: CollectionStructureHistoryBasis;
};
export type CollectionStructureHistoryComparison = {
  status: 'ready' | 'retired';
  changes: CollectionStructureHistoryChange[];
  coverage: CollectionStructureHistoryCoverage;
  basis: CollectionStructureHistoryBasis | null;
};

type CurrentCollection = Pick<CollectionResourceView, 'id' | 'curatorAccountId'> & {
  membershipKind?: 'curated' | 'dynamic';
};
type Current = (actor: Actor, collectionId: string, deadline: number) => Promise<CurrentCollection>;
type PageRow = Awaited<ReturnType<typeof historyPage.run>>[number];
type HeadRow = NonNullable<Awaited<ReturnType<typeof historyHead.run>>>;

type Head = {
  nextChangeNo: string;
  unknownBeforeTracking: boolean;
  hasPrunedGaps: boolean;
  retainedCount: number;
  firstRetainedChangeNo: string | null;
};
type Basis = { through: string; unknown: boolean; pruned: boolean };
type PositionToken = { changeNo: string; basis: Basis };

function notFound(): ProblemError {
  return new ProblemError('not_found');
}

function invalidCursor(): ProblemError {
  return new ProblemError('invalid_cursor');
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function storedState(value: unknown): CollectionStructureHistoryState | null {
  if (value === null) return null;
  const source = record(value);
  const position = source ? record(source.placement) : null;
  if (!source || !position) throw new ProblemError('dependency_unavailable');
  const presence = source.presence;
  const revision = source.memberRevision;
  const note = source.note;
  const addedAt = source.addedAt;
  const deletedAt = source.deletedAt;
  if (
    (presence !== 'live' && presence !== 'deleted' && presence !== 'not_in_collection') ||
    typeof revision !== 'string' ||
    (note !== null && typeof note !== 'string') ||
    (addedAt !== null && typeof addedAt !== 'string') ||
    (deletedAt !== null && typeof deletedAt !== 'string')
  )
    throw new ProblemError('dependency_unavailable');
  let placement: CollectionStructureHistoryPlacement;
  if (position.state === 'known') {
    const beforeMemberId = position.beforeMemberId;
    const afterMemberId = position.afterMemberId;
    if (
      (beforeMemberId !== null && typeof beforeMemberId !== 'string') ||
      (afterMemberId !== null && typeof afterMemberId !== 'string')
    )
      throw new ProblemError('dependency_unavailable');
    placement = {
      state: 'known',
      beforeMemberId: beforeMemberId as string | null,
      afterMemberId: afterMemberId as string | null,
    };
  } else if (position.state === 'unavailable') {
    placement = { state: 'unavailable' };
  } else {
    throw new ProblemError('dependency_unavailable');
  }
  return {
    presence,
    memberRevision: revision,
    note,
    addedAt: timestamp(addedAt),
    deletedAt: timestamp(deletedAt),
    placement,
  };
}

function validSequence(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

function binding(
  operation: string,
  route: number,
  collectionId: string,
  owner: AccountActor,
  limit?: number,
): CursorBinding {
  return {
    operation,
    parameters: {
      route,
      collectionId,
      curator: owner.accountId,
      authnEpoch: owner.authnEpoch,
      stream: 'structure',
      ...(limit === undefined ? {} : { limit }),
    },
  };
}

function currentHead(row: HeadRow | null | undefined): Head {
  if (!row)
    return {
      nextChangeNo: '0',
      unknownBeforeTracking: true,
      hasPrunedGaps: false,
      retainedCount: 0,
      firstRetainedChangeNo: null,
    };
  return {
    nextChangeNo: row.nextChangeNo,
    unknownBeforeTracking: row.unknownBeforeTracking,
    hasPrunedGaps: row.hasPrunedGaps,
    retainedCount: row.retainedCount,
    firstRetainedChangeNo: row.firstRetainedChangeNo,
  };
}

function coverage(head: Head, basis?: Basis): CollectionStructureHistoryCoverage {
  return {
    retainedChanges: head.retainedCount,
    firstRetainedChangeNo: head.firstRetainedChangeNo,
    latestRecordedChangeNo: head.nextChangeNo === '0' ? null : head.nextChangeNo,
    hasPrunedGaps: head.hasPrunedGaps || Boolean(basis?.pruned),
    historyBeforeTracking:
      head.unknownBeforeTracking || basis?.unknown
        ? 'unknown_before_installation'
        : 'collection_created_after_installation',
  };
}

function basisView(basis: Basis): CollectionStructureHistoryBasis {
  return {
    throughChangeNo: basis.through,
    hadUnknownPrehistory: basis.unknown,
    hadPrunedGaps: basis.pruned,
  };
}

function decodePosition(ring: KeyRing, cursorBinding: CursorBinding, token: string): PositionToken {
  if (!token || token.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  const decoded = decodeCursor(ring, cursorBinding, token);
  if (!decoded.ok) throw invalidCursor();
  const [changeNo, through, unknownValue, prunedValue] = decoded.after;
  if (
    decoded.epoch !== 1 ||
    decoded.after.length !== 4 ||
    !validSequence(changeNo) ||
    !validSequence(through) ||
    (unknownValue !== '0' && unknownValue !== '1') ||
    (prunedValue !== '0' && prunedValue !== '1') ||
    BigInt(changeNo) < 1n ||
    BigInt(changeNo) > BigInt(through) + 1n
  )
    throw invalidCursor();
  return {
    changeNo,
    basis: { through, unknown: unknownValue === '1', pruned: prunedValue === '1' },
  };
}

function addressFor(
  ring: KeyRing,
  route: number,
  collectionId: string,
  owner: AccountActor,
  changeNo: string,
  basis: Basis,
): string {
  return encodeCursor(ring, binding(addressOperation, route, collectionId, owner), {
    epoch: 1,
    after: [changeNo, basis.through, basis.unknown ? '1' : '0', basis.pruned ? '1' : '0'],
  });
}

function viewChange(
  ring: KeyRing,
  route: number,
  collectionId: string,
  owner: AccountActor,
  basis: Basis,
  row: PageRow,
): CollectionStructureHistoryChange {
  if (!(changeKinds as readonly string[]).includes(row.changeKind)) throw new ProblemError('dependency_unavailable');
  const recordedAt = timestamp(row.recordedAt);
  if (!recordedAt) throw new ProblemError('dependency_unavailable');
  return {
    address: addressFor(ring, route, collectionId, owner, row.changeNo, basis),
    operation: row.changeKind as CollectionStructureHistoryKind,
    recordedAt,
    occurrenceId: row.memberId,
    memberRevision: row.memberRevision,
    before: storedState(row.beforeState),
    after: storedState(row.afterState),
    subjectContext: { state: 'withheld' },
  };
}

async function snapshot<T>(
  pool: Pool,
  deadline: number,
  read: (client: ReturnType<typeof deadlineClient>) => Promise<T>,
) {
  return withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const value = await read(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

export function createCollectionStructureHistory(dependencies: { pool: Pool; tokens: KeyRing; current: Current }) {
  const { pool, tokens } = dependencies;
  return { page, compare };

  async function owner(actor: Actor, collectionId: string, deadline: number) {
    if (actor.kind !== 'account' || !Number.isSafeInteger(actor.authnEpoch) || actor.authnEpoch < 1) throw notFound();
    const route = routeOf(collectionId);
    if (route === null) throw notFound();
    const collection = await dependencies.current(actor, collectionId, deadline);
    if (
      collection.id !== collectionId ||
      collection.curatorAccountId !== actor.accountId ||
      collection.membershipKind === 'dynamic'
    )
      throw notFound();
    return { actor, route };
  }

  async function readHead(
    client: ReturnType<typeof deadlineClient>,
    route: number,
    collectionId: string,
  ): Promise<Head> {
    return currentHead(await historyHead.run(client, { route, collection_id: collectionId }));
  }

  async function page(
    actor: Actor,
    collectionId: string,
    options: { cursor?: string | null; limit?: number },
    deadline: number,
  ): Promise<CollectionStructureHistoryPage> {
    const { actor: curator, route } = await owner(actor, collectionId, deadline);
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ProblemError('invalid_request');
    const pageBinding = binding(pageOperation, route, collectionId, curator, limit);
    const result = await snapshot(pool, deadline, async (client) => {
      const head = await readHead(client, route, collectionId);
      let after = (BigInt(head.nextChangeNo) + 1n).toString();
      let basis: Basis = {
        through: head.nextChangeNo,
        unknown: head.unknownBeforeTracking,
        pruned: head.hasPrunedGaps,
      };
      if (options.cursor !== undefined && options.cursor !== null) {
        const position = decodePosition(tokens, pageBinding, options.cursor);
        after = position.changeNo;
        basis = position.basis;
      }
      const rows = await historyPage.run(client, {
        route,
        collection_id: collectionId,
        through_change_no: basis.through,
        before_change_no: after,
        limit: limit + 1,
      });
      return { head, basis, rows };
    });
    await owner(curator, collectionId, deadline);
    const hasMore = result.rows.length > limit;
    const selected = result.rows.slice(0, limit);
    const changes = selected.map((row) => viewChange(tokens, route, collectionId, curator, result.basis, row));
    const last = selected.at(-1);
    const next =
      hasMore && last
        ? encodeCursor(tokens, pageBinding, {
            epoch: 1,
            after: [
              last.changeNo,
              result.basis.through,
              result.basis.unknown ? '1' : '0',
              result.basis.pruned ? '1' : '0',
            ],
          })
        : null;
    return {
      collectionId,
      changes,
      next,
      coverage: coverage(result.head, result.basis),
      basis: basisView(result.basis),
    };
  }

  async function compare(
    actor: Actor,
    collectionId: string,
    addresses: readonly string[],
    deadline: number,
  ): Promise<CollectionStructureHistoryComparison> {
    const { actor: curator, route } = await owner(actor, collectionId, deadline);
    if (addresses.length < 1 || addresses.length > MAX_COMPARE || new Set(addresses).size !== addresses.length)
      throw new ProblemError('invalid_request');
    const addressBinding = binding(addressOperation, route, collectionId, curator);
    const positions = addresses.map((address) => decodePosition(tokens, addressBinding, address));
    const basis = positions[0]!.basis;
    if (positions.some((position) => JSON.stringify(position.basis) !== JSON.stringify(basis))) throw invalidCursor();
    const result = await snapshot(pool, deadline, async (client) => {
      const head = await readHead(client, route, collectionId);
      const rows = await historySelected.run(client, {
        route,
        collection_id: collectionId,
        change_nos: positions.map((position) => position.changeNo),
      });
      return { head, rows };
    });
    await owner(curator, collectionId, deadline);
    if (result.rows.length !== positions.length) {
      return { status: 'retired', changes: [], coverage: coverage(result.head, basis), basis: basisView(basis) };
    }
    const byChange = new Map(result.rows.map((row) => [row.changeNo, row]));
    if (positions.some((position) => !byChange.has(position.changeNo))) {
      return { status: 'retired', changes: [], coverage: coverage(result.head, basis), basis: basisView(basis) };
    }
    const changes = positions.map((position) =>
      viewChange(tokens, route, collectionId, curator, basis, byChange.get(position.changeNo)!),
    );
    return { status: 'ready', changes, coverage: coverage(result.head, basis), basis: basisView(basis) };
  }
}
