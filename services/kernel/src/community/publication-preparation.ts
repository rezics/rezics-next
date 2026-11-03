import { t } from 'elysia';
import { deadlineClient } from '../access/authenticate.ts';
import { AccessUnavailableError, CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { authoritativeTimeValue, mintReadTime } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { SessionComponent } from '../tokens/session.ts';
import { spaceReadEligibility } from './space.ts';
import { realmReadEligibility } from './realm.ts';
import type { PublicationDependencies, PublicationReadContext, PublicationVerdict } from './publication.ts';
import { preparePublicationSubject } from './publication-preparation-subject.ts';
import read from './publication-preparation-read.sql';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullableId = t.Union([id, t.Null()]);
const command = t.Object(
  {
    method: t.Literal('POST'),
    href: t.String(),
    subjectId: id,
    expectedHead: nullableId,
    ifMatch: t.Union([t.String(), t.Null()]),
  },
  closed,
);

export const PublicationPreparationSchema = t.Object(
  {
    realm: t.Object(
      {
        realmId: id,
        spaceId: id,
        contextId: id,
        title: t.String(),
        hostTitle: t.String(),
      },
      closed,
    ),
    subject: t.Object(
      {
        originalId: id,
        currentId: id,
        // The bounded reference owner is installed. Full display hydration has a
        // separate owner seam; unavailable never means concealed or an empty label.
        presentation: t.Object({ state: t.Literal('unavailable') }, closed),
      },
      closed,
    ),
    current: t.Union([
      t.Object(
        {
          publicationId: id,
          verdict: t.Union([t.Literal('adopt'), t.Literal('reject'), t.Literal('withdraw')]),
          decidedAt: t.String({ format: 'date-time' }),
        },
        closed,
      ),
      t.Null(),
    ]),
    commands: t.Object(
      {
        publish: command,
        withdraw: t.Union([command, t.Null()]),
        reject: t.Union([command, t.Null()]),
      },
      closed,
    ),
    recovery: t.Object(
      {
        requestIdentity: t.Literal('unknown'),
        replay: t.Literal('original-command'),
      },
      closed,
    ),
    viewer: t.Object({ accountId: id, clientId: t.String(), authnEpoch: t.Integer() }, closed),
  },
  closed,
);
export const PublicationPreparationResponseSchema = t.Object({ preparation: PublicationPreparationSchema }, closed);

type Row = NonNullable<Awaited<ReturnType<typeof read.run>>>;
type Observation = Readonly<{ row: Row; component: SessionComponent }>;
type Account = Extract<Actor, { kind: 'account' }>;

async function realmChecks(
  deps: PublicationDependencies,
  realmId: string,
  context: PublicationReadContext,
  spaceId?: string,
) {
  const route = routeOf(realmId)!;
  const resource = { route, id: realmId };
  const accessContext = { pool: deps.pool, deadline: context.deadline };
  // Membership and successful disclosure do not substitute for the actual action.
  const publish = await accessCheck(deps.access, context.actor, 'realm:publish', resource, accessContext);
  const realm = await accessCheck(
    deps.access,
    context.actor,
    'realm:read',
    { ...resource, eligibility: realmReadEligibility(resource) },
    accessContext,
  );
  const host = spaceId
    ? await accessCheck(
        deps.access,
        context.actor,
        'space:read',
        {
          route,
          id: spaceId,
          eligibility: spaceReadEligibility({ route, id: spaceId }),
        },
        accessContext,
      )
    : null;
  return { publish, realm, host };
}

async function observe(
  deps: PublicationDependencies,
  realmId: string,
  subjectId: string,
  context: PublicationReadContext,
  checks: Awaited<ReturnType<typeof realmChecks>>,
): Promise<Observation | null> {
  const route = routeOf(realmId)!;
  return withReadTransaction(
    deps.pool,
    async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      const partition = await readPartition(client, partitionOf(route));
      if (!partition) throw new AccessUnavailableError('contention');
      if (partition.writeState !== 'active')
        throw new CommandUnavailableError(partition.writeState, partition.partitionNo, partition.movedTo);
      const time = await mintReadTime(client, deps.clock);
      if (!(await checks.publish(client, time)) || !(await checks.realm(client, time))) return null;
      if (checks.host && !(await checks.host(client, time))) return null;
      const row = await read.run(client, {
        route,
        realm: realmId,
        subject: subjectId,
        at: authoritativeTimeValue(time),
      });
      if (!row || row.ownership_state !== 'owned') return null;
      return {
        row,
        component: {
          partition: partition.partitionNo,
          epoch: partition.epoch,
          position: partition.position,
        },
      };
    },
    context.deadline,
  );
}

function same(before: Observation, after: Observation) {
  return (
    JSON.stringify(before.row) === JSON.stringify(after.row) &&
    before.component.epoch === after.component.epoch &&
    before.component.position === after.component.position
  );
}

function destination(href: string, subjectId: string, head: string | null) {
  return {
    method: 'POST' as const,
    href,
    subjectId,
    expectedHead: head,
    ifMatch: head === null ? null : JSON.stringify(head),
  };
}

function response(realmId: string, subjectId: string, currentId: string, row: Row, actor: Account) {
  const base = `/v1/realms/${realmId}/publications`;
  const head = row.publication_id;
  if (row.verdict !== null && !['adopt', 'reject', 'withdraw'].includes(row.verdict))
    throw new TypeError('Invalid native publication verdict');
  if ((head === null) !== (row.verdict === null) || (head !== null && row.decided_at === null))
    throw new TypeError('Incomplete native publication head');
  return {
    realm: {
      realmId,
      spaceId: row.space_id,
      contextId: row.context_id,
      title: row.realm_title,
      hostTitle: row.space_title,
    },
    subject: {
      originalId: subjectId,
      currentId,
      presentation: { state: 'unavailable' as const },
    },
    current:
      head === null
        ? null
        : {
            publicationId: head,
            verdict: row.verdict as PublicationVerdict,
            decidedAt: new Date(row.decided_at!).toISOString(),
          },
    commands: {
      publish: destination(base, subjectId, head),
      withdraw: head === null ? null : destination(`${base}/${subjectId}:withdraw`, subjectId, head),
      reject: head === null ? null : destination(`${base}/${subjectId}:reject`, subjectId, head),
    },
    recovery: {
      requestIdentity: 'unknown' as const,
      replay: 'original-command' as const,
    },
    viewer: {
      accountId: actor.accountId,
      clientId: actor.clientId,
      authnEpoch: actor.authnEpoch,
    },
  };
}

/** Exact operational inspection. All dependencies are prepared on released homes;
 * final equality is conservative, never a claim of a global atomic snapshot.
 * No receipt, mutation, idempotency key or repair participates in this GET.
 */
export async function readPublicationPreparation(
  deps: PublicationDependencies,
  realmId: string,
  subjectId: string,
  context: PublicationReadContext,
) {
  if (!Number.isFinite(context.deadline)) throw new AccessUnavailableError('deadline');
  requireAccessDeadline(context.deadline);
  if (context.actor.kind !== 'account' || routeOf(realmId) === null || routeOf(subjectId) === null) return null;
  const actor = context.actor;
  const before = await observe(deps, realmId, subjectId, context, await realmChecks(deps, realmId, context));
  if (!before) return null;
  const subject = await preparePublicationSubject(deps, subjectId, context);
  if (!subject) return null;
  // No origin checkout is held while Subject reference and Access evidence run.
  const checks = await realmChecks(deps, realmId, context, before.row.space_id);
  if (!(await subject.current())) throw new AccessUnavailableError('contention');
  const after = await observe(deps, realmId, subjectId, context, checks);
  if (!after) return null;
  if (!same(before, after)) throw new AccessUnavailableError('contention');
  requireAccessDeadline(context.deadline);
  return {
    preparation: response(realmId, subjectId, subject.currentId, after.row, actor),
    components: [after.component, ...subject.components],
  };
}
