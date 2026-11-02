import { kernelClient } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import { dependencyUnavailable, problem, problemResponse } from '../media/kernel';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { UUID } from './price';
import { checkoutDestination, decodeAcquisitionProblem } from './offer-recovery';

const bodyLimit = 4 * 1024;

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
  if (await prepareSession(request, sessionEnv)) return problemResponse(problem(401, 'unauthorized', 'Unauthorized'));
  const credential = viewerCredential(request);
  if (!credential) return problemResponse(problem(401, 'unauthorized', 'Unauthorized'));
  const body = await jsonBody(request);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw problem(400, 'invalid_request', 'Invalid Request');
  const fields = body as Record<string, unknown>;
  if (
    Object.keys(fields).some(
      (key) => key !== 'offerId' && key !== 'expectedOfferRevision' && key !== 'idempotencyKey',
    ) ||
    typeof fields.offerId !== 'string' ||
    !UUID.test(fields.offerId) ||
    typeof fields.expectedOfferRevision !== 'number' ||
    !Number.isSafeInteger(fields.expectedOfferRevision) ||
    fields.expectedOfferRevision < 1 ||
    typeof fields.idempotencyKey !== 'string' ||
    !UUID.test(fields.idempotencyKey)
  )
    throw problem(400, 'invalid_request', 'Invalid Request');

  let result: Awaited<ReturnType<ReturnType<typeof kernelClient>['orders']['post']>>;
  try {
    const headers = {
      authorization: credential,
      'idempotency-key': fields.idempotencyKey,
    };
    const input = { offerId: fields.offerId, expectedOfferRevision: fields.expectedOfferRevision };
    result = await kernelClient().orders.post(input, { headers, fetch: { cache: 'no-store', redirect: 'manual' } });
  } catch (error) {
    if (isPlatformClosedError(error))
      return Response.json(error.problem, {
        status: error.status,
        headers: { 'content-type': 'application/problem+json', 'cache-control': 'private, no-store' },
      });
    throw dependencyUnavailable(503);
  }
  if (result.error || !result.data) {
    const status = result.status || result.error?.status;
    if (status === 409 && result.error) {
      const failure: unknown = result.error.value;
      const existing = decodeAcquisitionProblem(status, failure);
      if (existing)
        return Response.json(existing, {
          status: 409,
          headers: { 'content-type': 'application/problem+json', 'cache-control': 'private, no-store' },
        });
      if (failure && typeof failure === 'object' && 'code' in failure) {
        if (failure.code === 'offer_revision_conflict')
          return problemResponse(problem(409, 'offer_revision_conflict', 'Offer Terms Changed'));
        if (failure.code === 'offer_unavailable')
          return problemResponse(problem(409, 'offer_unavailable', 'Offer Unavailable'));
      }
    }
    throw dependencyUnavailable(503);
  }
  const destination = checkoutDestination(result.data.order, fields.offerId);
  if (!destination) throw dependencyUnavailable(503);
  return Response.json(destination, { headers: { 'cache-control': 'private, no-store' } });
}
