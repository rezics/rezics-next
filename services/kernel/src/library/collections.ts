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
import { resourceAuthorization } from '../access/resource-authorization.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../access/resource-roles.ts';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  principalCommandIdentity,
  runCommand,
  type CommandAttempt,
  type CommandEvent,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, AccessClient, AccountActor, Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type {
  Collection,
  CollectionMember,
  CollectionVisibility,
  MemberPosition,
  MemberReordering,
} from './collection-model.ts';
import { placeMember } from './collection-placement.ts';
import {
  deleteMember as deleteMemberRow,
  insertCollection,
  insertMember,
  listMembers,
  memberNeighbors,
  moveMember as moveMemberRow,
  readCollection,
  readMemberDeletion,
  restoreMember as restoreMemberRow,
  respaceMembers,
  tombstoneCollection,
  updateCollection as updateCollectionRow,
  updateMemberNote as updateMemberNoteRow,
} from './collection-store.ts';
import { createLibraryCommandRunner, WORK_STEP_DEADLINE_MS } from './command-support.ts';
import { resolveSubject } from './subject-anchor.ts';

const MEMBER_LIMIT = 5_000;
const TITLE_LIMIT = 200;
const DESCRIPTION_LIMIT = 2_000;
const NOTE_LIMIT = 1_000;

type CollectionPatch = {
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

function insertionIndex(memberIds: readonly string[], movingId: string | null, position: MemberPosition): number {
  const resting = movingId === null ? memberIds : memberIds.filter((id) => id !== movingId);
  if (position.kind === 'first') return 0;
  if (position.kind === 'last') return resting.length;
  if (movingId !== null && position.memberId === movingId) {
    const current = memberIds.indexOf(movingId);
    if (current < 0) throw notFound();
    return current;
  }
  const anchor = resting.indexOf(position.memberId);
  if (anchor < 0) throw notFound();
  return anchor + 1;
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
  return Object.freeze({ partition: live.partition, basis, time: live.time });
}

async function touchCollection(
  tx: CommandTransaction,
  route: number,
  collectionId: string,
  time: string,
  transactionId: string,
): Promise<void> {
  const updated = await tx.query<{ revision: number }>(
    `UPDATE library.collection
        SET updated_at = $1::timestamptz, transaction_id = $2::uuid
      WHERE route = $3 AND collection_id = $4 AND state = 'active'
      RETURNING revision`,
    [time, transactionId, route, collectionId],
  );
  if (updated.rows.length !== 1) throw notFound();
}

async function activeCollection(tx: CommandTransaction, route: number, collectionId: string): Promise<Collection> {
  const current = await readCollection(tx, route, collectionId);
  if (!current || current.state !== 'active') throw notFound();
  return current;
}

export function createCollectionCommands(config: { pool: Pool; access: Access; clock?: KernelClock }) {
  const { pool, access, clock } = config;
  const owned = createLibraryCommandRunner({ pool: writerPool(pool), ...(clock ? { clock } : {}) });
  const creation = collectionCreationAccess(access);

  return {
    createCollection,
    updateCollection,
    deleteCollection,
    addMember,
    moveMember,
    updateMemberNote,
    removeMember,
    restoreMember,
  };

  async function createCollection(
    actor: Actor,
    draft: { title: string; description?: string | null; visibility: CollectionVisibility },
    requestKey: string,
  ): Promise<CommandOutcome<Collection>> {
    const title = requiredText(draft.title, TITLE_LIMIT);
    const description = draft.description === undefined ? null : optionalText(draft.description, DESCRIPTION_LIMIT);
    const visibility = visibilityOf(draft.visibility);
    const input = { title, description, visibility };
    const route = actor.kind === 'account' ? routeOf(actor.accountId) : null;
    const id = route === null ? newId(1) : newId(route);
    let provenance: { transactionId: string; at: string } | null = null;

    return owned.ownAccount(
      actor,
      { action: 'collection:create', kind: 'library.collection.create', requestKey, input },
      async (tx, command) => {
        if (actor.kind !== 'account' || route === null) throw new GrantDeniedError();
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
        const at = authoritativeTimeValue(command.time);
        const value = await insertCollection(
          tx,
          route,
          { id, curatorAccountId: actor.accountId, title, description, visibility },
          { transactionId: command.transactionId, time: at },
        );
        provenance = { transactionId: command.transactionId, at };
        await initializeResourceGrants(tx, { resource, type: 'library.collection', creator: actor.accountId });
        await authorization.finalize!(tx, attempt, proof);
        return { value, events: collectionEvents('updated', id, visibility === 'public') };
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
      command: { transactionId: string; time: string },
      route: number,
    ) => Promise<{ value: T; events: CommandEvent[] }>,
  ): Promise<CommandOutcome<T>> {
    const route = collectionRoute(collectionId);
    const owner = accountActor(actor);
    const identity = principalCommandIdentity(owner);
    const normalAccess = resourceAuthorization({
      access,
      actor: owner,
      action,
      anchor: {
        resource: { route, id: collectionId },
        validate: async (client, time) => !!(await visibleCollection(client, owner, route, collectionId, time)),
      },
      context: { pool, deadline: deadlineFor(WORK_STEP_DEADLINE_MS), partition: partitionOf(route) },
    });
    const authorization: typeof normalAccess = {
      ...normalAccess,
      async authorize(tx, attempt, proof) {
        const mode = await normalAccess.authorize(tx, attempt, proof);
        const collection = await visibleCollection(tx, owner, route, collectionId, attempt.time);
        try {
          // Keep the immutable curator live through commit, including receipt replay.
          await shareAccount(tx, collection.curatorAccountId);
        } catch (error) {
          if (error instanceof LifecycleDeniedError) throw new GrantDeniedError();
          throw error;
        }
        return mode;
      },
    };
    return runCommand(
      pool,
      {
        ...identity,
        partition: partitionOf(route),
        deadline: deadlineFor(WORK_STEP_DEADLINE_MS),
        ...(clock ? { clock } : {}),
        receipt: { kind, key: requestKey, digest: digest(identity, kind, input) },
        authorization,
      },
      async (tx, command) =>
        body(tx, { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) }, route),
    );
  }

  async function updateCollection(
    actor: Actor,
    id: string,
    patch: CollectionPatch,
    requestKey: string,
  ): Promise<CommandOutcome<Collection>> {
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
          },
          command,
        );
        if (!value) throw new ProblemError('conflict');
        return { value, events: collectionEvents('updated', id, wasListed !== listed(value)) };
      },
    );
  }

  async function deleteCollection(
    actor: Actor,
    id: string,
    revision: number,
    requestKey: string,
  ): Promise<CommandOutcome<Collection>> {
    const expected = revisionOf(revision);
    return mutate(
      actor,
      id,
      'collection:delete',
      'library.collection.delete',
      requestKey,
      { id, revision: expected },
      async (tx, command, route) => {
        const current = await activeCollection(tx, route, id);
        if (current.revision !== expected) throw new ProblemError('conflict');
        const value = await tombstoneCollection(tx, route, id, command);
        if (!value) throw notFound();
        return { value, events: collectionEvents('deleted', id, listed(current)) };
      },
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
        if (current.memberCount >= MEMBER_LIMIT) throw new ProblemError('collection_full');
        const memberId = newId(route);
        const placed = await placeInCollection(tx, route, collectionId, position, memberId, false);
        const subject = await subjectPromise;
        if (!subject || (subject.subjectId !== draft.subjectId && subject.requestedSubjectId !== draft.subjectId))
          throw notFound();
        if (placed.respace.length > 0) {
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
          if (again && again.memberCount >= MEMBER_LIMIT) throw new ProblemError('collection_full');
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
    move: { after: string | null },
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
      { collectionId, memberId, after: move.after },
      async (tx, command) => {
        await activeCollection(tx, route, collectionId);
        const placed = await placeInCollection(tx, route, collectionId, position, memberId, true);
        if (placed.respace.length > 0) {
          const epoch = await respaceMembers(tx, route, collectionId, placed.respace, command);
          if (epoch === null) throw new ProblemError('conflict');
          const value = await readMemberOn(tx, route, collectionId, memberId);
          return { value, events: [memberEvent(collectionId, value.id, value.subjectId)] };
        }
        const value = await moveMemberRow(tx, route, collectionId, memberId, placed.ordinalKey, command);
        if (!value) throw notFound();
        await touchCollection(tx, route, collectionId, command.time, command.transactionId);
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
    const expectedRevision = typeof revisionOrKey === 'number'
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
    return mutate(
      actor,
      collectionId,
      'collection:update',
      'library.collection.member.restore',
      requestKey,
      { collectionId, memberId, deletionId: deletion.deletionId, revision: expectedRevision },
      async (tx, command) => {
        await activeCollection(tx, route, collectionId);
        const saved = await readMemberDeletion(tx, route, collectionId, memberId);
        if (!saved || saved.deletionId !== deletion.deletionId) throw notFound();
        if (saved.deletionRevision !== expectedRevision) throw new ProblemError('member_restore_stale');
        if (!saved.purgeAfter || Date.parse(saved.purgeAfter) <= Date.parse(command.time))
          throw new ProblemError('member_restore_expired');
        const collision = await tx.query(
          `SELECT 1 FROM library.collection_member
            WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL AND ordinal_key=$3 AND member_id<>$4 LIMIT 1`,
          [route, collectionId, saved.ordinalKey, memberId],
        );
        if (collision.rows.length) throw new ProblemError('member_restore_occupied');
        const subject = await resolveSubject(
          { pool, access, ...(clock ? { clock } : {}) },
          accountActor(actor),
          saved.subjectId,
        );
        if (!subject || (subject.subjectId !== saved.subjectId && subject.requestedSubjectId !== saved.subjectId))
          throw notFound();
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
    );
  }
}

async function visibleCollection(
  client: AccessClient,
  actor: AccountActor,
  route: number,
  collectionId: string,
  time: Parameters<typeof authoritativeTimeValue>[0],
): Promise<Collection> {
  authoritativeTimeValue(time);
  const current = await readCollection(client, route, collectionId);
  if (!current || current.state === 'deleted') throw notFound();
  if (current.visibility === 'private' && actor.accountId !== current.curatorAccountId) throw notFound();
  return current;
}

async function readMemberOn(
  tx: CommandTransaction,
  route: number,
  collectionId: string,
  memberId: string,
): Promise<CollectionMember> {
  const members = await listMembers(tx, route, collectionId, { after: null, limit: MEMBER_LIMIT });
  const member = members.find((item) => item.id === memberId);
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
  const neighbors = await memberNeighbors(tx, route, collectionId, position);
  if (!neighbors) throw notFound();
  const direct = placeMember(neighbors);
  if (direct.kind === 'key') return { ordinalKey: direct.ordinalKey, respace: [] };
  const existing = await listMembers(tx, route, collectionId, { after: null, limit: MEMBER_LIMIT });
  const memberIds = existing.map((member) => member.id);
  if (moving && !memberIds.includes(memberId)) throw notFound();
  const orderedMemberIds = moving ? memberIds.filter((id) => id !== memberId) : memberIds;
  const index = insertionIndex(memberIds, moving ? memberId : null, position);
  const placed = placeMember(neighbors, { orderedMemberIds, index, memberId });
  if (!('members' in placed)) throw new ProblemError('conflict');
  const respace = moving ? placed.members : placed.members.filter((member) => member.memberId !== memberId);
  return { ordinalKey: placed.ordinalKey, respace };
}
