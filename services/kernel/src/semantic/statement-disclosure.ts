import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import type { Release } from '@rezics/definitions';
import { currentCommand, runCommand, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import { accessCheck, type Access, type Actor, type AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { accountAgentsForSubjects } from './agents.ts';
import { GLOBAL_CONTEXT, readRelease } from './definitions.ts';
import { LINKS_CHANGED } from './events.ts';
import { factDataTypes, SubjectInputError, type FactRow } from './item.ts';
import { holderFacts, holderKeys, labelOrderKey } from './link-keys.ts';
import { contextLinkChanges, linkChanges } from './link-changes.ts';
import listRelationContexts from './relation-context-list.sql';
import { readLabels } from './subject.ts';
import readRetraction from './statement-disclosure-retraction.sql';
import insertRetraction from './bulk-insert-retraction.sql';
import insertRetractRevision from './bulk-insert-retract-revision.sql';
import { currentAcceptance, insertAcceptance, insertAdoption, latestAdoption, slotView } from './slots.ts';
import insertDisclosure from './statement-disclosure-insert.sql';
import readDisclosure from './statement-disclosure-read.sql';
import updateDisclosure from './statement-disclosure-update.sql';
import readPrivateLinks from './private-links.sql';
import bumpSecurity from './moderation-bump-security.sql';
import readVisibility from './read-visibility.sql';

const NIL = '00000000-0000-0000-0000-000000000000';
export type StatementReader = { account: string; moderator: (client: CommandTransaction) => Promise<boolean> };
const PUBLIC_READER = Symbol('public statement reader');
type ReaderScope = StatementReader & { refreshAuthorization?: () => Promise<void> };
const readers = new AsyncLocalStorage<ReaderScope | typeof PUBLIC_READER>();

/** Prepare audience evidence outside the source checkout after every freshness wait. */
export async function refreshStatementReaderAuthorization(): Promise<void> {
  const reader = readers.getStore();
  if (reader && reader !== PUBLIC_READER) await reader.refreshAuthorization?.();
}
/** Restrict disclosure throughout nested hydration without changing caller authority. */
export function withPublicStatementReader<T>(fn: () => T): T {
  return readers.run(PUBLIC_READER, fn);
}
/** Request-scoped audience; relays, exports and background work always use the public view. */
export function withStatementReader<T>(reader: StatementReader, read: () => T): T {
  if (readers.getStore() === PUBLIC_READER) return read();
  return readers.run(reader, read);
}
export async function readStatementAs<T>(
  pool: Pool,
  access: Access,
  actor: Actor,
  deadline: number,
  read: (refreshAuthorization: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (readers.getStore() === PUBLIC_READER || actor.kind !== 'account') return read(async () => {});
  const prepareCheck = () =>
    accessCheck(access, actor, 'moderation:hide', { route: 0, id: GLOBAL_CONTEXT }, { pool, deadline });
  let check = await prepareCheck();
  let permission: Promise<boolean> | undefined;
  const refreshAuthorization = async () => {
    check = await prepareCheck();
    permission = undefined;
  };
  const reader: ReaderScope = {
    account: actor.accountId,
    moderator: (client) => (permission ??= check(client as PoolClient)),
    refreshAuthorization,
  };
  return withStatementReader(reader, () => read(refreshAuthorization));
}
export async function statementAudience(client: CommandTransaction) {
  const reader = readers.getStore();
  if (!reader || reader === PUBLIC_READER) return { viewer_account: NIL, viewer_moderator: false };
  return { viewer_account: reader.account, viewer_moderator: await reader.moderator(client) };
}

/** Validate consent at the same transaction snapshot as the proposal, including bulk writes. */
export async function disclosureAccount(
  tx: CommandTransaction,
  release: Release,
  property: string,
  body: unknown,
): Promise<string | null> {
  if (release.properties[property]?.disclosure !== 'sourceOrConsent') return null;
  const statement = body as { references: unknown[]; value: { type: string; content?: unknown } };
  if (statement.references.length) return null;
  const account = currentCommand(tx).basis?.actorAccountId;
  const target = statement.value.type === 'value' ? statement.value.content : null;
  const agents = typeof target === 'string' ? await accountAgentsForSubjects(tx, [target]) : new Map();
  if (!account || agents.get(target as string)?.account !== account)
    throw new SubjectInputError([{ pointer: '/statement/references', code: 'required' }]);
  return account;
}

export async function keepStatementPrivate(
  tx: CommandTransaction,
  input: {
    subject: string;
    candidate: string;
    slot: string;
    property: string;
    body: unknown;
    account: string;
    revision: number;
    release: Release;
  },
) {
  const target = (input.body as { value: { content: string } }).value.content;
  const identity = await holderFacts(tx, input.subject, input.release);
  // Label fills are bounded by the write's target count, never by the private-link population.
  const labels = (await readLabels(tx, [target])).get(target) ?? {};
  await insertDisclosure.run(tx, {
    route: routeOf(input.subject)!,
    subject_id: input.subject,
    candidate_id: input.candidate,
    target_id: target,
    account_id: input.account,
    property: input.property,
    source_order_key: holderKeys(identity.facts, identity.type).name,
    target_order_key: labelOrderKey(labels),
  });
  const acceptance = await currentAcceptance(tx, input.subject, input.candidate, GLOBAL_CONTEXT);
  await insertAcceptance(
    tx,
    input.subject,
    input.candidate,
    GLOBAL_CONTEXT,
    acceptance?.head ?? null,
    'accept',
    input.revision,
    input.slot,
  );
  const adoption = await latestAdoption(tx, input.subject, input.property, GLOBAL_CONTEXT, input.slot);
  const selection = [
    ...(adoption?.mode === 'replace' ? adoption.selection : []).filter((entry) => entry.candidate !== input.candidate),
    { candidate: input.candidate, rank: 'normal' as const },
  ];
  if (selection.length > 32) throw new SubjectInputError([{ pointer: '/selection', code: 'out_of_range' }]);
  await insertAdoption(
    tx,
    input.subject,
    input.property,
    GLOBAL_CONTEXT,
    adoption?.head ?? null,
    'replace',
    selection,
    input.revision,
    input.slot,
  );
}

export type PrivateLink = {
  route: number;
  subject_id: string;
  candidate_id: string;
  target_id: string;
  property: string;
  slot_id: string;
  statement: unknown;
  release: string;
  revision: number;
  rank: 'normal' | 'preferred';
  source_type: string;
  target_type: string;
  order_key: string;
};
export async function privateLinks(
  client: PoolClient,
  input: {
    subject: string;
    inbound?: boolean;
    property?: string | null;
    crossProperty?: boolean;
    after?: readonly unknown[] | undefined;
    limit: number;
  },
): Promise<{ entries: PrivateLink[]; total: number }> {
  const reader = readers.getStore();
  if (!reader || reader === PUBLIC_READER) return { entries: [], total: 0 };
  const row = await readPrivateLinks.run(client, {
    subject_id: input.subject,
    inbound: input.inbound ?? false,
    property: input.property ?? '',
    cross_property: input.crossProperty ?? false,
    account_id: reader.account,
    moderator: await reader.moderator(client),
    after_order: String(input.after?.[0] ?? ''),
    after_subject: String(input.after?.[1] ?? NIL),
    after_statement: String(input.after?.[2] ?? NIL),
    page_limit: input.limit,
  });
  return { entries: (row?.entries ?? []) as PrivateLink[], total: Number(row?.total ?? 0) };
}

type DisclosureSlot = { subject_id: string; property: string; slot_id: string };
async function disclosureViews(tx: CommandTransaction, slot: DisclosureSlot) {
  const global = (await slotView(tx, slot.subject_id, slot.property, GLOBAL_CONTEXT, {}, slot.slot_id)).facts;
  const contexts = new Map<string, FactRow[]>();
  for (const row of await listRelationContexts.run(tx, {
    route: routeOf(slot.subject_id)!,
    subject_id: slot.subject_id,
    slot_id: slot.slot_id,
  }))
    contexts.set(
      row.context_id,
      (await slotView(tx, slot.subject_id, slot.property, row.context_id, {}, slot.slot_id)).facts,
    );
  return { global, contexts };
}

/** A disclosure changes Global membership and each registered Context's sparse layer together. */
async function disclosureChanges(
  tx: CommandTransaction,
  slot: DisclosureSlot,
  release: Release,
  before: Awaited<ReturnType<typeof disclosureViews>>,
) {
  const after = (await slotView(tx, slot.subject_id, slot.property, GLOBAL_CONTEXT, {}, slot.slot_id)).facts;
  const holder = await holderFacts(tx, slot.subject_id, release);
  const metadata = { subject: slot.subject_id, release, type: holder.type, identityFacts: holder.facts };
  const changes = linkChanges(before.global, after, factDataTypes(release, [...before.global, ...after]), metadata);
  for (const [context, previous] of before.contexts) {
    const selected = (await slotView(tx, slot.subject_id, slot.property, context, {}, slot.slot_id)).facts;
    changes.push(
      ...contextLinkChanges(
        before.global,
        previous,
        selected,
        factDataTypes(release, [...before.global, ...after, ...previous, ...selected]),
        metadata,
        context,
        after,
      ),
    );
  }
  return changes;
}

export class StatementDisclosureDeniedError extends Error {}
export class StatementDisclosureNotFoundError extends Error {}
export class StatementDisclosureConflictError extends Error {}

/** Target-account consent and its terminal retraction share receipt and ownership checks. */
export async function changeStatementDisclosure(
  pool: Pool,
  options: {
    candidate: string;
    retract?: boolean;
    actor: AccountActor;
    idempotencyKey: string;
    digest: Uint8Array;
    authorization: CommandAuthorization;
    deadline: number;
    clock?: () => Date;
  },
) {
  const route = routeOf(options.candidate);
  if (route === null) throw new StatementDisclosureNotFoundError();
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: options.deadline,
      clock: options.clock,
      receipt: {
        actorAccountId: options.actor.accountId,
        kind: options.retract ? 'statement.retract' : 'statement.disclose',
        key: options.idempotencyKey,
        digest: options.digest,
      },
      basis: {
        actorAccountId: options.actor.accountId,
        clientId: options.actor.clientId,
        requestedBy: options.actor.requestedBy,
      },
      authorization: options.authorization,
    },
    async (tx, { transactionId }) => {
      const row = await readDisclosure.run(tx, { route, candidate_id: options.candidate });
      if (!row) throw new StatementDisclosureNotFoundError();
      const agents = await accountAgentsForSubjects(tx, [row.target_id]);
      if (agents.get(row.target_id)?.account !== options.actor.accountId) throw new StatementDisclosureDeniedError();
      const priorRetraction = await readRetraction.run(tx, {
        route,
        subject_id: row.subject_id,
        candidate_id: options.candidate,
      });
      if (priorRetraction && !options.retract) throw new StatementDisclosureConflictError();
      if (options.retract) {
        const revision = priorRetraction?.revision ?? row.latest_revision + 1;
        const events: { type: string; subject: string; data: unknown }[] = [
          {
            type: 'com.rezics.statement.retracted.v1',
            subject: row.subject_id,
            data: { candidate: options.candidate, revision },
          },
        ];
        if (priorRetraction) return { value: { candidate: options.candidate, disclosed: row.disclosed }, events };
        const release = await readRelease(tx, row.release);
        if (!release) throw new Error('Disclosure release is missing');
        const before = await disclosureViews(tx, row);
        await insertRetractRevision.run(tx, {
          route,
          subject_id: row.subject_id,
          revision,
          release: row.release,
          transaction_id: transactionId,
          source: { kind: 'agent', subject: row.target_id },
        });
        await insertRetraction.run(tx, {
          route,
          subject_id: row.subject_id,
          candidate_id: options.candidate,
          revision,
          references: [],
        });
        const visibility = await readVisibility.run(tx, { route, subject_id: row.subject_id });
        const security = await bumpSecurity.run(tx, {
          route,
          subject_id: row.subject_id,
          expected_security_revision: visibility!.securityRevision,
        });
        if (!security) throw new Error('Disclosure state is missing');
        events.push({
          type: 'com.rezics.subject.revised.v1',
          subject: row.subject_id,
          data: { id: row.subject_id, revision, kind: 'retract' },
        });
        const changes = await disclosureChanges(tx, row, release, before);
        if (changes.length)
          events.push({
            type: LINKS_CHANGED,
            subject: row.subject_id,
            data: { subject: row.subject_id, revision, security_revision: Number(security.security_revision), changes },
          });
        return { value: { candidate: options.candidate, disclosed: row.disclosed }, events };
      }
      const before = row.disclosed ? null : await disclosureViews(tx, row);
      const updated = await updateDisclosure.run(tx, { route, candidate_id: options.candidate });
      // Already disclosed is a successful one-way operation, including retries with another receipt.
      const subject = row.subject_id;
      const events = [
        {
          type: 'com.rezics.subject.statement_disclosed.v1',
          subject,
          data: { id: subject, candidate: options.candidate },
        },
      ];
      if (!updated) return { value: { candidate: options.candidate, disclosed: true }, events };
      const visibility = await readVisibility.run(tx, { route, subject_id: subject });
      if (!visibility) throw new StatementDisclosureNotFoundError();
      const security = await bumpSecurity.run(tx, {
        route,
        subject_id: subject,
        expected_security_revision: visibility.securityRevision,
      });
      const release = await readRelease(tx, row.release);
      if (!security || !release) throw new Error('Disclosure state is missing');
      const changes =
        visibility.visibility === 'visible' && before ? await disclosureChanges(tx, row, release, before) : [];
      return {
        value: { candidate: options.candidate, disclosed: true },
        events: changes.length
          ? [
              ...events,
              {
                type: LINKS_CHANGED,
                subject,
                data: {
                  subject,
                  revision: row.latest_revision,
                  security_revision: Number(security.security_revision),
                  changes,
                },
              },
            ]
          : events,
      };
    },
  );
  return {
    ...command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
  };
}
