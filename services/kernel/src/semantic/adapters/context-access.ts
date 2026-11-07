import type { Pool } from 'pg';
import { memoizedValue } from '../../memoized.ts';
import { deadlineClient } from '../../access/authenticate.ts';
import { requireAccessDeadline } from '../../access/unavailable.ts';
import { GrantDeniedError } from '../../access/resource-access-errors.ts';
import {
  createResourcePublicEligibility,
  initializeResourceGrants,
  resourceAuthorization,
  viewerActionReadTime,
} from '../../access/index.ts';
import { prepareReadDecisions, type Access, type AccessClient, type Actor } from '../../request/access.ts';
import { ProblemError } from '../../http/problem-error.ts';
import { withReadTransaction } from '../read.ts';
import { refreshSemanticErasureSourceRecord } from '../account-erasure.ts';
import {
  readSemanticSourceDisposition,
  recordSemanticSourceCommit,
  recordSemanticSourceDisposition,
} from '../erasure-producer.ts';
import type {
  ContextAccessHandle,
  ContextAccessPort,
  ContextActor,
  ContextPublicEligibilityPrepare,
  ContextPublicEligibilityVerify,
  ContextQueryClient,
  ContextReadDecisions,
  ContextResource,
} from '../context-access-port.ts';

function asAccess(handle: ContextAccessHandle): Access {
  return handle as Access;
}

function asActor(actor: ContextActor): Actor {
  return actor as Actor;
}

function asClient(client: ContextQueryClient): AccessClient {
  return client as AccessClient;
}

/** Native Access authorization, snapshot, eligibility and Source-erasure adapter. Composition binds it. */
export function nativeContextAccess(): ContextAccessPort {
  return memoizedValue(nativeContextAccess, () =>
    Object.freeze({
      deadlineClient(client: ContextQueryClient, deadline: number) {
        return deadlineClient(asClient(client), deadline);
      },
      requireDeadline: requireAccessDeadline,
      withReadTransaction<T>(pool: Pool, read: (client: ContextQueryClient) => Promise<T>, deadline?: number) {
        return withReadTransaction(pool, (client) => read(client), deadline);
      },
      prepareReadDecisions(access: ContextAccessHandle, input) {
        return prepareReadDecisions(asAccess(access), {
          actor: asActor(input.actor),
          actions: input.actions,
          context: input.context,
        }) as Promise<ContextReadDecisions>;
      },
      viewerActionReadTime(access: ContextAccessHandle, context) {
        return viewerActionReadTime(asAccess(access), context);
      },
      resourceAuthorization(input) {
        return resourceAuthorization({
          access: asAccess(input.access),
          actor: asActor(input.actor),
          action: input.action,
          anchor: {
            resource: input.anchor.resource,
            ...(input.anchor.resourceType === undefined ? {} : { resourceType: input.anchor.resourceType }),
            validate: (client, time) => input.anchor.validate(client, time),
          },
          context: input.context,
        });
      },
      initializeResourceGrants,
      createPublicEligibility<E extends {}>(options: {
        resource: ContextResource;
        action: string;
        prepare(context: ContextPublicEligibilityPrepare<E>): Promise<E | null | undefined>;
        verify(context: ContextPublicEligibilityVerify<E>): Promise<boolean>;
      }) {
        return createResourcePublicEligibility<E>({
          resource: options.resource,
          action: options.action,
          prepare: ({ pool, resource }) => options.prepare({ pool, resource }),
          verify: ({ client, resource, evidence }) => options.verify({ client, resource, evidence }),
        });
      },
      async readAccount(client, route, accountId) {
        const found = await client.query<{ state: string; fenced: boolean }>(
          'SELECT state, authn_fenced AS fenced FROM access.account WHERE route=$1 AND account_id=$2',
          [route, accountId],
        );
        return found.rows[0] ?? null;
      },
      requestInvalid: () => new ProblemError('invalid_request'),
      notFound: () => new ProblemError('not_found'),
      lifecycleDenied: () => new GrantDeniedError(),
      refreshErasureSourceRecord: refreshSemanticErasureSourceRecord,
      readSourceDisposition: readSemanticSourceDisposition,
      recordSourceDisposition: recordSemanticSourceDisposition,
      recordSourceCommit: recordSemanticSourceCommit,
    }),
  );
}
