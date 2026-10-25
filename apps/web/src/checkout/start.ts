import { kernelClient } from '../kernel/client';
import { dependencyUnavailable, problem, problemResponse } from '../media/kernel';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { UUID } from './price';

const bodyLimit = 4 * 1024;

function safeCheckoutUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href;
  } catch {
    return null;
  }
}

async function jsonBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    throw problem(415, 'invalid_request', 'Invalid Request');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > bodyLimit))
    throw problem(413, 'invalid_request', 'Invalid Request');
  if (!request.body) throw problem(400, 'invalid_request', 'Invalid Request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > bodyLimit) {
        await reader.cancel().catch(() => {});
        throw problem(413, 'invalid_request', 'Invalid Request');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw problem(400, 'invalid_request', 'Invalid Request');
  }
}

export async function startCheckout(request: Request, sessionEnv: Partial<SessionEnv>): Promise<Response> {
  await prepareSession(request, sessionEnv);
  const credential = viewerCredential(request);
  if (!credential) return problemResponse(problem(401, 'unauthorized', 'Unauthorized'));
  const body = await jsonBody(request);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw problem(400, 'invalid_request', 'Invalid Request');
  const fields = body as Record<string, unknown>;
  if (
    Object.keys(fields).some((key) => key !== 'offerId' && key !== 'idempotencyKey') ||
    typeof fields.offerId !== 'string' ||
    !UUID.test(fields.offerId) ||
    typeof fields.idempotencyKey !== 'string' ||
    !UUID.test(fields.idempotencyKey)
  )
    throw problem(400, 'invalid_request', 'Invalid Request');

  let result: Awaited<ReturnType<ReturnType<typeof kernelClient>['orders']['post']>>;
  try {
    // The treaty header type names only Idempotency-Key. The bearer is still sent; Eden forwards the object as given.
    const headers = {
      authorization: credential,
      'idempotency-key': fields.idempotencyKey,
    } as { 'idempotency-key': string };
    result = await kernelClient().orders.post({ offerId: fields.offerId }, { headers });
  } catch {
    throw dependencyUnavailable(503);
  }
  if (result.error || !result.data) {
    const status = result.status || result.error?.status;
    if (status === 409) return problemResponse(problem(409, 'offer_unavailable', 'Offer Unavailable'));
    throw dependencyUnavailable(503);
  }
  const checkoutUrl = safeCheckoutUrl(result.data.order.checkoutUrl);
  if (!checkoutUrl) throw dependencyUnavailable(503);
  return Response.json({ checkoutUrl }, { headers: { 'cache-control': 'private, no-store' } });
}
