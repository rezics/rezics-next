import type { Pool } from 'pg';
import { initializeResourceGrants, parentCreationAuthorization } from '../access/index.ts';
import { commandAccessContext } from '../access/command-admission.ts';
import { captureDurableInitiator, durableInitiatorCommitment } from '../access/durable-initiator-capture.ts';
import type { DurableInitiatorRecord } from '../access/durable-initiator.ts';
import { accessCommandAuthorization, accessCheck, type Access, type Actor } from '../request/access.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { ContentNotFoundError, RevisionPreconditionError } from './commands.ts';
import { prepareEditionSource } from './reads.ts';
import { isSpdxLicense } from './document.ts';
import {
  editionDigest,
  editionRow,
  editionSnapshot,
  editionSource,
  sameEdition,
  sameSource,
  sourceOf,
  type EditionRow,
} from './edition-store.ts';
import { EDITION_PUBLISH, publicationSourceDigest } from './edition-initiator.ts';

export type EditionCommandDependencies = Readonly<{ pool: Pool; access: Access; clock?: () => Date }>;
export type EditionCommandContext = Readonly<{ idempotencyKey: string; deadline: number }>;
type SourceGuard = NonNullable<Awaited<ReturnType<typeof prepareEditionSource>>>;

/** Create the fixed draft first. Owner grants exist before a separate publish can be admitted. */
export async function createContentEdition(
  deps: EditionCommandDependencies,
  actor: Actor,
  input: Readonly<{ postId: string; revisionId: string; targetSubjectId: string }>,
  context: EditionCommandContext,
) {
  const route = routeOf(input.postId);
  if (
    actor.kind !== 'account' ||
    route === null ||
    routeOf(input.revisionId) !== route ||
    routeOf(input.targetSubjectId) === null
  )
    throw new ContentNotFoundError();
  const source = (
    await editionSnapshot(deps, input.postId, context, (client) =>
      editionSource(client, input.postId, input.revisionId, input.targetSubjectId),
    )
  ).value;
  if (!source || source.creatorAccountId !== actor.accountId || !isSpdxLicense(source.licence))
    throw new ContentNotFoundError();
  const resource = { route, id: newId(route) };
  const inserted = new WeakMap<CommandTransaction, string>();
  const base = parentCreationAuthorization({
    access: deps.access,
    actor,
    action: 'post:revise',
    parent: {
      resource: { route, id: input.postId },
      async validate(client) {
        return sameSource(await editionSource(client, input.postId, input.revisionId, input.targetSubjectId), source);
      },
    },
    context: {
      pool: deps.pool,
      deadline: context.deadline,
      resource,
      creation: {
        async validate(tx, target, time) {
          const row = await editionRow(tx, target.id);
          return (
            !!row &&
            target.id === resource.id &&
            target.route === resource.route &&
            row.inserted_here &&
            row.state === 'draft' &&
            row.security_revision === '1' &&
            sameSource(sourceOf(row), source) &&
            row.recorded_transaction_id === inserted.get(tx) &&
            Date.parse(row.created_at) === Date.parse(authoritativeTimeValue(time))
          );
        },
      },
    },
  });
  const guards = new WeakMap<AuthoritativeTime, SourceGuard>();
  const authorization: CommandAuthorization = {
    ...base,
    async prepare(attempt) {
      const proof = await base.prepare!(attempt);
      const guard = await prepareEditionSource(
        deps,
        source,
        { actor, deadline: context.deadline },
        attempt.time,
        commandAccessContext({ pool: deps.pool, deadline: context.deadline }, attempt),
        true,
      );
      if (!guard || !(await guard.final())) throw new ContentNotFoundError();
      guards.set(attempt.time, guard);
      return proof;
    },
    async authorize(tx, attempt, proof) {
      if (!(await guards.get(attempt.time)?.check(tx))) throw new ContentNotFoundError();
      return base.authorize(tx, attempt, proof);
    },
    async finalize(tx, attempt, proof) {
      if (!(await guards.get(attempt.time)?.check(tx))) throw new ContentNotFoundError();
      return base.finalize?.(tx, attempt, proof);
    },
  };
  const identity = principalCommandIdentity(actor);
  const kind = 'content.edition.create';
  return runCommand(
    deps.pool,
    {
      ...identity,
      partition: partitionOf(route),
      clock: deps.clock,
      deadline: context.deadline,
      authorization,
      receipt: {
        kind,
        key: context.idempotencyKey,
        digest: Buffer.from(editionDigest([identity, kind, input]), 'hex'),
      },
    },
    async (tx, { transactionId, time }) => {
      await tx.query(
        `INSERT INTO content.edition
      (route,edition_id,creator_account_id,thread_id,post_id,revision_id,body_sha256,licence,state,
       security_revision,recorded_transaction_id,created_at,target_subject_id)
      VALUES ($1,$2,$3,$4,$5,$6,decode($7,'hex'),$8,'draft',1,$9,$10,$11)`,
        [
          route,
          resource.id,
          actor.accountId,
          source.threadId,
          source.postId,
          source.revisionId,
          source.sha256,
          source.licence,
          transactionId,
          authoritativeTimeValue(time),
          source.targetSubjectId,
        ],
      );
      inserted.set(tx, transactionId);
      await initializeResourceGrants(tx, { resource, type: 'content.edition', creator: actor.accountId });
      const value = { editionId: resource.id, editionRevision: '1' };
      return { value, events: [{ type: 'com.rezics.content.edition.created.v1', subject: resource.id, data: value }] };
    },
  );
}

/** Actual publication captures only the real admitted publisher, at the executor-owned T. */
export async function publishContentEdition(
  deps: EditionCommandDependencies,
  actor: Actor,
  editionId: string,
  expected: string,
  context: EditionCommandContext,
) {
  return changeEdition(deps, actor, editionId, expected, context, true);
}
export async function unpublishContentEdition(
  deps: EditionCommandDependencies,
  actor: Actor,
  editionId: string,
  expected: string,
  context: EditionCommandContext,
) {
  return changeEdition(deps, actor, editionId, expected, context, false);
}
async function changeEdition(
  deps: EditionCommandDependencies,
  actor: Actor,
  editionId: string,
  expected: string,
  context: EditionCommandContext,
  publish: boolean,
) {
  const route = routeOf(editionId);
  if (route === null || actor.kind !== 'account') throw new ContentNotFoundError();
  const initial = (await editionSnapshot(deps, editionId, context, (client) => editionRow(client, editionId))).value;
  if (!initial || initial.creator_account_id !== actor.accountId) throw new ContentNotFoundError();
  const source = sourceOf(initial);
  const action = publish ? 'edition:sell' : 'edition:unpublish';
  const kind = publish ? EDITION_PUBLISH : 'content.edition.unpublish';
  const identity = principalCommandIdentity(actor);
  const digest = editionDigest([identity, kind, editionId, expected]);
  const base = await accessCommandAuthorization(
    deps.access,
    actor,
    action,
    { route, id: editionId },
    { pool: deps.pool, deadline: context.deadline },
    () => new ContentNotFoundError(),
  );
  const states = new WeakMap<
    AuthoritativeTime,
    {
      guard: SourceGuard;
      revise: Awaited<ReturnType<typeof accessCheck>> | null;
      capture: Pick<DurableInitiatorRecord, 'originalAccount' | 'originalDelegation'> | null;
    }
  >();
  const operationId = newId(route);
  const authorization: CommandAuthorization = {
    ...base,
    async prepare(attempt) {
      const proof = await base.prepare!(attempt);
      const accessContext = commandAccessContext({ pool: deps.pool, deadline: context.deadline }, attempt);
      const guard = await prepareEditionSource(
        deps,
        source,
        { actor, deadline: context.deadline },
        attempt.time,
        accessContext,
        true,
      );
      if (!guard || !(await guard.final())) throw new ContentNotFoundError();
      const revise = publish
        ? await accessCheck(deps.access, actor, 'post:revise', { route, id: source.postId }, accessContext)
        : null;
      const capture = publish ? await captureDurableInitiator(accessContext, actor) : null;
      states.set(attempt.time, { guard, revise, capture });
      return proof;
    },
    async authorize(tx, attempt, proof) {
      const state = states.get(attempt.time);
      if (
        !state ||
        !(await state.guard.check(tx)) ||
        !sameSource(await editionSource(tx, source.postId, source.revisionId, source.targetSubjectId), source) ||
        (publish && !(await state.revise!(tx, attempt.time)))
      )
        throw new ContentNotFoundError();
      const row = await editionRow(tx, editionId);
      if (!sameEdition(row, initial)) throw new ContentNotFoundError();
      return base.authorize(tx, attempt, proof);
    },
    async finalize(tx, attempt, proof) {
      if (!(await states.get(attempt.time)?.guard.check(tx))) throw new ContentNotFoundError();
      return base.finalize?.(tx, attempt, proof);
    },
  };
  return runCommand(
    deps.pool,
    {
      ...identity,
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization,
      receipt: { kind, key: context.idempotencyKey, digest: Buffer.from(digest, 'hex') },
    },
    async (tx, { transactionId, time }) => {
      // Normal CAS is in the mutation phase so a genuinely authorized same-key replay still works.
      if (initial.security_revision !== expected || initial.state !== (publish ? 'draft' : 'published'))
        throw new RevisionPreconditionError();
      const row = (
        await tx.query<EditionRow>(
          `UPDATE content.edition SET state=$4,
      security_revision=security_revision+1 WHERE route=$1 AND edition_id=$2 AND security_revision=$3::bigint
      AND state=$5 RETURNING edition_id`,
          [route, editionId, expected, publish ? 'published' : 'unpublished', publish ? 'draft' : 'published'],
        )
      ).rows[0];
      if (!row) throw new RevisionPreconditionError();
      let commitment: string | undefined;
      if (publish) {
        const capture = states.get(time)!.capture!;
        const record: DurableInitiatorRecord = {
          operation: { route, id: operationId, kind, sourceId: editionId },
          initiatorAccountId: actor.accountId,
          actor: {
            kind: 'account',
            accountId: actor.accountId,
            clientId: actor.clientId,
            authnEpoch: actor.authnEpoch,
            requestedBy: actor.requestedBy,
            scopes: [...actor.scopes],
          },
          recordedTransactionId: transactionId,
          sourceDigest: publicationSourceDigest(initial, operationId),
          ...capture,
          creation: {
            commandKind: kind,
            idempotencyKey: context.idempotencyKey,
            requestDigest: digest,
            target: { route, id: editionId },
          },
        };
        await tx.query(
          `INSERT INTO content.edition_publication
        (route,operation_id,edition_id,recorded_transaction_id,initiator_account_id,actor_client_id,
         actor_scopes,actor_requested_by,actor_authn_epoch,original_minimum_authn_epoch,
         original_operator_account_id,original_delegation_transaction_id,original_delegation_issued_valid,
         source_digest,creation_idempotency_key,creation_request_digest)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            route,
            operationId,
            editionId,
            transactionId,
            actor.accountId,
            actor.clientId,
            [...actor.scopes],
            actor.requestedBy,
            actor.authnEpoch,
            capture.originalAccount.minimumAuthnEpoch,
            capture.originalAccount.operatorAccountId,
            capture.originalDelegation?.transactionId ?? null,
            capture.originalDelegation?.issuedValid ?? null,
            record.sourceDigest,
            context.idempotencyKey,
            digest,
          ],
        );
        commitment = durableInitiatorCommitment(record);
      }
      const value = {
        editionId,
        editionRevision: String(BigInt(expected) + 1n),
        ...(commitment ? { durableInitiator: commitment } : {}),
      };
      return {
        value,
        events: [
          {
            type: publish ? 'com.rezics.content.edition.published.v1' : 'com.rezics.content.edition.unpublished.v1',
            subject: editionId,
            data: { editionId, editionRevision: value.editionRevision },
          },
        ],
      };
    },
  );
}
