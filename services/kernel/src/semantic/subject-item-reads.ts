import type { Pool, PoolClient } from 'pg';
import type { CommandAttribution, CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { AgentSelfSource } from './fences.ts';
import type { Item } from './item.ts';
import { AccountAgentWriteDeniedError, accountAgentId } from './agents.ts';
import readTypesStatement from './read-item-types.sql';
import readLabelsStatement from './read-labels.sql';

const BATCH_LIMIT = 256;

export function listed<T>(result: T[] | T | null): T[] {
  if (result == null) return [];
  return Array.isArray(result) ? result : [result];
}

export type Queryable = Pick<PoolClient, 'query'>;

export type ItemTypeDetails = {
  type: string;
  agentAccountId: string | null;
  agentVerified: boolean;
};

export function accountSourceFor(
  basis: Readonly<CommandAttribution> | null,
  statementSubjects: readonly string[],
): AgentSelfSource | null {
  if (!basis || basis.actorAccountId === null) return null;
  const subject = accountAgentId(basis.actorAccountId);
  return statementSubjects.includes(subject) ? { kind: 'agent', subject } : null;
}

export function assertAgentStatementAccessFor(
  basis: Readonly<CommandAttribution> | null,
  ids: readonly string[],
  details: ReadonlyMap<string, ItemTypeDetails>,
): void {
  if (!basis) return;
  for (const id of new Set(ids)) {
    const agent = details.get(id);
    if (agent?.agentAccountId && !agent.agentVerified && agent.agentAccountId !== basis.actorAccountId)
      throw new AccountAgentWriteDeniedError(id);
  }
}

export function assertBatch(ids: readonly string[], message: string): void {
  if (ids.length > BATCH_LIMIT) throw new TypeError(message);
}

export function groupsOf(ids: readonly string[]): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const route = routeOf(id);
    if (route === null) continue;
    const partition = partitionOf(route);
    const group = groups.get(partition) ?? [];
    group.push(id);
    groups.set(partition, group);
  }
  return groups;
}

/** Item targets of one write, one primary-key probe per id and one statement per partition. */
export async function readItemDetails(
  client: Queryable,
  ids: readonly string[],
): Promise<Map<string, ItemTypeDetails>> {
  if (ids.length > BATCH_LIMIT + 1) throw new TypeError('An item type and account agent check accepts at most 257 ids');
  const details = new Map<string, ItemTypeDetails>();
  for (const [partition, subjectIds] of groupsOf(ids)) {
    const result = (await readTypesStatement.run(client, {
      partition_no: partition,
      routes: subjectIds.map((id) => routeOf(id)!),
      subject_ids: subjectIds,
    })) as
      | { id: string; type: string; agent_account_id: string | null; agent_verified: boolean }[]
      | { id: string; type: string; agent_account_id: string | null; agent_verified: boolean }
      | null;
    const rows = result == null ? [] : Array.isArray(result) ? result : [result];
    for (const row of rows)
      details.set(row.id, {
        type: row.type,
        agentAccountId: row.agent_account_id,
        agentVerified: row.agent_verified,
      });
  }
  return details;
}

export async function readLabels(
  pool: Pool | CommandTransaction,
  ids: readonly string[],
): Promise<Map<string, Item['labels']>> {
  assertBatch(ids, 'A label fill accepts at most 256 ids');
  const labels = new Map<string, Item['labels']>();
  await Promise.all(
    [...groupsOf(ids)].map(async ([partition, subjectIds]) => {
      const rows = listed(
        (await readLabelsStatement.run(pool, {
          partition_no: partition,
          routes: subjectIds.map((id) => routeOf(id)!),
          subject_ids: subjectIds,
        })) as { id: string; labels: Record<string, string> }[] | { id: string; labels: Record<string, string> } | null,
      );
      for (const row of rows) labels.set(row.id, row.labels ?? {});
    }),
  );
  return labels;
}
