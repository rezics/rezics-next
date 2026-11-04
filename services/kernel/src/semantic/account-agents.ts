import { admitIdentityTerminalCapture, runIdentityTerminalCommand } from './identity-terminal-closure-command.ts';
import { recordSemanticProducerRole } from './erasure-producer.ts';
import { initializeSubjectPagePublication } from './subject-page-publication-store.ts';
import { subjectPageFacts, recordSubjectPageDiff } from './subject-page-publication-native.ts';
import type { Pool, PoolClient } from 'pg';
import { runCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from './read.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccountActor } from '../request/access.ts';
import { activeRelease, GLOBAL_CONTEXT } from './definitions.ts';
import { itemFacts, resolveItem, type FactRow, type Item } from './item.ts';
import { accountAgentId, accountAgentsForSubjects, type AccountAgentLink } from './agents.ts';
import { AccountAgentScopeGrowthError, AccountAgentVerificationError } from './agents.ts';
import { SUBJECT_REVISED } from './events.ts';
import accountAgentSubject from './account-agent-subject.sql';
import insertAccountAgentSubject from './account-agent-subject-insert.sql';
import readAccountAgentRevocation from './account-agent-read-revocation.sql';
import changePartitionSubjectCount from './change-partition-subject-count.sql';
import syncLabel from './account-agent-sync-label.sql';
import insertSubject from './create-subject.sql';
import createRevision from './create-revision.sql';
import { identityEpochStore } from './identity-epoch-store.ts';

type Queryable = Pick<PoolClient, 'query'>;
type Account = string | Pick<AccountActor, 'accountId'>;
type AgentKind = 'person' | 'organization' | 'software';
type AgentMapping = AccountAgentLink;
type AgentSubjectRow = {
  id: string;
  type: string;
  revision: number;
  release: string;
  labels: Record<string, string>;
  redirect: string | null;
};

function listed<T>(result: T[] | T | null): T[] {
  if (result == null) return [];
  return Array.isArray(result) ? result : [result];
}

export class NoActiveDefinitionReleaseError extends Error {
  constructor() {
    super('Global definition release is not active');
  }
}

class NoAgentChange extends Error {
  constructor(readonly value: { subject: Item; created: boolean }) {
    super('Account agent is already current');
  }
}

function accountIdOf(account: Account): string {
  const id = typeof account === 'string' ? account : account?.accountId;
  if (typeof id !== 'string' || routeOf(id) === null) throw new TypeError('Account id must be a routed UUID');
  return id;
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

async function createAccountAgentBackLink(
  tx: Queryable,
  account: string,
  route: number,
  subject: string,
): Promise<void> {
  await insertAccountAgentSubject.run(tx as PoolClient, {
    route,
    account_route: route,
    subject_id: subject,
    account_id: account,
    agent_id: subject,
  });
}

async function accountAgentForNode(client: Queryable, agentId: string): Promise<AccountAgentLink | null> {
  const node = await readAgentSubject(client, agentId);
  if (!node) return null;
  const current = node.redirect ? await currentSubject(client, node.id) : null;
  const subject = current?.row.id ?? agentId;
  return (await accountAgentsForSubjects(client, [subject])).get(subject) ?? null;
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

async function syncAgentLabel(
  tx: CommandTransaction,
  transactionId: string,
  route: number,
  row: AgentSubjectRow,
  name: string | null,
  language: string,
): Promise<{ subject: Item; changed: boolean; events: { type: string; subject: string; data: unknown }[] }> {
  const labels = name === null ? {} : { [language]: name };
  if (Object.keys(row.labels).length === Object.keys(labels).length && (name === null || row.labels[language] === name))
    return { subject: await subjectFromRow(tx, row), changed: false, events: [] };
  const facts = name === null ? [] : itemFacts(row.id, { labels });
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
  const publicationEvents: { type: string; subject: string; data: unknown }[] = [];
  await recordSubjectPageDiff(
    tx,
    row.id,
    transactionId,
    await subjectPageFacts(tx, row.id, agentFacts(row.labels), release.release),
    await subjectPageFacts(tx, row.id, agentFacts(labels), release.release),
    publicationEvents,
  );
  return {
    subject,
    changed: true,
    events: [
      ...publicationEvents,
      { type: SUBJECT_REVISED, subject: row.id, data: { id: row.id, revision: row.revision + 1, kind: 'identity' } },
    ],
  };
}

// Ordinary catalogue creation requires a label. A nameless account node has no label facts to validate or write.
async function createUnlabeledAgent(
  tx: CommandTransaction,
  transactionId: string,
  id: string,
  type: string,
  release: string,
) {
  const route = routeOf(id)!;
  await insertSubject.run(tx, {
    route,
    subject_id: id,
    type,
    transaction_id: transactionId,
    current_facts: 0,
    current_release: release,
  });
  await createRevision.run(tx, { route, subject_id: id, release, transaction_id: transactionId, source: null });
  await identityEpochStore.initializeSubject(tx, id);
  await changePartitionSubjectCount.run(tx, { partition_no: partitionOf(route), delta: 1 });
  await initializeSubjectPagePublication(tx, { route, id });
  return {
    value: resolveItem(id, [], type, {}, { revision: 1, release, context: GLOBAL_CONTEXT }),
    events: [{ type: 'com.rezics.subject.created.v1', subject: id, data: { id } }],
  };
}

async function ensureInTransaction(
  tx: CommandTransaction,
  transactionId: string,
  options: { account: Account; kind: AgentKind; name: string | null; language?: string },
): Promise<{
  value: { subject: Item; created: boolean };
  events: { type: string; subject: string; data: unknown }[];
  changed: boolean;
}> {
  const account = accountIdOf(options.account);
  if (!['person', 'organization', 'software'].includes(options.kind)) throw new TypeError('Invalid account agent kind');
  const agentId = accountAgentId(account);
  await admitIdentityTerminalCapture(tx, [agentId]);
  const agentRoute = routeOf(agentId)!;
  const language = options.language ?? 'und';
  const row = await readAgentSubject(tx, agentId);
  if (row?.redirect) {
    const linked = await currentSubject(tx, row.redirect);
    return { value: { subject: linked.subject, created: false }, events: [], changed: false };
  }
  if (!row) {
    const active = await activeRelease(tx);
    if (!active) throw new NoActiveDefinitionReleaseError();
    const type =
      options.kind === 'person'
        ? 'schema:Person'
        : options.kind === 'organization'
          ? 'schema:Organization'
          : 'schema:SoftwareApplication';
    if (options.kind === 'software' && !active.release.types[type])
      throw new AccountAgentScopeGrowthError('packages/definitions/sources/vndb.yaml');
    if (!active.release.types[type])
      throw new AccountAgentVerificationError('The account agent kind is absent from the active definition release');
    const created = await createUnlabeledAgent(tx, transactionId, agentId, type, active.digest);
    // Account labels are a replaceable native projection, including at birth.
    // The authored catalogue writer enrolls retention/history that this derived
    // identity does not own and would retain prior account display names.
    const labeled =
      options.name === null
        ? null
        : await syncAgentLabel(
            tx,
            transactionId,
            agentRoute,
            (await readAgentSubject(tx, agentId))!,
            options.name,
            language,
          );
    await createAccountAgentBackLink(tx, account, agentRoute, agentId);
    return {
      value: { subject: labeled?.subject ?? created.value, created: true },
      events: [...created.events, ...(labeled?.events ?? [])],
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

/** Ensure one account graph agent at its deterministic account-partition id. */
export async function ensureAccountAgent(
  pool: Pool,
  options: { account: Account; kind: AgentKind; name: string | null; language?: string },
): Promise<{ subject: Item; created: boolean }>;
export async function ensureAccountAgent(
  pool: Pool,
  options: { account: Account; kind: AgentKind; name: string | null; language?: string },
): Promise<{ subject: Item; created: boolean }> {
  const account = accountIdOf(options.account);
  const agentId = accountAgentId(account);
  const agentRoute = routeOf(agentId)!;
  try {
    const outcome = await runIdentityTerminalCommand(
      pool,
      { partition: partitionOf(agentRoute) },
      async (tx, { transactionId }) => {
        await recordSemanticProducerRole(tx, transactionId, accountIdOf(options.account), 'subject');
        const state = await tx.query(
          'SELECT state,authn_fenced AS fenced FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE',
          [routeOf(account), account],
        );
        // An old producer input is never authority to restore the display name after native account T.
        const effective =
          state.rows[0]?.state === 'deleted' || state.rows[0]?.fenced ? { ...options, name: null } : options;
        const result = await ensureInTransaction(tx, transactionId, effective);
        if (!result.changed) throw new NoAgentChange(result.value);
        return { value: result.value, events: result.events };
      },
    );
    return outcome.value;
  } catch (error) {
    if (error instanceof NoAgentChange) return error.value;
    throw error;
  }
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
  if (routeOf(options.catalogue) === null || options.catalogue === agentId) throw new AccountAgentVerificationError();
  const { deliverAccountIdentity, loadAccountIdentitySource, accountIdentityUnavailable } =
    await import('../access/agent-verification-identity.ts');
  const receipt = { kind: 'account-agent.verify' as const, account, receipt: options.receipt };
  const source = await loadAccountIdentitySource(pool, receipt);
  if (source.input.intent.kind !== 'merge' || source.input.intent.survivor !== options.catalogue)
    throw accountIdentityUnavailable('caller catalogue does not match original verification');
  const { lookupIdentityBinding } = await import('./identity-epoch-binding.ts');
  // An admitted original delivery owns its recovery even while mapping is between native commits.
  const bound = await lookupIdentityBinding(pool, {}, source.input);
  if (!bound) {
    const node = await readAgentSubject(pool, agentId);
    const catalogue = await readAgentSubject(pool, options.catalogue);
    const before = await accountAgentForNode(pool, agentId);
    if (
      !node ||
      !catalogue ||
      catalogue.redirect ||
      !before ||
      before.account !== account ||
      before.agent_id !== agentId
    )
      throw new AccountAgentVerificationError('The account agent and catalogue must be visible and complete');
    if (node.type !== 'schema:Person' && node.type !== 'schema:Organization')
      throw new AccountAgentVerificationError('Only person and organization account agents can be verified');
    if (node.type !== catalogue.type)
      throw new AccountAgentVerificationError('The catalogue subject must match the account agent kind');
    if (before.verified) {
      if (before.subject !== options.catalogue || before.receipt_id !== options.receipt)
        throw new AccountAgentVerificationError('The account agent is already verified to another catalogue subject');
    } else {
      if (
        node.redirect ||
        before.subject !== agentId ||
        (await accountAgentsForSubjects(pool, [options.catalogue])).has(options.catalogue)
      )
        throw new AccountAgentVerificationError(
          'The catalogue subject is already linked or the account agent is merged',
        );
    }
  }
  await deliverAccountIdentity(pool, receipt);
  const mapping = await accountAgentForNode(pool, agentId);
  if (
    !mapping?.verified ||
    mapping.account !== account ||
    mapping.subject !== options.catalogue ||
    mapping.receipt_id !== options.receipt
  )
    throw accountIdentityUnavailable('published verification lacks its actual reciprocal back link');
  return existingVerification(pool, mapping, agentId);
}

/** Revoke a verified account-agent link and restore only the inbound links moved by that verification. */
export async function unverifyAccountAgent(
  pool: Pool,
  options: { account: Account; receipt: string },
): Promise<{
  survivor: string;
  redirected: string;
  revision: number;
  subject: Item;
  component: { partition: number; epoch: number; position: bigint };
}> {
  const account = accountIdOf(options.account);
  const agentId = accountAgentId(account);
  const { deliverAccountIdentity, loadAccountIdentitySource, accountIdentityUnavailable } =
    await import('../access/agent-verification-identity.ts');
  const receipt = { kind: 'account-agent.unverify' as const, account, receipt: options.receipt };
  const source = await loadAccountIdentitySource(pool, receipt);
  if (source.input.intent.kind !== 'unmerge') throw accountIdentityUnavailable('caller reversal direction differs');
  await deliverAccountIdentity(pool, receipt);
  const mapping = await accountAgentForNode(pool, agentId);
  const node = await readAgentSubject(pool, agentId);
  if (
    !mapping ||
    mapping.verified ||
    mapping.account !== account ||
    mapping.agent_id !== agentId ||
    mapping.subject !== agentId ||
    !node ||
    node.redirect
  )
    throw accountIdentityUnavailable('published reversal lacks its actual restored native back link');
  const prior = listed(
    await readAccountAgentRevocation.run(pool, {
      route: routeOf(agentId)!,
      subject_id: agentId,
      receipt_id: options.receipt,
    }),
  )[0];
  if (!prior?.survivor || prior.verification_receipt_id !== source.input.intent.verificationReceipt)
    throw accountIdentityUnavailable('published reversal lacks exact original revision provenance');
  const partition = await withReadTransaction(pool, (tx) => readPartition(tx, partitionOf(routeOf(agentId)!)));
  if (!partition || partition.writeState !== 'active') throw accountIdentityUnavailable('reversal owner moved');
  return {
    survivor: prior.survivor,
    redirected: agentId,
    revision: prior.revision,
    subject: await subjectFromRow(pool, node),
    component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
  };
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

/** Read account agent ids in one SQL statement per requested account partition. */
