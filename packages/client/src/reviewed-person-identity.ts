import type { KernelClient, SubjectRead } from './index.ts';

/** Semantic's coherent observation of an original Person, never a followed canonical read. */
export type ReviewedPersonEndpoint = {
  subject: string;
  revision: number;
  securityRevision: string;
  source: 'bangumi' | 'vndb';
  externalId: string;
  claimTransactionId: string;
  property: 'wdt:P6298' | 'wdt:P3180';
  value: string;
};
export type ReviewedPersonSource = Pick<ReviewedPersonEndpoint, 'source' | 'externalId'>;
export type ReviewedPersonRead = SubjectRead & { reviewedIdentity?: ReviewedPersonEndpoint | null };
export type ReviewedPersonMerge = {
  subjects: [string, string];
  expectedIdentity: { endpoints: [ReviewedPersonEndpoint, ReviewedPersonEndpoint] };
};
export type ReviewedPersonAdmission = { operation: { id: string } };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bytes = (value: string) => new TextEncoder().encode(value).length;
export function isReviewedPersonSource(value: unknown): value is ReviewedPersonSource {
  if (!value || typeof value !== 'object') return false;
  const v = value as ReviewedPersonSource;
  return (
    typeof v.externalId === 'string' &&
    bytes(v.externalId) <= 255 &&
    (v.source === 'bangumi'
      ? /^person:[1-9][0-9]*$(?![\s\S])/.test(v.externalId)
      : v.source === 'vndb' && /^s[1-9][0-9]*$(?![\s\S])/.test(v.externalId))
  );
}
export function isReviewedPersonEndpoint(value: unknown): value is ReviewedPersonEndpoint {
  if (!isReviewedPersonSource(value)) return false;
  const v = value as ReviewedPersonEndpoint;
  return (
    Object.keys(v).length === 8 &&
    typeof v.subject === 'string' &&
    uuid.test(v.subject) &&
    Number.isSafeInteger(v.revision) &&
    v.revision > 0 &&
    typeof v.securityRevision === 'string' &&
    /^[1-9][0-9]*$(?![\s\S])/.test(v.securityRevision) &&
    typeof v.claimTransactionId === 'string' &&
    uuid.test(v.claimTransactionId) &&
    typeof v.value === 'string' &&
    bytes(v.value) <= 255 &&
    (v.source === 'bangumi'
      ? v.property === 'wdt:P6298' && v.value === v.externalId.slice(7)
      : v.property === 'wdt:P3180' && v.value === v.externalId)
  );
}
/** BFF HTTP input admission; endpoint order remains the original subjects order. */
export function reviewedPersonMergeInput(value: unknown): ReviewedPersonMerge {
  const v = value as ReviewedPersonMerge | null;
  if (
    !v ||
    !Array.isArray(v.subjects) ||
    v.subjects.length !== 2 ||
    !Array.isArray(v.expectedIdentity?.endpoints) ||
    v.expectedIdentity.endpoints.length !== 2 ||
    bytes(JSON.stringify(v.expectedIdentity)) > 4096 ||
    v.subjects[0] === v.subjects[1] ||
    !v.expectedIdentity.endpoints.every(
      (endpoint, index) => isReviewedPersonEndpoint(endpoint) && endpoint.subject === v.subjects[index],
    ) ||
    v.expectedIdentity.endpoints[0].source === v.expectedIdentity.endpoints[1].source
  )
    throw new TypeError('Invalid reviewed Person merge');
  return {
    subjects: [...v.subjects],
    expectedIdentity: {
      endpoints: v.expectedIdentity.endpoints.map((e) => ({
        subject: e.subject,
        revision: e.revision,
        securityRevision: e.securityRevision,
        source: e.source,
        externalId: e.externalId,
        claimTransactionId: e.claimTransactionId,
        property: e.property,
        value: e.value,
      })) as [ReviewedPersonEndpoint, ReviewedPersonEndpoint],
    },
  };
}

/** Transport seam until emit-client can publish the native 202 merge signatures. */
export function reviewedPersonRequests(client: KernelClient) {
  return {
    read(
      id: string,
      source: ReviewedPersonSource,
      options: { headers?: Record<string, string>; fetch?: { signal?: AbortSignal } } = {},
    ) {
      return client.subjects({ id }).get({
        ...options,
        query: {
          reviewIdentitySource: source.source,
          reviewIdentityExternalId: source.externalId,
          includeViewerActions: true,
        },
      } as never);
    },
    merge(
      body: ReviewedPersonMerge,
      options: { headers: Record<string, string> & { 'idempotency-key': string }; fetch?: { signal?: AbortSignal } },
    ) {
      return client.subjects.$merge.post(body as never, options);
    },
  };
}
