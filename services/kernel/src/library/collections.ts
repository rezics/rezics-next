import { createCollectionPublicationEpisodes } from './collection-publication-episodes.ts';
import { createBuiltinRuntime } from './builtin-runtime.ts';
import { enterShelfWrite } from './shelf-counter-owner.ts';
import { createShelfCounters } from './shelf-counters.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import pg, { type Pool, type PoolConfig } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { shareAccount } from '../access/account-share.ts';
import { deriveAccess } from '../access/derived-access.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { parentCreationAuthorization } from '../access/parent-creation.ts';
import { initializeResourceGrants } from '../access/resource-initialization.ts';
import { resourceAuthorization, resourceAuthorizationPage } from '../access/resource-authorization.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../access/resource-roles.ts';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  principalCommandIdentity,
  runCommand,
  type CommandAttempt,
  type AuthoritativeTime,
  type CommandEvent,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, AccessCheck, AccessClient, AccountActor, Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type {
  Collection,
  CollectionMember,
  CollectionVisibility,
  MemberPosition,
  MemberReordering,
} from './collection-model.ts';
import type { BulkReason, TerminalOutcome } from './bulk-contract.ts';
import {
  presentationSelection,
  preparePresentationSelection,
  type PresentationSelection,
} from './collection-presentation.ts';
import { CollectionOrderRepairRequired, planCollectionPlacement } from './collection-order-placement.ts';
import { assertCollectionOrderWritable, beginCollectionOrderRepair } from './collection-order.ts';
import {
  deleteMember as deleteMemberRow,
  insertCollection,
  insertMember,
  readMember,
  moveMember as moveMemberRow,
  readCollection,
  readMemberDeletion,
  restoreMember as restoreMemberRow,
  respaceMembers,
  tombstoneCollection,
  restoreCollection as restoreCollectionRow,
  updateCollection as updateCollectionRow,
  updateMemberNote as updateMemberNoteRow,
} from './collection-store.ts';
import { createLibraryCommandRunner, WORK_STEP_DEADLINE_MS } from './command-support.ts';
import { createCollectionBatchCommands } from './collection-batch.ts';
import batchParents from './collection-batch-parents.sql';
import authorizationCollection from './collection-store-collection-authorization.sql';
import restoreWindow from './collection-store-collection-restore-window.sql';
import { resolveSubject } from './subject-anchor.ts';
import { recordPrivacyReduction } from '../semantic/public-filter-source.ts';
import {
  admitCollectionRule,
  authorizeCollectionRule,
  insertSavedCollection,
  parseCollectionRule,
  prepareCollectionRuleAuthority,
  updateSavedCollectionRule,
  type AdmittedCollectionRule,
  type CollectionRule,
} from './collection-rules.ts';

const MAX_MEMBER_COUNT = 2_147_483_647;
const TITLE_LIMIT = 200;
const DESCRIPTION_LIMIT = 2_000;
const NOTE_LIMIT = 1_000;

type CollectionPatch = PresentationSelection & {
  revision: number;
  title?: string;
  description?: string | null;
  visibility?: CollectionVisibility;
};

type MemberDraft = {
  subjectId: string;
  note?: string | null;
  after?: string | null;
};

const writers = new WeakMap<Pool, Pool>();
const creationAccesses = new WeakMap<Access, Access>();

function digest(identity: unknown, kind: string, input: unknown): Buffer {
  const canonical = canonicalize([identity, kind, input]);
  if (typeof canonical !== 'string') throw new TypeError('Command input must be canonical JSON');
  return createHash('sha256').update(canonical).digest();
}

function notFound(): ProblemError {
  return new ProblemError('not_found');
}

function invalid(): ProblemError {
  return new ProblemError('invalid_request');
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function requiredText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.includes('\0') || codePoints(value) < 1 || codePoints(value) > max) {
    throw invalid();
  }
  return value;
}

function optionalText(value: unknown, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.includes('\0') || codePoints(value) > max) throw invalid();
  return value;
}

function visibilityOf(value: unknown): CollectionVisibility {
  if (value !== 'private' && value !== 'unlisted' && value !== 'public') throw invalid();
  return value;
}

function revisionOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}

function collectionRoute(id: unknown): number {
  if (typeof id !== 'string') throw notFound();
  const route = routeOf(id);
  if (route === null) throw notFound();
  return route;
}

function accountActor(actor: Actor): AccountActor {
  if (actor.kind !== 'account') throw notFound();
  return actor;
}

function listed(collection: { state: string; visibility: string }): boolean {
  return collection.state === 'active' && collection.visibility === 'public';
}

function positionOf(after: string | null | undefined): MemberPosition {
  if (after === undefined) return { kind: 'last' };
  if (after === null) return { kind: 'first' };
  collectionRoute(after);
  return { kind: 'after', memberId: after };
}

/** createPool refuses a second checkout while a command holds its connection.
 * Creation proof reads through the caller's pool; the insert uses another pool on the same database.
 */
function writerPool(pool: Pool): Pool {
  const existing = writers.get(pool);
  if (existing) return existing;
  const connectionString = pool.options.connectionString;
  if (!connectionString) throw new Error('Collection commands need a database connection string');
  const writer = new pg.Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
  } as PoolConfig);
  writer.on('error', () => {});
  writers.set(pool, writer);
  return writer;
}

function collectionCreationAccess(access: Access): Access {
  const existing = creationAccesses.get(access);
  if (existing) return existing;
  const wrapped = deriveAccess(access, {
    async authorize(client, actor, action, resource, evidence, time) {
      if (
        action === 'collection:create' &&
        actor.kind === 'account' &&
        actor.scopes.includes('collection:create') &&
        resource.id === actor.accountId &&
        routeOf(actor.accountId) === resource.route
      ) {
        return true;
      }
      return access.authorize(client, actor, action, resource, evidence, time);
    },
  });
  const catalogue = resourceRoleCatalogue(access);
  if (catalogue) installResourceRoleCatalogue(wrapped, catalogue);
  creationAccesses.set(access, wrapped);
  return wrapped;
}

function collectionEvents(kind: 'updated' | 'deleted', collectionId: string, listingChanged: boolean): CommandEvent[] {
  const events: CommandEvent[] = [
    {
      type: `com.rezics.library.collection.${kind}.v1`,
      subject: collectionId,
      data: { collectionId },
    },
  ];
  if (listingChanged) {
    events.push({
      type: 'com.rezics.library.collection.listing.changed.v1',
      subject: collectionId,
      data: { collectionId },
    });
  }
  return events;
}

export async function recordPublicCollectionReduction(
  tx: CommandTransaction,
  route: number,
  collectionId: string,
  transactionId: string,
): Promise<void> {
  await recordPrivacyReduction(tx, {
    partition: partitionOf(route),
    transactionId,
    time: currentCommand(tx).time,
    cause: 'collection',
    affected: [{ kind: 'collection', route, collection: collectionId }],
    impacts: [{ kind: 'dependency', locator: { kind: 'collection', route, collection: collectionId } }],
  });
}

function memberEvent(collectionId: string, memberId: string, subjectId: string): CommandEvent {
  return {
    type: 'com.rezics.library.collection.member.changed.v1',
    subject: collectionId,
    data: { collectionId, memberId, subjectId },
  };
}

function accountAttempt(tx: CommandTransaction): CommandAttempt {
  const live = currentCommand(tx);
  const basis = live.basis;
  if (!basis || !('actorAccountId' in basis) || basis.actorAccountId === null) throw new GrantDeniedError();
  return Object.freeze({
    partition: live.partition,
    basis,
    time: live.time,
    ...(live.commandWork ? { commandWork: live.commandWork } : {}),
  });
}

async function touchCollection(
  tx: CommandTransaction,
  route: number,
  collectionId: string,
  time: string,
  transactionId: string,
  structural = false,
): Promise<void> {
  const updated = await tx.query<{ revision: number }>(
    `UPDATE library.collection
        SET updated_at = $1::timestamptz, transaction_id = $2::uuid,
            revision = revision + $5::integer, source_generation = source_generation + $5::integer
      WHERE route = $3 AND collection_id = $4 AND state = 'active'
      RETURNING revision`,
    [time, transactionId, route, collectionId, Number(structural)],
  );
  if (updated.rows.length !== 1) throw notFound();
}

async function activeCollection(tx: CommandTransaction, route: number, collectionId: string): Promise<Collection> {
  const current = await readCollection(tx, route, collectionId);
  if (!current || current.state !== 'active') throw notFound();
  return current;
}

export type CollectionBulkAddEffect = Readonly<{
  state: TerminalOutcome;
  reason: BulkReason | null;
  resultingMemberId: string | null;
  events: readonly CommandEvent[];
}>;

/** Apply the bulk skip-present variant inside its owning native Collection command. */
export async function addCollectionMemberIfAbsentNative(
  tx: CommandTransaction,
  actor: AccountActor,
  collectionId: string,
  subjectId: string,
  command: { transactionId: string; time: string },
): Promise<CollectionBulkAddEffect> {
  const route = collectionRoute(collectionId);
  const first = await activeCollection(tx, route, collectionId);
  if (first.curatorAccountId === null) throw new GrantDeniedError();
  try {
    await shareAccount(tx, first.curatorAccountId);
  } catch (error) {
    if (error instanceof LifecycleDeniedError) throw new GrantDeniedError();
    throw error;
  }
  await enterShelfWrite({ client: tx, route, accountId: first.curatorAccountId });

  const current = await activeCollection(tx, route, collectionId);
  if (current.curatorAccountId !== first.curatorAccountId) throw new GrantDeniedError();
  if (current.membershipKind !== 'curated' || current.builtinKind !== null)
    return { state: 'failed', reason: 'dependency_unavailable', resultingMemberId: null, events: [] };

  const represented = await tx.query(
    `SELECT 1 FROM library.collection_member
     WHERE route=$1 AND collection_id=$2 AND subject_id=$3 AND deletion_id IS NULL LIMIT 1`,
    [route, collectionId, subjectId],
  );
  if (represented.rows.length > 0) return { state: 'no_effect', reason: null, resultingMemberId: null, events: [] };
  if (current.memberCount >= MAX_MEMBER_COUNT)
    return { state: 'failed', reason: 'collection_full', resultingMemberId: null, events: [] };

  try {
    await assertCollectionOrderWritable(tx, route, collectionId);
  } catch (error) {
    if (error instanceof CollectionOrderRepairRequired)
      return { state: 'failed', reason: 'dependency_unavailable', resultingMemberId: null, events: [] };
    throw error;
  }
  const memberId = newId(route);
  const placed = await placeInCollection(tx, route, collectionId, positionOf(undefined), memberId, false);
  if (placed.respace.length > 0) {
    await tx.query('SET CONSTRAINTS library.collection_member_ordinal_key DEFERRED');
    const epoch = await respaceMembers(tx, route, collectionId, placed.respace, command);
    if (epoch === null) return { state: 'conflict', reason: 'revision_mismatch', resultingMemberId: null, events: [] };
  }
  const value = await insertMember(
    tx,
    route,
    collectionId,
    { id: memberId, subjectId, note: null, ordinalKey: placed.ordinalKey },
    command,
  );
  if (!value) {
    const latest = await readCollection(tx, route, collectionId);
    if (latest && latest.memberCount >= MAX_MEMBER_COUNT)
      return { state: 'failed', reason: 'collection_full', resultingMemberId: null, events: [] };
    throw notFound();
  }
  return {
    state: 'applied',
    reason: null,
    resultingMemberId: value.id,
    events: [memberEvent(collectionId, value.id, value.subjectId)],
  };
}

export function createCollectionCommands(config: {
  pool: Pool;
  access: Access;
  clock?: KernelClock;
  routeKey?: Uint8Array;
}) {
  const { pool, access, clock } = config;
  const owned = createLibraryCommandRunner({ pool: writerPool(pool), ...(clock ? { clock } : {}) });
  const creation = collectionCreationAccess(access);

  return {
    createCollection,
    beginCollectionPublication: createCollectionPublicationEpisodes(config).begin,
    updateCollection,
    updateCollectionRule,
    deleteCollection,
    restoreCollection,
    addMember,
    moveMember,
    updateMemberNote,
    removeMember,
    restoreMember,
    ...createCollectionBatchCommands(config, mutate),
  };

  async function createCollection(
    actor: Actor,
    draft: PresentationSelection & { title: string; description?: string | null; visibility: CollectionVisibility } & (
        | { membershipKind?: 'curated' }
        | { membershipKind: 'dynamic'; rule: unknown }
      ),
    requestKey: string,
  ): Promise<CommandOutcome<Collection>> {
    const title = requiredText(draft.title, TITLE_LIMIT);
    const description = draft.description === undefined ? null : optionalText(draft.description, DESCRIPTION_LIMIT);
    const visibility = visibilityOf(draft.visibility);
    const selection = presentationSelection(draft);
    const rule = draft.membershipKind === 'dynamic' ? parseCollectionRule(draft.rule) : null;
    const input = {
      title,
      description,
      visibility,
      ...selection,
      ...(draft.membershipKind === 'dynamic' ? { membershipKind: 'dynamic', rule: draft.rule } : {}),
    };
    const route = actor.kind === 'account' ? routeOf(actor.accountId) : null;
    const id = route === null ? newId(1) : newId(route);
    let provenance: { transactionId: string; at: string } | null = null;

    return owned.ownAccountPrepared(
      actor,
      {
        action: 'collection:create',
        kind: 'library.collection.create',
        requestKey,
        input,
        async prepare(attempt) {
          const failure = await preparePresentationSelection(
            config,
            actor,
            selection,
            deadlineFor(WORK_STEP_DEADLINE_MS),
          );
          const admitted = rule ? await admitCollectionRule(pool, rule) : null;
          const checks =
            admitted && actor.kind === 'account'
              ? await prepareCollectionRuleAuthority(
                  config,
                  actor,
                  admitted.filter,
                  attempt,
                  deadlineFor(WORK_STEP_DEADLINE_MS),
                )
              : [];
          return { failure, admitted, checks };
        },
      },
      async (tx, command, prepared) => {
        if (actor.kind !== 'account' || route === null) throw new GrantDeniedError();
        if (prepared.failure) throw prepared.failure;
        provenance = null;
        const resource = Object.freeze({ route, id });
        const authorization = parentCreationAuthorization({
          access: creation,
          actor,
          action: 'collection:create',
          parent: {
            resource: Object.freeze({ route, id: actor.accountId }),
            async validate(client, time) {
              authoritativeTimeValue(time);
              const account = await readAccount(client, route, actor.accountId);
              return account !== null && account.kind === 'actor' && account.state === 'active' && !account.fenced;
            },
          },
          context: {
            pool,
            deadline: deadlineFor(WORK_STEP_DEADLINE_MS),
            resource,
            creation: {
              async validate(inner, target, time) {
                if (!provenance || target.route !== route || target.id !== id) return false;
                authoritativeTimeValue(time);
                const found = await inner.query(
                  `SELECT 1
                     FROM library.collection
                    WHERE route = $1 AND collection_id = $2 AND curator_account_id = $3
                      AND revision = 1 AND state = 'active'
                      AND transaction_id = $4 AND created_at = $5::timestamptz
                      AND xmin = pg_current_xact_id()::xid`,
                  [route, id, actor.accountId, provenance.transactionId, provenance.at],
                );
                return found.rows.length === 1;
              },
            },
          },
        });
        const attempt = accountAttempt(tx);
        const proof = await authorization.prepare!(attempt);
        if ((await authorization.authorize(tx, attempt, proof)) !== 'execute') throw new GrantDeniedError();
        const shelfWrite = { client: tx, route, accountId: actor.accountId };
        await enterShelfWrite(shelfWrite);
        const at = authoritativeTimeValue(command.time);
        const collectionDraft = { id, curatorAccountId: actor.accountId, title, description, visibility, ...selection };
        const context = { transactionId: command.transactionId, time: at };
        let value: Collection;
        if (prepared.admitted) {
          await insertSavedCollection(tx, route, collectionDraft, prepared.admitted, context);
          value = await activeCollection(tx, route, id);
        } else value = await insertCollection(tx, route, collectionDraft, context);
        await createShelfCounters().collection(shelfWrite, 1);
        provenance = { transactionId: command.transactionId, at };
        await initializeResourceGrants(tx, { resource, type: 'library.collection', creator: actor.accountId });
        await authorization.finalize!(tx, attempt, proof);
        return { value, events: collectionEvents('updated', id, visibility === 'public') };
      },
      async (tx, attempt, prepared) => {
        if (!prepared.admitted) return;
        await authorizeCollectionRule(tx, attempt, prepared.checks);
        // A create stores a private definition. Public metadata/membership needs explicit publication.
        if (visibility !== 'private') throw new ProblemError('dependency_unavailable');
      },
    );
  }

  async function mutate<T>(
    actor: Actor,
    collectionId: string,
    action: 'collection:update' | 'collection:delete',
    kind: string,
    requestKey: string,
    input: unknown,
    body: (
      tx: CommandTransaction,
      command: { transactionId: string; time: string; rule?: AdmittedCollectionRule },
      route: number,
    ) => Promise<{ value: T; events: readonly CommandEvent[] }>,
    destinationCollectionId?: string,
    prepareMembers?: (time: AuthoritativeTime) => Promise<void>,
    selection?: PresentationSelection,
    rule?: CollectionRule,
    allowDeleted = false,
  ): Promise<CommandOutcome<T>> {
    const route = collectionRoute(collectionId);
    const owner = accountActor(actor);
    if (
      owner.scopes.includes(action) &&
      (kind.startsWith('library.collection.member') ||
        kind === 'library.collection.delete' ||
        kind === 'library.collection.rule.update')
    ) {
      const builtins = createBuiltinRuntime({ pool });
      if (await builtins.read(owner, collectionId, action))
        throw new ProblemError(kind === 'library.collection.delete' ? 'conflict' : 'dynamic_membership_immutable');
      if (destinationCollectionId && (await builtins.read(owner, destinationCollectionId, action)))
        throw new ProblemError('dynamic_membership_immutable');
    }
    const identity = principalCommandIdentity(owner);
    const normalAccess = destinationCollectionId
      ? resourceAuthorizationPage({
          access,
          actor: owner,
          action,
          anchor: {
            route,
            resourceType: 'library.collection',
            ids: Object.freeze([collectionId, destinationCollectionId].sort()),
            async validate(client, time) {
              authoritativeTimeValue(time);
              const rows = await batchParents.run(client, { route, ids: [collectionId, destinationCollectionId] });
              if (rows.length !== 2 || rows.some((row) => row.state !== 'active')) throw notFound();
              if (rows.some((row) => row.membershipKind !== 'curated'))
                throw new ProblemError('dynamic_membership_immutable');
              if (rows[0]!.curatorAccountId !== rows[1]!.curatorAccountId)
                throw new ProblemError('collection_move_unsupported');
              return true;
            },
          },
          context: { pool, deadline: deadlineFor(WORK_STEP_DEADLINE_MS), partition: partitionOf(route) },
        })
      : resourceAuthorization({
          access,
          actor: owner,
          action,
          anchor: {
            resource: { route, id: collectionId },
            validate: async (client, time) =>
              !!(await authorizedCollection(client, owner, route, collectionId, time, allowDeleted)),
          },
          context: { pool, deadline: deadlineFor(WORK_STEP_DEADLINE_MS), partition: partitionOf(route) },
        });
    const failures = new WeakMap<object, ProblemError | null>();
    const rules = new WeakMap<AuthoritativeTime, { rule: AdmittedCollectionRule; checks: readonly AccessCheck[] }>();
    const authorization: typeof normalAccess = {
      ...normalAccess,
      async prepare(attempt) {
        const proof = await normalAccess.prepare!(attempt);
        if (selection)
          failures.set(
            attempt.time,
            await preparePresentationSelection(config, owner, selection, deadlineFor(WORK_STEP_DEADLINE_MS)),
          );
        try {
          await prepareMembers?.(attempt.time);
          if (rule) {
            const admitted = await admitCollectionRule(pool, rule);
            rules.set(attempt.time, {
              rule: admitted,
              checks: await prepareCollectionRuleAuthority(
                config,
                owner,
                admitted.filter,
                attempt,
                deadlineFor(WORK_STEP_DEADLINE_MS),
              ),
            });
          }
        } catch (error) {
          if (!(error instanceof ProblemError)) throw error;
          failures.set(attempt.time, error);
        }
        return proof;
      },
      async authorize(tx, attempt, proof) {
        const mode = await normalAccess.authorize(tx, attempt, proof);
        const collection = await authorizedCollection(tx, owner, route, collectionId, attempt.time, allowDeleted);
        if (
          (kind.startsWith('library.collection.member') || kind === 'library.collection.order.repair.begin') &&
          collection.membershipKind === 'dynamic'
        )
          throw new ProblemError('dynamic_membership_immutable');
        if (rule) {
          if (collection.membershipKind !== 'dynamic' || collection.builtinKind != null || !collection.hasSavedRule)
            throw new ProblemError('dynamic_membership_immutable');
          if (collection.curatorAccountId !== owner.accountId) throw new GrantDeniedError();
          const failure = failures.get(attempt.time);
          if (failure) throw failure;
          const prepared = rules.get(attempt.time);
          if (!prepared) throw new Error('Missing native Collection rule preparation');
          await authorizeCollectionRule(tx, attempt, prepared.checks);
        }
        try {
          // Keep the immutable curator live through commit, including receipt replay.
          if (collection.curatorAccountId === null) throw new GrantDeniedError();
          await shareAccount(tx, collection.curatorAccountId);
        } catch (error) {
          if (error instanceof LifecycleDeniedError) throw new GrantDeniedError();
          throw error;
        }
        return mode;
      },
    };
    try {
      return await runCommand(
        pool,
        {
          ...identity,
          partition: partitionOf(route),
          deadline: deadlineFor(WORK_STEP_DEADLINE_MS),
          ...(clock ? { clock } : {}),
          receipt: { kind, key: requestKey, digest: digest(identity, kind, input) },
          authorization,
        },
        async (tx, command) => {
          const current = await authorizedCollection(tx, owner, route, collectionId, command.time, allowDeleted);
          if (current.curatorAccountId === null) throw new GrantDeniedError();
          await enterShelfWrite({ client: tx, route, accountId: current.curatorAccountId });
          const failure = failures.get(command.time);
          if (failure) throw failure;
          if (kind !== 'library.collection.order.repair.begin' && kind !== 'library.collection.delete') {
            for (const id of [
              ...new Set([collectionId, ...(destinationCollectionId ? [destinationCollectionId] : [])]),
            ].sort())
              await assertCollectionOrderWritable(tx, route, id);
          }
          return body(
            tx,
            {
              transactionId: command.transactionId,
              time: authoritativeTimeValue(command.time),
              ...(rules.get(command.time) ? { rule: rules.get(command.time)!.rule } : {}),
            },
            route,
          );
        },
      );
    } catch (error) {
      if (!(error instanceof CollectionOrderRepairRequired)) throw error;
      const repairKind = 'library.collection.order.repair.begin';
      // Keep admission separate from the failed mutation, including its receipt
      // namespace and authoritative authorization time. No Actor is retained.
      const repairKey = digest(identity, repairKind, { requestKey, kind, input, fence: error.fence }).toString('hex');
      await mutate(
        actor,
        error.collectionId,
        'collection:update',
        repairKind,
        repairKey,
        { collectionId: error.collectionId, originalKind: kind, originalKey: requestKey, fence: error.fence },
        async (tx, _command, repairRoute) => beginCollectionOrderRepair(tx, repairRoute, error.collectionId),
      );
      throw new ProblemError('dependency_unavailable');
    }
  }

  async function updateCollectionRule(
    actor: Actor,
    id: string,
    input: { revision: number; filter: unknown; sort?: string },
    requestKey: string,
  ): Promise<CommandOutcome<Collection>> {
    const revision = input.revision === 0 ? 0 : revisionOf(input.revision);
    const rule = parseCollectionRule({
      filter: input.filter,
      ...(input.sort === undefined ? {} : { sort: input.sort }),
    });
    return mutate(
      actor,
      id,
      'collection:update',
      'library.collection.rule.update',
      requestKey,
      { collectionId: id, revision, filter: input.filter, ...(input.sort === undefined ? {} : { sort: input.sort }) },
      async (tx, command, route) => {
        if (!command.rule) throw new Error('Missing admitted Collection rule');
        const previous = await activeCollection(tx, route, id);
        await updateSavedCollectionRule(tx, route, id, revision, command.rule, command);
        const updated = await activeCollection(tx, route, id);
        if (listed(previous) && listed(updated))
          await recordPublicCollectionReduction(tx, route, id, command.transactionId);
        return { value: updated, events: collectionEvents('updated', id, false) };
      },
      undefined,
      undefined,
      undefined,
      rule,
    );
  }

  async function updateCollection(
    actor: Actor,
    id: string,
    patch: CollectionPatch,
    requestKey: string,
  ): Promise<CommandOutcome<Collection>> {
    const selection = presentationSelection(patch);
    const revision = revisionOf(patch.revision);
    const title = patch.title === undefined ? undefined : requiredText(patch.title, TITLE_LIMIT);
    const description =
      patch.description === undefined ? undefined : optionalText(patch.description, DESCRIPTION_LIMIT);
    const visibility = patch.visibility === undefined ? undefined : visibilityOf(patch.visibility);
    const input = {
      id,
      revision,
      title: title ?? null,
      description: description ?? null,
      visibility: visibility ?? null,
      ...selection,
      present: {
        title: title !== undefined,
        description: description !== undefined,
        visibility: visibility !== undefined,
      },
    };
    return mutate(
      actor,
      id,
      'collection:update',
      'library.collection.update',
      requestKey,
      input,
      async (tx, command, route) => {
        const current = await activeCollection(tx, route, id);
        if (current.revision !== revision) throw new ProblemError('conflict');
        const wasListed = listed(current);
        const value = await updateCollectionRow(
          tx,
          route,
          id,
          revision,
          {
            title: title ?? current.title,
            description: description === undefined ? current.description : description,
            visibility: visibility ?? current.visibility,
            presentationKind:
              selection.presentationKind === undefined ? current.presentationKind : selection.presentationKind,
            coverMediaId: selection.coverMediaId === undefined ? current.coverMediaId : selection.coverMediaId,
          },
          command,
        );
        if (!value) throw new ProblemError('conflict');
        if (wasListed && !listed(value)) await recordPublicCollectionReduction(tx, route, id, command.transactionId);
        return {
          value: current.membershipKind === 'dynamic' ? await activeCollection(tx, route, id) : value,
          events: collectionEvents('updated', id, wasListed !== listed(value)),
        };
      },
      undefined,
      undefined,
      selection,
    );
  }

  async function deleteCollection(
    actor: Actor,
    id: string,
    revision: number,
    requestKey: string,
  ): Promise<CommandOutcome<Collection & { deletionId: string }>> {
    const expected = revisionOf(revision);
    return mutate(
      actor,
      id,
      'collection:delete',
      'library.collection.delete',
      requestKey,
      { id, revision: expected },
      async (tx, command, route) => {
        const ownerRow = await readCollection(tx, route, id);
        if (!ownerRow?.curatorAccountId) throw notFound();
        const shelfWrite = { client: tx, route, accountId: ownerRow.curatorAccountId };
        await enterShelfWrite(shelfWrite);
        const current = await activeCollection(tx, route, id);
        if (current.revision !== expected) throw new ProblemError('conflict');
        const value = await tombstoneCollection(tx, route, id, command);
        if (!value) throw notFound();
        if (listed(current)) await recordPublicCollectionReduction(tx, route, id, command.transactionId);
        await createShelfCounters().collection(shelfWrite, -1);
        return {
          value: { ...value, deletionId: command.transactionId },
          events: collectionEvents('deleted', id, listed(current)),
        };
      },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
  }

  async function restoreCollection(
    actor: Actor,
    id: string,
    input: { deletionId: string; revision: number },
    requestKey: string,
  ): Promise<CommandOutcome<Collection>> {
    const expected = revisionOf(input.revision);
    if (
      typeof input.deletionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.deletionId)
    )
      throw invalid();
    return mutate(
      actor,
      id,
      'collection:update',
      'library.collection.restore',
      requestKey,
      { id, deletionId: input.deletionId, revision: expected },
      async (tx, command, route) => {
        const current = await restoreWindow.run(tx, { route, id, time: command.time });
        if (!current) throw notFound();
        if (!current.deleted) throw new ProblemError('collection_restore_occupied');
        if (current.revision !== expected || current.deletionId !== input.deletionId)
          throw new ProblemError('collection_restore_stale');
        if (current.expired) throw new ProblemError('collection_restore_expired');
        const value = await restoreCollectionRow(tx, route, id, expected, input.deletionId, command);
        if (!value) throw new ProblemError('collection_restore_stale');
        await createShelfCounters().collection({ client: tx, route, accountId: value.curatorAccountId! }, 1);
        return { value, events: collectionEvents('updated', id, value.visibility === 'public') };
      },
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
  }

  async function addMember(
    actor: Actor,
    collectionId: string,
    draft: MemberDraft,
    requestKey: string,
  ): Promise<CommandOutcome<CollectionMember>> {
    const note = draft.note === undefined ? null : optionalText(draft.note, NOTE_LIMIT);
    const position = positionOf(draft.after);
    const route = collectionRoute(collectionId);
    const owner = accountActor(actor);
    if (typeof draft.subjectId !== 'string') throw notFound();
    // Collection authorization and the subject anchor are independent reads.
    // Start the subject read before the command so both finish inside the actor's observation.
    const subjectPromise = resolveSubject({ pool, access, ...(clock ? { clock } : {}) }, owner, draft.subjectId);
    const input = {
      collectionId,
      subjectId: draft.subjectId,
      note,
      after: draft.after ?? null,
      position: position.kind,
    };
    return mutate(
      owner,
      collectionId,
      'collection:update',
      'library.collection.member.add',
      requestKey,
      input,
      async (tx, command) => {
        const current = await activeCollection(tx, route, collectionId);
        if (current.memberCount >= MAX_MEMBER_COUNT) throw new ProblemError('collection_full');
        const memberId = newId(route);
        const placed = await placeInCollection(tx, route, collectionId, position, memberId, false);
        const subject = await subjectPromise;
        if (!subject || (subject.subjectId !== draft.subjectId && subject.requestedSubjectId !== draft.subjectId))
          throw notFound();
        if (placed.respace.length > 0) {
          await tx.query('SET CONSTRAINTS library.collection_member_ordinal_key DEFERRED');
          const epoch = await respaceMembers(tx, route, collectionId, placed.respace, command);
          if (epoch === null) throw new ProblemError('conflict');
        }
        const value = await insertMember(
          tx,
          route,
          collectionId,
          { id: memberId, subjectId: subject.subjectId, note, ordinalKey: placed.ordinalKey },
          command,
        );
        if (!value) {
          const again = await readCollection(tx, route, collectionId);
          if (again && again.memberCount >= MAX_MEMBER_COUNT) throw new ProblemError('collection_full');
          throw notFound();
        }
        return { value, events: [memberEvent(collectionId, value.id, value.subjectId)] };
      },
    );
  }

  async function moveMember(
    actor: Actor,
    collectionId: string,
    memberId: string,
    move: { after?: string | null },
    requestKey: string,
  ): Promise<CommandOutcome<CollectionMember>> {
    collectionRoute(memberId);
    const position = positionOf(move.after);
    const route = collectionRoute(collectionId);
    return mutate(
      actor,
      collectionId,
      'collection:update',
      'library.collection.member.move',
      requestKey,
      { collectionId, memberId, ...(move.after === undefined ? {} : { after: move.after }) },
      async (tx, command) => {
        await activeCollection(tx, route, collectionId);
        const placed = await placeInCollection(tx, route, collectionId, position, memberId, true);
        if (placed.respace.length > 0) {
          await tx.query('SET CONSTRAINTS library.collection_member_ordinal_key DEFERRED');
          const epoch = await respaceMembers(tx, route, collectionId, placed.respace, command);
          if (epoch === null) throw new ProblemError('conflict');
        }
        const value = await moveMemberRow(tx, route, collectionId, memberId, placed.ordinalKey, command);
        if (!value) throw notFound();
        await touchCollection(tx, route, collectionId, command.time, command.transactionId, true);
        return { value, events: [memberEvent(collectionId, value.id, value.subjectId)] };
      },
    );
  }

  async function updateMemberNote(
    actor: Actor,
    collectionId: string,
    memberId: string,
    change: { note: string | null },
    requestKey: string,
  ): Promise<CommandOutcome<CollectionMember>> {
    collectionRoute(memberId);
    const note = optionalText(change.note, NOTE_LIMIT);
    const route = collectionRoute(collectionId);
    return mutate(
      actor,
      collectionId,
      'collection:update',
      'library.collection.member.note',
      requestKey,
      { collectionId, memberId, note },
      async (tx, command) => {
        await activeCollection(tx, route, collectionId);
        const value = await updateMemberNoteRow(tx, route, collectionId, memberId, note, command);
        if (!value) throw notFound();
        await touchCollection(tx, route, collectionId, command.time, command.transactionId);
        return { value, events: [memberEvent(collectionId, value.id, value.subjectId)] };
      },
    );
  }

  async function removeMember(
    actor: Actor,
    collectionId: string,
    memberId: string,
    revisionOrKey: number | string,
    maybeRequestKey?: string,
  ): Promise<CommandOutcome<CollectionMember & { deletionId: string; revision: number }>> {
    collectionRoute(memberId);
    const route = collectionRoute(collectionId);
    const requestKey = typeof revisionOrKey === 'string' ? revisionOrKey : maybeRequestKey;
    if (!requestKey) throw invalid();
    const expectedRevision =
      typeof revisionOrKey === 'number'
        ? revisionOf(revisionOrKey)
        : (await readCollection(pool, route, collectionId))?.revision;
    if (!expectedRevision) throw notFound();
    const deletionId = newId(route);
    return mutate(
      actor,
      collectionId,
      'collection:update',
      'library.collection.member.remove',
      requestKey,
      { collectionId, memberId, revision: expectedRevision },
      async (tx, command) => {
        const current = await activeCollection(tx, route, collectionId);
        if (current.revision !== expectedRevision) throw new ProblemError('conflict');
        const value = await deleteMemberRow(tx, route, collectionId, memberId, expectedRevision, deletionId, command);
        if (!value) throw new ProblemError('conflict');
        if (listed(current)) await recordPublicCollectionReduction(tx, route, collectionId, command.transactionId);
        return { value, events: [memberEvent(collectionId, value.id, value.subjectId)] };
      },
    );
  }

  async function restoreMember(
    actor: Actor,
    collectionId: string,
    memberId: string,
    deletion: { deletionId: string; revision: number },
    requestKey: string,
  ): Promise<CommandOutcome<CollectionMember>> {
    collectionRoute(memberId);
    const route = collectionRoute(collectionId);
    if (typeof deletion?.deletionId !== 'string') throw invalid();
    const expectedRevision = revisionOf(deletion.revision);
    let readableOriginal: string | null = null;
    return mutate(
      actor,
      collectionId,
      'collection:update',
      'library.collection.member.restore',
      requestKey,
      { collectionId, memberId, deletionId: deletion.deletionId, revision: expectedRevision },
      async (tx, command) => {
        const parent = await activeCollection(tx, route, collectionId);
        const saved = await readMemberDeletion(tx, route, collectionId, memberId);
        if (!saved || saved.deletionId !== deletion.deletionId) throw notFound();
        if (!saved.purgeAfter || Date.parse(saved.purgeAfter) <= Date.parse(command.time))
          throw new ProblemError('member_restore_expired');
        if (saved.deletionRevision !== BigInt(expectedRevision)) throw new ProblemError('member_restore_stale');
        if (readableOriginal !== saved.subjectId) throw notFound();
        if (parent.memberCount >= MAX_MEMBER_COUNT) throw new ProblemError('collection_full');
        const collision = await tx.query(
          `SELECT 1 FROM library.collection_member
            WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL AND ordinal_key=$3 AND member_id<>$4 LIMIT 1`,
          [route, collectionId, saved.ordinalKey, memberId],
        );
        if (collision.rows.length) throw new ProblemError('member_restore_occupied');
        const value = await restoreMemberRow(
          tx,
          route,
          collectionId,
          memberId,
          deletion.deletionId,
          expectedRevision,
          command,
        );
        if (!value) throw new ProblemError('member_restore_stale');
        return { value, events: [memberEvent(collectionId, value.id, value.subjectId)] };
      },
      undefined,
      async (time) => {
        const saved = await readMemberDeletion(pool, route, collectionId, memberId);
        if (!saved || saved.deletionId !== deletion.deletionId) return;
        const subject = await resolveSubject(
          { pool, access, ...(clock ? { clock } : {}) },
          accountActor(actor),
          saved.subjectId,
          time,
        );
        readableOriginal =
          subject && (subject.subjectId === saved.subjectId || subject.requestedSubjectId === saved.subjectId)
            ? saved.subjectId
            : null;
      },
    );
  }
}

async function authorizedCollection(
  client: AccessClient,
  actor: AccountActor,
  route: number,
  collectionId: string,
  time: Parameters<typeof authoritativeTimeValue>[0],
  allowDeleted: boolean,
): Promise<NonNullable<Awaited<ReturnType<typeof authorizationCollection.run>>>> {
  authoritativeTimeValue(time);
  const current = await authorizationCollection.run(client, { route, collection_id: collectionId });
  if (!current || (!allowDeleted && current.state === 'deleted')) throw notFound();
  if (allowDeleted && current.visibility === 'private' && actor.accountId !== current.curatorAccountId)
    throw notFound();
  return current;
}

async function readMemberOn(
  tx: CommandTransaction,
  route: number,
  collectionId: string,
  memberId: string,
): Promise<CollectionMember> {
  const member = await readMember(tx, route, collectionId, memberId);
  if (!member) throw notFound();
  return member;
}

async function placeInCollection(
  tx: CommandTransaction,
  route: number,
  collectionId: string,
  position: MemberPosition,
  memberId: string,
  moving: boolean,
): Promise<{ ordinalKey: string; respace: readonly MemberReordering[] }> {
  if (moving) {
    const current = await readMemberOn(tx, route, collectionId, memberId);
    if (position.kind === 'after' && position.memberId === memberId)
      return { ordinalKey: current.ordinalKey, respace: [] };
  }
  const plan = await planCollectionPlacement(tx, route, collectionId, position, [memberId], moving ? [memberId] : []);
  return { ordinalKey: plan.keys[0]!, respace: plan.members };
}
