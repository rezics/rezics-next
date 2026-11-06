import { createHash } from 'node:crypto';
import type {
  ReviewedPersonAdmission,
  ReviewedPersonEndpoint,
  ReviewedPersonMerge,
  ReviewedPersonOperation,
  ReviewedPersonRead,
  ReviewedPersonSource,
} from '@rezics/client';
import type { ReviewedSubjectRead } from './import-client.ts';
import type { Provider } from './cross-media-bindings.ts';
import type { SourceRecord } from '@rezics/conversion';

export type PersonIdentity = Readonly<{
  source: Provider;
  externalId: string;
  property: 'wdt:P6298' | 'wdt:P3180';
  value: string;
}>;

export type PersonIdentityCurrentness = 'current' | 'missing' | 'wrong_type' | 'conflicting';

export type CurrentPersonIdentity = Readonly<{
  state: 'current';
  currentSubjectId: string;
  identity: PersonIdentity;
}>;

export type PersonIdentityObservation =
  | CurrentPersonIdentity
  | Readonly<{
      state: Exclude<PersonIdentityCurrentness, 'current'>;
      identity: PersonIdentity;
    }>;

/** Private seed handoff. The binding is the original native UUID, even after a merge. */
export type PersonReviewSource = Readonly<{
  identity: PersonIdentity;
  boundSubjectId: string;
  sourceAlias: string;
  record: SourceRecord;
  digest: string;
  converterRevision: string;
}>;

export type PersonReviewSelection = Readonly<{
  bangumi: string;
  vndb: string;
}>;

/** Acquisition selects this human; native review still requires fresh evidence and explicit consent. */
export const showcasePersonReview = {
  selection: { bangumi: 'person:1916', vndb: 's224' },
  independentEvidence: 'https://artist.cdjournal.com/a/maeda-jun/842760',
} as const;

export type PersonReviewPair =
  | Readonly<{ state: 'selected'; sources: readonly [PersonReviewSource, PersonReviewSource] }>
  | Readonly<{
      state: 'incomplete';
      missing: readonly Readonly<{ source: Provider; externalId: string }>[];
    }>;

/** Use the converter's actual type and digest, never a name match or a fabricated native ID. */
export function personReviewSource(input: {
  record: SourceRecord;
  nativeType: string;
  boundSubjectId: string;
  sourceAlias: string;
  digest: string;
  converterRevision: string;
}): PersonReviewSource | undefined {
  const { record } = input;
  if (record.source !== 'bangumi' && record.source !== 'vndb') return undefined;
  const identity = personIdentityForSource(record.source, record.key, input.nativeType);
  if (!identity) return undefined;
  const { nativeType: _, ...source } = input;
  return { identity, ...structuredClone(source) };
}

/** Select exact admitted records for comparison. Selection is not an identity decision. */
export function selectPersonReviewPair(
  sources: readonly PersonReviewSource[],
  selection: PersonReviewSelection,
): PersonReviewPair {
  const bangumi = sources.find(
    (entry) => entry.identity.source === 'bangumi' && entry.identity.externalId === selection.bangumi,
  );
  const vndb = sources.find(
    (entry) => entry.identity.source === 'vndb' && entry.identity.externalId === selection.vndb,
  );
  if (bangumi && vndb) return { state: 'selected', sources: [bangumi, vndb] };
  return {
    state: 'incomplete',
    missing: [
      ...(!bangumi ? [{ source: 'bangumi' as const, externalId: selection.bangumi }] : []),
      ...(!vndb ? [{ source: 'vndb' as const, externalId: selection.vndb }] : []),
    ],
  };
}

/** Only exact source-key identities qualify; names and credit evidence never create a binding. */
export function personIdentityForSource(
  source: Provider,
  externalId: string,
  expectedType: string | undefined,
): PersonIdentity | undefined {
  if (expectedType !== 'schema:Person') return undefined;
  if (source === 'bangumi' && /^person:[1-9][0-9]*$(?![\s\S])/u.test(externalId))
    return { source, externalId, property: 'wdt:P6298', value: externalId.slice('person:'.length) };
  if (source === 'vndb' && /^s[1-9][0-9]*$(?![\s\S])/u.test(externalId))
    return { source, externalId, property: 'wdt:P3180', value: externalId };
  return undefined;
}

/**
 * A native merge may redirect the original source binding to a canonical Person.
 * Accept that current endpoint only while its type and single exact provider key remain present.
 */
export function observePersonIdentity(identity: PersonIdentity, read: ReviewedSubjectRead): PersonIdentityObservation {
  const subject = read.subject;
  if (subject.type !== 'schema:Person') return { state: 'wrong_type', identity };
  const selected = (subject.statements[identity.property] ?? []).filter((statement) => statement.rank !== 'deprecated');
  if (selected.some((statement) => statement.value.type !== 'value' || typeof statement.value.content !== 'string'))
    return { state: 'conflicting', identity };
  const values = selected.flatMap((statement) =>
    statement.value.type === 'value' ? [statement.value.content as string] : [],
  );
  if (!values.length) return { state: 'missing', identity };
  const unique = new Set(values);
  if (unique.size !== 1 || !unique.has(identity.value)) return { state: 'conflicting', identity };
  return { state: 'current', currentSubjectId: subject.id, identity };
}

/** Native paired merge and operation surface; the import transport satisfies it structurally. */
export type ReviewedPersonMergeTransport = Readonly<{
  readReviewedPersonIdentity(
    id: string,
    source: ReviewedPersonSource,
    signal?: AbortSignal,
  ): Promise<ReviewedPersonRead>;
  mergeReviewedPersons(body: ReviewedPersonMerge, key: string, signal?: AbortSignal): Promise<ReviewedPersonAdmission>;
  readReviewedPersonOperation(id: string, signal?: AbortSignal): Promise<ReviewedPersonOperation>;
}>;

/** Sealed action journal. A send that may have reached Kernel keeps its exact body and key for replay. */
export type ReviewedPersonMergeJournal = Readonly<{
  prepareAction(actionKey: string, body: unknown, idempotencyKey: string): unknown;
  action(actionKey: string): Readonly<{
    state: 'prepared' | 'acknowledged' | 'refused';
    body_json: string;
    idempotency_key: string;
    result_id: string | null;
    error_code: string | null;
  }> | null;
  acknowledgeAction(actionKey: string, resultId?: string): void;
  refuseAction(actionKey: string, errorCode: string): void;
}>;

export type ReviewedPersonPublication =
  | Readonly<{
      state: 'published';
      operation: string;
      survivor: string;
      redirected: string;
      revision: number;
      identities: readonly Readonly<{ boundSubjectId: string; identity: PersonIdentity; currentSubjectId: string }>[];
    }>
  | Readonly<{ state: 'pending' | 'unconfirmed'; operation: string }>
  | Readonly<{ state: 'withheld'; reason: string }>;

const MERGE_POLLS = 30;
const MERGE_POLL_MS = 1_000;

/** Version-8 UUID shape derived from the sealed body, so every replay presents the same idempotency key. */
function mergeKey(digest: string): string {
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Publish a selected Bangumi and VNDB Person pair through the released paired merge. The sealed body is
 * sent once; the native operation is observed until done; then both original bindings are read through the
 * public reader. Only the same survivor carrying both exact identifiers counts as published.
 */
export async function publishReviewedPersonMerge(input: {
  pair: readonly [PersonReviewSource, PersonReviewSource];
  transport: ReviewedPersonMergeTransport;
  readPublic: (id: string) => Promise<ReviewedSubjectRead>;
  journal: ReviewedPersonMergeJournal;
  pause?: (ms: number) => Promise<void>;
  polls?: number;
}): Promise<ReviewedPersonPublication> {
  const [bangumi, vndb] = input.pair;
  if (
    bangumi.identity.source !== 'bangumi' ||
    vndb.identity.source !== 'vndb' ||
    bangumi.boundSubjectId === vndb.boundSubjectId
  )
    throw new TypeError('Reviewed Person pair must be one Bangumi original and one VNDB original');
  const subjects: [string, string] = [bangumi.boundSubjectId, vndb.boundSubjectId];
  const actionKey = `reviewed-person-merge:${[...subjects].sort().join(':')}`;
  // A journaled intent is the authority: resume its sealed body and key. Originals may already be redirected
  // by the merge, so their reviewed identities are read only when the intent is new.
  let intent = input.journal.action(actionKey);
  if (!intent) {
    const endpoints: ReviewedPersonEndpoint[] = [];
    for (const source of input.pair) {
      const read = await input.transport.readReviewedPersonIdentity(source.boundSubjectId, {
        source: source.sourceAlias as ReviewedPersonSource['source'],
        externalId: source.identity.externalId,
      });
      const endpoint = read.reviewedIdentity;
      if (!endpoint)
        return { state: 'withheld', reason: `${source.identity.externalId} has no coherent reviewed identity` };
      if (
        endpoint.subject !== source.boundSubjectId ||
        endpoint.property !== source.identity.property ||
        endpoint.value !== source.identity.value
      )
        return { state: 'withheld', reason: `${source.identity.externalId} observed a different identity` };
      endpoints.push(endpoint);
    }
    const body: ReviewedPersonMerge = {
      subjects,
      expectedIdentity: { endpoints: [endpoints[0]!, endpoints[1]!] },
    };
    const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    input.journal.prepareAction(actionKey, body, mergeKey(digest));
    intent = input.journal.action(actionKey)!;
  }
  const sealed = JSON.parse(intent.body_json) as ReviewedPersonMerge;
  if (intent.state === 'refused') return { state: 'withheld', reason: intent.error_code ?? 'refused' };
  let operation: string | null = intent.result_id;
  if (operation === null) {
    try {
      const admission = await input.transport.mergeReviewedPersons(sealed, intent.idempotency_key);
      operation = admission.operation.id;
    } catch (error) {
      // A definite client refusal is terminal. Other failures may have reached Kernel: resume replays this exact intent.
      const status = (error as { status?: unknown }).status;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        input.journal.refuseAction(actionKey, `review-http-${status}`);
        return { state: 'withheld', reason: `Native merge refused with HTTP ${status}` };
      }
      throw error;
    }
    input.journal.acknowledgeAction(actionKey, operation);
  }
  const pause = input.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const polls = input.polls ?? MERGE_POLLS;
  let done: Extract<ReviewedPersonOperation, { done: true }> | undefined;
  for (let attempt = 0; attempt < polls && !done; attempt += 1) {
    const observed = await input.transport.readReviewedPersonOperation(operation);
    if (observed.done) done = observed;
    else if (attempt + 1 < polls) await pause(MERGE_POLL_MS);
  }
  if (!done) return { state: 'pending', operation };
  const { survivor, redirected, revision } = done.result;
  if (
    !subjects.includes(survivor) ||
    !subjects.includes(redirected) ||
    survivor === redirected ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    throw new TypeError('Invalid native Person publication');
  const reads = await Promise.all(input.pair.map((source) => input.readPublic(source.boundSubjectId)));
  const identities = input.pair.flatMap((source, index) => {
    const observed = observePersonIdentity(source.identity, reads[index]!);
    return observed.state === 'current' && observed.currentSubjectId === survivor
      ? [{ boundSubjectId: source.boundSubjectId, identity: source.identity, currentSubjectId: survivor }]
      : [];
  });
  if (identities.length !== input.pair.length) return { state: 'unconfirmed', operation };
  return { state: 'published', operation, survivor, redirected, revision, identities };
}
