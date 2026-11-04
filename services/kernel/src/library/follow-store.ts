import type { PoolClient } from 'pg';
import applyFollowStatement from './follow-store-apply.sql';
import pageFollowsStatement from './follow-store-page.sql';
import readFollowStatement from './follow-store-read.sql';
import {
  MAX_FOLLOW_PAGE_SIZE,
  type ApplyFollowInput,
  type Follow,
  type FollowPage,
  type FollowRow,
  type FollowReason,
  type FollowState,
  type FollowTargetType,
} from './follow-model.ts';

type Client = Pick<PoolClient, 'query'>;

function queryClient(client: Client): Client {
  return { query: client.query.bind(client) };
}

function iso(value: string): string {
  return new Date(value).toISOString();
}

function asTargetType(value: string): FollowTargetType {
  if (value === 'subject' || value === 'collection' || value === 'space') return value;
  throw new Error(`Unknown follow target type: ${value}`);
}

function asState(value: string): FollowState {
  if (value === 'following' || value === 'unfollowed') return value;
  throw new Error(`Unknown follow state: ${value}`);
}

function asReason(value: string): FollowReason {
  if (value === 'explicit' || value === 'library' || value === 'membership') return value;
  throw new Error(`Unknown follow reason: ${value}`);
}

function asFollow(row: FollowRow): Follow {
  const { route: _route, ...follow } = row;
  return {
    ...follow,
    targetType: asTargetType(follow.targetType),
    state: asState(follow.state),
    reason: asReason(follow.reason),
    createdAt: iso(follow.createdAt),
    updatedAt: iso(follow.updatedAt),
  };
}

function assertReason(input: ApplyFollowInput): void {
  if (input.intent === 'implied' && input.reason === 'explicit')
    throw new TypeError('An implied follow must use the library or membership reason');
  if (input.intent !== 'implied' && input.reason !== 'explicit')
    throw new TypeError('An explicit follow intent must use the explicit reason');
}

export async function applyFollow(tx: Client, route: number, input: ApplyFollowInput): Promise<boolean> {
  assertReason(input);
  const result = await applyFollowStatement.run(queryClient(tx), {
    route,
    account_id: input.accountId,
    target_id: input.targetId,
    target_type: input.targetType,
    state: input.intent === 'unfollow' ? 'unfollowed' : 'following',
    reason: input.reason,
    time: input.time,
    transaction_id: input.transactionId,
    intent: input.intent,
  });
  return result[0]?.changed === true;
}

export async function readFollow(
  tx: Client,
  route: number,
  accountId: string,
  targetId: string,
): Promise<Follow | null> {
  const row = await readFollowStatement.run(queryClient(tx), {
    route,
    account_id: accountId,
    target_id: targetId,
  });
  return row ? asFollow(row) : null;
}

export async function pageFollows(tx: Client, route: number, accountId: string, page: FollowPage): Promise<Follow[]> {
  if (!Number.isInteger(page.limit) || page.limit < 1) throw new RangeError('Page limit must be a positive integer');
  const rows = await pageFollowsStatement.run(queryClient(tx), {
    route,
    account_id: accountId,
    target_type: page.targetType ?? null,
    after_updated_at: page.after?.updatedAt ?? '2026-01-01T00:00:00.000Z',
    after_target_id: page.after?.targetId ?? '00000000-0000-0000-0000-000000000000',
    has_cursor: page.after !== null,
    limit: Math.min(MAX_FOLLOW_PAGE_SIZE, page.limit),
  });
  return rows.map(asFollow);
}
