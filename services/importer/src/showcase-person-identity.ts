import { createHash } from 'node:crypto';
import type {
  ReviewedPersonAdmission,
  ReviewedPersonEndpoint,
  ReviewedPersonMerge,
  ReviewedPersonOperation,
  ReviewedPersonRead,
  ReviewedPersonSource,
} from '@rezics/client';
import type { MediaVariantDecision, ReviewedSubjectRead } from './import-client.ts';
import { ReviewedSubjectNotReady } from './public-bulk-client.ts';
import type { Provider } from './cross-media-bindings.ts';
import type { SourceRecord } from '@rezics/conversion';

export type ImportProducerPhase = 'readiness' | 'merge403' | 'SubjectGET503';

/** Map a public or merge failure onto the exact producer phase the seed already reports. */
export function importProducerPhase(error: unknown): ImportProducerPhase | undefined {
  if (error instanceof ReviewedSubjectNotReady) return 'readiness';
  const status = (error as { status?: unknown }).status;
  const type = (error as { type?: unknown }).type;
  const phase = (error as { phase?: unknown }).phase;
  if (phase === 'readiness' || phase === 'merge403' || phase === 'SubjectGET503') return phase;
  if (status === 403) return 'merge403';
  if (status === 503 && type === 'https://rezics.com/problems/semantic_not_ready') return 'readiness';
  if (status === 503) return 'SubjectGET503';
  return undefined;
}

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

/** Durable original binding plus the current canonical Person it now reads as. */
export type BoundPersonIdentity = CurrentPersonIdentity & { boundSubjectId: string };

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

/**
 * After a reviewed merge, reread each original binding through the public reader. Only identities that are
 * still current on that canonical Person are retained; `semantic_not_ready` is skipped for a later run.
 */
export async function rereadCanonicalPersonIdentities(input: {
  identities: readonly BoundPersonIdentity[];
  readPublic: (id: string) => Promise<ReviewedSubjectRead>;
}): Promise<{
  identities: BoundPersonIdentity[];
  canonicalPersons: Record<string, string>;
  unconfirmed: readonly BoundPersonIdentity[];
}> {
  const identities: BoundPersonIdentity[] = [];
  const unconfirmed: BoundPersonIdentity[] = [];
  const canonicalPersons: Record<string, string> = {};
  for (const entry of input.identities) {
    const read = await input.readPublic(entry.boundSubjectId).catch((error: unknown) => {
      if (error instanceof ReviewedSubjectNotReady) return null;
      throw error;
    });
    const observed = read ? observePersonIdentity(entry.identity, read) : undefined;
    if (!observed || observed.state !== 'current') {
      unconfirmed.push(entry);
      continue;
    }
    identities.push({ ...observed, boundSubjectId: entry.boundSubjectId });
    canonicalPersons[entry.identity.externalId] = observed.currentSubjectId;
  }
  return { identities, canonicalPersons, unconfirmed };
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

/** A native job may take minutes under load; the journal keeps its admitted operation for a later run. */
const MERGE_POLLS = 120;
const MERGE_POLL_MS = 1_000;
const MERGE_READ_ATTEMPTS = 10;

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
        const phase = status === 403 ? 'merge403' : `review-http-${status}`;
        input.journal.refuseAction(actionKey, phase);
        return { state: 'withheld', reason: phase };
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
  // The completed operation is final; a public read may still lag behind its visibility, so re-read briefly.
  // Only the exact not-ready read counts as "not current yet"; any other read failure is terminal.
  const readCurrentOrNull = (id: string): Promise<ReviewedSubjectRead | null> =>
    input.readPublic(id).catch((error: unknown) => {
      if (error instanceof ReviewedSubjectNotReady) return null;
      throw error;
    });
  for (let attempt = 0; attempt < MERGE_READ_ATTEMPTS; attempt += 1) {
    const reads = await Promise.all(input.pair.map((source) => readCurrentOrNull(source.boundSubjectId)));
    const bothIdentitiesCurrentOnBothReads = input.pair.every((source) =>
      reads.every((read) => {
        if (!read) return false;
        const observed = observePersonIdentity(source.identity, read);
        return observed.state === 'current' && observed.currentSubjectId === survivor;
      }),
    );
    if (bothIdentitiesCurrentOnBothReads)
      return {
        state: 'published',
        operation,
        survivor,
        redirected,
        revision,
        identities: input.pair.map((source) => ({
          boundSubjectId: source.boundSubjectId,
          identity: source.identity,
          currentSubjectId: survivor,
        })),
      };
    if (attempt + 1 < MERGE_READ_ATTEMPTS) await pause(MERGE_POLL_MS);
  }
  return { state: 'unconfirmed', operation };
}

export type CharacterIdentity = Readonly<{
  source: Provider;
  externalId: string;
  property: 'wdt:P6296' | 'wdt:P3180';
  value: string;
}>;

export type CharacterIdentityObservation =
  | Readonly<{ state: 'current'; currentSubjectId: string; identity: CharacterIdentity }>
  | Readonly<{ state: 'missing' | 'wrong_type' | 'conflicting'; identity: CharacterIdentity }>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const creditProperties = new Set([
  'schema:author',
  'schema:contributor',
  'schema:creator',
  'schema:composer',
  'wdt:P86',
  'wdt:P676',
  'wdt:P725',
  'wdt:P161',
  'wdt:P170',
  'wdt:P110',
]);

type StatementRow = {
  rank?: unknown;
  value?: { type?: unknown; content?: unknown };
  qualifiers?: readonly { property?: { id?: unknown }; value?: { type?: unknown; content?: unknown } }[];
  references?: readonly { parts?: readonly { property?: { id?: unknown }; value?: { type?: unknown; content?: unknown } }[] }[];
};

function subjectStatements(read: ReviewedSubjectRead): Record<string, readonly StatementRow[]> {
  const statements = (read.subject as { statements?: Record<string, readonly StatementRow[]> }).statements;
  return statements ?? {};
}

function selectedValues(rows: readonly StatementRow[] | undefined): string[] {
  const selected = (rows ?? []).filter((row) => row.rank !== 'deprecated');
  return selected.flatMap((row) => {
    if (row.value?.type !== 'value') return [];
    if (typeof row.value.content === 'string') return [row.value.content];
    const quantity = row.value.content as { amount?: unknown } | null;
    return quantity && typeof quantity.amount === 'string' ? [quantity.amount] : [];
  });
}

function selectedFacts(
  rows: readonly StatementRow[] | undefined,
): readonly Readonly<{ content: string; qualifiers: readonly string[]; citations: readonly string[] }>[] {
  return (rows ?? [])
    .filter((row) => row.rank !== 'deprecated' && row.value?.type === 'value' && typeof row.value.content === 'string')
    .map((row) => ({
      content: row.value!.content as string,
      qualifiers: (row.qualifiers ?? []).flatMap((part) =>
        part.property?.id === 'wdt:P1932' && part.value?.type === 'value' && typeof part.value.content === 'string'
          ? [part.value.content]
          : [],
      ),
      citations: (row.references ?? []).flatMap((reference) =>
        (reference.parts ?? []).flatMap((part) =>
          part.property?.id === 'schema:url' && part.value?.type === 'value' && typeof part.value.content === 'string'
            ? [part.value.content]
            : [],
        ),
      ),
    }));
}

/** Only exact Character source keys qualify; a name or appearance never creates a binding. */
export function characterIdentityForSource(
  source: Provider,
  externalId: string,
  expectedType: string | undefined,
): CharacterIdentity | undefined {
  if (expectedType !== 'wd:Q95074') return undefined;
  if (source === 'bangumi' && /^character:[1-9][0-9]*$(?![\s\S])/u.test(externalId))
    return { source, externalId, property: 'wdt:P6296', value: externalId.slice('character:'.length) };
  if (source === 'vndb' && /^c[1-9][0-9]*$(?![\s\S])/u.test(externalId))
    return { source, externalId, property: 'wdt:P3180', value: externalId };
  return undefined;
}

export function observeCharacterIdentity(
  identity: CharacterIdentity,
  read: ReviewedSubjectRead,
): CharacterIdentityObservation {
  const subject = read.subject as { id: string; type?: unknown; statements?: Record<string, readonly StatementRow[]> };
  if (subject.type !== 'wd:Q95074') return { state: 'wrong_type', identity };
  const values = selectedValues(subject.statements?.[identity.property]);
  if (!values.length) return { state: 'missing', identity };
  const unique = new Set(values);
  if (unique.size !== 1 || !unique.has(identity.value)) return { state: 'conflicting', identity };
  return { state: 'current', currentSubjectId: subject.id, identity };
}

export type AdoptedCharacterImage =
  | Readonly<{
      state: 'served';
      mediaId: string;
      variants: readonly Readonly<{ format: 'avif' | 'webp'; width: number }>[];
    }>
  | Readonly<{ state: 'unavailable' | 'uncredited' }>;

export type AdoptedCharacterCurrent = Readonly<{
  state: 'current';
  boundSubjectId: string;
  currentSubjectId: string;
  identity: CharacterIdentity;
  names: readonly string[];
  traits: readonly string[];
  measurements: readonly string[];
  appearances: readonly string[];
  performers: readonly string[];
  sourceLinks: readonly string[];
  image: AdoptedCharacterImage;
}>;

function characterCover(read: ReviewedSubjectRead): AdoptedCharacterImage {
  const summary = (read as { summary?: { cover?: { media?: unknown; variants?: unknown; credit?: unknown } } }).summary;
  const cover = summary?.cover;
  if (!cover || typeof cover.media !== 'string' || !uuid.test(cover.media) || !Array.isArray(cover.variants))
    return { state: 'unavailable' };
  const variants = cover.variants.flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      ((entry as { format?: unknown }).format !== 'avif' && (entry as { format?: unknown }).format !== 'webp') ||
      typeof (entry as { width?: unknown }).width !== 'number'
    )
      return [];
    return [{ format: (entry as { format: 'avif' | 'webp' }).format, width: (entry as { width: number }).width }];
  });
  if (!variants.length) return { state: 'unavailable' };
  if (cover.credit == null) return { state: 'uncredited' };
  return { state: 'served', mediaId: cover.media, variants };
}

async function imageServedCurrent(
  image: AdoptedCharacterImage,
  authorize?: (mediaId: string, variant: string) => Promise<MediaVariantDecision>,
): Promise<AdoptedCharacterImage> {
  if (image.state !== 'served' || !authorize) return image;
  const smallest = new Map<string, { format: 'avif' | 'webp'; width: number }>();
  for (const variant of image.variants) if (!smallest.has(variant.format)) smallest.set(variant.format, variant);
  try {
    for (const variant of smallest.values()) {
      const decision = await authorize(image.mediaId, `${variant.format}-${variant.width}`);
      if (!decision.allowed || decision.mediaType !== `image/${variant.format}` || decision.byteCount < 1)
        return { state: 'unavailable' };
    }
    return image;
  } catch (error) {
    if (importProducerPhase(error) === 'readiness') return { state: 'unavailable' };
    throw error;
  }
}

/**
 * Independently reread an adopted Character. Names, traits, measurements, source links and the
 * rights-credited image come from this subject; appearance and performer facts stay on the work.
 */
export async function readAdoptedCharacter(input: {
  identity: CharacterIdentity;
  boundSubjectId: string;
  readPublic: (id: string) => Promise<ReviewedSubjectRead>;
  authorizeMediaVariant?: (mediaId: string, variant: string) => Promise<MediaVariantDecision>;
  appearances?: readonly string[];
  performers?: readonly string[];
}): Promise<AdoptedCharacterCurrent | { state: 'unconfirmed'; identity: CharacterIdentity }> {
  const read = await input.readPublic(input.boundSubjectId).catch((error: unknown) => {
    if (importProducerPhase(error) === 'readiness') return null;
    throw error;
  });
  if (!read) return { state: 'unconfirmed', identity: input.identity };
  const observed = observeCharacterIdentity(input.identity, read);
  if (observed.state !== 'current') return { state: 'unconfirmed', identity: input.identity };
  const statements = subjectStatements(read);
  const image = await imageServedCurrent(characterCover(read), input.authorizeMediaVariant);
  return {
    state: 'current',
    boundSubjectId: input.boundSubjectId,
    currentSubjectId: observed.currentSubjectId,
    identity: input.identity,
    names: [
      ...selectedValues(statements['schema:name']),
      ...selectedValues(statements['schema:alternateName']),
    ],
    traits: [
      ...selectedValues(statements['schema:gender']),
      ...selectedValues(statements['schema:keywords']),
      ...selectedValues(statements['wdt:P1853']),
    ],
    measurements: [
      ...selectedValues(statements['schema:height']),
      ...selectedValues(statements['schema:weight']),
      ...selectedValues(statements['schema:birthDate']),
    ],
    appearances: input.appearances ? [...input.appearances] : selectedValues(statements['wdt:P1441']),
    performers: input.performers ? [...input.performers] : [],
    sourceLinks: [...selectedValues(statements['schema:url']), ...selectedValues(statements['schema:sameAs'])],
    image,
  };
}

export async function readAdoptedCharacters(input: {
  characters: readonly Readonly<{ identity: CharacterIdentity; boundSubjectId: string }>[];
  readPublic: (id: string) => Promise<ReviewedSubjectRead>;
  authorizeMediaVariant?: (mediaId: string, variant: string) => Promise<MediaVariantDecision>;
  appearances?: Readonly<Record<string, readonly string[]>>;
  performers?: Readonly<Record<string, readonly string[]>>;
}): Promise<{
  currents: AdoptedCharacterCurrent[];
  unconfirmed: readonly CharacterIdentity[];
}> {
  const currents: AdoptedCharacterCurrent[] = [];
  const unconfirmed: CharacterIdentity[] = [];
  for (const entry of input.characters) {
    const appearances = input.appearances?.[entry.identity.externalId];
    const performers = input.performers?.[entry.identity.externalId];
    const observed = await readAdoptedCharacter({
      ...entry,
      readPublic: input.readPublic,
      ...(input.authorizeMediaVariant ? { authorizeMediaVariant: input.authorizeMediaVariant } : {}),
      ...(appearances ? { appearances } : {}),
      ...(performers ? { performers } : {}),
    });
    if (observed.state !== 'current') {
      unconfirmed.push(entry.identity);
      continue;
    }
    currents.push(observed);
  }
  return { currents, unconfirmed };
}

export type CombinedPersonCredit = Readonly<{
  workExternalId: string;
  workSubjectId: string;
  personExternalId: string;
  boundPersonId: string;
  canonicalPersonId: string;
  property: string;
  creditedAs: readonly string[];
  citations: readonly string[];
  characterExternalId?: string;
}>;

export type CombinedPersonCredits = Readonly<{
  canonicalPersonId: string;
  credits: readonly CombinedPersonCredit[];
}>;

function creditCharacter(row: StatementRow): string | undefined {
  for (const part of row.qualifiers ?? []) {
    if (
      (part.property?.id === 'wdt:P453' || part.property?.id === 'schema:character') &&
      part.value?.type === 'value' &&
      typeof part.value.content === 'string' &&
      uuid.test(part.value.content)
    )
      return part.value.content;
  }
  return undefined;
}

/**
 * After merge, both original works keep their credit statements. The value may still name the
 * durable Person; a one-hop redirect names the survivor. Combined credits are those two windows.
 */
export function recordCombinedPersonCredits(input: {
  canonicalPersonId: string;
  originals: readonly Readonly<{ boundPersonId: string; personExternalId: string }>[];
  works: readonly Readonly<{ externalId: string; read: ReviewedSubjectRead }>[];
  related?: Readonly<Record<string, { redirect?: string }>>;
}): CombinedPersonCredits {
  const originals = new Map(input.originals.map((entry) => [entry.boundPersonId, entry.personExternalId]));
  const credits: CombinedPersonCredit[] = [];
  for (const work of input.works) {
    const workId = (work.read.subject as { id: string }).id;
    const related = {
      ...(work.read as { related?: Record<string, { redirect?: string }> }).related,
      ...input.related,
    };
    for (const [property, rows] of Object.entries(subjectStatements(work.read))) {
      if (!creditProperties.has(property)) continue;
      for (const row of selectedFacts(rows)) {
        const target = row.content;
        const survivor =
          target === input.canonicalPersonId
            ? target
            : related[target]?.redirect === input.canonicalPersonId
              ? input.canonicalPersonId
              : originals.has(target)
                ? input.canonicalPersonId
                : undefined;
        if (!survivor) continue;
        const boundPersonId = originals.has(target) ? target : input.canonicalPersonId;
        const personExternalId = originals.get(boundPersonId) ?? originals.get(input.canonicalPersonId);
        if (!personExternalId) continue;
        const character = creditCharacter(
          (rows ?? []).find((entry) => entry.value?.content === target) ?? { value: { content: target } },
        );
        credits.push({
          workExternalId: work.externalId,
          workSubjectId: workId,
          personExternalId,
          boundPersonId,
          canonicalPersonId: survivor,
          property,
          creditedAs: row.qualifiers,
          citations: row.citations,
          ...(character ? { characterExternalId: character } : {}),
        });
      }
    }
  }
  return { canonicalPersonId: input.canonicalPersonId, credits };
}

export async function readCombinedPersonCredits(input: {
  canonicalPersonId: string;
  originals: readonly Readonly<{ boundPersonId: string; personExternalId: string }>[];
  works: readonly Readonly<{ externalId: string; boundSubjectId: string }>[];
  readPublic: (id: string) => Promise<ReviewedSubjectRead>;
}): Promise<CombinedPersonCredits | { state: 'unconfirmed' }> {
  const works: { externalId: string; read: ReviewedSubjectRead }[] = [];
  for (const work of input.works) {
    const read = await input.readPublic(work.boundSubjectId).catch((error: unknown) => {
      if (importProducerPhase(error) === 'readiness') return null;
      throw error;
    });
    if (!read) return { state: 'unconfirmed' };
    works.push({ externalId: work.externalId, read });
  }
  return recordCombinedPersonCredits({
    canonicalPersonId: input.canonicalPersonId,
    originals: input.originals,
    works,
  });
}
