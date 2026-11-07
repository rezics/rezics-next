/** Installed native Access adapter for Zone resource operations. Composition binds the Access producer here. */

import type { Pool } from 'pg';
import { memoizedValue } from '../../memoized.ts';
import { withConnection } from '../../database/pool.ts';
import {
  AuthenticationError,
  type Access,
  type AccessClient,
  type Actor,
  type Resource,
} from '../../request/access.ts';
import {
  createZoneResourceAccessProducer,
  type ZoneResourceAccessProducer,
} from '../../access/zone-resource-adapter.ts';
import type {
  ZoneAccessBudget,
  ZoneAccessHandle,
  ZoneAccountActor,
  ZoneActor,
  ZoneAuthorizationPage,
  ZoneCreationPort,
  ZoneParentAnchor,
  ZonePublicEligibilityPrepare,
  ZonePublicEligibilityVerify,
  ZoneQueryClient,
  ZoneResourceAccessPort,
  ZoneResourceRef,
} from '../resource-access-port.ts';

function asAccess(handle: ZoneAccessHandle): Access {
  return handle as Access;
}

function asActor(actor: ZoneActor): Actor {
  return actor as Actor;
}

function asAccount(actor: ZoneAccountActor): Extract<Actor, { kind: 'account' }> {
  return actor as Extract<Actor, { kind: 'account' }>;
}

function asClient(client: ZoneQueryClient): AccessClient {
  return client as AccessClient;
}

function asResource(resource: ZoneResourceRef | Readonly<{ route: number; id: string }>): Resource {
  return resource as Resource;
}

function asParent(parent: ZoneParentAnchor) {
  return {
    resource: parent.resource,
    ...(parent.resourceType === undefined ? {} : { resourceType: parent.resourceType }),
    validate: (client: AccessClient, time: Parameters<ZoneParentAnchor['validate']>[1]) =>
      parent.validate(client, time),
  };
}

function asCreation(creation: ZoneCreationPort) {
  return {
    validate: (
      tx: Parameters<ZoneCreationPort['validate']>[0],
      resource: Parameters<ZoneCreationPort['validate']>[1],
      time: Parameters<ZoneCreationPort['validate']>[2],
    ) => creation.validate(tx, resource, time),
  };
}

function asPage(anchor: ZoneAuthorizationPage) {
  return {
    route: anchor.route,
    resourceType: anchor.resourceType,
    ids: anchor.ids,
    validate: (client: AccessClient, time: Parameters<ZoneAuthorizationPage['validate']>[1]) =>
      anchor.validate(client, time),
  };
}

async function withZoneReadTransaction<T>(
  pool: Pool,
  work: (client: ZoneQueryClient) => Promise<T>,
  requireDeadline: (deadline: number) => void,
  deadline?: number,
): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      if (deadline !== undefined) {
        requireDeadline(deadline);
        await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - Date.now()))}ms'`);
      }
      const result = await work(client);
      if (deadline !== undefined) requireDeadline(deadline);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

function install(producer: ZoneResourceAccessProducer): ZoneResourceAccessPort {
  return Object.freeze({
    requireDeadline: producer.requireDeadline,
    commandAccessContext(context: ZoneAccessBudget, attempt) {
      return producer.commandAccessContext(context, attempt);
    },
    parentCreationAuthorization(input) {
      return producer.parentCreationAuthorization({
        access: asAccess(input.access),
        actor: asAccount(input.actor),
        action: input.action,
        parent: asParent(input.parent),
        context: {
          ...input.context,
          resource: asResource(input.context.resource),
          creation: asCreation(input.context.creation),
        },
      });
    },
    resourceAuthorizationPage(input) {
      return producer.resourceAuthorizationPage({
        access: asAccess(input.access),
        actor: asAccount(input.actor),
        action: input.action,
        anchor: asPage(input.anchor),
        context: input.context,
      });
    },
    initializeResourceGrants(tx, input) {
      return producer.initializeResourceGrants(tx, {
        resource: asResource(input.resource),
        type: input.type,
        creator: input.creator,
      });
    },
    prepareAction(access, actor, action, resource, context) {
      return producer.prepareAction(asAccess(access), asAccount(actor), action, asResource(resource), context);
    },
    authorizeAction(client, access, actor, action, resource, permission, time) {
      return producer.authorizeAction(
        asClient(client),
        asAccess(access),
        asAccount(actor),
        action,
        asResource(resource),
        permission,
        time,
      );
    },
    checkAction(access, actor, action, resource, context) {
      return producer.checkAction(asAccess(access), asActor(actor), action, asResource(resource), context);
    },
    createPublicEligibility<E extends {}>(options: {
      resource: Readonly<{ route: number; id: string }>;
      action: string;
      prepare(context: ZonePublicEligibilityPrepare<E>): Promise<E | null | undefined>;
      verify(context: ZonePublicEligibilityVerify<E>): Promise<boolean>;
    }) {
      return producer.createPublicEligibility<E>({
        resource: asResource(options.resource),
        action: options.action,
        prepare: ({ pool, resource }) => options.prepare({ pool, resource }),
        verify: ({ client, resource, evidence }) => options.verify({ client, resource, evidence }),
      });
    },
    readAccount(client, route, accountId) {
      return producer.readAccount(asClient(client), route, accountId);
    },
    readAccountActionStates(client, ids) {
      return producer.readAccountActionStates(asClient(client), ids);
    },
    withReadTransaction<T>(pool: Pool, work: (client: ZoneQueryClient) => Promise<T>, deadline?: number) {
      return withZoneReadTransaction(pool, work, producer.requireDeadline, deadline);
    },
    isGrantDenied: producer.isGrantDenied,
    grantDenied: producer.grantDenied,
    authenticationRequired: () => new AuthenticationError(401, 'Bearer'),
  });
}

/** Native Zone Access adapter. Ordinary composition supplies the Access producer. */
export function createZoneResourceAccess(producer?: ZoneResourceAccessProducer): ZoneResourceAccessPort {
  if (!producer) return memoizedValue(createZoneResourceAccess, () => install(createZoneResourceAccessProducer()));
  return install(producer);
}
