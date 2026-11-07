/** Public Access producer for Zone resource command and read operations. Composition binds it; Zone does not import these internals. */

import type { Pool } from 'pg';
import { memoizedValue } from '../memoized.ts';
import { commandAccessContext } from './command-admission.ts';
import { parentCreationAuthorization, type ParentAnchor, type ResourceCreationPort } from './parent-creation.ts';
import { resourceAuthorizationPage, type AuthorizationAnchorPage } from './resource-authorization.ts';
import { initializeResourceGrants } from './resource-initialization.ts';
import { readAccount } from './account-data.ts';
import { readAccountActionStates } from './account-viewer-actions.ts';
import { createResourcePublicEligibility } from './public-eligibility.ts';
import { requireAccessDeadline } from './unavailable.ts';
import { GrantDeniedError } from './resource-access-errors.ts';
import {
  accessCheck,
  type Access,
  type AccessClient,
  type AccessContext,
  type Actor,
  type Resource,
} from '../request/access.ts';
import type {
  AuthoritativeTime,
  CommandAttempt,
  CommandAuthorization,
  CommandTransaction,
} from '../command/command.ts';

export type ZoneResourceAccessClient = AccessClient;
export type ZoneResourceAccessActor = Extract<Actor, { kind: 'account' }>;
export type ZoneResourceAccessHandle = Access;

export type ZoneResourceAccountSnapshot = Readonly<{
  id: string;
  kind: string;
  state: string;
  fenced: boolean;
  minimumAuthnEpoch: bigint;
  transactionId: string;
}>;
export type ZoneResourceAccountActionState = Readonly<{
  id: string;
  kind: string;
  state: string;
  fenced: boolean;
}>;

export type ZoneResourceAccessProducer = Readonly<{
  requireDeadline(deadline: number): void;
  commandAccessContext(context: AccessContext, attempt: CommandAttempt): AccessContext;
  parentCreationAuthorization(input: {
    access: Access;
    actor: Actor;
    action: string;
    parent: ParentAnchor;
    context: AccessContext & { resource: Resource; creation: ResourceCreationPort };
  }): CommandAuthorization;
  resourceAuthorizationPage(input: {
    access: Access;
    actor: Actor;
    action: string;
    anchor: AuthorizationAnchorPage;
    context: AccessContext & { partition: number };
  }): CommandAuthorization;
  initializeResourceGrants(
    tx: CommandTransaction,
    input: { resource: Resource; type: string; creator: string },
  ): Promise<void>;
  prepareAction(
    access: Access,
    actor: Extract<Actor, { kind: 'account' }>,
    action: string,
    resource: Resource,
    context: AccessContext,
  ): Promise<unknown>;
  authorizeAction(
    client: AccessClient,
    access: Access,
    actor: Extract<Actor, { kind: 'account' }>,
    action: string,
    resource: Resource,
    permission: unknown,
    time: AuthoritativeTime,
  ): Promise<boolean>;
  checkAction(
    access: Access,
    actor: Actor,
    action: string,
    resource: Resource,
    context: AccessContext,
  ): Promise<(client: AccessClient, time?: AuthoritativeTime) => Promise<boolean>>;
  createPublicEligibility<E extends {}>(options: {
    resource: Resource;
    action: string;
    prepare(context: { pool: Pool; resource: Resource }): Promise<E | null | undefined>;
    verify(context: { client: AccessClient; resource: Resource; evidence: E }): Promise<boolean>;
  }): unknown;
  readAccount(client: AccessClient, route: number, accountId: string): Promise<ZoneResourceAccountSnapshot | null>;
  readAccountActionStates(
    client: AccessClient,
    ids: readonly string[],
  ): Promise<readonly ZoneResourceAccountActionState[]>;
  isGrantDenied(error: unknown): boolean;
  grantDenied(): GrantDeniedError;
}>;

function snapshot(row: Awaited<ReturnType<typeof readAccount>>): ZoneResourceAccountSnapshot | null {
  if (!row) return null;
  return {
    id: row.accountId,
    kind: row.kind,
    state: row.state,
    fenced: row.fenced,
    minimumAuthnEpoch: row.minimumAuthnEpoch,
    transactionId: row.transactionId,
  };
}

/** Native Access command admission, grant initialization, account snapshots and public eligibility. */
export function createZoneResourceAccessProducer(): ZoneResourceAccessProducer {
  return memoizedValue(createZoneResourceAccessProducer, () =>
    Object.freeze({
      requireDeadline: requireAccessDeadline,
      commandAccessContext,
      parentCreationAuthorization,
      resourceAuthorizationPage,
      initializeResourceGrants,
      prepareAction(access, actor, action, resource, context) {
        return access.prepare?.(actor, action, resource, context) ?? Promise.resolve(null);
      },
      authorizeAction(client, access, actor, action, resource, permission, time) {
        return access.authorize(client, actor, action, resource, permission, time);
      },
      checkAction(access, actor, action, resource, context) {
        return accessCheck(access, actor, action, resource, context);
      },
      createPublicEligibility<E extends {}>(options: {
        resource: Resource;
        action: string;
        prepare(context: { pool: Pool; resource: Resource }): Promise<E | null | undefined>;
        verify(context: { client: AccessClient; resource: Resource; evidence: E }): Promise<boolean>;
      }) {
        return createResourcePublicEligibility<E>({
          resource: options.resource,
          action: options.action,
          prepare: async ({ pool, resource }) => {
            const evidence = await options.prepare({ pool, resource });
            if (evidence === null || evidence === undefined) throw new Error('Missing resource eligibility evidence');
            return evidence;
          },
          verify: ({ client, resource, evidence }) => options.verify({ client, resource, evidence }),
        });
      },
      async readAccount(client, route, accountId) {
        return snapshot(await readAccount(client, route, accountId));
      },
      async readAccountActionStates(client, ids) {
        const rows = await readAccountActionStates(client, ids);
        return rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          state: row.state,
          fenced: row.fenced,
        }));
      },
      isGrantDenied(error: unknown) {
        return error instanceof GrantDeniedError;
      },
      grantDenied: () => new GrantDeniedError(),
    }),
  );
}
