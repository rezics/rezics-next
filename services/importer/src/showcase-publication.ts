import { Database } from 'bun:sqlite';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult, BatchStatement } from '@rezics/definitions/bulk';
import type { ReviewedSubjectRead } from './import-client.ts';
import { createImportTransport } from './import-client.ts';
import type { CrossMediaPlan, CrossMediaPort, CrossMediaSeedResult } from './cross-media-seed.ts';
import {
  buildShowcaseManifest,
  showcaseDigest,
  showcaseLimits,
  showcaseSourceMatches,
  showcaseStatementMatches,
  type ShowcaseAcknowledgement,
  type ShowcaseAssertion,
  type ShowcaseManifest,
  type ShowcaseRecord,
  type ShowcaseVocabularyRecord,
  type ShowcaseVocabularyRequirement,
} from './showcase-manifest.ts';
import type { PublicBulkClient } from './public-bulk-client.ts';
import { GLOBAL_CONTEXT } from './public-bulk-client.ts';
import { createSourceRegistration } from './source-registry.ts';
import { converter_revision as entityRevision, mapSourceEnumeration } from '@rezics/conversion/cross-media-entities';
import { subjectSlug } from '@rezics/definitions/slug';

type ImportTransport = ReturnType<typeof createImportTransport>;
export type ShowcaseReviewPort = Pick<
  ImportTransport,
  'readReviewedSubject' | 'reviewedCandidates' | 'acceptReviewedCandidate' | 'adoptReviewedCandidates'
>;

type JournalCommandRow = {
  command_key: string;
  command_digest: string;
  command_json: string;
  state: 'prepared' | 'acknowledged';
  subject_id: string | null;
  candidate_id: string | null;
};
type JournalActionRow = {
  action_key: string;
  body_digest: string;
  body_json: string;
  idempotency_key: string;
  state: 'prepared' | 'acknowledged' | 'refused';
  error_code: string | null;
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function successResult(
  result: BatchWriteResult['results'][number],
): result is Extract<BatchWriteResult['results'][number], { status: 200 | 201 }> {
  return result.status === 200 || result.status === 201;
}

/** Durable, local-only journal for exact source commands and separately authorized review actions. */
export class ShowcaseJournal {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS showcase_command (
        command_key TEXT PRIMARY KEY,
        command_digest TEXT NOT NULL,
        command_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared','acknowledged')),
        subject_id TEXT,
        candidate_id TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS showcase_intent (
        intent_digest TEXT PRIMARY KEY,
        intent_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS showcase_action (
        action_key TEXT PRIMARY KEY,
        body_digest TEXT NOT NULL,
        body_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared','acknowledged','refused')),
        error_code TEXT
      ) STRICT;
    `);
  }

  prepareCommand(command: BatchCommand): void {
    const commandDigest = showcaseDigest(command);
    const prior = this.#db
      .query<Pick<JournalCommandRow, 'command_digest' | 'command_json'>, [string]>(
        'SELECT command_digest,command_json FROM showcase_command WHERE command_key=?',
      )
      .get(command.key);
    if (prior) {
      if (prior.command_digest !== commandDigest || prior.command_json !== json(command))
        throw new TypeError('Showcase command key was reused with a changed body');
      return;
    }
    this.#db
      .query("INSERT INTO showcase_command(command_key,command_digest,command_json,state) VALUES(?,?,?,'prepared')")
      .run(command.key, commandDigest, json(command));
  }

  acknowledgeCommand(
    command: BatchCommand,
    result: Extract<BatchWriteResult['results'][number], { status: 200 | 201 }>,
  ): void {
    const value = result.value;
    const subjectId = 'id' in value ? value.id : command.op === 'propose' ? command.subject : null;
    const candidateId = 'candidate' in value ? value.candidate : null;
    const prior = this.#db
      .query<Pick<JournalCommandRow, 'command_digest' | 'subject_id' | 'candidate_id'>, [string]>(
        'SELECT command_digest,subject_id,candidate_id FROM showcase_command WHERE command_key=?',
      )
      .get(command.key);
    if (!prior || prior.command_digest !== showcaseDigest(command))
      throw new TypeError('Showcase ACK does not match a prepared command');
    if (
      (prior.subject_id && subjectId && prior.subject_id !== subjectId) ||
      (prior.candidate_id && candidateId && prior.candidate_id !== candidateId)
    )
      throw new TypeError('Showcase ACK identity changed for a sealed command');
    this.#db
      .query(
        "UPDATE showcase_command SET state='acknowledged',subject_id=COALESCE(subject_id,?),candidate_id=COALESCE(candidate_id,?) WHERE command_key=?",
      )
      .run(subjectId, candidateId, command.key);
  }

  acknowledgedCommands(): ShowcaseAcknowledgement[] {
    return this.#db
      .query<JournalCommandRow, [number]>(
        "SELECT command_key,command_digest,command_json,state,subject_id,candidate_id FROM showcase_command WHERE state='acknowledged' ORDER BY command_key LIMIT ?",
      )
      .all(showcaseLimits.candidates + showcaseLimits.records)
      .map((row) => ({
        command: JSON.parse(row.command_json) as BatchCommand,
        commandDigest: row.command_digest,
        ...(row.subject_id ? { subjectId: row.subject_id } : {}),
        ...(row.candidate_id ? { candidateId: row.candidate_id } : {}),
      }));
  }

  prepareAction(actionKey: string, body: unknown, idempotencyKey: string): unknown {
    const bodyJson = json(body);
    const bodyDigest = showcaseDigest(body);
    const prior = this.#db
      .query<JournalActionRow, [string]>('SELECT * FROM showcase_action WHERE action_key=?')
      .get(actionKey);
    if (prior) {
      if (
        prior.state === 'refused' &&
        prior.error_code?.startsWith('review-http-4') &&
        prior.body_digest !== bodyDigest
      ) {
        this.#db
          .query(
            "UPDATE showcase_action SET body_digest=?,body_json=?,idempotency_key=?,state='prepared',error_code=NULL WHERE action_key=?",
          )
          .run(bodyDigest, bodyJson, idempotencyKey, actionKey);
        return body;
      }
      // A timed-out action is retried with the original sealed body and key even if
      // the current adoption head has advanced after the server committed it.
      if (prior.state === 'acknowledged' && prior.body_digest !== bodyDigest)
        throw new TypeError('Acknowledged showcase action changed under the same intent');
      return JSON.parse(prior.body_json) as unknown;
    }
    this.#db
      .query(
        "INSERT INTO showcase_action(action_key,body_digest,body_json,idempotency_key,state) VALUES(?,?,?,?,'prepared')",
      )
      .run(actionKey, bodyDigest, bodyJson, idempotencyKey);
    return body;
  }

  action(actionKey: string): JournalActionRow | null {
    return (
      this.#db.query<JournalActionRow, [string]>('SELECT * FROM showcase_action WHERE action_key=?').get(actionKey) ??
      null
    );
  }

  acknowledgeAction(actionKey: string): void {
    this.#db.query("UPDATE showcase_action SET state='acknowledged',error_code=NULL WHERE action_key=?").run(actionKey);
  }

  refuseAction(actionKey: string, errorCode: string): void {
    this.#db
      .query("UPDATE showcase_action SET state='refused',error_code=? WHERE action_key=?")
      .run(errorCode, actionKey);
  }

  sealIntent(manifest: ShowcaseManifest): void {
    const intent = {
      records: manifest.records.map((record) => ({
        provider: record.provider,
        sourceKey: record.sourceKey,
        subjectId: record.subjectId,
        assertions: record.assertions.map(({ commandKey, candidateId, candidateDigest }) => ({
          commandKey,
          candidateId,
          candidateDigest,
        })),
      })),
      vocabulary: manifest.vocabulary.map((record) => ({
        sourceKey: record.sourceKey,
        subjectId: record.subjectId,
        assertions: record.assertions.map(({ commandKey, candidateId, candidateDigest }) => ({
          commandKey,
          candidateId,
          candidateDigest,
        })),
      })),
    };
    const body = json(intent);
    const prior = this.#db
      .query<{ intent_json: string }, [string]>('SELECT intent_json FROM showcase_intent WHERE intent_digest=?')
      .get(manifest.digest);
    if (prior) {
      if (prior.intent_json !== body) throw new TypeError('Showcase intent changed under the same source digest');
      return;
    }
    this.#db.query('INSERT INTO showcase_intent(intent_digest,intent_json) VALUES(?,?)').run(manifest.digest, body);
  }

  close(): void {
    this.#db.close();
  }
}

/** Persist each exact body before transport, then seal only acknowledged native UUIDs. */
export function captureShowcaseCommands(port: CrossMediaPort, journal: ShowcaseJournal): CrossMediaPort {
  return {
    ...port,
    async batch(request: BatchWriteRequest): Promise<BatchWriteResult> {
      for (const command of request.commands) {
        if (command.op === 'create' || command.op === 'propose') journal.prepareCommand(command);
      }
      const result = await port.batch(request);
      const byKey = new Map(result.results.map((row) => [row.key, row]));
      for (const command of request.commands) {
        if (command.op !== 'create' && command.op !== 'propose') continue;
        const acknowledgement = byKey.get(command.key);
        if (acknowledgement && successResult(acknowledgement)) journal.acknowledgeCommand(command, acknowledgement);
      }
      return result;
    },
  };
}

type CandidateRead = {
  id: string;
  source: BatchCommand['source'] | null;
  statement: BatchStatement;
  head: number | null;
  decision?: 'accept' | 'reject' | 'abstain' | null;
};
type CandidatePage = {
  candidates: CandidateRead[];
  next: unknown;
  adoption: { head?: number | null; selection?: { candidate: string; rank: 'normal' | 'preferred' }[] } | null;
};
const nativeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function subjectId(read: ReviewedSubjectRead): string | null {
  const subject = read.subject as { id?: unknown } | undefined;
  return typeof subject?.id === 'string' ? subject.id : null;
}

function subjectType(read: ReviewedSubjectRead): string | null {
  const subject = read.subject as { type?: unknown } | undefined;
  return typeof subject?.type === 'string' ? subject.type : null;
}

function safeCandidatePage(value: unknown): CandidatePage {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid current candidate page');
  const page = value as Partial<CandidatePage>;
  if (
    !Array.isArray(page.candidates) ||
    page.candidates.length > showcaseLimits.reviewPage ||
    page.candidates.some(
      (candidate) =>
        !candidate ||
        typeof candidate !== 'object' ||
        !nativeUuid.test(candidate.id) ||
        !candidate.statement ||
        typeof candidate.statement !== 'object',
    )
  )
    throw new TypeError('Invalid current candidate page');
  return page as CandidatePage;
}

function groupKey(subject: string, property: string): string {
  return `${subject}\0${property}`;
}

function statementOnPublicRead(value: unknown, expected: BatchStatement): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  const property = actual.property;
  const propertyId = typeof property === 'string' ? property : (property as { id?: unknown } | null)?.id;
  if (propertyId !== expected.property.id) return false;
  return (
    showcaseDigest({
      property: { id: propertyId },
      value: actual.value,
      qualifiers: actual.qualifiers ?? [],
      references: actual.references ?? [],
    }) ===
    showcaseDigest({
      property: expected.property,
      value: expected.value,
      qualifiers: expected.qualifiers ?? [],
      references: expected.references ?? [],
    })
  );
}

function sourceIdentity(record: ShowcaseRecord): { property: string; value: string } | null {
  if (record.provider === 'vndb') return { property: 'wdt:P3180', value: record.sourceKey };
  if (record.kind === 'work') return { property: 'wdt:P5732', value: record.sourceKey };
  if (record.kind === 'character' && record.sourceKey.startsWith('character:'))
    return { property: 'wdt:P6296', value: record.sourceKey.slice('character:'.length) };
  if (record.kind === 'person' && record.sourceKey.startsWith('person:'))
    return { property: 'wdt:P6298', value: record.sourceKey.slice('person:'.length) };
  if (record.kind === 'episode' && record.sourceUri) return { property: 'schema:url', value: record.sourceUri };
  return null;
}

function phase(record: ShowcaseRecord, assertion: ShowcaseAssertion): number {
  if (record.kind === 'source-vocabulary' && record.nativeType === 'skos:ConceptScheme') return 0;
  if (record.kind === 'source-vocabulary' && record.nativeType === 'skos:Concept') return 1;
  if (assertion.property === sourceIdentity(record)?.property) return 2;
  return 3;
}

function actionKey(kind: 'accept' | 'adopt', identity: string, digest: string): string {
  return `${kind}:${showcaseDigest({ identity, digest })}`;
}

function actionIdempotencyKey(body: unknown): string {
  return showcaseDigest(body);
}

function errorCode(error: unknown): string {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
  if (typeof status === 'number' && Number.isInteger(status)) return `review-http-${status}`;
  if (error instanceof DOMException && error.name === 'AbortError') return 'review-interrupted';
  return 'review-unavailable';
}

function recordSource(record: ShowcaseRecord, assertion: ShowcaseAssertion): boolean {
  return (
    assertion.source.source === record.sourceAlias &&
    (assertion.source.external_id === record.sourceKey || assertion.ownerKey === record.sourceKey)
  );
}

const bangumiCharacterKindsUri = 'https://rezics.com/schemes/bangumi/character-kinds';
const bangumiAppearanceRolesUri = 'https://rezics.com/schemes/bangumi/appearance-roles';
const bangumiCharacterKindsSource =
  'https://github.com/bangumi/api/blob/65d29cff2331e08c0110d30d515f7f1b6488f845/open-api/v0.yaml#/components/schemas/CharacterType';
const bangumiAppearanceRolesSource =
  'https://github.com/bangumi/Archive/blob/959474a4fcb833f6dabe8dd2f4fe192f82a71140/README.md';

function sourceVocabularyCitation(record: ShowcaseRecord, uri: string): boolean {
  if (record.provider !== 'bangumi' || record.kind !== 'source-vocabulary' || !record.sourceUri) return false;
  if (/^https:\/\/rezics\.com\/schemes\/bangumi\/character-kinds(?:\/[1-4])?$/u.test(record.sourceUri))
    return uri === record.sourceUri || uri === bangumiCharacterKindsSource;
  if (/^https:\/\/rezics\.com\/schemes\/bangumi\/appearance-roles(?:\/[1-3])?$/u.test(record.sourceUri))
    return uri === record.sourceUri || uri === bangumiAppearanceRolesSource;
  return false;
}

function proseOrImage(property: string): boolean {
  return (
    property === 'schema:image' ||
    property === 'schema:abstract' ||
    property === 'schema:description' ||
    property === 'schema:comment' ||
    property === 'schema:text' ||
    property === 'schema:articleBody'
  );
}

function admittedTextRights(record: ShowcaseRecord, assertion: ShowcaseAssertion): boolean {
  const rights = assertion.rights;
  return (
    record.provider === 'bangumi' &&
    assertion.property === 'schema:abstract' &&
    rights?.license === 'CC-BY-SA-3.0' &&
    rights.obligations.includes('cc:Attribution') &&
    rights.obligations.includes('cc:ShareAlike') &&
    !!record.sourceUri &&
    rights.attribution.includes(record.sourceUri) &&
    assertion.citations.includes(record.sourceUri)
  );
}

function publicStatements(read: ReviewedSubjectRead, property: string): readonly unknown[] {
  const subject = read.subject as { statements?: Record<string, unknown[]> } | undefined;
  return subject?.statements?.[property] ?? [];
}

function publicHasValue(read: ReviewedSubjectRead, property: string, expected: unknown): boolean {
  return publicStatements(read, property).some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const value = (entry as { value?: { content?: unknown } }).value;
    return showcaseDigest(value?.content) === showcaseDigest(expected);
  });
}

function publicStatementCites(value: unknown, uri: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const references = (value as { references?: unknown }).references;
  if (!Array.isArray(references)) return false;
  return references.some((reference) => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return false;
    const parts = (reference as { parts?: unknown }).parts;
    return (
      Array.isArray(parts) &&
      parts.some((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return false;
        const row = part as { property?: unknown; value?: { content?: unknown } };
        const property =
          typeof row.property === 'string' ? row.property : (row.property as { id?: unknown } | null)?.id;
        return property === 'schema:url' && row.value?.content === uri;
      })
    );
  });
}

function publicHasCitation(read: ReviewedSubjectRead, uri: string): boolean {
  return Object.values((read.subject as { statements?: Record<string, unknown[]> }).statements ?? {}).some((rows) =>
    rows.some((row) => publicStatementCites(row, uri)),
  );
}

function publicVocabularySourceEvidence(read: ReviewedSubjectRead, record: ShowcaseVocabularyRecord): boolean {
  if (record.provenance !== 'reviewed-catalogue')
    return !!record.sourceUri && publicHasValue(read, 'schema:url', record.sourceUri);
  if (!record.sourceUri) return false;
  if (record.nativeType === 'skos:ConceptScheme')
    return !!record.schemeUri && publicHasValue(read, 'schema:sameAs', record.schemeUri);
  return publicHasCitation(read, record.sourceUri);
}

function publicHasSourceIdentity(read: ReviewedSubjectRead, record: ShowcaseRecord): boolean {
  const identity = sourceIdentity(record);
  if (!identity || !record.sourceUri) return false;
  return publicStatements(read, identity.property).some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const value = (entry as { value?: { content?: unknown } }).value;
    return value?.content === identity.value && publicStatementCites(entry, record.sourceUri!);
  });
}

function recordHasSourceIdentity(record: ShowcaseRecord): boolean {
  const identity = sourceIdentity(record);
  if (!record.sourceUri || !identity) return false;
  return record.assertions.some(
    (assertion) =>
      assertion.property === identity.property &&
      assertion.source.digest === record.semanticDigest &&
      assertion.statement.value.type === 'value' &&
      assertion.statement.value.content === identity.value &&
      assertion.citations.includes(record.sourceUri!),
  );
}

function safeGapKey(value: Record<string, unknown>): string {
  for (const field of ['id', 'subject_id', 'vid', 'person_id', 'character_id', 'episode_id']) {
    const entry = value[field];
    if ((typeof entry === 'string' || typeof entry === 'number') && /^[A-Za-z0-9:_-]{1,64}$/u.test(String(entry)))
      return String(entry);
  }
  return 'selected-family';
}

async function candidatePage(
  input: { review: ShowcaseReviewPort; id: string; property: string },
  cache: Map<string, CandidatePage>,
): Promise<CandidatePage> {
  const key = groupKey(input.id, input.property);
  const cached = cache.get(key);
  if (cached) return cached;
  const page = safeCandidatePage(
    await input.review.reviewedCandidates(input.id, {
      property: input.property,
      context: GLOBAL_CONTEXT,
      limit: showcaseLimits.reviewPage,
    }),
  );
  if (page.candidates.length > showcaseLimits.reviewPage)
    throw new RangeError('Current candidate page exceeded its bound');
  if (cache.size >= showcaseLimits.reviewPage) cache.delete(cache.keys().next().value!);
  cache.set(key, page);
  return page;
}

async function resolveLegacyCandidates(input: {
  plan: CrossMediaPlan;
  result: CrossMediaSeedResult;
  aliases: Readonly<Record<'bangumi' | 'vndb', string>>;
  review: ShowcaseReviewPort;
  existing: readonly ShowcaseAcknowledgement[];
}): Promise<{
  acknowledgements: ShowcaseAcknowledgement[];
  omissions: { provider: 'bangumi' | 'vndb'; sourceKey: string }[];
}> {
  const acknowledgements = [...input.existing];
  const known = new Set(acknowledgements.flatMap((ack) => (ack.candidateId ? [ack.command.key] : [])));
  const readings = new Map(
    input.result.readings.map((reading) => [`${reading.source}\0${reading.externalId}`, reading]),
  );
  const omissions: { provider: 'bangumi' | 'vndb'; sourceKey: string }[] = [];
  const pageCache = new Map<string, CandidatePage>();
  const rows = [
    ...input.plan.records.bangumi.map((row) => ({ provider: 'bangumi' as const, row })),
    ...input.plan.entities.bangumi.map((row) => ({ provider: 'bangumi' as const, row })),
    ...input.plan.records.vndb.map((row) => ({ provider: 'vndb' as const, row })),
    ...input.plan.entities.vndb.map((row) => ({ provider: 'vndb' as const, row })),
  ];
  let visited = 0;
  rowLoop: for (const { provider, row } of rows) {
    const reading = readings.get(`${provider}\0${row.key}`);
    const id = reading && subjectId(reading.subject);
    if (!id) continue;
    const alias = input.aliases[provider];
    const registration = createSourceRegistration(provider, { source: alias, converterRevision: entityRevision });
    const converted = registration.convert(
      { external_id: row.key, record_revision: row.revision ?? 'unversioned', record: row.payload },
      { source: alias, subjectId: id },
    );
    for (const command of converted.proposals) {
      if (command.op !== 'propose' || known.has(command.key)) continue;
      if (visited >= showcaseLimits.candidates) {
        omissions.push({ provider, sourceKey: row.key });
        break rowLoop;
      }
      visited += 1;
      const property = command.statement.property.id;
      const page = await candidatePage({ review: input.review, id, property }, pageCache);
      const exact = page.candidates.filter(
        (candidate) =>
          showcaseSourceMatches(candidate.source, command.source) &&
          showcaseStatementMatches(candidate.statement, command.statement),
      );
      if (exact.length !== 1) {
        omissions.push({ provider, sourceKey: row.key });
        continue;
      }
      const candidate = exact[0]!;
      acknowledgements.push({
        command,
        commandDigest: showcaseDigest(command),
        subjectId: id,
        candidateId: candidate.id,
      });
      known.add(command.key);
      if (page.next !== null && page.next !== undefined) omissions.push({ provider, sourceKey: row.key });
    }
  }
  return { acknowledgements, omissions };
}

export type ShowcasePublicationResult = Readonly<{
  status: 'published' | 'incomplete';
  manifest: ShowcaseManifest;
  published: readonly {
    provider: 'bangumi' | 'vndb';
    sourceKey: string;
    subjectId: string;
    nativeType: string;
    readerRoute: string;
    assertions: readonly { candidateId: string; property: string; digest: string }[];
  }[];
  omissions: readonly { provider: 'bangumi' | 'vndb'; sourceKey: string; code: string }[];
  unresolvedCharacterDependencies: readonly {
    workKey: string | null;
    workSubjectId: string | null;
    characterKey: string;
    characterSubjectId: string | null;
    sourceIndex: number | null;
    conceptUri?: string;
    conceptId?: string;
    code?: string;
    reason: string;
    property?: string;
  }[];
}>;

/** Accept exact acknowledged candidates, adopt only those selections, then check them as a public viewer. */
export async function publishShowcase(input: {
  plan: CrossMediaPlan;
  result: CrossMediaSeedResult;
  aliases: Readonly<Record<'bangumi' | 'vndb', string>>;
  journal: ShowcaseJournal;
  review: ShowcaseReviewPort;
  publicClient: PublicBulkClient;
  vocabularyRequirements?: readonly ShowcaseVocabularyRequirement[];
}): Promise<ShowcasePublicationResult> {
  const recovered = await resolveLegacyCandidates({
    plan: input.plan,
    result: input.result,
    aliases: input.aliases,
    review: input.review,
    existing: input.journal.acknowledgedCommands(),
  });
  const genre = input.result.bangumiGenrePublication;
  const acknowledgementByCandidate = new Map<string, ShowcaseAcknowledgement>();
  for (const acknowledgement of [...recovered.acknowledgements, ...(genre?.acknowledgements ?? [])]) {
    const key = acknowledgement.candidateId ?? acknowledgement.command.key;
    acknowledgementByCandidate.set(key, acknowledgement);
  }
  const manifest = buildShowcaseManifest({
    plan: input.plan,
    readings: input.result.readings,
    acknowledgements: [...acknowledgementByCandidate.values()],
    aliases: input.aliases,
    ...(input.vocabularyRequirements ? { vocabularyRequirements: input.vocabularyRequirements } : {}),
    ...(genre
      ? {
          reviewedVocabulary: genre.vocabulary,
          currentBangumiGenreCandidateIds: genre.candidateIds,
          bangumiGenreOwnerKeys: genre.ownerKeys,
        }
      : {}),
  });
  input.journal.sealIntent(manifest);

  const omissions = [
    ...manifest.omissions.map((item) => ({ ...item, code: item.code })),
    ...recovered.omissions.map((item) => ({ ...item, code: 'legacy-candidate-not-exact' })),
  ].slice(0, showcaseLimits.omissions);
  if (!manifest.records.length && !manifest.vocabulary.length)
    omissions.push({ provider: 'bangumi', sourceKey: 'selected-family', code: 'source-read-missing' });
  if (input.result.status === 'imported-with-gaps')
    omissions.push({ provider: 'bangumi', sourceKey: 'selected-family', code: 'source-claim-withheld' });
  for (const gap of input.result.gaps.slice(0, showcaseLimits.omissions))
    omissions.push({ provider: gap.source, sourceKey: safeGapKey(gap.record), code: 'source-claim-withheld' });
  for (const unresolved of input.result.unresolved.slice(0, showcaseLimits.omissions))
    omissions.push({ provider: 'bangumi', sourceKey: unresolved.holder, code: 'source-claim-withheld' });
  if (input.result.creditGaps.length || input.result.characterDiagnostics.length)
    omissions.push({ provider: 'bangumi', sourceKey: 'selected-family', code: 'source-claim-withheld' });
  const typeById = new Map<string, string>();
  for (const record of manifest.records)
    if (record.subjectId && record.nativeType) typeById.set(record.subjectId, record.nativeType);
  for (const record of manifest.vocabulary) typeById.set(record.subjectId, record.nativeType);

  const assertions = [
    ...manifest.records.flatMap((record) => record.assertions.map((assertion) => ({ record, assertion }))),
    ...manifest.vocabulary.flatMap((record) =>
      record.assertions.map((assertion) => ({
        record: {
          provider: record.provider,
          sourceAlias: record.sourceAlias,
          sourceKey: record.sourceKey,
          sourceUri: record.sourceUri,
          sourceRevision: 'unversioned',
          rawDigest: record.assertions[0]?.source.digest ?? '',
          semanticDigest: record.assertions[0]?.source.digest ?? '',
          converterRevision: record.assertions[0]?.source.converter_revision ?? '',
          kind: 'source-vocabulary' as const,
          subjectId: record.subjectId,
          nativeType: record.nativeType,
          readerRoute: null,
          assertions: record.assertions,
        },
        assertion,
      })),
    ),
  ].sort(
    (left, right) =>
      phase(left.record, left.assertion) - phase(right.record, right.assertion) ||
      left.assertion.candidateId.localeCompare(right.assertion.candidateId),
  );
  const currentSubjectCache = new Map<string, ReviewedSubjectRead | null>();
  const pageCache = new Map<string, CandidatePage>();
  const validated = new Map<string, CandidateRead>();
  const blockedSubjects = new Set<string>();
  const vocabularyById = new Map(manifest.vocabulary.map((record) => [record.subjectId, record]));
  for (const record of manifest.records) {
    if (!record.subjectId || recordHasSourceIdentity(record)) continue;
    blockedSubjects.add(record.subjectId);
    omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'source-uri-not-current' });
  }
  for (const record of manifest.vocabulary) {
    const sourceUri = record.sourceUri;
    const sourceAssertion = record.assertions.find(
      (assertion) =>
        assertion.property === 'schema:url' &&
        assertion.statement.value.type === 'value' &&
        assertion.statement.value.content === sourceUri &&
        !!sourceUri &&
        assertion.citations.includes(sourceUri),
    );
    const reviewedSourceAssertion =
      record.provenance === 'reviewed-catalogue' &&
      (record.nativeType === 'skos:ConceptScheme'
        ? record.assertions.some(
            (assertion) =>
              assertion.property === 'schema:sameAs' &&
              assertion.statement.value.type === 'value' &&
              assertion.statement.value.content === record.schemeUri,
          )
        : record.assertions.some((assertion) => assertion.citations.includes(record.sourceUri!)));
    if (
      (!sourceAssertion && !reviewedSourceAssertion) ||
      (record.nativeType === 'skos:Concept' &&
        (!record.schemeId ||
          !vocabularyById.has(record.schemeId) ||
          record.schemeId === record.subjectId ||
          !record.assertions.some(
            (assertion) =>
              assertion.property === 'skos:inScheme' &&
              assertion.statement.value.type === 'value' &&
              assertion.statement.value.content === record.schemeId,
          )))
    ) {
      blockedSubjects.add(record.subjectId);
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'vocabulary-binding-missing' });
    }
  }

  for (const { record, assertion } of assertions) {
    const id = record.subjectId;
    if (!id || !recordSource(record, assertion)) continue;
    let current = currentSubjectCache.get(id);
    if (current === undefined) {
      try {
        current = await input.review.readReviewedSubject(id);
      } catch {
        current = null;
      }
      currentSubjectCache.set(id, current);
    }
    if (!current || subjectId(current) !== id || subjectType(current) !== typeById.get(id)) {
      omissions.push({
        provider: record.provider,
        sourceKey: record.sourceKey,
        code: 'current-source-identity-mismatch',
      });
      continue;
    }
    if (blockedSubjects.has(id)) continue;
    if (
      proseOrImage(assertion.property) &&
      (assertion.property === 'schema:image' || !admittedTextRights(record, assertion))
    ) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'content-rights-not-admitted' });
      continue;
    }
    if (
      !assertion.citations.length ||
      assertion.citations.some((uri) => {
        try {
          const parsed = new URL(uri);
          if (parsed.protocol !== 'https:') return true;
          const host = parsed.hostname.toLowerCase();
          return record.provider === 'bangumi'
            ? host !== 'bgm.tv' &&
                host !== 'bangumi.tv' &&
                host !== 'www.bgm.tv' &&
                host !== 'www.bangumi.tv' &&
                !sourceVocabularyCitation(record, uri)
            : host !== 'vndb.org' && !host.endsWith('.vndb.org');
        } catch {
          return true;
        }
      })
    ) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'source-uri-not-current' });
      continue;
    }
    if (
      record.kind !== 'source-vocabulary' &&
      assertion.source.digest === record.semanticDigest &&
      record.sourceUri &&
      !assertion.citations.includes(record.sourceUri)
    ) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'source-uri-not-current' });
      continue;
    }
    let page: CandidatePage;
    try {
      page = await candidatePage({ review: input.review, id, property: assertion.property }, pageCache);
    } catch {
      omissions.push({
        provider: record.provider,
        sourceKey: record.sourceKey,
        code: 'candidate-current-read-unavailable',
      });
      continue;
    }
    const candidate = page.candidates.find((entry) => entry.id === assertion.candidateId);
    if (
      !candidate ||
      !showcaseSourceMatches(candidate.source, assertion.source) ||
      !showcaseStatementMatches(candidate.statement, assertion.statement) ||
      showcaseDigest({ source: candidate.source, statement: candidate.statement }) !== assertion.candidateDigest
    ) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'candidate-digest-changed' });
      continue;
    }
    if (page.next !== null && page.next !== undefined && !candidate) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'candidate-page-bounded' });
      continue;
    }
    validated.set(assertion.candidateId, candidate);
  }

  const stoppedSubjects = new Set<string>();
  for (const { record, assertion } of assertions) {
    const id = record.subjectId;
    if (!id || !validated.has(assertion.candidateId) || stoppedSubjects.has(id)) continue;
    const candidate = validated.get(assertion.candidateId)!;
    if (candidate.decision === 'accept') continue;
    if (candidate.decision === 'reject') {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'candidate-currently-rejected' });
      stoppedSubjects.add(id);
      continue;
    }
    const body = { context: GLOBAL_CONTEXT, expected_head: candidate.head ?? null };
    const key = actionKey('accept', assertion.candidateId, assertion.candidateDigest);
    const idempotencyKey = actionIdempotencyKey(body);
    const prior = input.journal.action(key);
    if (prior?.state === 'acknowledged') continue;
    const sealedBody = input.journal.prepareAction(key, body, idempotencyKey) as typeof body;
    const sealedKey = input.journal.action(key)!.idempotency_key;
    try {
      await input.review.acceptReviewedCandidate(id, assertion.candidateId, sealedBody, sealedKey);
      input.journal.acknowledgeAction(key);
      pageCache.delete(groupKey(id, assertion.property));
    } catch (error) {
      input.journal.refuseAction(key, errorCode(error));
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: errorCode(error) });
      stoppedSubjects.add(id);
    }
  }

  const grouped = new Map<string, { record: ShowcaseRecord; property: string; ids: Set<string> }>();
  for (const { record, assertion } of assertions) {
    const id = record.subjectId;
    if (!id || !validated.has(assertion.candidateId) || stoppedSubjects.has(id)) continue;
    const key = groupKey(id, assertion.property);
    const group = grouped.get(key) ?? { record, property: assertion.property, ids: new Set<string>() };
    group.ids.add(assertion.candidateId);
    grouped.set(key, group);
  }

  const publicSubjects = new Map<string, ReviewedSubjectRead | null>();
  const publicRead = async (id: string): Promise<ReviewedSubjectRead | null> => {
    if (publicSubjects.has(id)) return publicSubjects.get(id) ?? null;
    try {
      const read = await input.publicClient.readSubject(id);
      publicSubjects.set(id, read);
      return read;
    } catch {
      publicSubjects.set(id, null);
      return null;
    }
  };
  for (const [key, group] of grouped) {
    const [id] = key.split('\0');
    if (!id || stoppedSubjects.has(id)) continue;
    let page: CandidatePage;
    try {
      page = await candidatePage({ review: input.review, id, property: group.property }, pageCache);
    } catch {
      omissions.push({
        provider: group.record.provider,
        sourceKey: group.record.sourceKey,
        code: 'adoption-current-read-unavailable',
      });
      stoppedSubjects.add(id);
      continue;
    }
    const previous = page.adoption;
    const priorSelection = Array.isArray(previous?.selection) ? previous.selection : [];
    if (previous && !Array.isArray(previous.selection)) {
      omissions.push({
        provider: group.record.provider,
        sourceKey: group.record.sourceKey,
        code: 'adoption-selection-unavailable',
      });
      stoppedSubjects.add(id);
      continue;
    }
    const selections = new Map<string, 'normal' | 'preferred'>();
    for (const item of priorSelection)
      if (item?.candidate) selections.set(item.candidate, item.rank === 'preferred' ? 'preferred' : 'normal');
    for (const candidateId of group.ids) selections.set(candidateId, selections.get(candidateId) ?? 'normal');
    if (selections.size > showcaseLimits.reviewPage) {
      omissions.push({
        provider: group.record.provider,
        sourceKey: group.record.sourceKey,
        code: 'adoption-selection-bounded',
      });
      stoppedSubjects.add(id);
      continue;
    }
    const dependencyIds = new Set<string>();
    for (const assertion of assertions.filter(
      (entry) => entry.record.subjectId === id && entry.assertion.property === group.property,
    )) {
      const value = assertion.assertion.statement.value;
      const content = value.type === 'value' ? value.content : undefined;
      if (typeof content === 'string' && vocabularyById.has(content)) dependencyIds.add(content);
    }
    const concept = vocabularyById.get(id);
    if (concept?.nativeType === 'skos:Concept' && concept.schemeId) dependencyIds.add(concept.schemeId);
    let dependencyReady = true;
    const identityProperty = group.property === sourceIdentity(group.record)?.property;
    if (group.record.kind !== 'source-vocabulary' && !identityProperty) {
      const sourceRead = await publicRead(id);
      if (
        !sourceRead ||
        subjectId(sourceRead) !== id ||
        subjectType(sourceRead) !== typeById.get(id) ||
        !publicHasSourceIdentity(sourceRead, group.record)
      ) {
        omissions.push({
          provider: group.record.provider,
          sourceKey: group.record.sourceKey,
          code: 'source-uri-not-current',
        });
        stoppedSubjects.add(id);
        continue;
      }
    }
    for (const dependencyId of dependencyIds) {
      const dependency = vocabularyById.get(dependencyId);
      const dependencyRead = await publicRead(dependencyId);
      if (
        !dependency ||
        !dependencyRead ||
        subjectId(dependencyRead) !== dependencyId ||
        subjectType(dependencyRead) !== dependency.nativeType ||
        !dependency.sourceUri ||
        !publicVocabularySourceEvidence(dependencyRead, dependency) ||
        (dependency.nativeType === 'skos:Concept' &&
          (!dependency.schemeId || !publicHasValue(dependencyRead, 'skos:inScheme', dependency.schemeId)))
      ) {
        omissions.push({
          provider: group.record.provider,
          sourceKey: group.record.sourceKey,
          code: 'vocabulary-binding-not-current',
        });
        dependencyReady = false;
        break;
      }
    }
    if (!dependencyReady) {
      stoppedSubjects.add(id);
      continue;
    }
    const body = {
      context: GLOBAL_CONTEXT,
      property: group.property,
      mode: 'replace' as const,
      expected_head: previous?.head ?? null,
      selection: [...selections]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([candidate, rank]) => ({ candidate, rank })),
    };
    const action = actionKey('adopt', `${id}:${group.property}`, manifest.digest);
    const idempotencyKey = actionIdempotencyKey(body);
    const priorAction = input.journal.action(action);
    if (priorAction?.state === 'acknowledged') continue;
    const sealedBody = input.journal.prepareAction(action, body, idempotencyKey) as typeof body;
    const sealedKey = input.journal.action(action)!.idempotency_key;
    try {
      await input.review.adoptReviewedCandidates(id, sealedBody, sealedKey);
      input.journal.acknowledgeAction(action);
      pageCache.delete(groupKey(id, group.property));
      publicSubjects.delete(id);
    } catch (error) {
      input.journal.refuseAction(action, errorCode(error));
      omissions.push({ provider: group.record.provider, sourceKey: group.record.sourceKey, code: errorCode(error) });
      stoppedSubjects.add(id);
    }
  }

  const published: {
    provider: 'bangumi' | 'vndb';
    sourceKey: string;
    subjectId: string;
    nativeType: string;
    readerRoute: string;
    kind: string;
    assertions: { candidateId: string; property: string; digest: string }[];
  }[] = [];
  const publicRecords = [
    ...manifest.records,
    ...manifest.vocabulary.map((record) => ({
      provider: record.provider,
      sourceAlias: record.sourceAlias,
      sourceKey: record.sourceKey,
      sourceUri: record.sourceUri,
      sourceRevision: 'unversioned',
      rawDigest: '',
      semanticDigest: '',
      converterRevision: '',
      kind: 'source-vocabulary' as const,
      subjectId: record.subjectId,
      nativeType: record.nativeType,
      readerRoute: null,
      assertions: record.assertions,
    })),
  ];
  for (const record of publicRecords) {
    if (!record.subjectId || !record.nativeType) continue;
    const read = await publicRead(record.subjectId);
    if (!read || subjectId(read) !== record.subjectId || subjectType(read) !== record.nativeType) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'public-view-unavailable' });
      continue;
    }
    const publicSubject = read.subject as { statements?: Record<string, unknown[]> } | undefined;
    const visible = record.assertions.filter((assertion) => {
      if (!validated.has(assertion.candidateId)) return false;
      const rows = publicSubject?.statements?.[assertion.property] ?? [];
      return rows.some((row) => statementOnPublicRead(row, assertion.statement));
    });
    if (visible.length !== record.assertions.length) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'selected-facts-not-public' });
      continue;
    }
    const publicIdentity = read.subject as { labels?: Record<string, string> } | undefined;
    const label =
      publicIdentity?.labels?.und ??
      publicIdentity?.labels?.en ??
      publicIdentity?.labels?.ja ??
      publicIdentity?.labels?.zh ??
      Object.values(publicIdentity?.labels ?? {})[0] ??
      'subject';
    const route = `/subjects/${record.subjectId}/${subjectSlug(label)}`;
    published.push({
      provider: record.provider,
      sourceKey: record.sourceKey,
      subjectId: record.subjectId,
      nativeType: record.nativeType,
      readerRoute: route,
      kind: record.kind,
      assertions: visible.map(({ candidateId, property, candidateDigest }) => ({
        candidateId,
        property,
        digest: candidateDigest,
      })),
    });
  }

  const uniqueOmissions = [
    ...new Map(omissions.map((item) => [`${item.provider}\0${item.sourceKey}\0${item.code}`, item])).values(),
  ].slice(0, showcaseLimits.omissions);
  const unresolvedCharacterDependencies = input.result.characterDiagnostics
    .slice(0, showcaseLimits.omissions)
    .flatMap((gap) => {
      const appearanceIndex = /^\/subject-characters\/([0-9]+)\/type$/u.exec(gap.path)?.[1];
      const appearance =
        appearanceIndex === undefined
          ? undefined
          : input.plan.characterAppearances?.find((row) => row.sourceIndex === Number(appearanceIndex));
      const characterCode = /^\/character\/([1-9][0-9]*)\/type$/u.exec(gap.path)?.[1];
      const characterKey = appearance
        ? `character:${appearance.characterId}`
        : characterCode
          ? `character:${characterCode}`
          : undefined;
      if (!characterKey) return [];
      const workKey = appearance?.subjectId ?? null;
      const work = workKey
        ? manifest.records.find((record) => record.provider === 'bangumi' && record.sourceKey === workKey)
        : undefined;
      const character = manifest.records.find(
        (record) => record.provider === 'bangumi' && record.sourceKey === characterKey,
      );
      const characterRecord = [...input.plan.records.bangumi, ...input.plan.entities.bangumi].find(
        (record) => record.key === characterKey,
      );
      const code = appearance?.roleCode ?? (characterRecord?.payload as Record<string, unknown> | undefined)?.type;
      const group = appearance ? 'subject-characters.type' : 'character.role';
      const enumeration =
        typeof code === 'number' || typeof code === 'string'
          ? mapSourceEnumeration('bangumi', group, code)
          : undefined;
      const conceptUri = enumeration?.concept?.id;
      const concept = conceptUri
        ? manifest.vocabulary.find(
            (record) =>
              record.provider === 'bangumi' &&
              record.nativeType === 'skos:Concept' &&
              record.sourceUri === conceptUri,
          )
        : undefined;
      return [
        {
          workKey,
          workSubjectId: work?.subjectId ?? null,
          characterKey,
          characterSubjectId: character?.subjectId ?? null,
          sourceIndex: appearance?.sourceIndex ?? null,
          ...(conceptUri ? { conceptUri } : {}),
          ...(concept?.subjectId ? { conceptId: concept.subjectId } : {}),
          ...(gap.code ? { code: gap.code.slice(0, 64) } : {}),
          reason: gap.reason,
          ...(gap.property ? { property: gap.property } : {}),
        },
      ];
    });
  return {
    status:
      uniqueOmissions.length || published.length !== manifest.records.length + manifest.vocabulary.length
        ? 'incomplete'
        : 'published',
    manifest,
    published,
    omissions: uniqueOmissions,
    unresolvedCharacterDependencies,
  };
}
