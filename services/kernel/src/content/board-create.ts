import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { initializeResourceGrants, parentCreationAuthorization } from '../access/index.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../access/resource-roles.ts';
import { accessCommandAttempt } from '../access/command-admission.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { permissionEvidenceDeadline } from '../access/permission.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandTransaction,
} from '../command/command.ts';
import type { Access, Actor, Resource } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { readSubject } from '../semantic/subject.ts';
import type { Item } from '../semantic/item.ts';
import type { RealmParticipationCheck } from '../community/participation.ts';
import readBoardScheme from '../community/board-scheme-read.sql';
import insertBoard from './board-create.sql';
import readBoard from './board-created.sql';
import { prepareRealmParticipation, realmParticipationMatches, type RealmParticipationProof } from './media-parent.ts';

export type BoardCreationDependencies = Readonly<{
  pool: Pool;
  access: Access;
  realmParticipation?: RealmParticipationCheck;
  clock?: () => Date;
}>;

export type BoardCreationContext = Readonly<{ idempotencyKey: string; deadline: number }>;
export type BoardCreationInput = Readonly<{
  realmId: string;
  conceptId: string;
  title: string;
  visibility: 'published' | 'protected' | 'draft';
}>;
export type BoardCreationValue = Readonly<{ boardId: string; realmId: string; conceptId: string }>;

export class BoardCreationInputError extends Error {
  constructor() {
    super('Invalid board metadata or identity');
    this.name = 'BoardCreationInputError';
  }
}

export class BoardCreationConflictError extends Error {
  constructor() {
    super('A Realm already has a board for this concept');
    this.name = 'BoardCreationConflictError';
  }
}

function postgresCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function belongsToScheme(subject: Item, schemeId: string): boolean {
  return (subject.statements['skos:inScheme'] ?? []).some(
    (statement) => statement.value.type === 'value' && statement.value.content === schemeId,
  );
}

/** Creates one concept board in its Realm partition and initializes its grants
 * in the same command transaction. Semantic supplies the readable Concept. */
export async function createBoard(
  dependencies: BoardCreationDependencies,
  actor: Actor,
  input: BoardCreationInput,
  context: BoardCreationContext,
) {
  if (
    actor.kind !== 'account' ||
    typeof input.title !== 'string' ||
    input.title.trim().length === 0 ||
    [...input.title].length > 1024 ||
    input.title.includes('\0') ||
    !['published', 'protected', 'draft'].includes(input.visibility)
  )
    throw new BoardCreationInputError();

  const realmRoute = routeOf(input.realmId);
  const conceptRoute = routeOf(input.conceptId);
  if (realmRoute === null || conceptRoute === null) throw new BoardCreationInputError();

  const body = {
    realmId: input.realmId,
    conceptId: input.conceptId,
    title: input.title,
    visibility: input.visibility,
  };
  const resource: Resource = { route: realmRoute, id: newId(realmRoute) };
  const conceptResource: Resource = {
    route: conceptRoute,
    id: input.conceptId,
    eligibility: subjectReadEligibility({ route: conceptRoute, id: input.conceptId }),
  };
  const concepts = new WeakMap<AuthoritativeTime, { subject: Item; deadline: number }>();
  const access: Access = {
    authenticate: dependencies.access.authenticate.bind(dependencies.access),
    authorize: dependencies.access.authorize.bind(dependencies.access),
    async prepare(principal, action, target, preparation) {
      const attempt = accessCommandAttempt(preparation);
      if (!attempt || action !== 'board:create' || target.id !== input.realmId || target.route !== realmRoute)
        throw new GrantDeniedError();

      const primary = await dependencies.access.prepare?.(principal, action, target, preparation);
      const evidence = await dependencies.access.prepare?.(principal, 'subject:read', conceptResource, preparation);
      const deadline = Math.min(
        preparation.deadline,
        permissionEvidenceDeadline(primary) ?? -Infinity,
        permissionEvidenceDeadline(evidence) ?? -Infinity,
      );
      if (Date.now() >= deadline) throw new GrantDeniedError();

      const result = await within(deadline, () =>
        readSubject(dependencies.pool, input.conceptId, (client) =>
          dependencies.access.authorize(
            deadlineClient(client, deadline),
            principal,
            'subject:read',
            conceptResource,
            evidence,
            attempt.time,
          ),
        ),
      );
      if (result?.subject.type !== 'skos:Concept' || Date.now() >= deadline) throw new GrantDeniedError();
      concepts.set(attempt.time, { subject: result.subject, deadline });
      return primary;
    },
  };
  const roles = resourceRoleCatalogue(dependencies.access);
  if (roles) installResourceRoleCatalogue(access, roles);

  const inserted = new WeakMap<CommandTransaction, string>();
  const participation = new WeakMap<AuthoritativeTime, RealmParticipationProof>();
  const authorization = parentCreationAuthorization({
    access,
    actor,
    action: 'board:create',
    parent: {
      resource: { route: realmRoute, id: input.realmId },
      async validate(client, time) {
        if (dependencies.realmParticipation && !realmParticipationMatches(participation.get(time), input.realmId))
          throw new GrantDeniedError();
        const concept = concepts.get(time);
        if (!concept || Date.now() >= concept.deadline || concept.subject.type !== 'skos:Concept') return false;
        const realm = await readBoardScheme.run(client, {
          route: realmRoute,
          id: input.realmId,
          at: authoritativeTimeValue(time),
        });
        return !!realm?.board_scheme_id && belongsToScheme(concept.subject, realm.board_scheme_id);
      },
    },
    context: {
      pool: dependencies.pool,
      deadline: context.deadline,
      resource,
      creation: {
        async validate(tx, target, time) {
          const transactionId = inserted.get(tx);
          if (!transactionId || target.route !== resource.route || target.id !== resource.id) return false;
          const row = await readBoard.run(tx, { route: target.route, id: target.id });
          return (
            row !== null &&
            row.created_at !== null &&
            row.inserted_here === true &&
            row.recorded_transaction_id === transactionId &&
            Date.parse(row.created_at) === Date.parse(authoritativeTimeValue(time))
          );
        },
      },
    },
  });
  const preparedAuthorization = {
    ...authorization,
    async prepare(attempt: Parameters<NonNullable<typeof authorization.prepare>>[0]) {
      if (dependencies.realmParticipation) {
        const proof = await prepareRealmParticipation(
          dependencies.pool,
          dependencies.realmParticipation,
          actor,
          input.realmId,
          attempt.time,
          context.deadline,
        );
        if (!proof.allowed) throw new GrantDeniedError();
        participation.set(attempt.time, proof);
      }
      return authorization.prepare!(attempt);
    },
  };

  const identity = principalCommandIdentity(actor);
  const kind = 'content.board.create';
  try {
    return await runCommand<BoardCreationValue>(
      dependencies.pool,
      {
        ...identity,
        partition: partitionOf(realmRoute),
        deadline: context.deadline,
        clock: dependencies.clock,
        receipt: {
          kind,
          key: context.idempotencyKey,
          digest: createHash('sha256')
            .update(canonicalize([identity, kind, body])!)
            .digest(),
        },
        authorization: preparedAuthorization,
      },
      async (tx, { transactionId, time }) => {
        await insertBoard.run(tx, {
          route: realmRoute,
          board_id: resource.id,
          realm_id: input.realmId,
          subject_id: input.conceptId,
          title: input.title,
          visibility: input.visibility,
          transaction_id: transactionId,
          at: authoritativeTimeValue(time),
        });
        inserted.set(tx, transactionId);
        await initializeResourceGrants(tx, {
          resource,
          type: 'content.board',
          creator: actor.accountId,
        });
        return {
          value: { boardId: resource.id, realmId: input.realmId, conceptId: input.conceptId },
          events: [
            {
              type: 'com.rezics.content.board.created.v1',
              subject: resource.id,
              data: {
                boardId: resource.id,
                realmId: input.realmId,
                conceptId: input.conceptId,
                actorId: actor.accountId,
              },
            },
          ],
        };
      },
    );
  } catch (error) {
    if (postgresCode(error) === '23505') throw new BoardCreationConflictError();
    throw error;
  }
}
