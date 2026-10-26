import type { Pool, PoolClient } from 'pg';
import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type { AccountActor } from '../request/access.ts';
import { activeRelease, GLOBAL_CONTEXT, readRelease } from './definitions.ts';
import { itemFacts, resolveItem, type FactRow, type Item } from './item.ts';
import type { Release } from '@rezics/definitions';
import accountAgentInsert from './account-agent-insert.sql';
import accountAgentRead from './account-agent-read.sql';
import accountAgentSubject from './account-agent-subject.sql';
import accountAgentsRead from './account-agents-read.sql';
import { writeSubject } from './subject.ts';
import updateIdentity from './update-subject-identity.sql';

const BATCH_LIMIT = 256;
const AGENT_SOURCE = (subject: string) => ({ kind: 'agent' as const, subject });

type Queryable = Pick<PoolClient, 'query'>;
type Account = string | Pick<AccountActor, 'accountId'>;
type AgentKind = 'person' | 'organization';

type AgentMapping = { account: string; route: number; subject: string };
type AgentSubjectRow = {
  id: string;
  type: string;
  revision: number;
  current_facts: number;
  release: string;
  labels: Record<string, string>;
  label_sequences: Record<string, number>;
  redirect: string | null;
};

export class AccountAgentAccessDeniedError extends Error {
  constructor() {
    super('Only an account may create or name its own agent subject');
    this.name = 'AccountAgentAccessDeniedError';
  }
}

function accountIdOf(account: Account): string {
  const id = typeof account === 'string' ? account : account?.accountId;
  if (typeof id !== 'string' || routeOf(id) === null) throw new TypeError('Account id must be a routed UUID');
  return id;
}

function assertOwnAccount(tx: CommandTransaction, accountId: string): void {
  const actor = currentCommand(tx).basis;
  if (!actor || actor.actorAccountId !== accountId) throw new AccountAgentAccessDeniedError();
}

function agentFacts(labels: Record<string, string>): FactRow[] {
  return Object.entries(labels).map(([language, body]) => ({
    operation: 'assert',
    kind: 'label',
    language,
    property: null,
    statement_id: null,
    body,
  }));
}

async function subjectFromRow(tx: Queryable, row: AgentSubjectRow): Promise<Item> {
  const release = await readRelease(tx, row.release);
  if (!release) throw new Error('Account agent revision release is missing');
  const facts = agentFacts(row.labels);
  return resolveItem(
    row.id,
    facts,
    row.type,
    {},
    {
      revision: row.revision,
      release: row.release,
      context: GLOBAL_CONTEXT,
    },
  );
}

async function readAgentSubject(tx: Queryable, mapping: AgentMapping): Promise<AgentSubjectRow> {
  const rows = (await accountAgentSubject.run(tx as PoolClient, {
    account_id: mapping.account,
    route: mapping.route,
    subject_id: mapping.subject,
  })) as AgentSubjectRow[];
  const row = rows[0];
  if (!row) throw new Error('Account agent subject is missing or hidden');
  if (row.redirect) throw new Error(`Account agent subject redirects to ${row.redirect}`);
  return row;
}

/** Create or retrieve an account's one Global person or organization subject. */
export async function ensureAccountAgent(
  tx: CommandTransaction,
  options: { account: Account; kind: AgentKind; name: string; language: string },
): Promise<{ subject: Item }> {
  const account = accountIdOf(options.account);
  assertOwnAccount(tx, account);
  if (options.kind !== 'person' && options.kind !== 'organization') throw new TypeError('Invalid account agent kind');
  const route = routeOf(account)!;
  const candidate = newId(route);
  const inserted = (await accountAgentInsert.run(tx as PoolClient, {
    account_id: account,
    route,
    subject_id: candidate,
  })) as AgentMapping[];

  if (inserted.length === 0) {
    const mappings = (await accountAgentRead.run(tx as PoolClient, { account_id: account })) as AgentMapping[];
    const mapping = mappings[0];
    if (!mapping) throw new Error('Account agent mapping disappeared');
    return { subject: await subjectFromRow(tx, await readAgentSubject(tx, mapping)) };
  }

  const release = await activeRelease(tx);
  if (!release) throw new Error('Global definition release is not active');
  const transactionId = Bun.randomUUIDv7();
  const created = await writeSubject(tx, transactionId, {
    target: { route, id: candidate },
    item: {
      type: options.kind === 'person' ? 'schema:Person' : 'schema:Organization',
      labels: { [options.language]: options.name },
    },
    release,
    source: AGENT_SOURCE(candidate),
  });
  return { subject: created.value };
}

/** Replace one display-name label as a self-sourced identity revision. */
export async function setAgentName(
  tx: CommandTransaction,
  options: { account: Account; name: string; language: string },
): Promise<{ subject: Item }> {
  const account = accountIdOf(options.account);
  assertOwnAccount(tx, account);
  const mappings = (await accountAgentRead.run(tx as PoolClient, { account_id: account })) as AgentMapping[];
  const mapping = mappings[0];
  if (!mapping) throw new Error('Account has no agent subject');
  const row = await readAgentSubject(tx, mapping);
  const source = AGENT_SOURCE(row.id);
  const active = await activeRelease(tx);
  if (!active) throw new Error('Global definition release is not active');
  const release: { digest: string; release: Release } = { digest: active.digest, release: active.release };
  const facts = itemFacts(row.id, { labels: { [options.language]: options.name } });
  const sequence = row.label_sequences[options.language] ?? 0;
  if (sequence >= 32 || row.current_facts >= 512) throw new TypeError('Account agent name history is full');

  const transactionId = Bun.randomUUIDv7();
  const label = facts[0]!;
  await updateIdentity.run(tx as PoolClient, {
    route: mapping.route,
    subject_id: mapping.subject,
    type: row.type,
    release: release.digest,
    revision: row.revision + 1,
    transaction_id: transactionId,
    source,
    labels: [{ slot_id: label.slot_id, language: label.language, body: label.body }],
  });
  const labels = { ...row.labels, [options.language]: options.name };
  return {
    subject: resolveItem(
      row.id,
      agentFacts(labels),
      row.type,
      {},
      {
        revision: row.revision + 1,
        release: release.digest,
        context: GLOBAL_CONTEXT,
      },
    ),
  };
}

/** Read agent subject ids in one SQL statement for each touched account partition. */
export async function accountAgents(
  client: Pool | Queryable,
  accountIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (!Array.isArray(accountIds) || accountIds.length < 1 || accountIds.length > BATCH_LIMIT)
    throw new TypeError('An account agent batch accepts 1 to 256 account ids');
  const groups = new Map<number, { accounts: string[]; routes: number[] }>();
  const result = new Map<string, string | null>();
  for (const account of accountIds) {
    const route = routeOf(account);
    if (route === null) throw new TypeError('Account id must be a routed UUID');
    const partition = partitionOf(route);
    const group = groups.get(partition) ?? { accounts: [], routes: [] };
    group.accounts.push(account);
    group.routes.push(route);
    groups.set(partition, group);
    result.set(account, null);
  }
  for (const [partition, group] of groups) {
    const rows = (await accountAgentsRead.run(client as PoolClient, {
      partition_no: partition,
      account_ids: group.accounts,
      routes: group.routes,
    })) as { account: string; subject: string | null }[];
    for (const row of rows) result.set(row.account, row.subject);
  }
  return result;
}
