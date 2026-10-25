import { withHeaders } from '@elysia/openapi';
import {
  BATCH_LIMIT,
  BatchWriteRequestSchema,
  BatchWriteResultSchema,
  checkBatchWrite,
  type BatchCommand,
  type BatchWriteResult,
} from '@rezics/definitions/bulk';
import { t } from 'elysia';
import type { Pool } from 'pg';
import type { OpenAPIV3 } from 'openapi-types';
import { GrantDeniedError } from '../../access/grant-commands.ts';
import { withConnection } from '../../database/pool.ts';
import { customMethod } from '../../http/custom-method.ts';
import { ProblemError, problemResponse, problemSchema, type FieldError } from '../../http/problem.ts';
import { defineRateLimit } from '../../http/rate-limit.ts';
import { SESSION_HEADER } from '../../http/request.ts';
import { accessCommandAuthorization, AuthenticationError, type Access } from '../../request/access.ts';
import { partitionOf } from '../../route/route.ts';
import { batchCommand, batchRoute } from '../bulk.ts';
import { EditorialConflictError, SubjectNotFoundError } from '../candidates.ts';
import { activeRelease, GLOBAL_CONTEXT } from '../definitions.ts';
import { SubjectInputError } from '../item.ts';
import { SubjectRedirectError } from '../merges.ts';
import { SubjectAccessDeniedError, type SubjectComponent } from '../subject.ts';
import type { subjectRoutes } from './subjects.ts';

// A malformed command key still needs its own result. Keep the portable success
// shapes while allowing the diagnostic result to echo an empty or invalid key.
const portableResult = BatchWriteResultSchema.properties.results.items.anyOf;
const responseSchema = t.Object({
  results: t.Array(t.Union([portableResult[0], t.Object({ ...portableResult[1].properties, key: t.String() })]), {
    minItems: 1,
    maxItems: BATCH_LIMIT,
  }),
});

export function bulkRoutes(
  app: ReturnType<typeof subjectRoutes>,
  { pool, routeKey, access }: { pool: Pool; routeKey: Uint8Array; access: () => Access },
) {
  return app.post(
    customMethod('/v1/subjects', 'batchWrite'),
    {
      // Native validation bounds the request before the shared rate stage. The
      // portable validator retains command diagnostics instead of rejecting peers.
      body: t.Object(
        { commands: t.Array(t.Unsafe<BatchCommand>(t.Any()), { minItems: 1, maxItems: BATCH_LIMIT }) },
        { additionalProperties: false },
      ),
      response: {
        200: withHeaders(responseSchema, { [SESSION_HEADER]: t.String() }),
        400: problemSchema('invalid_request'),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        403: problemSchema('forbidden'),
        503: problemSchema('semantic_not_ready', 'overloaded', 'deadline_exceeded'),
      },
      detail: {
        operationId: 'subject.batch_write',
        'x-exposure': 'public',
        'x-action': 'subject:batch_write',
        'x-rate-limit': defineRateLimit({ family: 'write', units: 'commands' }),
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: BatchWriteRequestSchema as unknown as OpenAPIV3.SchemaObject } },
        },
      },
    },
    async ({ body, actor, authorize, admission, job, session }) => {
      const requestId = Bun.randomUUIDv7();
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const global = { route: 0, id: GLOBAL_CONTEXT };
      const permission = await authorize(global);
      const allowed = await admission.run('normal', job, () => withConnection(pool, (tx) => permission(tx)));
      if (!allowed) throw new ProblemError('forbidden');
      const release = await admission.run('normal', job, () => activeRelease(pool));
      if (!release) throw new ProblemError('semantic_not_ready');
      const violations = checkBatchWrite(body, release.release) as FieldError[];
      if (violations.some(({ pointer }) => !/^\/commands\/\d+(?:\/|$)/.test(pointer)))
        throw new ProblemError('invalid_request', { errors: violations });
      const results: BatchWriteResult['results'] = new Array(body.commands.length);
      const components: (SubjectComponent | undefined)[] = new Array(body.commands.length);
      const groups = new Map<
        number,
        { index: number; route: number | null; command: BatchCommand; errors: FieldError[] }[]
      >();
      for (let index = 0; index < body.commands.length; index++) {
        const command = body.commands[index] as BatchCommand;
        const prefix = `/commands/${index}`;
        const group = command?.source?.field_group;
        const errors: FieldError[] =
          group !== undefined && group !== 'facts'
            ? [{ pointer: `${prefix}/source/field_group`, code: 'unsupported' }]
            : violations.filter(({ pointer }) => pointer === prefix || pointer.startsWith(`${prefix}/`));
        let route: number | null = null;
        if (!errors.length) {
          try {
            route = batchRoute(routeKey, command);
          } catch {
            errors.push({ pointer: `${prefix}/source/external_id`, code: 'invalid_format' });
          }
        }
        const partition = route === null ? -1 : partitionOf(route);
        const pending = groups.get(partition) ?? [];
        pending.push({ index, route, command, errors });
        groups.set(partition, pending);
      }
      const pending = [...groups.values()];
      let next = 0;
      const worker = async () => {
        while (next < pending.length) {
          const group = pending[next++]!;
          for (const { index, route, command, errors } of group) {
            const key = typeof command?.key === 'string' ? command.key : '';
            try {
              if (errors.length) throw new ProblemError('invalid_request', { errors });
              if (route === null) throw new ProblemError('not_found');
              const authorization = await accessCommandAuthorization(
                access(),
                actor,
                command.op === 'create' ? 'subject:create' : 'statement:propose',
                global,
                { pool, deadline: job.deadline },
                () => new SubjectAccessDeniedError(),
              );
              const { component, ...result } = await admission.run('normal', job, () =>
                batchCommand(pool, { command, route, actor, authorization, release, deadline: job.deadline }),
              );
              results[index] = { key, ...result };
              components[index] = component;
            } catch (error) {
              let problem = error;
              if (error instanceof SubjectInputError)
                problem = new ProblemError('invalid_request', {
                  errors: error.violations.map((violation) => ({
                    ...violation,
                    pointer: `/commands/${index}${command.op === 'create' ? '/subject' : ''}${violation.pointer}`,
                  })),
                });
              if (error instanceof SubjectNotFoundError) problem = new ProblemError('not_found');
              if (error instanceof EditorialConflictError || error instanceof SubjectRedirectError)
                problem = new ProblemError('conflict');
              if (error instanceof SubjectAccessDeniedError || error instanceof GrantDeniedError)
                problem = new ProblemError('forbidden');
              const response = problemResponse(problem, {
                method: 'POST',
                id: requestId,
                action: command?.op === 'create' ? 'subject:create' : 'statement:propose',
              });
              const payload = await response.json();
              if (error instanceof SubjectRedirectError) payload.redirect = { from: error.from, to: error.to };
              results[index] = { key, status: response.status, problem: payload };
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, pending.length) }, () => worker()));
      for (const component of components) if (component) session.record(component);
      return { results };
    },
  );
}
