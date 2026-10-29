import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { initializeResourceGrants, parentCreationAuthorization } from '../access/index.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../access/resource-roles.ts';
import { accessCommandAttempt } from '../access/command-admission.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { deriveAccess } from '../access/derived-access.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
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
import { globalContextAnchor } from '../semantic/context.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { readItemTypes } from '../semantic/subject.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { readItemIdentityVersion } from '../semantic/item-identity.ts';
import { SubjectRedirectError } from '../semantic/merges.ts';
import { readConceptSchemeReference } from '../semantic/concept-scheme-reference.ts';
import { realmReadEligibility } from '../community/realm.ts';
import { mediaParentSnapshot } from './media-parent.ts';
import { realmParticipationAnchor, type RealmParticipationCheck } from '../community/participation.ts';
import readBoardScheme from '../community/board-scheme-read.sql';
import insertBoard from './board-create.sql';
import readBoard from './board-created.sql';
import { realmParticipationMatches, type RealmParticipationProof } from './media-parent.ts';

export type BoardCreationDependencies = Readonly<{
  pool: Pool;
  access: Access;
  routeKey?: Uint8Array;
  realmParticipation?: RealmParticipationCheck;
  clock?: () => Date;
}>;

export type BoardCreationContext = Readonly<{ idempotencyKey: string; deadline: number }>;
export type BoardCreationInput = Readonly<{
  realmId: string | null;
  conceptId: string;
  title: string;
  visibility: 'published' | 'protected' | 'draft';
  purpose?: 'discussion' | 'reviews';
}>;
export type BoardCreationValue = Readonly<{ boardId: string; realmId: string | null; conceptId: string }>;

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

/** Creates a board in its Realm partition, or its concept partition for Global, and initializes its grants
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
    !['published', 'protected', 'draft'].includes(input.visibility) ||
    (input.purpose !== undefined && input.purpose !== 'discussion' && input.purpose !== 'reviews') ||
    (input.realmId === null && input.visibility === 'draft')
  )
    throw new BoardCreationInputError();

  const conceptRoute = routeOf(input.conceptId);
  const boardRoute = input.realmId === null ? conceptRoute : routeOf(input.realmId);
  if (boardRoute === null || conceptRoute === null) throw new BoardCreationInputError();
  const parentResource: Resource =
    input.realmId === null ? globalContextAnchor.resource : { route: boardRoute, id: input.realmId };

  const body = {
    realmId: input.realmId,
    conceptId: input.conceptId,
    title: input.title,
    visibility: input.visibility,
    purpose: input.purpose ?? 'discussion',
  };
  const resource: Resource = { route: boardRoute, id: newId(boardRoute) };
  const conceptResource: Resource = {
    route: conceptRoute,
    id: input.conceptId,
    eligibility: subjectReadEligibility({ route: conceptRoute, id: input.conceptId }),
  };
  const concepts = new WeakMap<
    AuthoritativeTime,
    {
      deadline: number;
      schemeId?: string;
      realmHead?: string;
      realmEvidence?: unknown;
      participationEvidence?: unknown;
    }
  >();
  const realmResource: Resource = { ...parentResource, eligibility: realmReadEligibility(parentResource) };
  const participationResource = realmParticipationAnchor(parentResource).resource;
  const access = deriveAccess(dependencies.access, {
    async prepare(principal, action, target, preparation) {
      const attempt = accessCommandAttempt(preparation);
      if (
        !attempt ||
        action !== 'board:create' ||
        target.id !== parentResource.id ||
        target.route !== parentResource.route
      )
        throw new GrantDeniedError();

      const primary = await dependencies.access.prepare?.(principal, action, target, preparation);
      const evidence = await dependencies.access.prepare?.(principal, 'subject:read', conceptResource, preparation);
      let deadline = Math.min(
        preparation.deadline,
        permissionEvidenceDeadline(primary) ?? -Infinity,
        permissionEvidenceDeadline(evidence) ?? -Infinity,
      );
      if (Date.now() >= deadline) throw new GrantDeniedError();

      if (input.realmId === null) {
        // Global has no scheme: only the Concept's current type and read authority
        // are needed, independently of the subject page's link projections.
        const valid = await within(deadline, () =>
          withReadTransaction(dependencies.pool, async (client) => {
            const bounded = deadlineClient(client, deadline);
            const types = await readItemTypes(bounded, [input.conceptId]);
            if (
              types.get(input.conceptId) !== 'skos:Concept' ||
              !(await dependencies.access.authorize(
                bounded,
                principal,
                'subject:read',
                conceptResource,
                evidence,
                attempt.time,
              ))
            )
              return false;
            const identity = await readItemIdentityVersion(bounded, input.conceptId);
            if (identity?.redirect) throw new SubjectRedirectError(input.conceptId, identity.redirect);
            return identity !== null;
          }),
        );
        if (!valid || Date.now() >= deadline) throw new GrantDeniedError();
        concepts.set(attempt.time, { deadline });
        return primary;
      }

      const participationEvidence = await dependencies.access.prepare?.(
        principal,
        'realm:participate',
        participationResource,
        preparation,
      );
      deadline = Math.min(deadline, permissionEvidenceDeadline(participationEvidence) ?? -Infinity);
      const realmEvidence = await dependencies.access.prepare?.(principal, 'realm:read', realmResource, preparation);
      deadline = Math.min(deadline, permissionEvidenceDeadline(realmEvidence) ?? -Infinity);
      if (Date.now() >= deadline) throw new GrantDeniedError();
      const realm = await mediaParentSnapshot(dependencies.pool, boardRoute, deadline, async (client) => {
        const row = await readBoardScheme.run(client, {
          route: boardRoute,
          id: input.realmId!,
          at: authoritativeTimeValue(attempt.time),
        });
        if (
          !row?.board_scheme_id ||
          !(await dependencies.access.authorize(
            client,
            principal,
            'realm:read',
            realmResource,
            realmEvidence,
            attempt.time,
          ))
        )
          throw new GrantDeniedError();
        return row;
      });
      const scheme: Resource = {
        route: routeOf(realm.board_scheme_id!)!,
        id: realm.board_scheme_id!,
        eligibility: subjectReadEligibility({ route: routeOf(realm.board_scheme_id!)!, id: realm.board_scheme_id! }),
      };
      const schemeEvidence = await dependencies.access.prepare?.(principal, 'subject:read', scheme, preparation);
      deadline = Math.min(deadline, permissionEvidenceDeadline(schemeEvidence) ?? -Infinity);
      if (
        Date.now() >= deadline ||
        !(await readConceptSchemeReference(dependencies.pool, {
          access: dependencies.access,
          actor: principal,
          routeKey: dependencies.routeKey,
          nativeT: attempt.time,
          deadline,
          concept: { resource: conceptResource, evidence },
          scheme: { resource: scheme, evidence: schemeEvidence },
        }))
      )
        throw new GrantDeniedError();
      concepts.set(attempt.time, {
        deadline,
        schemeId: realm.board_scheme_id!,
        realmHead: realm.head_revision_id,
        realmEvidence,
        participationEvidence,
      });
      return primary;
    },
  });
  const roles = resourceRoleCatalogue(dependencies.access);
  if (roles) installResourceRoleCatalogue(access, roles);

  const inserted = new WeakMap<CommandTransaction, string>();
  const participation = new WeakMap<AuthoritativeTime, RealmParticipationProof>();
  const authorization = parentCreationAuthorization({
    access,
    actor,
    action: 'board:create',
    parent: {
      resource: parentResource,
      async validate(client, time) {
        if (
          input.realmId !== null &&
          dependencies.realmParticipation &&
          !realmParticipationMatches(participation.get(time), input.realmId)
        )
          throw new GrantDeniedError();
        const concept = concepts.get(time);
        if (!concept || Date.now() >= concept.deadline) return false;
        if (input.realmId === null) return globalContextAnchor.validate(client, time);
        const realm = await readBoardScheme.run(client, {
          route: boardRoute,
          id: input.realmId,
          at: authoritativeTimeValue(time),
        });
        if (!realm || realm.board_scheme_id !== concept.schemeId || realm.head_revision_id !== concept.realmHead)
          return false;
        const bounded = deadlineClient(client, concept.deadline);
        return (
          (await dependencies.access.authorize(
            bounded,
            actor,
            'realm:read',
            realmResource,
            concept.realmEvidence,
            time,
          )) &&
          (await dependencies.access.authorize(
            bounded,
            actor,
            'realm:participate',
            participationResource,
            concept.participationEvidence,
            time,
          ))
        );
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
    async authorize(tx: CommandTransaction, attempt: Parameters<typeof authorization.authorize>[1], proof: unknown) {
      const prepared = concepts.get(attempt.time);
      if (!prepared) throw new GrantDeniedError();
      requireAccessDeadline(prepared.deadline);
      return authorization.authorize(tx, attempt, proof);
    },
    async finalize(tx: CommandTransaction, attempt: Parameters<typeof authorization.authorize>[1], proof: unknown) {
      const prepared = concepts.get(attempt.time);
      if (!prepared) throw new GrantDeniedError();
      requireAccessDeadline(prepared.deadline);
      return authorization.finalize?.(tx, attempt, proof);
    },
    async prepare(attempt: Parameters<NonNullable<typeof authorization.prepare>>[0]) {
      if (input.realmId !== null && dependencies.realmParticipation) {
        // The participation reader prepares native Access before issuing its
        // point queries. A lazy pool transport holds no checkout during preparation.
        const allowed = await within(context.deadline, () =>
          dependencies.realmParticipation!(
            deadlineClient(dependencies.pool, context.deadline),
            { realmId: input.realmId!, actor },
            attempt.time,
          ),
        );
        const proof = { realmId: input.realmId, allowed };
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
        partition: partitionOf(boardRoute),
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
          route: boardRoute,
          board_id: resource.id,
          realm_id: input.realmId,
          subject_id: input.conceptId,
          title: input.title,
          visibility: input.visibility,
          purpose: input.purpose ?? 'discussion',
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
