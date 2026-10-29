import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import type { ModerationDecision } from './decision-read';

type AppealResult = { status: number; error?: unknown };
type AppealReads = {
  appeal: (id: string, statement: string) => Promise<AppealResult>;
  decision: (id: string) => Promise<ModerationDecision | null>;
};
export type AppealSubmission =
  | { state: 'pending'; decision: ModerationDecision }
  | { state: 'invalid'; text: string }
  | { state: 'updated'; decision: ModerationDecision }
  | { state: 'failed' };

/** Sends once and re-reads current appeal state after success or terminal conflicts. */
export async function submitDecisionAppeal(id: string, text: string, reads: AppealReads): Promise<AppealSubmission> {
  const result = await reads.appeal(id, text);
  if (result.status === 201 || result.status === 200) {
    const decision = await reads.decision(id);
    return decision ? { state: 'pending', decision } : { state: 'failed' };
  }
  if (result.status === 422 && Array.from(text).length > 2000) return { state: 'invalid', text };
  if (result.status === 409 || result.status === 422) {
    const decision = await reads.decision(id);
    return decision ? { state: 'updated', decision } : { state: 'failed' };
  }
  return { state: 'failed' };
}

type DecisionKernel = {
  'moderation-decisions': (params: { id: string }) => {
    $appeal: { post: (options: unknown) => Promise<{ data?: unknown; error?: unknown; status?: number }> };
    get: (options: unknown) => Promise<{ data?: unknown; error?: unknown }>;
  };
};

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
    return { id: input.id, statement: input.statement };
  })
  .handler(async ({ data }): Promise<AppealSubmission> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) return { state: 'failed' };
    const client = kernelClient() as unknown as DecisionKernel;
    const resource = client['moderation-decisions']({ id: data.id });
    return submitDecisionAppeal(data.id, data.statement, {
      appeal: async (id, statement) => {
        const response = await client['moderation-decisions']({ id }).$appeal.post({
          body: { statement },
          headers: { authorization, 'idempotency-key': crypto.randomUUID() },
        });
        const errorStatus =
          response.error && typeof response.error === 'object' && 'status' in response.error
            ? Number(response.error.status)
            : undefined;
        return { status: response.status ?? errorStatus ?? (response.error ? 500 : 201), error: response.error };
      },
      decision: async (id) => {
        const response = await (id === data.id ? resource : client['moderation-decisions']({ id })).get({
          headers: { authorization },
        });
        return response.error ? null : ((response.data as ModerationDecision | undefined) ?? null);
      },
    });
  });
