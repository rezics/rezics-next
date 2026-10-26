import type { Pool, PoolClient } from 'pg';
import { currentCommand, runCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from './read.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccountActor } from '../request/access.ts';
import { activeRelease, GLOBAL_CONTEXT } from './definitions.ts';
import { itemFacts, resolveItem, type FactRow, type Item } from './item.ts';
import {
  accountAgentId,
  accountAgentForAccount,
  type AccountAgentLink,
} from './agents.ts';
import { AccountAgentLabelEditError, AccountAgentScopeGrowthError, AccountAgentVerificationError } from './agents.ts';
import { EditorialConflictError, SubjectNotFoundError } from './candidates.ts';
import { SUBJECT_REVISED, AGENT_LINKED } from './events.ts';
import accountAgentInsert from './account-agent-insert.sql';
import accountAgentSubject from './account-agent-subject.sql';
import insertAccountAgentSubject from './account-agent-subject-insert.sql';
import verifyAccountAgentSubject from './account-agent-subject-verify.sql';
import accountAgentVerify from './account-agent-verify.sql';
import syncLabel from './account-agent-sync-label.sql';
import accountAgentsRead from './account-agents-read.sql';
import { writeSubject } from './subject.ts';
import { mergeSubjectsInCommand } from './merges.ts';

const BATCH_LIMIT = 256;

type Queryable = Pick<PoolClient, 'query'>;
type Account = string | Pick<AccountActor, 'accountId'>;
type AgentKind = 'person' | 'organization' | 'software';
type AgentMapping = AccountAgentLink;
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

function listed<T>(result: T[] | T | null): T[] {
  if (result == null) return [];
  return Array.isArray(result) ? result : [result];
}

export class AccountAgentAccessDeniedError extends Error {
  constructor() {
    super('Account agent maintenance is only available as platform work');
    this.name = 'AccountAgentAccessDeniedError';
  }
}

class NoAgentChange extends Error {
  constructor(readonly value: { subject: Item; created: boolean }) {
    super('Account agent is already current');
  }
}

class AlreadyVerified extends Error {
  constructor(readonly mapping: AgentMapping) {
    super('Account agent was already verified');
  }
}

function accountIdOf(account: Account): string {
  const id = typeof account === 'string' ? account : account?.accountId;
  if (typeof id !== 'string' || routeOf(id) === null) throw new TypeError('Account id must be a routed UUID');
  return id;
}

function assertPlatform(tx: CommandTransaction): void {
  const basis = currentCommand(tx).basis;
  if (basis !== null) throw new AccountAgentAccessDeniedError();
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

async function readAgentSubject(tx: Queryable, subjectId: string): Promise<AgentSubjectRow | null> {
  const route = routeOf(subjectId);
  if (route === null) return null;
  const rows = listed(
    (await accountAgentSubject.run(tx as PoolClient, { route, subject_id: subjectId })) as
      | AgentSubjectRow[]
      | AgentSubjectRow
      | null,
  );
  return rows[0] ?? null;
}

async function createAccountAgentMapping(
  tx: Queryable,
  account: string,
  route: number,
  subject: string,
): Promise<void> {
  await accountAgentInsert.run(tx as PoolClient, {
    account_id: account,
    route,
    subject_id: subject,
    agent_id: subject,
  });
  await insertAccountAgentSubject.run(tx as PoolClient, {
    route,
    account_route: route,
    subject_id: subject,
    account_id: account,
    agent_id: subject,
  });
}

async function subjectFromRow(tx: Queryable, row: AgentSubjectRow): Promise<Item> {
  const labels = row.labels ?? {};
  return resolveItem(
    row.id,
    agentFacts(labels),
    row.type,
    {},
    {
      revision: row.revision,
      release: row.release,
      context: GLOBAL_CONTEXT,
    },
  );
}

async function currentSubject(tx: Queryable, subjectId: string): Promise<{ subject: Item; row: AgentSubjectRow }> {
  let id = subjectId;
  const visited = new Set<string>();
  for (let hop = 0; hop < 16; hop++) {
    if (visited.has(id)) throw new AccountAgentVerificationError('Account agent redirect cycle detected');
    visited.add(id);
    const row = await readAgentSubject(tx, id);
    if (!row) throw new AccountAgentVerificationError('Account agent subject is missing or hidden');
    if (!row.redirect) return { subject: await subjectFromRow(tx, row), row };
    id = row.redirect;
  }
  throw new AccountAgentVerificationError('Account agent redirect chain is too long');
}

function labelFacts(subject: string, row: AgentSubjectRow, name: string, language: string) {
  const desired = Object.keys(row.labels).length === 1 && row.labels[language] === name;
  if (desired) return [];
  const changes: {
    slot_id: string;
    language: string;
    body: string;
    operation: 'assert' | 'retract';
    log_seq: number;
  }[] = [];
  for (const [currentLanguage, currentName] of Object.entries(row.labels)) {
    if (currentLanguage === language) continue;
    const [fact] = itemFacts(subject, { labels: { [currentLanguage]: currentName } });
    if (!fact) continue;
    changes.push({
      slot_id: fact.slot_id,
      language: currentLanguage,
      body: currentName,
      operation: 'retract',
      log_seq: (row.label_sequences[currentLanguage] ?? 0) + 1,
    });
  }
  if (row.labels[language] !== name) {
    const [fact] = itemFacts(subject, { labels: { [language]: name } });
    if (fact)
      changes.push({
        slot_id: fact.slot_id,
        language,
        body: name,
        operation: 'assert',
        log_seq: (row.label_sequences[language] ?? 0) + 1,
      });
  }
  return changes;
}

async function syncAgentLabel(
  tx: CommandTransaction,
  transactionId: string,
  route: number,
  row: AgentSubjectRow,
  name: string,
  language: string,
): Promise<{ subject: Item; changed: boolean; events: { type: string; subject: string; data: unknown }[] }> {
  const facts = labelFacts(row.id, row, name, language);
  if (!facts.length) return { subject: await subjectFromRow(tx, row), changed: false, events: [] };
  if (row.current_facts + facts.length > 512 || facts.some((fact) => fact.log_seq > 32))
    throw new TypeError('Account agent name history is full');
  const release = await activeRelease(tx);
  if (!release) throw new Error('Global definition release is not active');
  await syncLabel.run(tx as PoolClient, {
    route,
    subject_id: row.id,
    type: row.type,
    release: release.digest,
    revision: row.revision + 1,
    transaction_id: transactionId,
    source: null,
    labels: facts,
  });
  const labels = { ...row.labels };
  for (const fact of facts) {
    if (fact.operation === 'retract') delete labels[fact.language];
    else labels[fact.language] = fact.body;
  }
  const subject = resolveItem(
    row.id,
    agentFacts(labels),
    row.type,
    {},
    {
      revision: row.revision + 1,
      release: release.digest,
      context: GLOBAL_CONTEXT,
    },
  );
  return {
    subject,
    changed: true,
    events: [
      { type: SUBJECT_REVISED, subject: row.id, data: { id: row.id, revision: row.revision + 1, kind: 'identity' } },
    ],
  };
}

async function ensureInTransaction(
  tx: CommandTransaction,
  transactionId: string,
  options: { account: Account; kind: AgentKind; name: string; language?: string },
): Promise<{
  value: { subject: Item; created: boolean };
  events: { type: string; subject: string; data: unknown }[];
  changed: boolean;
}> {
  const account = accountIdOf(options.account);
  assertPlatform(tx);
  if (!['person', 'organization', 'software'].includes(options.kind)) throw new TypeError('Invalid account agent kind');
  const agentId = accountAgentId(account);
  const agentRoute = routeOf(agentId)!;
  const language = options.language ?? 'und';
  const row = await readAgentSubject(tx, agentId);
  if (row?.redirect) {
    const linked = await currentSubject(tx, row.redirect);
    return { value: { subject: linked.subject, created: false }, events: [], changed: false };
  }
  if (!row) {
    const active = await activeRelease(tx);
    if (!active) throw new Error('Global definition release is not active');
    const type =
      options.kind === 'person'
        ? 'schema:Person'
        : options.kind === 'organization'
          ? 'schema:Organization'
          : 'schema:SoftwareApplication';
    if (options.kind === 'software' && !active.release.types[type])
      throw new AccountAgentScopeGrowthError('packages/definitions/sources/vndb.yaml');
    const created = await writeSubject(tx, transactionId, {
      target: { route: agentRoute, id: agentId },
      item: { type, labels: { [language]: options.name } },
      release: active,
    });
    await createAccountAgentMapping(tx, account, agentRoute, agentId);
    return {
      value: { subject: created.value, created: true },
      events: [...created.events, { type: AGENT_LINKED, subject: agentId, data: { account, subject: agentId } }],
      changed: true,
    };
  }

  const active = await activeRelease(tx);
  if (!active) throw new Error('Global definition release is not active');
  // The derived ID is the lookup key; successful creation installs its back link atomically.
  const wantedType =
    options.kind === 'person'
      ? 'schema:Person'
      : options.kind === 'organization'
        ? 'schema:Organization'
        : 'schema:SoftwareApplication';
  if (row.type !== wantedType)
    throw new AccountAgentVerificationError('Account agent kind cannot be changed after creation');
  const label = await syncAgentLabel(tx, transactionId, agentRoute, row, options.name, language);
  return {
    value: { subject: label.subject, created: false },
    events: label.events,
    changed: label.changed,
  };
}

function isPool(value: Pool | CommandTransaction): value is Pool {
  return typeof (value as Pool).connect === 'function';
}

/** Ensure one account graph agent at its deterministic account-partition id. */
export async function ensureAccountAgent(
  pool: Pool,
  options: { account: Account; kind: AgentKind; name: string; language?: string },
): Promise<{ subject: Item; created: boolean }>;
/** @deprecated Retained for source compatibility; account agents must use the platform pool command. */
export async function ensureAccountAgent(
  tx: CommandTransaction,
  options: { account: Account; kind: AgentKind; name: string; language?: string },
): Promise<{ subject: Item; created: boolean }>;
export async function ensureAccountAgent(
  db: Pool | CommandTransaction,
  options: { account: Account; kind: AgentKind; name: string; language?: string },
): Promise<{ subject: Item; created: boolean }> {
  if (!isPool(db)) {
    throw new AccountAgentAccessDeniedError();
  }
  const account = accountIdOf(options.account);
  const agentId = accountAgentId(account);
  const agentRoute = routeOf(agentId)!;
  try {
    const outcome = await runCommand(db, { partition: partitionOf(agentRoute) }, async (tx, { transactionId }) => {
      const result = await ensureInTransaction(tx, transactionId, options);
      if (!result.changed) throw new NoAgentChange(result.value);
      return { value: result.value, events: result.events };
    });
    return outcome.value;
  } catch (error) {
    if (error instanceof NoAgentChange) return error.value;
    throw error;
  }
}

/** @deprecated Retained for source compatibility; label changes are owned by ensureAccountAgent. */
export async function setAgentName(
  tx: CommandTransaction,
  _options: { account: Account; name: string; language: string },
): Promise<{ subject: Item }> {
  void tx;
  throw new AccountAgentLabelEditError();
}

/** Link a verified catalogue agent to the account's existing graph node. */
export async function verifyAccountAgent(
  pool: Pool,
  options: { account: Account; catalogue: string; receipt: string },
): Promise<{
  survivor: string;
  redirected: string;
  revision: number;
  subject: Item;
  component: { partition: number; epoch: number; position: bigint };
}> {
  const account = accountIdOf(options.account);
  const agentId = accountAgentId(account);
  const nodeRoute = routeOf(agentId)!;
  const catalogueRoute = routeOf(options.catalogue);
  if (!catalogueRoute || options.catalogue === agentId) throw new AccountAgentVerificationError();
  if (typeof options.receipt !== 'string' || !options.receipt.length || options.receipt.length > 255)
    throw new TypeError('Verification receipt id must contain 1 to 255 characters');
  const before = await accountAgentForAccount(pool, account);
  if (before?.verified) {
    if (before.subject !== options.catalogue || before.receipt_id !== options.receipt)
      throw new AccountAgentVerificationError('The account agent is already verified to another catalogue subject');
    return existingVerification(pool, before, agentId);
  }
  const active = await activeRelease(pool);
  if (!active) throw new Error('Global definition release is not active');
  try {
    const command = await runCommand(pool, { partition: partitionOf(nodeRoute) }, async (tx, { transactionId }) => {
      if (currentCommand(tx).basis !== null)
        throw new AccountAgentVerificationError('Verification requires platform work');
      const mapping = await accountAgentForAccount(tx, account);
      if (mapping?.verified) {
        if (mapping.subject === options.catalogue && mapping.receipt_id === options.receipt)
          throw new AlreadyVerified(mapping);
        throw new AccountAgentVerificationError('The account agent is already verified to another catalogue subject');
      }
      if (!mapping || mapping.agent_id !== agentId || mapping.subject !== agentId)
        throw new AccountAgentVerificationError(
          'The account must have one unverified derived agent before verification',
        );
      const node = await readAgentSubject(tx, agentId);
      if (!node || node.redirect)
        throw new AccountAgentVerificationError('The account agent is missing, hidden, or already merged');
      let merged: Awaited<ReturnType<typeof mergeSubjectsInCommand>>;
      try {
        merged = await mergeSubjectsInCommand(tx, transactionId, {
          survivor: options.catalogue,
          redirected: agentId,
          release: active,
          verificationReceiptId: options.receipt,
          allowAccountAgent: true,
        });
      } catch (error) {
        if (error instanceof EditorialConflictError || error instanceof SubjectNotFoundError)
          throw new AccountAgentVerificationError('The catalogue agent must be visible and not already merged');
        throw error;
      }
      const updated = listed(
        (await accountAgentVerify.run(tx as PoolClient, {
          account_id: account,
          account_route: routeOf(account)!,
          agent_id: agentId,
          subject_id: options.catalogue,
          receipt_id: options.receipt,
        })) as AgentMapping[] | AgentMapping | null,
      );
      if (!updated.length)
        throw new AccountAgentVerificationError('The account agent link changed during verification');
      const backLink = listed(
        (await verifyAccountAgentSubject.run(tx as PoolClient, {
          account_id: account,
          account_route: routeOf(account)!,
          agent_id: agentId,
          node_route: nodeRoute,
          catalogue: options.catalogue,
          receipt_id: options.receipt,
        })) as AccountAgentLink[] | AccountAgentLink | null,
      );
      if (!backLink.length) throw new AccountAgentVerificationError('The account agent back link could not be moved');
      const catalogue = await currentSubject(tx, options.catalogue);
      return {
        value: { ...merged.value, subject: catalogue.subject },
        events: [
          ...merged.events,
          { type: AGENT_LINKED, subject: options.catalogue, data: { account, subject: options.catalogue } },
        ],
      };
    });
    return {
      ...command.value,
      component: { partition: command.partition, epoch: command.epoch, position: command.position },
    };
  } catch (error) {
    if (error instanceof AlreadyVerified) return existingVerification(pool, error.mapping, agentId);
    if (isAccountAgentConstraintViolation(error))
      throw new AccountAgentVerificationError('The catalogue subject is already linked to another account');
    throw error;
  }
}

async function existingVerification(
  pool: Pool,
  mapping: AgentMapping,
  agentId: string,
): Promise<{
  survivor: string;
  redirected: string;
  revision: number;
  subject: Item;
  component: { partition: number; epoch: number; position: bigint };
}> {
  const { subject, row } = await currentSubject(pool, mapping.subject);
  const partition = await withReadTransaction(pool, (client) => readPartition(client, partitionOf(routeOf(agentId)!)));
  if (!partition) throw new AccountAgentVerificationError('The account agent partition is unavailable');
  return {
    survivor: mapping.subject,
    redirected: agentId,
    revision: row.revision,
    subject,
    component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
  };
}

function isAccountAgentConstraintViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; constraint?: unknown };
  return (
    record.code === '23505' &&
    [
      'account_agent_agent_id_key',
      'account_agent_subject_id_key',
      'account_agent_route_subject_id_key',
      'account_agent_subject_pkey',
      'account_agent_subject_route_account_id_key',
    ].includes(
      String(record.constraint),
    )
  );
}

/** Read account agent ids in one SQL statement per requested account partition. */
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
    const rows = listed(
      (await accountAgentsRead.run(client as PoolClient, {
        partition_no: partition,
        account_ids: group.accounts,
        routes: group.routes,
      })) as { account: string; subject: string | null }[] | { account: string; subject: string | null } | null,
    );
    for (const row of rows) result.set(row.account, row.subject);
  }
  return result;
}
