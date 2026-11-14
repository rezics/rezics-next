import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { readYearlyGoal } from './yearly-goal-native';
import type { YearlyGoalReadResult } from './yearly-goal-page';

export type YearlyGoalReadRequest = { year: number; viewer: string };

function readInput(value: unknown): YearlyGoalReadRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid yearly goal read');
  const input = value as Record<string, unknown>;
  if (
    !Number.isInteger(input.year) ||
    (input.year as number) < 1 ||
    (input.year as number) > 9999 ||
    typeof input.viewer !== 'string' ||
    input.viewer.length < 1 ||
    input.viewer.length > 128
  )
    throw new Error('Invalid yearly goal read');
  return { year: input.year as number, viewer: input.viewer };
}

/** Private payloads enter only a mounted browser visit, never a loader or shared query. */
export const readPrivateYearlyGoal = createServerFn({ method: 'GET' })
  .validator(readInput)
  .handler(async ({ data }): Promise<YearlyGoalReadResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    if (await prepareSession(request, env as Partial<SessionEnv>, { refresh: false })) return { state: 'retired' };
    const authorization = viewerCredential(request);
    if (!authorization || request.headers.has('authorization') || sessionSubject(request) !== data.viewer)
      return { state: 'retired' };
    return readYearlyGoal(kernelClient(), authorization, data.year, request.signal);
  });
