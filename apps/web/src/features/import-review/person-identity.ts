import {
  isReviewedPersonEndpoint,
  isReviewedPersonSource,
  reviewedPersonRequests,
  reviewedPersonMergeInput,
  type KernelClient,
  type SubjectRead,
  type ReviewedPersonRead,
  type ReviewedPersonSource,
  type ReviewedPersonMerge,
  type ReviewedPersonAdmission,
} from '@rezics/client';
import { providerFailure, type ProviderFailure } from './provider-review-actions';

export type PersonReviewAddress = ReviewedPersonSource & { subject: string };
export type PersonReviewPair = [PersonReviewAddress, PersonReviewAddress];
export type PersonComparison =
  | ProviderFailure
  | {
      ok: true;
      originals: PersonReviewPair;
      reads: [ReviewedPersonRead, ReviewedPersonRead];
      merge: ReviewedPersonMerge | null;
    };
export type PersonReviewCommand = { body: ReviewedPersonMerge; key: string };
export type PersonReviewResult = ProviderFailure | { ok: true; admission: ReviewedPersonAdmission };
export type PersonPublication =
  | ProviderFailure
  | ({ ok: true } & ({ state: 'pending' | 'unconfirmed' } | { state: 'published'; read: SubjectRead }));
export type PersonPublicationRequest = { command: PersonReviewCommand; operation: string };
export function personPublicationInput(value: unknown): PersonPublicationRequest {
  const v = value as PersonPublicationRequest | null;
  if (!v || typeof v.operation !== 'string' || !uuid.test(v.operation)) throw new TypeError('Invalid Person operation');
  return { command: personReviewCommandInput(v.command), operation: v.operation };
}
export type PersonReviewTransport = {
  compare: (pair: PersonReviewPair) => Promise<PersonComparison>;
  merge: (command: PersonReviewCommand) => Promise<PersonReviewResult>;
  publication: (request: PersonPublicationRequest) => Promise<PersonPublication>;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function personReviewPairInput(value: unknown): PersonReviewPair {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every(
      (v) =>
        isReviewedPersonSource(v) &&
        typeof (v as PersonReviewAddress).subject === 'string' &&
        uuid.test((v as PersonReviewAddress).subject),
    ) ||
    !['bangumi', 'bangumi_cross_media'].includes(value[0].source) ||
    !['vndb', 'vndb_cross_media'].includes(value[1].source) ||
    value[0].subject === value[1].subject
  )
    throw new TypeError('Invalid Person comparison');
  return value.map((v) => ({ subject: v.subject, source: v.source, externalId: v.externalId })) as PersonReviewPair;
}
export function personReviewCommandInput(value: unknown): PersonReviewCommand {
  const v = value as PersonReviewCommand | null;
  if (!v || typeof v.key !== 'string' || !uuid.test(v.key)) throw new TypeError('Invalid Person review key');
  return { body: reviewedPersonMergeInput(v.body), key: v.key };
}

/** Only the native coherent observation enables confirmation; ordinary reads remain useful for comparison. */
export function personComparison(
  originals: PersonReviewPair,
  reads: [ReviewedPersonRead, ReviewedPersonRead],
): PersonComparison {
  const endpoints = reads.map((read) => read.reviewedIdentity);
  const eligible = reads.every((read, index) => {
    const original = originals[index]!;
    const endpoint = endpoints[index];
    return (
      read.subject.id === original.subject &&
      read.subject.type === 'schema:Person' &&
      endpoint?.subject === original.subject &&
      endpoint.source === original.source &&
      endpoint.externalId === original.externalId &&
      read.viewerActions?.state === 'available' &&
      read.viewerActions.actions.some((action) => action.operations.includes('subject.merge'))
    );
  });
  return {
    ok: true,
    originals,
    reads,
    merge: eligible
      ? {
          subjects: originals.map((o) => o.subject) as [string, string],
          expectedIdentity: { endpoints: endpoints as ReviewedPersonMerge['expectedIdentity']['endpoints'] },
        }
      : null,
  };
}
/** A merged subject answers 308 with its survivor in the body; one hop reads that survivor, never a chain. */
function survivorHop(id: string, response: { status: number; data?: unknown; error?: { value?: unknown } | null }) {
  if (response.status !== 308) return null;
  const body = (response.data ?? response.error?.value) as { redirect?: { from?: unknown; to?: unknown } } | undefined;
  const to = body?.redirect?.from === id ? body.redirect.to : undefined;
  return typeof to === 'string' && uuid.test(to) && to !== id ? to : null;
}
export async function readPersonComparison(
  client: KernelClient,
  authorization: string,
  pair: PersonReviewPair,
  signal?: AbortSignal,
): Promise<PersonComparison> {
  const options = { headers: { authorization }, ...(signal === undefined ? {} : { fetch: { signal } }) };
  const responses = await Promise.all(
    pair.map(async (original) => {
      const response = await reviewedPersonRequests(client).read(original.subject, original, options);
      const survivor = survivorHop(original.subject, response);
      return survivor ? reviewedPersonRequests(client).read(survivor, original, options) : response;
    }),
  );
  for (const response of responses)
    if (response.status !== 200 || !response.data) return providerFailure(response.status, response.headers);
  const reads = responses.map((r) => r.data) as unknown as [ReviewedPersonRead, ReviewedPersonRead];
  for (const read of reads)
    if (read.reviewedIdentity != null && !isReviewedPersonEndpoint(read.reviewedIdentity))
      throw new TypeError('Invalid native reviewed Person identity');
  return personComparison(pair, reads);
}
export async function mergePersonComparison(
  client: KernelClient,
  authorization: string,
  command: PersonReviewCommand,
  signal?: AbortSignal,
): Promise<PersonReviewResult> {
  const response = await reviewedPersonRequests(client).merge(command.body, {
    headers: { authorization, 'idempotency-key': JSON.stringify(command.key) },
    ...(signal === undefined ? {} : { fetch: { signal } }),
  });
  if (response.status !== 202 || !response.data) return providerFailure(response.status, response.headers);
  const admission = response.data;
  if (!admission.operation || !uuid.test(admission.operation.id))
    throw new TypeError('Invalid native identity admission');
  return { ok: true, admission };
}

/** Publication comes from the native job; public facts are then read independently without review credentials. */
export async function readPersonPublication(
  client: KernelClient,
  authorization: string,
  { command, operation }: PersonPublicationRequest,
  signal?: AbortSignal,
): Promise<PersonPublication> {
  const response = await reviewedPersonRequests(client).operation(operation, {
    headers: { authorization },
    ...(signal === undefined ? {} : { fetch: { signal } }),
  });
  if (response.status !== 200 || !response.data) return providerFailure(response.status, response.headers);
  const observed = response.data.operation;
  if (!observed.done) return { ok: true, state: 'pending' };
  const originals = command.body.subjects;
  if (
    !originals.includes(observed.result.survivor) ||
    !originals.includes(observed.result.redirected) ||
    observed.result.survivor === observed.result.redirected
  )
    throw new TypeError('Invalid native Person publication');
  const getSubject = (id: string) =>
    client.subjects({ id }).get({ fetch: { redirect: 'manual', ...(signal === undefined ? {} : { signal }) } });
  const responses = await Promise.all(
    originals.map(async (id) => {
      const response = await getSubject(id);
      const survivor = survivorHop(id, response);
      return survivor ? getSubject(survivor) : response;
    }),
  );
  for (const read of responses)
    if (read.status !== 200 || !read.data) return providerFailure(read.status, read.headers);
  const reads = responses.map((read) => read.data!);
  const current = reads.every(
    (read) =>
      read.subject.id === observed.result.survivor &&
      read.subject.type === 'schema:Person' &&
      command.body.expectedIdentity.endpoints.every((endpoint) => {
        const values = (read.subject.statements[endpoint.property] ?? []).filter((row) => row.rank !== 'deprecated');
        return (
          values.length > 0 && values.every((row) => row.value.type === 'value' && row.value.content === endpoint.value)
        );
      }),
  );
  return current ? { ok: true, state: 'published', read: reads[0]! } : { ok: true, state: 'unconfirmed' };
}
