import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';

type BoardResource = ReturnType<KernelClient['boards']>;
type Board = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>['board'];

/** Preparing a composer reads its board with current authority; submission authorizes separately. */
export async function loadNewThreadPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { id: string },
): Promise<{ board: Board; idempotencyKey: string }> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization) throw new Error('A signed-in session is required to start a thread.');

  const result = await client.boards({ id: input.id }).get({ headers: { authorization } });
  if (result.error || !result.data) {
    if (result.status === 404) throw notFound();
    throw new Error('Kernel board read failed');
  }
  if (result.data.board.id !== input.id) throw notFound();
  return { board: result.data.board, idempotencyKey: crypto.randomUUID() };
}
