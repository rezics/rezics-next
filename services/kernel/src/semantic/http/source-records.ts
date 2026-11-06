import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { Pool } from 'pg';
import type { OpenAPIV3 } from 'openapi-types';
import { GrantDeniedError } from '../../access/grant-commands.ts';
import { resourceAuthorization } from '../../access/resource-authorization.ts';
import { importedTupleRouteOf } from '../adapters/imported-route.ts';
import { customMethod } from '../../http/custom-method.ts';
import { ProblemError, problemSchema } from '../../http/problem.ts';
import { defineRateLimit } from '../../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, requestDigest, SESSION_HEADER } from '../../http/request.ts';
import { AuthenticationError, type Access } from '../../request/access.ts';
import { partitionOf } from '../../route/route.ts';
import { globalContextAnchor } from '../context.ts';
import {
  SOURCE_RECORD_METADATA,
  SourceRecordMetadataCommandSchema,
  SourceRecordMetadataConflictError,
  SourceRecordMetadataInputError,
  SourceRecordMetadataResultSchema,
  validateSourceRecordMetadata,
  writeSourceRecordMetadata,
  type SourceRecordMetadataCommand,
} from '../source-records.ts';
import type { subjectRoutes } from './subjects.ts';

/** Reuses only Global trusted bulk permission. No source alias can mint a grant. */
export function sourceRecordRoutes(
  app: ReturnType<typeof subjectRoutes>,
  { pool, routeKey, access, clock }: { pool: Pool; routeKey: Uint8Array; access: () => Access; clock: () => Date },
) {
  return app.post(
    customMethod('/v1/source-records', 'setMetadata'),
    {
      // Keep native metadata validation's 422 boundary, including closed nested objects.
      body: t.Unsafe<SourceRecordMetadataCommand>(t.Any()),
      headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
      response: {
        200: withHeaders(SourceRecordMetadataResultSchema, { [SESSION_HEADER]: t.String() }),
        201: withHeaders(SourceRecordMetadataResultSchema, { [SESSION_HEADER]: t.String() }),
        400: problemSchema('invalid_request'),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        403: problemSchema('forbidden'),
        409: problemSchema('source_record_metadata_conflict'),
        422: problemSchema('invalid_source_record_metadata', 'idempotency_conflict'),
        503: problemSchema('overloaded', 'deadline_exceeded', 'partition_unavailable', 'transaction_retry_exhausted'),
      },
      detail: {
        operationId: SOURCE_RECORD_METADATA,
        'x-exposure': 'public',
        'x-action': 'subject:batch_write',
        'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: SourceRecordMetadataCommandSchema as unknown as OpenAPIV3.SchemaObject },
          },
        },
      },
    },
    async ({ body, headers, actor, admission, job, session, set }) => {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      try {
        validateSourceRecordMetadata(body);
        const home = importedTupleRouteOf(pool)(routeKey, body.source, body.external_id);
        const authorization = resourceAuthorization({
          access: access(),
          actor,
          action: 'subject:batch_write',
          anchor: globalContextAnchor,
          context: { pool, deadline: job.deadline, partition: partitionOf(home) },
        });
        const result = await admission.run('normal', job, () =>
          writeSourceRecordMetadata(pool, {
            command: body,
            validated: true,
            routeKey,
            actor,
            authorization,
            deadline: job.deadline,
            clock,
            idempotencyKey: idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
            digest: requestDigest(SOURCE_RECORD_METADATA, actor, body),
          }),
        );
        session.record(result.component);
        set.status = result.status;
        return result.value;
      } catch (error) {
        if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
        if (error instanceof SourceRecordMetadataInputError || error instanceof SourceRecordMetadataConflictError) {
          throw new ProblemError(
            error instanceof SourceRecordMetadataConflictError
              ? 'source_record_metadata_conflict'
              : 'invalid_source_record_metadata',
          );
        }
        throw error;
      }
    },
  );
}
