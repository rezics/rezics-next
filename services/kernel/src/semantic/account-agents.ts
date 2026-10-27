import type { Pool, PoolClient } from 'pg';
import { currentCommand, runCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from './read.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccountActor } from '../request/access.ts';
import { activeRelease, GLOBAL_CONTEXT } from './definitions.ts';
import { factDataTypes, itemFacts, resolveItem, type FactRow, type Item } from './item.ts';
import { accountAgentId, accountAgentsForSubjects, type AccountAgentLink } from './agents.ts';
import { AccountAgentScopeGrowthError, AccountAgentVerificationError } from './agents.ts';
import { EditorialConflictError, SubjectNotFoundError } from './candidates.ts';
import { SUBJECT_REVISED, LINKS_CHANGED, LINKS_PROJECTED } from './events.ts';
import { linkChanges } from './link-changes.ts';
import { slotView } from './slots.ts';
import accountAgentSubject from './account-agent-subject.sql';
import insertAccountAgentSubject from './account-agent-subject-insert.sql';
import verifyAccountAgentSubject from './account-agent-subject-verify.sql';
import unverifyAccountAgentSubject from './account-agent-subject-unverify.sql';
import deleteAccountAgentRedirect from './account-agent-delete-redirect.sql';
import deleteAccountAgentMember from './account-agent-delete-member.sql';
import insertUnverifyRevision from './account-agent-unverify-revision.sql';
import readAccountAgentRevocation from './account-agent-read-revocation.sql';
import readLatestRevision from './merges-read-latest-revision.sql';
import changePartitionSubjectCount from './change-partition-subject-count.sql';
import updateSubjectRelease from './update-subject-release.sql';
import syncLabel from './account-agent-sync-label.sql';
import insertSubject from './create-subject.sql';
import createRevision from './create-revision.sql';
import { writeSubject } from './subject.ts';
import { mergeSubjectsInCommand } from './merges.ts';
import { reverseAccountAgentLinks } from './merge-moves.ts';

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
  return {
    subject,
    changed: true,
    events: [
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
  await changePartitionSubjectCount.run(tx, { partition_no: partitionOf(route), delta: 1 });
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
    const created =
      options.name === null
        ? await createUnlabeledAgent(tx, transactionId, agentId, type, active.digest)
        : await writeSubject(tx, transactionId, {
            target: { route: agentRoute, id: agentId },
            item: { type, labels: { [language]: options.name } },
            release: active,
          });
    await createAccountAgentBackLink(tx, account, agentRoute, agentId);
    return {
      value: { subject: created.value, created: true },
      events: created.events,
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
    const outcome = await runCommand(pool, { partition: partitionOf(agentRoute) }, async (tx, { transactionId }) => {
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
  if (catalogueRoute === null || options.catalogue === agentId) throw new AccountAgentVerificationError();
  if (typeof options.receipt !== 'string' || !options.receipt.length || options.receipt.length > 255)
    throw new TypeError('Verification receipt id must contain 1 to 255 characters');
  const before = await accountAgentForNode(pool, agentId);
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
      const node = await readAgentSubject(tx, agentId);
      if (!node)
        throw new AccountAgentVerificationError(
          'The account must have one unverified derived agent before verification',
        );
      if (node.redirect) {
        const mapping = await accountAgentForNode(tx, agentId);
        if (mapping?.verified) {
          if (mapping.subject === options.catalogue && mapping.receipt_id === options.receipt)
            throw new AlreadyVerified(mapping);
          throw new AccountAgentVerificationError('The account agent is already verified to another catalogue subject');
        }
        throw new AccountAgentVerificationError('The account agent is missing, hidden, or already merged');
      }
      const mapping = (await accountAgentsForSubjects(tx, [agentId])).get(agentId);
      if (!mapping || mapping.account !== account || mapping.agent_id !== agentId || mapping.subject !== agentId)
        throw new AccountAgentVerificationError(
          'The account must have one unverified derived agent before verification',
        );
      if (mapping.verified)
        throw new AccountAgentVerificationError('The account agent is already verified to another catalogue subject');
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
        events: merged.events,
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
  if (typeof options.receipt !== 'string' || !options.receipt.length || options.receipt.length > 255)
    throw new TypeError('Revocation receipt id must contain 1 to 255 characters');
  const agentId = accountAgentId(account);
  const nodeRoute = routeOf(agentId)!;
  const command = await runCommand(pool, { partition: partitionOf(nodeRoute) }, async (tx, { transactionId }) => {
    if (currentCommand(tx).basis !== null)
      throw new AccountAgentVerificationError('Verification reversal requires platform work');
    const node = await readAgentSubject(tx, agentId);
    if (!node) throw new AccountAgentVerificationError('The account agent does not exist');
    const mapping = await accountAgentForNode(tx, agentId);
    if (!mapping || mapping.account !== account || mapping.agent_id !== agentId)
      throw new AccountAgentVerificationError('The account has no verified derived agent');

    if (!mapping.verified) {
      if (node.redirect) throw new AccountAgentVerificationError('The account agent is already merged');
      const prior = listed(
        (await readAccountAgentRevocation.run(tx as PoolClient, {
          route: nodeRoute,
          subject_id: agentId,
          receipt_id: options.receipt,
        })) as
          | {
              revision: number;
              verification_receipt_id: string | null;
              survivor: string | null;
            }[]
          | null,
      )[0];
      if (!prior?.verification_receipt_id || !prior.survivor)
        throw new AccountAgentVerificationError('The account agent is not verified');
      const active = await activeRelease(tx);
      if (!active) throw new Error('Global definition release is not active');
      const subject = resolveItem(
        agentId,
        agentFacts(node.labels),
        node.type,
        {},
        {
          revision: node.revision,
          release: active.digest,
          context: GLOBAL_CONTEXT,
        },
      );
      return {
        value: {
          survivor: prior.survivor,
          redirected: agentId,
          revision: prior.revision,
          subject,
          verificationReceipt: prior.verification_receipt_id,
        },
        events: [{ type: LINKS_PROJECTED, subject: prior.survivor, data: { subjects: [prior.survivor] } }],
      };
    }

    if (!mapping.receipt_id || !node.redirect || node.redirect !== mapping.subject)
      throw new AccountAgentVerificationError('The account agent verification is incomplete');
    const active = await activeRelease(tx);
    if (!active) throw new Error('Global definition release is not active');
    const latest = await readLatestRevision.run(tx, { route: nodeRoute, subject_id: agentId });
    if (!latest) throw new SubjectNotFoundError();
    const revision = Number(latest.revision) + 1;
    const securityRevision = Number(latest.security_revision);
    await insertUnverifyRevision.run(tx as PoolClient, {
      route: nodeRoute,
      subject_id: agentId,
      revision,
      release: active.digest,
      transaction_id: transactionId,
      verification_receipt_id: mapping.receipt_id,
      revocation_receipt_id: options.receipt,
      revoked_survivor_id: mapping.subject,
    });
    const movedBack = listed(
      (await unverifyAccountAgentSubject.run(tx as PoolClient, {
        node_route: nodeRoute,
        catalogue_route: routeOf(mapping.subject)!,
        account_route: routeOf(account)!,
        account_id: account,
        agent_id: agentId,
        catalogue: mapping.subject,
        verification_receipt_id: mapping.receipt_id,
      })) as AccountAgentLink[] | AccountAgentLink | null,
    );
    if (!movedBack.length) throw new AccountAgentVerificationError('The verified account-agent link changed');
    await deleteAccountAgentRedirect.run(tx, { route: nodeRoute, subject_id: agentId });
    await deleteAccountAgentMember.run(tx, {
      route: routeOf(mapping.subject)!,
      subject_id: mapping.subject,
      member_id: agentId,
    });
    await updateSubjectRelease.run(tx, { route: nodeRoute, subject_id: agentId, release: active.digest });
    await changePartitionSubjectCount.run(tx, { partition_no: partitionOf(nodeRoute), delta: 1 });

    const facts: FactRow[] = [];
    for (const property of active.release.types[node.type]?.properties ?? [])
      facts.push(...(await slotView(tx, agentId, property)).facts);
    const changes = linkChanges([], facts, factDataTypes(active.release, facts), {
      subject: agentId,
      release: active.release,
      type: node.type,
    });
    const subject = resolveItem(
      agentId,
      agentFacts(node.labels),
      node.type,
      {},
      {
        revision,
        release: active.digest,
        context: GLOBAL_CONTEXT,
      },
    );
    return {
      value: {
        survivor: mapping.subject,
        redirected: agentId,
        revision,
        subject,
        verificationReceipt: mapping.receipt_id,
      },
      events: [
        { type: SUBJECT_REVISED, subject: agentId, data: { id: agentId, revision, kind: 'merge' } },
        ...(changes.length
          ? [
              {
                type: LINKS_CHANGED,
                subject: agentId,
                data: { subject: agentId, revision, security_revision: securityRevision, changes },
              },
            ]
          : []),
      ],
    };
  });

  await reverseAccountAgentLinks(pool, {
    account,
    receipt: command.value.verificationReceipt,
    survivor: command.value.survivor,
    movedFrom: agentId,
  });
  return {
    survivor: command.value.survivor,
    redirected: agentId,
    revision: command.value.revision,
    subject: command.value.subject,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
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

function isAccountAgentConstraintViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; constraint?: unknown };
  return (
    record.code === '23505' &&
    [
      'account_agent_subject_pkey',
      'account_agent_subject_account_id_key',
      'account_agent_subject_agent_id_key',
    ].includes(String(record.constraint))
  );
}

/** Read account agent ids in one SQL statement per requested account partition. */
