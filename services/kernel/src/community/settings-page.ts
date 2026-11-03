import { documentText, DocumentSnapshotSchema } from '@rezics/document';
import { t } from 'elysia';
import type { Static, TSchema } from 'typebox';
import { deadlineClient, within } from '../access/authenticate.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { readExactPublishedRules } from '../content/reads.ts';
import { rulesKey } from '../content/community-presentation-rules.ts';
import {
  exactRealmPresentationImage,
  RealmPresentationImageSchema,
  readRealmPresentationImages,
} from '../content/realm-media.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import bindingRead from './container-lifecycle-binding.sql';
import { RealmPresentationSchema } from './presentation.ts';
import { readRealm, readRealmSettingsHead, realmReadEligibility, type RealmDependencies } from './realm.ts';
import { readSpace, spaceReadEligibility } from './space.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullable = <T extends TSchema>(schema: T) => t.Union([schema, t.Null()]);
const optional = <T extends TSchema>(schema: T) =>
  t.Union([
    t.Object({ state: t.Literal('available'), value: schema }, closed),
    t.Object(
      {
        state: t.Union([t.Literal('none'), t.Literal('unavailable')]),
        value: t.Null(),
      },
      closed,
    ),
  ]);
const operation = t.Object(
  {
    method: t.Union([t.Literal('PATCH'), t.Literal('PUT'), t.Literal('POST')]),
    path: t.String(),
    available: t.Boolean(),
    reason: nullable(t.Literal('governance_read_only')),
    headers: t.Array(t.String()),
    ifMatch: nullable(t.String()),
    requirements: t.Array(t.String()),
  },
  closed,
);

/** A structural superset of Web's existing RealmAppearanceSnapshot. `none` uses
 * its existing concealed/unset optional contract; selected IDs remain in presentation. */
export const RealmSettingsPageSchema = t.Object(
  {
    snapshot: t.Object(
      {
        realmId: id,
        head: id,
        title: t.String(),
        summary: t.String(),
        contextId: id,
        visibility: t.Union([t.Literal('public'), t.Literal('protected')]),
        state: t.Literal('active'),
        ownershipState: t.Union([t.Literal('owned'), t.Literal('orphaned')]),
        governanceReadOnly: t.Boolean(),
        canManage: t.Boolean(),
        boardSchemeId: nullable(id),
        votes: t.Record(t.String(), t.Union([t.Literal(1), t.Literal(-1)])),
        presentation: RealmPresentationSchema,
        avatar: optional(RealmPresentationImageSchema),
        banner: optional(RealmPresentationImageSchema),
        rules: optional(
          t.Object(
            {
              postId: id,
              revisionId: id,
              title: t.String({ maxLength: 160 }),
              summary: t.String({ maxLength: 800 }),
              body: DocumentSnapshotSchema,
              licence: t.String(),
              sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
            },
            closed,
          ),
        ),
      },
      closed,
    ),
    host: t.Object({ spaceId: id, head: id, title: t.String(), summary: t.String() }, closed),
    operations: t.Object({ update: operation, boardScheme: operation, reserveMedia: operation }, closed),
  },
  closed,
);
export type RealmSettingsPage = Static<typeof RealmSettingsPageSchema>;
type Dependencies = Pick<RealmDependencies, 'pool' | 'access' | 'clock'>;
const none = { state: 'none', value: null } as const;
const unavailable = { state: 'unavailable', value: null } as const;
const signature = (value: unknown) => JSON.stringify(value);
const hidden = () => new ProblemError('not_found');

/** Reprepare Access outside the source checkout. All Community source and
 * management checks then share one read-only source snapshot. */
async function sourceRound(deps: Dependencies, actor: Actor, realmId: string, spaceId: string, deadline: number) {
  const route = routeOf(realmId)!;
  const resource = { route, id: realmId };
  const hostResource = { route: routeOf(spaceId)!, id: spaceId };
  if (hostResource.route !== route) throw hidden();
  const context = { pool: deps.pool, deadline };
  const manage = await accessCheck(deps.access, actor, 'realm:manage', resource, context);
  const disclose = await accessCheck(
    deps.access,
    actor,
    'realm:read',
    {
      ...resource,
      eligibility: realmReadEligibility(resource),
    },
    context,
  );
  const discloseHost = await accessCheck(
    deps.access,
    actor,
    'space:read',
    {
      ...hostResource,
      eligibility: spaceReadEligibility(hostResource),
    },
    context,
  );
  return within(deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      let time: Awaited<ReturnType<typeof mintReadTime>> | undefined;
      try {
        time = await mintReadTime(client, deps.clock);
        const home = await readPartition(client, partitionOf(route));
        if (!home || home.writeState === 'moved') throw new ProblemError('partition_unavailable');
        if (!(await manage(client, time)) || !(await disclose(client, time)) || !(await discloseHost(client, time)))
          throw hidden();
        const at = authoritativeTimeValue(time);
        const realm = await readRealmSettingsHead(client, realmId, at);
        const host = await readSpace(client, spaceId, at);
        const binding = await bindingRead.run(client, {
          ...resource,
          subject: null,
          at,
        });
        if (!realm || !host || !binding || realm.spaceId !== spaceId) throw hidden();
        await client.query('COMMIT');
        return {
          realm,
          host,
          binding,
          home: {
            node: home.node,
            epoch: home.epoch,
            writeState: home.writeState,
          },
        };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      } finally {
        if (time) releaseOperationalTime(time);
      }
    }),
  );
}

async function selected(
  deps: Dependencies,
  actor: Actor,
  realm: Awaited<ReturnType<typeof sourceRound>>['realm'],
  deadline: number,
) {
  const context = { actor, deadline };
  const images = await readRealmPresentationImages(deps, { realmId: realm.realmId, ...realm.presentation }, context);
  const image = (value: typeof images.avatar): RealmSettingsPage['snapshot']['avatar'] => {
    if (value.state !== 'available') return value;
    const exact = exactRealmPresentationImage(value.value);
    return exact ? { state: 'available', value: exact } : none;
  };
  let rules: RealmSettingsPage['snapshot']['rules'] = none;
  if (realm.presentation.rules) {
    try {
      const reference = realm.presentation.rules;
      const values = await readExactPublishedRules(deps, [{ ...reference, realmId: realm.realmId }], context);
      const value = values.get(rulesKey(reference, realm.realmId));
      if (value) {
        const [first = '', ...rest] = documentText(value.body).split('\n');
        rules = {
          state: 'available',
          value: {
            ...value,
            title: first.slice(0, 160),
            summary: rest.join('\n').slice(0, 800),
          },
        };
      }
    } catch {
      rules = unavailable;
    }
  }
  return { avatar: image(images.avatar), banner: image(images.banner), rules };
}

/** Stable keys only: no inventory, media claim, receipt or command admission.
 * Foreign owner readers release their checkouts before final source preparation.
 * This is a rechecked composition, never an atomic cross-home snapshot. */
export async function readRealmSettingsPage(
  deps: Dependencies,
  actor: Actor,
  realmId: string,
  context: { deadline: number },
): Promise<RealmSettingsPage> {
  if (actor.kind !== 'account' || routeOf(realmId) === null) throw hidden();
  if (!Number.isFinite(context.deadline) || Date.now() >= context.deadline) throw new ProblemError('deadline_exceeded');
  try {
    const current = await readRealm(deps, actor, realmId, context);
    if (!current) throw hidden();
    const initial = await sourceRound(deps, actor, realmId, current.spaceId, context.deadline);
    const first = await selected(deps, actor, initial.realm, context.deadline);
    const last = await selected(deps, actor, initial.realm, context.deadline);
    const final = await sourceRound(deps, actor, realmId, current.spaceId, context.deadline);
    if (signature(initial) !== signature(final)) throw hidden();
    const stable = <T extends { state: string; value: unknown }>(before: T, after: T): T | typeof none =>
      after.state === 'unavailable' ? after : signature(before) === signature(after) ? after : none;
    const realm = final.realm;
    const writable = !realm.governanceReadOnly;
    const command = (method: 'PATCH' | 'PUT' | 'POST', path: string, cas: boolean, requirements: string[]) => ({
      method,
      path,
      available: writable,
      reason: writable ? null : ('governance_read_only' as const),
      headers: cas ? ['If-Match', 'Idempotency-Key'] : ['Idempotency-Key'],
      ifMatch: cas ? JSON.stringify(realm.headRevisionId) : null,
      requirements,
    });
    return {
      snapshot: {
        realmId,
        head: realm.headRevisionId,
        title: realm.title,
        summary: realm.summary,
        contextId: realm.contextId,
        visibility: realm.visibility as 'public' | 'protected',
        state: 'active',
        ownershipState: realm.ownershipState,
        governanceReadOnly: realm.governanceReadOnly,
        canManage: writable,
        boardSchemeId: realm.boardSchemeId,
        votes: { ...realm.votes },
        presentation: realm.presentation,
        avatar: stable(first.avatar, last.avatar),
        banner: stable(first.banner, last.banner),
        rules: stable(first.rules, last.rules),
      },
      host: {
        spaceId: final.host.spaceId,
        head: final.host.headRevisionId,
        title: final.host.title,
        summary: final.host.summary,
      },
      operations: {
        update: command('PATCH', `/v1/realms/${realmId}`, true, [
          'Current realm:manage; command reauthorizes before receipt replay',
          'Omitted presentation preserves it; supplied presentation is the complete strict object',
          'Selected images must pass the existing exact same-Realm purpose and claim checks',
          'Rules must pass exact published native Text revision preparation in this Realm (65536 canonical UTF-8 bytes, SPDX, SHA256)',
        ]),
        boardScheme: command('PUT', `/v1/realms/${realmId}/boardScheme`, true, [
          'Current realm:manage',
          'Existing native schemeId',
        ]),
        reserveMedia: command('POST', `/v1/realms/${realmId}/media`, false, [
          'Current realm:manage',
          'Existing native realm-icon or realm-banner reservation input',
        ]),
      },
    };
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    const reason = classifyUnavailability(error);
    throw new ProblemError(
      reason === 'deadline'
        ? 'deadline_exceeded'
        : reason === 'contention'
          ? 'transaction_retry_exhausted'
          : reason === 'overloaded'
            ? 'overloaded'
            : reason === 'moved' || reason === 'fenced'
              ? 'partition_unavailable'
              : 'dependency_unavailable',
    );
  }
}
