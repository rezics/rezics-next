import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { decodeBoardWatchPage, type BoardWatchCommandResult, type BoardWatchReadResult } from './contract';

type NativeOptions = { headers: { authorization: string }; fetch: { cache: 'no-store' } };
type NativeWriteOptions = NativeOptions & { headers: { authorization: string; 'idempotency-key': string } };
type NativeResponse = Promise<{ status: number; data?: unknown; error?: unknown }>;
type NativeBoardWatch = {
  page: { get(options: NativeOptions): NativeResponse };
  put(body: { watching: boolean; expectedRevision: number }, options: NativeWriteOptions): NativeResponse;
};

export type BoardWatchReadInput = Readonly<{ boardId: string; accountId: string }>;
export type BoardWatchSetInput = BoardWatchReadInput &
  Readonly<{ watching: boolean; expectedRevision: number; idempotencyKey: string }>;

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

export function validateBoardWatchRead(input: unknown): BoardWatchReadInput {
  if (!input || typeof input !== 'object' || !('boardId' in input) || !('accountId' in input))
    throw new Error('Invalid Board watch target');
  if (!validId(input.boardId) || !validId(input.accountId)) throw new Error('Invalid Board watch target');
  return { boardId: input.boardId, accountId: input.accountId };
}

export function validateBoardWatchSet(input: unknown): BoardWatchSetInput {
  const target = validateBoardWatchRead(input);
  if (
    !input ||
    typeof input !== 'object' ||
    !('watching' in input) ||
    typeof input.watching !== 'boolean' ||
    !('expectedRevision' in input) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    (input.expectedRevision as number) < 0 ||
    !('idempotencyKey' in input) ||
    !validId(input.idempotencyKey)
  )
    throw new Error('Invalid Board watch command');
  return {
    ...target,
    watching: input.watching,
    expectedRevision: input.expectedRevision as number,
    idempotencyKey: input.idempotencyKey,
  };
}

/** The private route typing is not published yet; this small adapter consumes its mounted OpenAPI shape. */
function nativeWatch(client: KernelClient, boardId: string): NativeBoardWatch | undefined {
  const board = client.boards({ id: boardId }) as unknown as { watch?: NativeBoardWatch };
  const watch = board.watch;
  if (!watch || typeof watch.page?.get !== 'function' || typeof watch.put !== 'function') return undefined;
  return watch;
}

function readFailure(status: number): BoardWatchReadResult {
  if (status === 401 || status === 403 || status === 404 || status === 410) return { kind: 'access-lost' };
  if (status === 409) return { kind: 'conflict' };
  return { kind: 'unavailable' };
}

export async function readNativeBoardWatchPage(
  client: KernelClient,
  boardId: string,
  accountId: string,
  authorization: string,
): Promise<BoardWatchReadResult> {
  const watch = nativeWatch(client, boardId);
  if (!watch) return { kind: 'unavailable' };
  try {
    const result = await watch.page.get({ headers: { authorization }, fetch: { cache: 'no-store' } });
    if (result.status !== 200 || result.error) return readFailure(result.status);
    const page = decodeBoardWatchPage(result.data, boardId, accountId);
    return page ? { kind: 'current', page } : { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

export async function setNativeBoardWatch(
  client: KernelClient,
  input: BoardWatchSetInput,
  authorization: string,
): Promise<BoardWatchCommandResult> {
  const watch = nativeWatch(client, input.boardId);
  if (!watch) return { kind: 'unknown' };
  try {
    const result = await watch.put(
      { watching: input.watching, expectedRevision: input.expectedRevision },
      {
        headers: { authorization, 'idempotency-key': JSON.stringify(input.idempotencyKey) },
        fetch: { cache: 'no-store' },
      },
    );
    if (result.status === 409) return { kind: 'conflict' };
    if (result.status === 401 || result.status === 403 || result.status === 404 || result.status === 410)
      return { kind: 'refused', reason: 'access-lost' };
    if (result.status === 422 || (result.status >= 400 && result.status < 500))
      return { kind: 'refused', reason: 'denied' };
    if (result.status !== 200 || result.error) return { kind: 'unknown' };
    const value = result.data;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !('watching' in value) ||
      !('revision' in value) ||
      value.watching !== input.watching ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) !== input.expectedRevision + 1
    )
      return { kind: 'unknown' };
    return { kind: 'acknowledged', watching: input.watching, revision: value.revision as number };
  } catch {
    return { kind: 'unknown' };
  }
}

async function ownerOptions(
  input: BoardWatchReadInput,
  request: Request,
  env: Partial<SessionEnv>,
): Promise<{ authorization: string } | null> {
  await prepareSession(request, env);
  const authorization = viewerCredential(request);
  if (!authorization || sessionSubject(request) !== input.accountId) return null;
  return { authorization };
}

export async function readBoardWatchRequest(
  input: BoardWatchReadInput,
  request: Request,
  env: Partial<SessionEnv>,
  client: KernelClient,
): Promise<BoardWatchReadResult> {
  const owner = await ownerOptions(input, request, env);
  if (!owner) return { kind: 'access-lost' };
  return readNativeBoardWatchPage(client, input.boardId, input.accountId, owner.authorization);
}

export async function setBoardWatchRequest(
  input: BoardWatchSetInput,
  request: Request,
  env: Partial<SessionEnv>,
  client: KernelClient,
): Promise<BoardWatchCommandResult> {
  const owner = await ownerOptions(input, request, env);
  if (!owner) return { kind: 'refused', reason: 'access-lost' };
  return setNativeBoardWatch(client, input, owner.authorization);
}
