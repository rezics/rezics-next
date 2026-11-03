import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { bindDecisionSource, type ModerationDecision } from './decision-read';
import { moderationCommandHeaders, validateModerationKey } from './command-intent';

type AppealResult = { status: number; error?: unknown };
type AppealReads = {
  appeal: (id: string, statement: string) => Promise<AppealResult>;
  decision: (id: string) => Promise<ModerationDecision | null>;
};
export type DecisionAppealReadback =
  | { state: 'available'; decision: ModerationDecision; nativeSourceFingerprint: string }
  | { state: 'unavailable' };
export type AppealSubmission =
  | { state: 'acknowledged'; readback: DecisionAppealReadback }
  | { state: 'invalid'; text: string }
  | { state: 'denied' }
  | { state: 'refused' }
  | { state: 'conflict'; readback: DecisionAppealReadback }
  | { state: 'failed' };

async function currentReadback(id: string, reads: AppealReads): Promise<DecisionAppealReadback> {
  const decision = await reads.decision(id).catch(() => null);
  if (!decision || decision.id !== id) return { state: 'unavailable' };
  const source = await bindDecisionSource(decision).catch(() => ({ state: 'unavailable' as const }));
  return source.state === 'available'
    ? { state: 'available', decision, nativeSourceFingerprint: source.fingerprint }
    : { state: 'unavailable' };
}

/** The command receipt and the separate current decision readback remain independent results. */
export async function submitDecisionAppeal(id: string, text: string, reads: AppealReads): Promise<AppealSubmission> {
  const result = await reads.appeal(id, text);
  if (result.status === 201 || result.status === 200) {
    return { state: 'acknowledged', readback: await currentReadback(id, reads) };
  }
  if ([401, 403, 404].includes(result.status)) return { state: 'denied' };
  if (result.status === 422 && Array.from(text).length > 2000) return { state: 'invalid', text };
  if (result.status === 409 || result.status === 422)
    return { state: 'conflict', readback: await currentReadback(id, reads) };
  return { state: 'failed' };
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
        fetch: { cache: 'no-store' },
      });
      return response.error ? null : response.data;
    },
  });
}
