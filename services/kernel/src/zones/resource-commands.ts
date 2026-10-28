import { platformRegistry, validateZoneStarter } from '@rezics/composition';
import type { Pool } from 'pg';
import { commandAccessContext } from '../access/command-admission.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { parentCreationAuthorization } from '../access/parent-creation.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import { initializeResourceGrants } from '../access/resource-initialization.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandAttempt,
  type AuthoritativeTime,
  currentCommand,
} from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { requestDigest } from '../http/request.ts';
import { createCollectionReads } from '../library/collection-reads.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { globalContextAnchor } from '../semantic/context.ts';
import { activeRelease } from '../semantic/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { ZoneConfigureInput, ZoneCreateInput, ZonePublishInput } from './contract.ts';
import { requireZoneAccount, zoneIdentity, zoneOwned } from './resource-reads.ts';
import {
  compareAndSetZone,
  hasZoneOwnerRole,
  insertZone,
  lockZoneHead,
  readZoneHead,
  type ZoneHead,
} from './resource-store.ts';

const WINDOW_MS = 30 * 86_400_000;
export function zoneIfMatch(value: string | undefined): string {
  if (
    !value ||
    !/^"[1-9][0-9]*"$/.test(value) ||
    value.length > 21 ||
    BigInt(value.slice(1, -1)) > 9223372036854775807n
  )
    throw new ProblemError('invalid_request', { errors: [{ pointer: '/headers/if-match', code: 'invalid_format' }] });
  return value.slice(1, -1);
}

type PreparedConfiguration = { releaseDigest: string };
type Prepared = {
  configuration: PreparedConfiguration | undefined;
  failure?: unknown;
  permission?: unknown;
  proof: unknown;
};
export function createZoneCommands(dependencies: { pool: Pool; access: Access; tokens: KeyRing; clock: () => Date }) {
  const { pool, access, tokens, clock } = dependencies;
  const collections = createCollectionReads({ pool, access, tokens });

  async function validate(
    actor: AccountActor,
    body: ZoneConfigureInput,
    deadline: number,
  ): Promise<PreparedConfiguration> {
    const release = await activeRelease(pool);
    if (!release) throw new ProblemError('semantic_not_ready');
    const violations = validateZoneStarter(platformRegistry, body.configuration, {
      filters: new Set(Object.keys(release.release.filters ?? {})),
    });
    const reserved = body.configuration.pages.flatMap((page, index) =>
      page.route.split('/')[0] === 'subjects' ? [{ pointer: `/pages/${index}/route`, code: 'invalid' as const }] : [],
    );
    if (violations.length || reserved.length)
      throw new ProblemError('invalid_request', {
        errors: [...violations, ...reserved].map((item) => ({
          pointer: `/configuration${item.pointer}`,
          code: item.code === 'limit' ? 'out_of_range' : 'invalid_format',
        })),
      });
    // Existing owning read API supplies current Collection state and native Access, with the caller's actor.
    // Each source checkout is released before the Zone command partition is entered. No source facts are cached.
    const sources = [];
    for (const id of body.mounts) sources.push(await collections.readCollection(actor, id, deadline));
    // Re-enter the owning read at the end of admission, after releasing its earlier checkout. A source
    // changed during preparation must be retried rather than admitting a stale reference witness.
    for (const source of sources) {
      const current = await collections.readCollection(actor, source.id, deadline);
      if (current.revision !== source.revision) throw new ProblemError('conflict');
    }
    return { releaseDigest: release.digest };
  }

  /** Fresh source/config admission belongs to the attempt. Defer validation failure until after authorized
   * receipt lookup so exact replay retains its original result across later release/source changes. */
  function prepareConfiguration(
    base: CommandAuthorization,
    actor: AccountActor,
    body: ZoneConfigureInput | null,
    deadline: number,
    resource: { route: number; id: string },
    action: string,
    fresh: boolean,
  ) {
    const attempts = new WeakMap<AuthoritativeTime, Prepared>();
    const authorization: CommandAuthorization = {
      ...base,
      async prepare(attempt) {
        let configuration: PreparedConfiguration | undefined;
        let failure: unknown;
        if (body) {
          try {
            configuration = await validate(actor, body, deadline);
          } catch (error) {
            failure = error;
          }
        }
        // Composition/source admission can be expensive on a cold process. Mint the native short-lived
        // action proofs last, after every unrelated source checkout has been released.
        const proof = await base.prepare!(attempt);
        const value: Prepared = { proof, configuration, failure };
        if (fresh)
          value.permission = await access.prepare?.(
            actor,
            action,
            resource,
            commandAccessContext({ pool, deadline }, attempt),
          );
        attempts.set(attempt.time, value);
        return value;
      },
      async authorize(tx, attempt, evidence) {
        const value = attempts.get(attempt.time);
        if (!value || evidence !== value) throw new GrantDeniedError();
        const mode = await base.authorize(tx, attempt, value.proof);
        if (fresh && !(await access.authorize(tx, actor, action, resource, value.permission, attempt.time)))
          throw new GrantDeniedError();
        return mode;
      },
      ...(base.finalize
        ? { finalize: (tx, attempt) => base.finalize!(tx, attempt, attempts.get(attempt.time)?.proof) }
        : {}),
    };
    return {
      authorization,
      prepared(attempt: CommandAttempt) {
        const value = attempts.get(attempt.time);
        if (!value) throw new Error('Missing Zone command attempt');
        if (value.failure) throw value.failure;
        return value.configuration;
      },
    };
  }

  async function create(actor: Actor, input: ZoneCreateInput, key: string, deadline: number) {
    requireZoneAccount(actor);
    const route = routeOf(actor.accountId)!;
    const resource = { route, id: newId(route) };
    let provenance: { transactionId: string; at: string } | null = null;
    const base = parentCreationAuthorization({
      access,
      actor,
      action: 'zone:create',
      parent: globalContextAnchor,
      context: {
        pool,
        deadline,
        resource,
        creation: {
          async validate(tx, target, time) {
            const row = await readZoneHead(tx, target.route, target.id);
            return (
              provenance !== null &&
              row !== null &&
              row.creationTransactionId === provenance.transactionId &&
              new Date(row.createdAt).getTime() === Date.parse(authoritativeTimeValue(time))
            );
          },
        },
      },
    });
    const prepared = prepareConfiguration(base, actor, input, deadline, resource, 'zone:create', false);
    const identity = principalCommandIdentity(actor);
    try {
      return await runCommand(
        pool,
        {
          ...identity,
          partition: partitionOf(route),
          deadline,
          clock,
          receipt: { kind: 'zone.create', key, digest: requestDigest('zone.create', actor, input) },
          authorization: prepared.authorization,
        },
        async (tx, command) => {
          const attempt = currentCommand(tx);
          const configuration = prepared.prepared(attempt)!;
          const at = authoritativeTimeValue(command.time);
          provenance = { transactionId: command.transactionId, at };
          const row = await insertZone(tx, {
            ...resource,
            ownerId: actor.accountId,
            visibility: input.visibility,
            configuration: input.configuration,
            mounts: input.mounts,
            releaseDigest: configuration.releaseDigest,
            at,
            transactionId: command.transactionId,
          });
          await initializeResourceGrants(tx, { resource, type: 'semantic.zone', creator: actor.accountId });
          return {
            value: { zone: zoneOwned(row) },
            events: [
              { type: 'com.rezics.zone.created.v1', subject: row.id, data: { id: row.id, revision: row.revision } },
            ],
          };
        },
      );
    } catch (error) {
      if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
      throw error;
    }
  }

  async function mutate(
    actor: Actor,
    id: string,
    operation: 'configure' | 'publish' | 'delete' | 'restore',
    input: ZoneConfigureInput | ZonePublishInput | null,
    expected: string,
    key: string,
    deadline: number,
  ) {
    requireZoneAccount(actor);
    const resource = zoneIdentity(id);
    const action = `zone:${operation}`;
    const base = resourceAuthorization({
      access,
      actor,
      action,
      anchor: {
        resource,
        async validate(client) {
          const row = await readZoneHead(client, resource.route, id);
          if (!row || row.state === 'purged') throw new ProblemError('not_found');
          return true;
        },
      },
      context: { pool, deadline, partition: partitionOf(resource.route) },
    });
    const prepared = prepareConfiguration(
      base,
      actor,
      operation === 'configure' ? (input as ZoneConfigureInput) : null,
      deadline,
      resource,
      action,
      true,
    );
    // Ownership restrictions apply BEFORE receipt lookup, including restore replays.
    const authorization: CommandAuthorization = {
      ...prepared.authorization,
      async authorize(tx, attempt, evidence) {
        const mode = await prepared.authorization.authorize(tx, attempt, evidence);
        if (
          operation === 'restore' &&
          !(await hasZoneOwnerRole(tx, resource.route, id, actor.accountId, authoritativeTimeValue(attempt.time)))
        )
          throw new GrantDeniedError();
        return mode;
      },
    };
    try {
      return await runCommand(
        pool,
        {
          ...principalCommandIdentity(actor),
          partition: partitionOf(resource.route),
          deadline,
          clock,
          authorization,
          receipt: {
            kind: `zone.${operation}`,
            key,
            digest: requestDigest(`zone.${operation}`, actor, { id, expected, input }),
          },
        },
        async (tx, command) => {
          const row = await lockZoneHead(tx, resource.route, id);
          if (!row || row.state === 'purged') throw new ProblemError('not_found');
          if (row.revision !== expected) throw new ProblemError('precondition_failed');
          if (row.writeFenced || !row.configuration || !row.mounts) throw new ProblemError('conflict');
          const configuration = prepared.prepared(currentCommand(tx));
          const at = authoritativeTimeValue(command.time);
          const next: ZoneHead = { ...row };
          if (operation === 'restore') {
            if (row.state !== 'deleted' || !row.restoreUntil || Date.parse(at) >= Date.parse(row.restoreUntil))
              throw new ProblemError('conflict');
            next.state = 'active';
            next.deletedAt = null;
            next.restoreUntil = null;
          } else {
            if (row.state !== 'active') throw new ProblemError('not_found');
            if (operation === 'delete') {
              next.state = 'deleted';
              next.deletedAt = new Date(at).toISOString();
              next.restoreUntil = new Date(Date.parse(at) + WINDOW_MS).toISOString();
            } else if (operation === 'publish') next.visibility = (input as ZonePublishInput).visibility;
            else {
              next.configuration = (input as ZoneConfigureInput).configuration;
              next.mounts = (input as ZoneConfigureInput).mounts;
              next.releaseDigest = configuration!.releaseDigest;
            }
          }
          const updated = await compareAndSetZone(tx, row, next, { at, transactionId: command.transactionId });
          if (!updated) throw new ProblemError('precondition_failed');
          const event = { configure: 'configured', publish: 'published', delete: 'deleted', restore: 'restored' }[
            operation
          ];
          return {
            value: { zone: zoneOwned(updated) },
            events: [{ type: `com.rezics.zone.${event}.v1`, subject: id, data: { id, revision: updated.revision } }],
          };
        },
      );
    } catch (error) {
      if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
      throw error;
    }
  }
  return { create, mutate };
}
