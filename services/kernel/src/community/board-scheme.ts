import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { resourceAuthorization } from '../access/index.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { accessCommandAttempt } from '../access/command-admission.ts';
import { deriveAccess } from '../access/derived-access.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { permissionEvidenceDeadline } from '../access/permission.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
} from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { readSubject } from '../semantic/subject.ts';
import { RealmConflictError, RealmInputError, type Realm, type RealmDependencies, type RealmContext } from './realm.ts';
import read from './board-scheme-read.sql';
import append from './board-scheme-revision.sql';
import moveHead from './board-scheme-head.sql';

type RealmRow = NonNullable<Awaited<ReturnType<typeof read.run>>>;
function record(row: RealmRow): Realm {
  return {
    realmId: row.realm_id,
    spaceId: row.space_id,
    state: row.state,
    visibility: row.visibility,
    contextId: row.context_id,
    headRevisionId: row.head_revision_id,
    createdAt: new Date(row.created_at).toISOString(),
    creator: row.creator,
    predecessor: row.predecessor,
    title: row.title,
    summary: row.summary,
    revisionCreatedAt: new Date(row.revision_created_at).toISOString(),
    author: row.author,
  };
}

export async function setBoardScheme(
  deps: RealmDependencies,
  actor: Actor,
  input: Readonly<{ realmId: string; schemeId: string; expectedHead: string }>,
  context: RealmContext,
) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  const body = { realmId: input.realmId, schemeId: input.schemeId, expectedHead: input.expectedHead };
  const route = routeOf(body.realmId),
    schemeRoute = routeOf(body.schemeId);
  if (route === null || schemeRoute === null || routeOf(body.expectedHead) !== route) throw new RealmInputError();
  const scheme = { route: schemeRoute, id: body.schemeId };
  const subject = { ...scheme, eligibility: subjectReadEligibility(scheme) };
  const checked = new WeakMap<AuthoritativeTime, number>();
  const current = new WeakMap<AuthoritativeTime, Realm>();
  // Semantic owns its subject/statement read. Prepare it before the Realm anchor
  // checks out a connection, retaining the exact command T and admission evidence.
  const access = deriveAccess(deps.access, {
    async prepare(principal, action, resource, preparation) {
      const attempt = accessCommandAttempt(preparation);
      if (!attempt) throw new GrantDeniedError();
      const primary = await deps.access.prepare?.(principal, action, resource, preparation);
      const evidence = await deps.access.prepare?.(principal, 'subject:read', subject, preparation);
      const deadline = Math.min(
        preparation.deadline,
        permissionEvidenceDeadline(primary) ?? -Infinity,
        permissionEvidenceDeadline(evidence) ?? -Infinity,
      );
      if (Date.now() >= deadline) throw new GrantDeniedError();
      const result = await within(deadline, () =>
        readSubject(deps.pool, body.schemeId, (client) =>
          deps.access.authorize(
            deadlineClient(client, deadline),
            principal,
            'subject:read',
            subject,
            evidence,
            attempt.time,
          ),
        ),
      );
      if (result?.subject.type !== 'skos:ConceptScheme' || Date.now() >= deadline) throw new GrantDeniedError();
      checked.set(attempt.time, deadline);
      return primary;
    },
  });
  const authorization = resourceAuthorization({
    access,
    actor,
    action: 'realm:manage',
    anchor: {
      resource: { route, id: body.realmId },
      async validate(client, time) {
        if (Date.now() >= (checked.get(time) ?? -Infinity)) return false;
        const row = await read.run(client, { route, id: body.realmId, at: authoritativeTimeValue(time) });
        if (!row) return false;
        current.set(time, record(row));
        return true;
      },
    },
    context: { pool: deps.pool, deadline: context.deadline, partition: partitionOf(route) },
  });
  const identity = principalCommandIdentity(actor);
  const kind = 'community.realm.board-scheme';
  try {
    return await runCommand(
      deps.pool,
      {
        ...identity,
        partition: partitionOf(route),
        deadline: context.deadline,
        clock: deps.clock,
        receipt: {
          kind,
          key: context.idempotencyKey,
          digest: createHash('sha256')
            .update(canonicalize([identity, kind, body])!)
            .digest(),
        },
        authorization: {
          ...authorization,
          async authorize(tx, attempt, proof) {
            if (Date.now() >= (checked.get(attempt.time) ?? -Infinity)) throw new GrantDeniedError();
            return authorization.authorize(tx, attempt, proof);
          },
        },
      },
      async (tx, command) => {
        const previous = current.get(command.time)!;
        if (previous.headRevisionId !== body.expectedHead) throw new RealmConflictError();
        const revision = newId(route);
        await append.run(tx, {
          route,
          id: body.realmId,
          revision,
          predecessor: body.expectedHead,
          title: previous.title,
          summary: previous.summary,
          visibility: previous.visibility,
          context: previous.contextId,
          scheme: body.schemeId,
          at: authoritativeTimeValue(command.time),
          author: actor.accountId,
        });
        if (
          !(await moveHead.run(tx, {
            route,
            id: body.realmId,
            revision,
            expected: body.expectedHead,
            scheme: body.schemeId,
          }))
        )
          throw new RealmConflictError();
        return {
          value: { realmId: body.realmId, revisionId: revision },
          events: [
            {
              type: 'com.rezics.community.realm.board-scheme.v1',
              subject: body.realmId,
              data: { realmId: body.realmId, revisionId: revision, schemeId: body.schemeId },
            },
          ],
        };
      },
    );
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new ProblemError('not_found');
    throw error;
  }
}
