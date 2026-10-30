import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import type { ModerationDecision } from './decision-read';
import { moderationCommandHeaders, validateModerationKey } from './command-intent';

type AppealResult = { status: number; error?: unknown };
type AppealReads = {
  appeal: (id: string, statement: string) => Promise<AppealResult>;
  decision: (id: string) => Promise<ModerationDecision | null>;
};
export type AppealSubmission =
  | { state: 'pending'; decision: ModerationDecision }
  | { state: 'invalid'; text: string }
  | { state: 'updated'; decision: ModerationDecision }
  | { state: 'denied' }
  | { state: 'refused' }
  | { state: 'conflict' }
  | { state: 'failed' };

/** Sends once and re-reads current appeal state after success or terminal conflicts. */
export async function submitDecisionAppeal(id: string, text: string, reads: AppealReads): Promise<AppealSubmission> {
  const result = await reads.appeal(id, text);
  if (result.status === 201 || result.status === 200) {
    const decision = await reads.decision(id).catch(() => null);
    return decision?.id === id && decision.appeal ? { state: 'pending', decision } : { state: 'failed' };
  }
  if ([401, 403, 404].includes(result.status)) return { state: 'denied' };
  if (result.status === 422 && Array.from(text).length > 2000) return { state: 'invalid', text };
  if (result.status === 409 || result.status === 422) {
    const decision = await reads.decision(id).catch(() => null);
    // A known refusal stays terminal even when the follow-up read is unavailable.
    return decision?.id === id ? { state: 'updated', decision } : { state: 'conflict' };
  }
  return { state: result.status >= 400 && result.status < 500 ? 'refused' : 'failed' };
}

export const appealDecision = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      !('statement' in input) ||
      typeof input.statement !== 'string'
    )
      throw new Error('Invalid appeal');
    return {
      id: input.id,
      statement: input.statement,
      idempotencyKey: validateModerationKey('idempotencyKey' in input ? input.idempotencyKey : undefined),
    };
  })
  .handler(async ({ data }): Promise<AppealSubmission> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) return { state: 'denied' };
    return sendDecisionAppeal(kernelClient(), data, authorization);
  });

export async function sendDecisionAppeal(
  client: KernelClient,
  data: { id: string; statement: string; idempotencyKey: string },
  authorization: string,
): Promise<AppealSubmission> {
  const resource = client['moderation-decisions']({ id: data.id });
  return submitDecisionAppeal(data.id, data.statement, {
    appeal: async (id, statement) => {
      const response = await client['moderation-decisions']({ id }).$appeal.post(
        {
          statement,
        },
        { headers: moderationCommandHeaders(authorization, data.idempotencyKey) },
      );
      const errorStatus =
        response.error && typeof response.error === 'object' && 'status' in response.error
          ? Number(response.error.status)
          : undefined;
      return { status: response.status ?? errorStatus ?? 500, error: response.error };
    },
    decision: async (id) => {
      const response = await (id === data.id ? resource : client['moderation-decisions']({ id })).get({
        headers: { authorization },
      });
      return response.error ? null : response.data;
    },
  });
}
