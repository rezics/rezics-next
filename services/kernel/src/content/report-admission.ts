import { communityReportReadCheck, communityReportTargetFacts } from '../community/report-targets.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { ANONYMOUS_PRINCIPAL_ID } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import { accessCheck, type Actor } from '../request/access.ts';
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
    requestId: Bun.randomUUIDv7(),
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
  await within(context.deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(client, partitionOf(route));
        if (!partition || partition.writeState === 'moved' || !(await check(client)) ||
          (nativeTarget && (!(await communityReportTargetFacts(client, nativeTarget)) || !(await readable!(client)))))
          throw new ProblemError('not_found');
        await client.query('COMMIT');
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}
