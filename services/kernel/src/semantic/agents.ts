/** Public Account/agent mapping for Access reads and native ports. */
import type { Pool, PoolClient } from 'pg';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import readAgentsBySubject from './account-agent-subjects-read.sql';

const ACCOUNT_AGENT_NAMESPACE = 'fb3a9d35-804c-4d22-b317-260c05382a41';

export type AccountAgentLink = {
  account: string;
  route: number;
  subject: string;
  agent_id: string;
  verified: boolean;
  receipt_id: string | null;
};

export class AccountAgentLabelEditError extends Error {
  readonly field = 'labels';

  constructor() {
    super('Account agent labels are synchronized from the account display name');
    this.name = 'AccountAgentLabelEditError';
  }
}

export class AccountAgentWriteDeniedError extends Error {
  constructor(readonly subject: string) {
    super('Only the account or platform work may state facts about an unverified account agent');
    this.name = 'AccountAgentWriteDeniedError';
  }
}

export class AccountAgentVerificationError extends Error {
  constructor(message = 'Account agent verification is not valid for these subjects') {
    super(message);
    this.name = 'AccountAgentVerificationError';
  }
}

export class AccountAgentScopeGrowthError extends Error {
  constructor(readonly definitionsFile: string) {
    super(`The active release lacks schema:SoftwareApplication; update ${definitionsFile}`);
    this.name = 'AccountAgentScopeGrowthError';
  }
}

type Queryable = Pick<PoolClient, 'query'>;

function listed<T>(result: T[] | T | null): T[] {
  if (result == null) return [];
  return Array.isArray(result) ? result : [result];
}

function accountIdOf(account: string | { accountId: string }): string {
  const id = typeof account === 'string' ? account : account?.accountId;
  if (typeof id !== 'string' || routeOf(id) === null) throw new TypeError('Account id must be a routed UUID');
  return id;
}

/** The stable graph identity for an account; its UUID route keeps it in the account partition. */
export function accountAgentId(account: string | { accountId: string }): string {
  const id = accountIdOf(account);
  return derivedId(ACCOUNT_AGENT_NAMESPACE, id, routeOf(id)!);
}

export async function accountAgentsForSubjects(
  client: Pool | Queryable,
  subjects: readonly string[],
): Promise<Map<string, AccountAgentLink>> {
  const unique = [...new Set(subjects)];
  if (unique.length > 257) throw new TypeError('An account agent subject batch accepts at most 257 ids');
  if (!unique.length) return new Map();
  const groups = new Map<number, string[]>();
  for (const subject of unique) {
    const route = routeOf(subject);
    if (route === null) continue;
    const partition = partitionOf(route);
    const group = groups.get(partition) ?? [];
    group.push(subject);
    groups.set(partition, group);
  }
  const rows: AccountAgentLink[] = [];
  for (const [partition, ids] of groups) {
    const result = listed(
      (await readAgentsBySubject.run(client as PoolClient, {
        partition_no: partition,
        routes: ids.map((id) => routeOf(id)!),
        subject_ids: ids,
      })) as AccountAgentLink[] | AccountAgentLink | null,
    );
    rows.push(...result);
  }
  return new Map(rows.flatMap((row) => [[row.subject, row] as const, [row.agent_id, row] as const]));
}
