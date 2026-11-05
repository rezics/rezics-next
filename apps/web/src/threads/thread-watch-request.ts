import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import {
  readNativeThreadWatch,
  setNativeThreadWatch,
  type ThreadWatchCommandResult,
  type ThreadWatchReadResult,
} from './thread-watch-native';

type NativeOptions = { headers: { authorization: string }; fetch: { cache: 'no-store' } };

export type ThreadWatchInput = Readonly<{ threadId: string; viewerId: string }>;
export type ThreadWatchSetInput = ThreadWatchInput & Readonly<{ watching: boolean }>;

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

export function validateThreadWatch(input: unknown): ThreadWatchInput {
  if (!input || typeof input !== 'object' || !('threadId' in input) || !('viewerId' in input))
    throw new Error('Invalid thread watch target');
  if (!validId(input.threadId) || !validId(input.viewerId)) throw new Error('Invalid thread watch target');
  return { threadId: input.threadId, viewerId: input.viewerId };
}

export function validateThreadWatchSet(input: unknown): ThreadWatchSetInput {
  const target = validateThreadWatch(input);
  if (!input || typeof input !== 'object' || !('watching' in input) || typeof input.watching !== 'boolean')
    throw new Error('Invalid requested watch state');
  return { ...target, watching: input.watching };
}

/** Only the caller's existing native session resolves credentials. No private thread/access probe. */
async function options(
  input: ThreadWatchInput,
  request: Request,
  env: Partial<SessionEnv>,
): Promise<NativeOptions | null> {
  await prepareSession(request, env);
  const authorization = viewerCredential(request);
  if (!authorization || sessionSubject(request) !== input.viewerId) return null;
  return { headers: { authorization }, fetch: { cache: 'no-store' } };
}

export async function readThreadWatchRequest(
  input: ThreadWatchInput,
  request: Request,
  env: Partial<SessionEnv>,
  client: KernelClient,
): Promise<ThreadWatchReadResult> {
  // Resolve outside transport error concealment: the existing CSRF/authentication boundary stays authoritative.
  const auth = await options(input, request, env);
  if (!auth) return { kind: 'access-lost' };
  return readNativeThreadWatch(client, input.threadId, auth.headers.authorization);
}

export async function setThreadWatchRequest(
  input: ThreadWatchSetInput,
  request: Request,
  env: Partial<SessionEnv>,
  client: KernelClient,
): Promise<ThreadWatchCommandResult> {
  const auth = await options(input, request, env);
  if (!auth) return { kind: 'refused', reason: 'access-lost' };
  return setNativeThreadWatch(client, input.threadId, input.watching, auth.headers.authorization);
}
