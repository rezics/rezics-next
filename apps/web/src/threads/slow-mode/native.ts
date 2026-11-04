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

/** Direct installed method, with no legacy route aliases or optional generated casts. */
export function nativeBoardSlowMode(client: KernelClient, boardId: string) {
  return client.boards({ id: boardId }).slowMode;
}

function readOutcome(status: number, body: unknown): SlowModeRead {
  if (status === 401 || status === 403) return { kind: 'denied' };
  if (status === 200) {
    const policy = parseSlowModePolicy(body);
    return policy ? { kind: 'available', policy } : { kind: 'unavailable' };
  }
  return { kind: 'unavailable' };
}

function changeOutcome(status: number, body: unknown, intervalSeconds: number): SlowModeChange {
  if (status === 401 || status === 403) return { kind: 'denied' };
  if (status === 409 || status === 412) return { kind: 'conflict' };
  if (status === 200) {
    const policy = parseSlowModePolicy(body);
    return policy?.intervalSeconds === intervalSeconds ? { kind: 'applied', policy } : { kind: 'unknown' };
  }
  return { kind: 'unknown' };
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
      { headers: { authorization, 'idempotency-key': JSON.stringify(input.idempotencyKey) } },
    );
    if (result.error) return changeOutcome(result.status, result.error.value, input.intervalSeconds);
    return changeOutcome(result.status, result.data, input.intervalSeconds);
  } catch (error) {
    if (isPlatformClosedError(error)) return { kind: 'unavailable' };
    return { kind: 'unknown' };
  }
}
