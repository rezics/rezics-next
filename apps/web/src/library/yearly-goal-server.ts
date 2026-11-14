import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareExpectedReader, validExpectedReader, type ExpectedReader } from '../session/expected-reader';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { captureEntryRestoreCredential, originalEntryRestoreCredential } from './entry-restore-credential';
import { readYearlyGoal, writeYearlyGoal, YEARLY_GOAL_METRIC } from './yearly-goal-native';
import type { YearlyGoalCommand, YearlyGoalReadResult, YearlyGoalWriteResult } from './yearly-goal-page';

export type YearlyGoalReadRequest = { year: number; viewer: string };
export type YearlyGoalDispatch = ExpectedReader & { credential: string; command: YearlyGoalCommand };
export type YearlyGoalPreparation = { state: 'ready'; credential: string } | { state: 'retired' | 'unavailable' };

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

function readerInput(value: unknown): ExpectedReader {
  if (!validExpectedReader(value)) throw new Error('Invalid yearly goal reader');
  return { expectedReader: value.expectedReader, expectedCredential: value.expectedCredential };
}

function dispatchInput(value: unknown): YearlyGoalDispatch {
  const reader = readerInput(value);
  const input = value as Record<string, unknown>;
  if (
    typeof input.credential !== 'string' ||
    input.credential.length > 3200 ||
    !/^[A-Za-z0-9_-]+$/.test(input.credential) ||
    !input.command ||
    typeof input.command !== 'object' ||
    Array.isArray(input.command)
  )
    throw new Error('Invalid yearly goal dispatch');
  const command = input.command as Record<string, unknown>;
  if (
    Object.keys(command).length !== 5 ||
    !Number.isInteger(command.year) ||
    (command.year as number) < 1 ||
    (command.year as number) > 9999 ||
    command.metric !== YEARLY_GOAL_METRIC ||
    !(
      command.target === null ||
      (Number.isInteger(command.target) && (command.target as number) >= 1 && (command.target as number) <= 1000)
    ) ||
    !(
      command.expectedRevision === null ||
      (typeof command.expectedRevision === 'string' && /^[1-9][0-9]*$/.test(command.expectedRevision))
    ) ||
    (command.target === null && command.expectedRevision === null) ||
    typeof command.idempotencyKey !== 'string' ||
    command.idempotencyKey.length < 3 ||
    command.idempotencyKey.length > 1024
  )
    throw new Error('Invalid yearly goal command');
  return { ...reader, credential: input.credential, command: command as YearlyGoalCommand };
}

async function preparedCommandRequest(reader: ExpectedReader) {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  if (
    request.method !== 'POST' ||
    request.headers.has('authorization') ||
    request.headers.get('x-csrf-token') !== reader.expectedCredential ||
    !(await prepareExpectedReader(request, env as Partial<SessionEnv>, reader))
  )
    return null;
  return request;
}

/** Seal the actual dispatch bearer before PUT; retry never captures a replacement bearer. */
export const preparePrivateYearlyGoal = createServerFn({ method: 'POST' })
  .validator(readerInput)
  .handler(async ({ data }): Promise<YearlyGoalPreparation> => {
    const request = await preparedCommandRequest(data);
    if (!request) return { state: 'retired' };
    const credential = await captureEntryRestoreCredential(request, env as Partial<SessionEnv>);
    return credential ? { state: 'ready', credential } : { state: 'unavailable' };
  });

export const writePrivateYearlyGoal = createServerFn({ method: 'POST' })
  .validator(dispatchInput)
  .handler(async ({ data }): Promise<YearlyGoalWriteResult> => {
    const request = await preparedCommandRequest(data);
    if (!request) return { state: 'retired' };
    let authorization;
    try {
      authorization = await originalEntryRestoreCredential(request, env as Partial<SessionEnv>, data.credential);
    } catch (error) {
      // An altered external credential carrier must never fall back to the current session bearer.
      if (error instanceof DOMException || error instanceof SyntaxError) return { state: 'retired' };
      throw error;
    }
    if (!authorization) return { state: 'retired' };
    // Kernel authorizes this original credential before its native receipt replay.
    return writeYearlyGoal(kernelClient(), authorization, data.command, request.signal);
  });
