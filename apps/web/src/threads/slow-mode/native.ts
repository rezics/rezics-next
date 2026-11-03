import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed.ts';
import type { SessionEnv } from '../../session/client.ts';
import { prepareSession, viewerCredential } from '../../session/request.ts';
import {
  isSlowModeInterval,
  parseSlowModePolicy,
  validBoardId,
  type SlowModeChange,
  type SlowModeInterval,
  type SlowModeRead,
} from './contract';

type NativeOptions = { headers: { authorization: string; 'idempotency-key'?: string } };
type NativeResult = Promise<{
  data?: unknown;
  error?: unknown;
  status: number;
  response?: { headers?: Headers };
  headers?: Headers;
}>;

type NativeSlowMode = {
  get: (options: NativeOptions) => NativeResult;
  put: (body: { intervalSeconds: SlowModeInterval }, options: NativeOptions) => NativeResult;
};

/** Bind generated Content methods when present. Do not invent a path or a successful body. */
export function nativeBoardSlowMode(client: KernelClient, boardId: string): NativeSlowMode | undefined {
  const board = client.boards({ id: boardId }) as ReturnType<KernelClient['boards']> & {
    slowMode?: NativeSlowMode;
    'slow-mode'?: NativeSlowMode;
  };
  const resource = board.slowMode ?? board['slow-mode'];
  if (!resource || typeof resource.get !== 'function' || typeof resource.put !== 'function') return undefined;
  return resource;
}

function readOutcome(status: number, body: unknown): SlowModeRead {
  if (status === 401 || status === 403) return { kind: 'denied' };
  if (status === 200 || status === 204) {
    const policy = parseSlowModePolicy(body);
    return policy ? { kind: 'available', policy } : { kind: 'unavailable' };
  }
  return { kind: 'unavailable' };
}

function changeOutcome(status: number, body: unknown): SlowModeChange {
  if (status === 401 || status === 403) return { kind: 'denied' };
  if (status === 409 || status === 412) return { kind: 'conflict' };
  if (status === 200 || status === 204) {
    const policy = parseSlowModePolicy(body);
    return policy ? { kind: 'applied', policy } : { kind: 'unavailable' };
  }
  return { kind: 'unavailable' };
}

export async function readBoardSlowModeRequest(
  boardId: string,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  client: KernelClient,
  originConfigured: boolean,
): Promise<SlowModeRead> {
  if (!validBoardId(boardId) || !originConfigured) return { kind: 'unavailable' };
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return { kind: 'denied' };
    const resource = nativeBoardSlowMode(client, boardId);
    if (!resource) return { kind: 'unavailable' };
    const result = await resource.get({ headers: { authorization } });
    if (result.error) return readOutcome(result.status, result.error);
    return readOutcome(result.status, result.data);
  } catch (error) {
    if (isPlatformClosedError(error)) return { kind: 'unavailable' };
    return { kind: 'unavailable' };
  }
}

export async function changeBoardSlowModeRequest(
  input: { boardId: string; intervalSeconds: SlowModeInterval; idempotencyKey: string },
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  client: KernelClient,
  originConfigured: boolean,
): Promise<SlowModeChange> {
  if (!validBoardId(input.boardId) || !isSlowModeInterval(input.intervalSeconds) || !originConfigured)
    return { kind: 'unavailable' };
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return { kind: 'denied' };
    const resource = nativeBoardSlowMode(client, input.boardId);
    if (!resource) return { kind: 'unavailable' };
    const result = await resource.put(
      { intervalSeconds: input.intervalSeconds },
      { headers: { authorization, 'idempotency-key': input.idempotencyKey } },
    );
    if (result.error) return changeOutcome(result.status, result.error);
    const applied = changeOutcome(result.status, result.data);
    if (applied.kind === 'unavailable' && (result.status === 200 || result.status === 204)) {
      const current = await resource.get({ headers: { authorization } });
      if (current.error) return changeOutcome(current.status, current.error);
      return changeOutcome(current.status, current.data);
    }
    return applied;
  } catch (error) {
    if (isPlatformClosedError(error)) return { kind: 'unavailable' };
    return { kind: 'unknown' };
  }
}
