import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { preparedPrivateReaderOrigin } from './private-reader-origin';
import type { PrivateReaderRead } from './private-reader-lifetime';
import { isPlatformClosedError, isPlatformClosedProblem, PlatformClosedError } from '../kernel/platform-closed';

type DecisionReadCall = ReturnType<ReturnType<KernelClient['moderation-decisions']>['get']>;
export type ModerationDecision = NonNullable<Awaited<DecisionReadCall>['data']>;

export type DecisionPage = PrivateReaderRead & {
  /** The exact installed generated response; native advice and context remain absent until publication. */
  decision: ModerationDecision;
  /** Hash of the exact native provenance; it is an observation, never browser authority. */
  nativeSourceFingerprint: string;
  viewerId: string | null;
  /** Legacy injected presenters may carry a local epoch; production never serializes a token. */
  sessionEpoch?: string;
  readGeneration?: string;
};

type ReadResult = Awaited<DecisionReadCall>;
type DecisionReads = {
  decision: (id: string) => Promise<ModerationDecision | null>;
};

export type DecisionSourceBinding =
  | { state: 'available'; fingerprint: string }
  | { state: 'unavailable' };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keep the installed typed unavailable seam until generated provenance reaches KernelClient. */
export async function bindDecisionSource(
  response: ModerationDecision,
  expectedActorId?: string,
): Promise<DecisionSourceBinding> {
  if (!record(response) || !Object.hasOwn(response, 'provenance')) return { state: 'unavailable' };
  const descriptor = Object.getOwnPropertyDescriptor(response, 'provenance');
  if (!descriptor || !('value' in descriptor)) return { state: 'unavailable' };
  const provenance: unknown = descriptor.value;
  if (
    !record(provenance) ||
    typeof provenance['actorId'] !== 'string' ||
    provenance['actorId'].trim() === '' ||
    !record(provenance['session']) ||
    typeof provenance['session']['clientId'] !== 'string' ||
    provenance['session']['clientId'].trim() === '' ||
    typeof provenance['session']['authnEpoch'] !== 'number' ||
    !Number.isSafeInteger(provenance['session']['authnEpoch']) ||
    !record(provenance['source']) ||
    typeof provenance['source']['partition'] !== 'number' ||
    !Number.isSafeInteger(provenance['source']['partition']) ||
    typeof provenance['source']['epoch'] !== 'number' ||
    !Number.isSafeInteger(provenance['source']['epoch']) ||
    typeof provenance['source']['position'] !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(provenance['source']['position'])
  )
    return { state: 'unavailable' };
  if (expectedActorId !== undefined && provenance['actorId'] !== expectedActorId) return { state: 'unavailable' };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify([
      provenance['actorId'],
      provenance['session']['clientId'],
      provenance['session']['authnEpoch'],
      provenance['source']['partition'],
      provenance['source']['epoch'],
      provenance['source']['position'],
    ]);
  } catch {
    return { state: 'unavailable' };
  }
  if (!serialized) return { state: 'unavailable' };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return {
    state: 'available',
    fingerprint: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

/** A single exact composed read supplies the receipt, appeal advice and optional current context. */
export async function loadDecisionPage(
  id: string,
  reads: DecisionReads,
  viewerId: string | null = null,
): Promise<DecisionPage | null> {
  const decision = await reads.decision(id);
  if (!decision || decision.id !== id) return null;
  const source = await bindDecisionSource(decision, viewerId ?? undefined);
  if (source.state === 'unavailable') throw new Error('Decision read unavailable');
  return { decision, nativeSourceFingerprint: source.fingerprint, viewerId };
}

const readOptions = (authorization: string) => ({
  headers: { authorization },
  fetch: { cache: 'no-store' as const },
});

function readStatus(result: ReadResult): number | undefined {
  if (typeof result.status === 'number') return result.status;
  if (result.error && typeof result.error === 'object' && 'status' in result.error) return Number(result.error.status);
  return undefined;
}

function refused(result: ReadResult): boolean {
  const status = readStatus(result);
  const problem =
    result.error && typeof result.error === 'object' && 'value' in result.error ? result.error.value : null;
  if (isPlatformClosedProblem(status, problem)) throw new PlatformClosedError(403, problem);
  if (status !== undefined && [401, 403, 404].includes(status)) return true;
  throw new Error('Decision read unavailable');
}

export const readDecisionPage = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      input.id.length > 128
    )
      throw notFound();
    return { id: input.id };
  })
  .handler(async ({ data }): Promise<DecisionPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadDecisionPageRequest(getRequest(), env as Partial<SessionEnv>, data.id);
  });

export async function loadDecisionPageRequest(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  id: string,
  client: () => KernelClient = kernelClient,
): Promise<DecisionPage> {
  try {
    await prepareSession(request, sessionEnv);
  } catch {
    throw new Error('Decision read unavailable');
  }
  const authorization = viewerCredential(request);
  const readerOrigin = await preparedPrivateReaderOrigin(request, authorization);
  if (!authorization || !readerOrigin) throw notFound();
  let page: DecisionPage | null;
  try {
    page = await loadDecisionPage(id, decisionReadAdapters(client(), authorization), readerOrigin.subject);
  } catch (error) {
    if (isPlatformClosedError(error)) throw new PlatformClosedError(403, null);
    throw new Error('Decision read unavailable');
  }
  if (!page) throw notFound();
  return { ...page, readerOrigin, readGeneration: crypto.randomUUID() };
}

export function decisionReadAdapters(client: KernelClient, authorization: string): DecisionReads {
  return {
    decision: async (id) => {
      const result = await client['moderation-decisions']({ id }).get(readOptions(authorization));
      if (result.error && refused(result)) return null;
      if (!result.data) throw new Error('Decision read unavailable');
      return result.data;
    },
  };
}
