import { contentRequestId } from './adapters/bind.ts';
import { communityReportReadCheck, communityReportTargetFacts } from '../community/report-targets.ts';
import { accessCheck } from './access-port.ts';
import {
  AccessUnavailableError,
  CommandUnavailableError,
  classifyUnavailability,
  throwAccessUnavailable,
} from '../access/unavailable.ts';
import { withBoundedReadOnlyTransaction } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { ANONYMOUS_PRINCIPAL_ID } from '../command/command.ts';
import { ProblemError } from '../http/problem-error.ts';
import { IDEMPOTENCY_HEADER } from '@rezics/operations/protocol';
import { idempotencyKeyOf } from '../http/idempotency-key.ts';
import type { AccessClient, Actor } from '../request/access.ts';
import type { ReportDependencies, ReportRequestContext } from './reports.ts';

/** The shared request stage has already charged report/1 before this runs.
 * Proof stays ephemeral: only createReport's front phase may verify the token.
 */
export function reportRequestContext(
  actor: Actor,
  request: Request,
  deadline: number,
  botToken: string | undefined,
): ReportRequestContext {
  return {
    idempotencyKey: idempotencyKeyOf(
      request.headers.get(IDEMPOTENCY_HEADER),
      actor.kind === 'anonymous'
        ? { kind: 'anonymous', id: ANONYMOUS_PRINCIPAL_ID }
        : { kind: 'account', id: actor.accountId },
    ),
    deadline,
    requestId: contentRequestId(),
    ...(botToken === undefined ? {} : { botToken }),
  };
}

const MAX_REPORT_BYTES = 64 * 1024;

/** Bounded transport parsing, independent of total content or subject volume. */
export async function parseReportBody(
  { request, contentType }: { request: Request; contentType: string },
  oversized: WeakSet<Request>,
): Promise<unknown> {
  if (contentType !== 'application/json' || !request.body) throw new ProblemError('invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPORT_BYTES) {
        await reader.cancel();
        oversized.add(request);
        return {};
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

/** The page adapter uses an empty internal page for denied reads. HTTP must
 * distinguish admission from an authorized empty page without inspecting any
 * report references. Use the shared Access formula on the target's own anchor.
 */
export async function requireReportInspection(
  dependencies: ReportDependencies,
  targetId: string,
  context: { actor: Actor; deadline: number },
  nativeKind?: 'space' | 'realm',
): Promise<void> {
  const route = routeOf(targetId);
  if (route === null || context.actor.kind !== 'account') throw new ProblemError('not_found');
  const check = await accessCheck(
    dependencies.access,
    context.actor,
    'moderation:read_reports',
    { route, id: targetId },
    { pool: dependencies.pool, deadline: context.deadline },
  );
  const nativeTarget = nativeKind ? { kind: nativeKind, id: targetId } : undefined;
  const readable = nativeTarget ? await communityReportReadCheck(dependencies, nativeTarget, context) : null;
  let readFailed = false;
  let readFailure: unknown;
  const snapshot = withBoundedReadOnlyTransaction(
    dependencies.pool,
    context.deadline,
    async (client) => {
      try {
        const accessClient = client as AccessClient;
        const partition = await readPartition(client, partitionOf(route));
        if (
          !partition ||
          partition.writeState === 'moved' ||
          !(await check(accessClient)) ||
          (nativeTarget &&
            (!(await communityReportTargetFacts(accessClient, nativeTarget)) || !(await readable!(accessClient))))
        )
          throw new ProblemError('not_found');
      } catch (error) {
        readFailed = true;
        readFailure = error;
        throw error;
      }
    },
    {
      deadlineError: () => new AccessUnavailableError('deadline'),
      mapError(error: unknown) {
        if (error instanceof CommandUnavailableError) return error;
        try {
          throwAccessUnavailable(error);
        } catch (mapped) {
          return mapped;
        }
        return error;
      },
      isUncertainError: (error: unknown) => classifyUnavailability(error) !== undefined,
      isUncertainSettledQueryError: () => true,
    },
  );
  await snapshot.catch((error: unknown) => {
    if (readFailed) throw readFailure;
    throw error;
  });
}
