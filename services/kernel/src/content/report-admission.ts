import { ANONYMOUS_PRINCIPAL_ID } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import type { Actor } from '../request/access.ts';
import type { ReportRequestContext } from './reports.ts';

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
