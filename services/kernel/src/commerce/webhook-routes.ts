import { t } from 'elysia';
import type { createApp } from '../http/app.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { classifyStripeEvent, verifyStripeEvent, WebhookSignatureError } from './webhook.ts';
import type { CommerceWork } from './work-contract.ts';

const MAX_BODY_BYTES = 256 * 1024;

async function readRawBody(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ProblemError('invalid_request');
      }
      chunks.push(value);
    }
  } catch {
    throw new ProblemError('invalid_request');
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

export function stripeWebhookRoutes(
  app: ReturnType<typeof createApp>,
  { secrets, work, clock = Date.now }: { secrets: readonly string[]; work: CommerceWork; clock?: () => number },
) {
  return app.post(
    '/v1/webhooks/stripe',
    {
      parse: 'none',
      // This provider endpoint has no Access action and is excluded from its catalogue.
      detail: { hide: true },
      response: {
        200: t.Object({ received: t.Literal(true) }, { additionalProperties: false }),
        400: problemSchema('invalid_request', 'invalid_signature'),
        503: problemSchema('dependency_unavailable'),
      },
    },
    async ({ request }) => {
      const receivedAt = clock();
      const raw = await readRawBody(request);
      let event;
      try {
        event = await verifyStripeEvent(raw, request.headers.get('stripe-signature'), secrets, receivedAt);
      } catch (error) {
        if (error instanceof WebhookSignatureError) throw new ProblemError('invalid_signature');
        throw error;
      }
      const ref = classifyStripeEvent(event);
      if (ref !== null) {
        try {
          await work.enqueueStripeEvent(ref);
        } catch {
          throw new ProblemError('dependency_unavailable');
        }
      }
      return { received: true as const };
    },
  );
}
