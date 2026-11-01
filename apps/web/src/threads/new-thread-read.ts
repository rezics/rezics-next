import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';

type BoardResource = ReturnType<KernelClient['boards']>;
type Board = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>['board'];

export type NewThreadPageResult = { board: Board; idempotencyKey: string; readerSubject: string };

/** Preparing a composer reads its board with current authority; submission authorizes separately. */
export async function loadNewThreadPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { id: string; expectedReaderSubject: string },
): Promise<NewThreadPageResult> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const readerSubject = sessionSubject(request);
  if (!authorization) throw new Error('A signed-in session is required to start a thread.');
  if (!readerSubject || readerSubject !== input.expectedReaderSubject) throw notFound();

  const result = await client.boards({ id: input.id }).get({ headers: { authorization } });
  if (result.error || !result.data) {
    if (result.status === 404) throw notFound();
    throw new Error('Kernel board read failed');
  }
  if (result.data.board.id !== input.id) throw notFound();
  return { board: result.data.board, idempotencyKey: crypto.randomUUID(), readerSubject };
}
