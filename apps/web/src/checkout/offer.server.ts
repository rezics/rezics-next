import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server';
import { kernelClient } from '../kernel/client';
import { dependencyUnavailable, MediaProblem, problem } from '../media/kernel';
import type { OfferPageData } from './offer';
import { formatOfferPrice } from './price';
import { benefitCreatorName, capturedBenefit } from './benefit';
import { subjectCover } from './subject-cover';
import { recordedMoneyUnit, recordedTaxBehavior } from './money-schema';
import { env } from 'cloudflare:workers';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { cookie, SESSION_COOKIE } from '../session/cookies';

const reads = new WeakMap<Request, Map<string, Promise<OfferPageData>>>();

async function readOnce(id: string, locale: string): Promise<OfferPageData> {
  const request = getRequest();
  if (await prepareSession(request, env as Partial<SessionEnv>)) throw problem(401, 'unauthorized', 'Unauthorized');
  const authorization = viewerCredential(request);
  if (!authorization && cookie(request, SESSION_COOKIE) !== undefined) throw dependencyUnavailable(503);
  const result = await kernelClient()
    .offers({ offerId: id })
    .get({
      query: { languages: locale },
      ...(authorization ? { headers: { authorization } } : {}),
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
  if (result.error) {
    if (result.status === 404 || result.error.status === 404) throw notFound();
    if (result.status >= 500 && result.status <= 599) {
      const failure = dependencyUnavailable(result.status);
      const retryAfter = new Headers(result.headers).get('retry-after');
      setResponseStatus(result.status);
      if (retryAfter) setResponseHeader('retry-after', retryAfter);
      throw new MediaProblem(failure.problem, retryAfter ? { 'retry-after': retryAfter } : undefined);
    }
    const body: unknown = result.error.value;
    if (
      body &&
      typeof body === 'object' &&
      'code' in body &&
      typeof body.code === 'string' &&
      'type' in body &&
      typeof body.type === 'string' &&
      'title' in body &&
      typeof body.title === 'string'
    ) {
      setResponseStatus(result.status);
      throw new MediaProblem({ type: body.type, title: body.title, code: body.code, status: result.status });
    }
    throw new Error('Kernel offer read failed');
  }
  const offer = result.data?.offer;
  // Fail closed while the derived client/recordings await the wire-contract update.
  if (
    !offer ||
    !('revision' in offer) ||
    typeof offer.revision !== 'number' ||
    !Number.isSafeInteger(offer.revision) ||
    offer.revision < 1
  )
    throw dependencyUnavailable(503);
  if (!Number.isSafeInteger(offer.unitAmountMinor) || offer.unitAmountMinor <= 0) throw dependencyUnavailable(503);
  const moneyUnit = recordedMoneyUnit(offer);
  const benefit = capturedBenefit(offer.contentEdition, offer.targetSubjectId);
  return {
    id: offer.id,
    revision: offer.revision,
    title: offer.title,
    currency: offer.currency,
    unitAmountMinor: offer.unitAmountMinor,
    state: offer.state,
    price: formatOfferPrice(locale, offer.currency, offer.unitAmountMinor, moneyUnit),
    moneyUnit,
    taxBehavior: recordedTaxBehavior(offer),
    benefit,
    creatorName: await benefitCreatorName(kernelClient(locale), benefit),
    idempotencyKey: crypto.randomUUID(),
    subject: subjectCover(locale, offer.targetSubjectId, offer.title, offer.subject),
  };
}

export async function loadOffer(id: string, locale: string): Promise<OfferPageData> {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  let pending = reads.get(request);
  if (!pending) {
    pending = new Map();
    reads.set(request, pending);
  }
  const key = `${locale}\n${id}`;
  let offer = pending.get(key);
  if (!offer) {
    offer = readOnce(id, locale);
    pending.set(key, offer);
  }
  return offer;
}
