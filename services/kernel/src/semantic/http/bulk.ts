import { memoizedValue } from '../../memoized.ts';
import { withHeaders } from '@elysia/openapi';
import {
  BATCH_LIMIT,
  BatchWriteRequestSchema,
  BatchWriteResultSchema,
  checkBatchWrite,
  type BatchCommand,
  type BatchWriteResult,
  type Source,
} from '@rezics/definitions/bulk';
import { t } from 'elysia';
import type { Pool } from 'pg';
import type { OpenAPIV3 } from 'openapi-types';
import { GrantDeniedError } from '../../access/grant-commands.ts';
import { CommandUnavailableError } from '../../command/command.ts';
import { commandTimingSnapshot } from '../../command/timing.ts';
import { resourceAuthorization } from '../../access/resource-authorization.ts';
import { contentLifecycleOf } from '../adapters/ports.ts';
import { discardConnection, withConnection } from '../../database/pool.ts';
import { customMethod } from '../../http/custom-method.ts';
import {
  PROBLEM_TYPE_BASE,
  ProblemError,
  logInternalError,
  problemResponse,
  problemSchema,
  type FieldError,
} from '../../http/problem.ts';
import { defineRateLimit } from '../../http/rate-limit.ts';
import { SESSION_HEADER } from '../../http/request.ts';
import { readPartition } from '../../partition/partition.ts';
import { accessCommandAuthorization, AuthenticationError, type Access } from '../../request/access.ts';
import { partitionOf, routeOf } from '../../route/route.ts';
import { batchCommand, batchRoute, guardBatchAuthorization } from '../bulk.ts';
import { EditorialConflictError, SubjectNotFoundError } from '../contract/subject-errors.ts';
import { activeRelease } from '../definition-release-read.ts';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from '../contract/subject-values.ts';
import {
  enforceSourceFence,
  FencePending,
  prepareFencePlan,
  readAnchoredFences,
  rememberFences,
  SourceFencedError,
  sourceTuple,
  type SourceFencePlan,
} from '../fences.ts';
import { SubjectInputError } from '../item.ts';
import { SubjectRedirectError } from '../contract/subject-errors.ts';
import { SubjectAccessDeniedError, type SubjectComponent } from '../subject.ts';
import { globalContextAnchor } from '../context.ts';
import type { subjectRoutes } from './subjects.ts';

export const BULK_WRITE_ROUTE = '/v1/subjects:batchWrite';

const TRANSACTION_PHASES = [
  'before_command',
  'command_overhead',
  'time_mint',
  'access_prepare',
  'gate_wait',
  'transaction_pool_wait',
  'transaction_body',
  'commit',
  'writable_wait',
  'contention_pause',
  'request_completion',
] as const;

export type BulkWriteTransactionPhase = (typeof TRANSACTION_PHASES)[number];
export type BulkWriteAction = 'subject:create' | 'statement:propose';
export type BulkWriteProblemBody = {
  type: string;
  title: string;
  status: number;
  code: string;
  retryable: boolean;
  effect_status: string;
  request_id: string;
  detail?: string;
  errors?: FieldError[];
  operation?: BulkWriteAction;
  partition?: number;
  phase?: BulkWriteTransactionPhase;
  contention_retries?: number;
  redirect?: { from: string; to: string };
};

const TRANSACTION_PHASE_SET = new Set<string>(TRANSACTION_PHASES);

export function bulkWriteAction(op: string | undefined): BulkWriteAction {
  return op === 'create' ? 'subject:create' : 'statement:propose';
}

export function bulkWriteUnavailableSchema() {
  return problemSchema(
    'semantic_not_ready',
    'overloaded',
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publicPartition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 65535 ? value : undefined;
}

function publicPhase(value: unknown): BulkWriteTransactionPhase | undefined {
  return typeof value === 'string' && TRANSACTION_PHASE_SET.has(value)
    ? (value as BulkWriteTransactionPhase)
    : undefined;
}

function publicRetries(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000 ? value : undefined;
}

/** Safe RFC9457 extensions: operation, partition and transaction phase only. */
export function bulkWriteDiagnostics(
  error: unknown,
  action: BulkWriteAction,
): Pick<BulkWriteProblemBody, 'operation' | 'partition' | 'phase' | 'contention_retries'> {
  const timing = commandTimingSnapshot();
  const partition = error instanceof CommandUnavailableError ? publicPartition(error.partition) : undefined;
  const phase = publicPhase(timing?.dominant_phase);
  const retries = publicRetries(timing?.contention_retries);
  return {
    operation: action,
    ...(partition === undefined ? {} : { partition }),
    ...(phase === undefined ? {} : { phase }),
    ...(retries === undefined ? {} : { contention_retries: retries }),
  };
}

export function logBulkWriteUnavailable(options: {
  requestId: string;
  action: BulkWriteAction;
  commandIndex: number;
  error: unknown;
  code: string;
}): void {
  const diagnostics = bulkWriteDiagnostics(options.error, options.action);
  const timing = commandTimingSnapshot(true);
  console.error(
    JSON.stringify({
      event: options.code,
      request_id: options.requestId,
      method: 'POST',
      route: BULK_WRITE_ROUTE,
      command_index: options.commandIndex,
      operation: diagnostics.operation,
      ...(diagnostics.partition === undefined ? {} : { partition: diagnostics.partition }),
      ...(timing
        ? {
            elapsed_ms: timing.elapsed_ms,
            phases_ms: timing.phases_ms,
            dominant_phase: timing.dominant_phase,
            contention_retries: timing.contention_retries,
          }
        : diagnostics.phase === undefined
          ? {}
          : { dominant_phase: diagnostics.phase }),
    }),
  );
}

function mapBulkWriteError(
  error: unknown,
  commandIndex: number,
  op: string | undefined,
): { problem: unknown; redirect?: { from: string; to: string } } {
  if (error instanceof SubjectInputError)
    return {
      problem: new ProblemError('invalid_request', {
        errors: error.violations.map((violation) => ({
          ...violation,
          pointer: `/commands/${commandIndex}${op === 'create' ? '/subject' : ''}${violation.pointer}`,
        })),
      }),
    };
  if (error instanceof SubjectNotFoundError) return { problem: new ProblemError('not_found') };
  if (error instanceof EditorialConflictError) return { problem: new ProblemError('conflict') };
  if (error instanceof SubjectRedirectError)
    return { problem: new ProblemError('conflict'), redirect: { from: error.from, to: error.to } };
  if (error instanceof SubjectAccessDeniedError || error instanceof GrantDeniedError)
    return { problem: new ProblemError('forbidden') };
  return { problem: error };
}

export async function bulkWriteCommandProblem(
  error: unknown,
  options: { requestId: string; commandIndex: number; op: string | undefined },
): Promise<{ status: number; problem: BulkWriteProblemBody }> {
  const action = bulkWriteAction(options.op);
  const mapped = mapBulkWriteError(error, options.commandIndex, options.op);
  const response = problemResponse(mapped.problem, {
    method: 'POST',
    id: options.requestId,
    action,
    route: BULK_WRITE_ROUTE,
  });
  if (response.status === 500)
    logInternalError({
      requestId: options.requestId,
      method: 'POST',
      route: BULK_WRITE_ROUTE,
      cause: error,
      commandIndex: options.commandIndex,
    });
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.code !== 'string' || typeof payload.status !== 'number')
    throw new TypeError('bulk write problem payload');
  const problem: BulkWriteProblemBody = {
    ...(payload as BulkWriteProblemBody),
    ...bulkWriteDiagnostics(error, action),
    ...(mapped.redirect ? { redirect: mapped.redirect } : {}),
  };
  if (
    response.status === 503 &&
    (problem.code === 'transaction_retry_exhausted' || problem.code === 'deadline_exceeded')
  )
    logBulkWriteUnavailable({
      requestId: options.requestId,
      action,
      commandIndex: options.commandIndex,
      error,
      code: problem.code,
    });
  return { status: response.status, problem };
}

export function logPendingFenceFailure(requestId: string, commandIndex: number): Error {
  const cause = new Error('Source fence was still pending after the retry pass');
  logInternalError({
    requestId,
    method: 'POST',
    route: BULK_WRITE_ROUTE,
    cause,
    commandIndex,
  });
  return cause;
}

// A malformed command key still needs its own result. Keep the portable success
// shapes while allowing the diagnostic result to echo an empty or invalid key.
function portableResult() {
  return memoizedValue(portableResult, () => BatchWriteResultSchema.properties.results.items.anyOf);
}
function responseSchema() {
  return memoizedValue(responseSchema, () =>
    t.Object({
      results: t.Array(
        t.Union([portableResult()[0], t.Object({ ...portableResult()[1].properties, key: t.String() })]),
        {
          minItems: 1,
          maxItems: BATCH_LIMIT,
        },
      ),
    }),
  );
}

/** `unavailable` is an availability verdict. It is raised only after the command's authorization and source fence. */
type Pending = {
  index: number;
  route: number | null;
  command: BatchCommand;
  errors: FieldError[];
  unavailable?: FieldError;
};

const served = new Set(['facts', 'summary', 'cover']);

function fencedProblem(requestId: string) {
  return {
    type: `${PROBLEM_TYPE_BASE}fenced`,
    title: 'Fenced',
    status: 409,
    code: 'fenced',
    retryable: false,
    effect_status: 'not_applied' as const,
    request_id: requestId,
  };
}

/** One anchored read per media partition. Each cover still gets its own reference probe. */
async function probeCovers(pool: Pool, partition: number, ids: readonly string[]): Promise<Map<string, boolean>> {
  return withConnection(pool, async (connection) => {
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const state = await readPartition(connection, partition);
      if (!state || state.writeState === 'moved')
        throw new CommandUnavailableError(state?.writeState === 'moved' ? 'moved' : 'deadline', partition);
      const available = new Map<string, boolean>();
      const lifecycle = contentLifecycleOf(pool);
      for (const id of ids) available.set(id, (await lifecycle.checkCover(connection, id)) !== null);
      await connection.query('COMMIT');
      return available;
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(connection, rollbackError as Error);
      }
      throw error;
    }
  });
}

async function publishInside(pool: Pool, plan: SourceFencePlan, partition: number): Promise<void> {
  if (!plan.inside.has(partition) || plan.done.has(partition)) return;
  try {
    rememberFences(plan, await readAnchoredFences(pool, partition, plan.inside.get(partition)!));
    plan.done.add(partition);
    plan.release.get(partition)?.();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('Source fence read failed');
    plan.failed.set(partition, failure);
    plan.reject.get(partition)?.(failure);
  }
}

export function bulkRoutes(
  app: ReturnType<typeof subjectRoutes>,
  { pool, routeKey, access, clock }: { pool: Pool; routeKey: Uint8Array; access: () => Access; clock: () => Date },
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
        200: withHeaders(responseSchema(), { [SESSION_HEADER]: t.String() }),
        400: problemSchema('invalid_request'),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        403: problemSchema('forbidden'),
        503: bulkWriteUnavailableSchema(),
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
      const groups = new Map<number, Pending[]>();
      const fatal = new Map<number, unknown>();
      for (let index = 0; index < body.commands.length; index++) {
        const command = body.commands[index] as BatchCommand;
        const prefix = `/commands/${index}`;
        const group = command?.source?.field_group;
        const errors: FieldError[] =
          group !== undefined && !served.has(group)
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
      const covers = new Map<number, { index: number; id: string }[]>();
      for (const group of groups.values()) {
        for (const pending of group) {
          if (pending.errors.length || pending.route === null || pending.command.op !== 'propose') continue;
          if (pending.command.source.field_group !== 'cover') continue;
          const statementValue = pending.command.statement.value;
          const content = statementValue.type === 'value' ? statementValue.content : undefined;
          const pointer = `/commands/${pending.index}/statement/value/content`;
          const mediaRoute = typeof content === 'string' ? routeOf(content) : null;
          if (mediaRoute === null) {
            pending.errors.push({ pointer, code: 'out_of_range' });
            continue;
          }
          const home = partitionOf(mediaRoute);
          const list = covers.get(home) ?? [];
          list.push({ index: pending.index, id: content as string });
          covers.set(home, list);
        }
      }
      await Promise.all(
        [...covers].map(async ([partition, list]) => {
          let available: Map<string, boolean>;
          try {
            available = await probeCovers(
              pool,
              partition,
              list.map((item) => item.id),
            );
          } catch (error) {
            for (const item of list) fatal.set(item.index, error);
            return;
          }
          for (const item of list) {
            if (available.get(item.id) === true) continue;
            for (const group of groups.values()) {
              const pending = group.find((row) => row.index === item.index);
              if (!pending) continue;
              pending.unavailable = {
                pointer: `/commands/${item.index}/statement/value/content`,
                code: 'out_of_range',
              };
              break;
            }
          }
        }),
      );
      const executing: { route: number; source: Source }[] = [];
      for (const group of groups.values()) {
        for (const pending of group) {
          if (pending.errors.length || pending.route === null || fatal.has(pending.index)) continue;
          executing.push({ route: pending.route, source: pending.command.source });
        }
      }
      const { plan, outside } = prepareFencePlan(routeKey, executing);
      await Promise.all(
        [...outside].map(async ([partition, tuples]) => {
          try {
            rememberFences(plan, await readAnchoredFences(pool, partition, tuples));
          } catch (error) {
            plan.failed.set(partition, error instanceof Error ? error : new Error('Source fence read failed'));
          }
        }),
      );
      const runGroup = async (partition: number, jobs: Pending[], deferred: [number, Pending[]][]) => {
        try {
          for (let start = 0; start < jobs.length; start++) {
            const pending = jobs[start]!;
            const key = typeof pending.command?.key === 'string' ? pending.command.key : '';
            try {
              if (fatal.has(pending.index)) throw fatal.get(pending.index);
              if (pending.errors.length) throw new ProblemError('invalid_request', { errors: pending.errors });
              if (pending.route === null) throw new ProblemError('not_found');
              const action = pending.command.op === 'create' ? 'subject:create' : 'statement:propose';
              const authorization = guardBatchAuthorization(
                partitionOf(global.route) === partition
                  ? await accessCommandAuthorization(
                      access(),
                      actor,
                      action,
                      global,
                      { pool, deadline: job.deadline },
                      () => new SubjectAccessDeniedError(),
                    )
                  : resourceAuthorization({
                      access: access(),
                      actor,
                      action,
                      anchor: globalContextAnchor,
                      context: { pool, deadline: job.deadline, partition },
                    }),
                pending.command,
                pending.route,
                async (tx) => {
                  await enforceSourceFence(
                    tx,
                    plan,
                    partitionOf(pending.route!),
                    sourceTuple(routeKey, pending.command.source),
                  );
                  if (pending.unavailable) throw new ProblemError('invalid_request', { errors: [pending.unavailable] });
                },
              );
              const { component, ...result } = await admission.run('normal', job, () =>
                batchCommand(pool, {
                  routeKey,
                  command: pending.command,
                  route: pending.route!,
                  actor,
                  authorization,
                  release,
                  deadline: job.deadline,
                  clock,
                }),
              );
              results[pending.index] = { key, ...result };
              components[pending.index] = component;
            } catch (error) {
              if (error instanceof FencePending) {
                deferred.push([partition, jobs.slice(start)]);
                return;
              }
              if (error instanceof SourceFencedError) {
                results[pending.index] = { key, status: 409, problem: fencedProblem(requestId) };
                continue;
              }
              results[pending.index] = {
                key,
                ...(await bulkWriteCommandProblem(error, {
                  requestId,
                  commandIndex: pending.index,
                  op: pending.command?.op,
                })),
              };
            }
          }
        } finally {
          await publishInside(pool, plan, partition);
        }
      };
      const drive = async (queue: [number, Pending[]][]) => {
        const deferred: [number, Pending[]][] = [];
        let cursor = 0;
        const worker = async () => {
          for (;;) {
            const current = cursor++;
            const item = queue[current];
            if (!item) return;
            await runGroup(item[0], item[1], deferred);
          }
        };
        await Promise.all(Array.from({ length: Math.min(8, queue.length) }, () => worker()));
        return deferred;
      };
      const deferred = await drive([...groups.entries()]);
      const remaining = deferred.length ? await drive(deferred) : [];
      for (const [, jobs] of remaining) {
        for (const pending of jobs) {
          const key = typeof pending.command?.key === 'string' ? pending.command.key : '';
          results[pending.index] = {
            key,
            ...(await bulkWriteCommandProblem(logPendingFenceFailure(requestId, pending.index), {
              requestId,
              commandIndex: pending.index,
              op: pending.command?.op,
            })),
          };
        }
      }
      for (const component of components) if (component) session.record(component);
      return { results };
    },
  );
}
