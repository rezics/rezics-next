import { createHash } from 'node:crypto';
import type { BatchCommand, BatchStatement } from '@rezics/definitions/bulk';
import type { SourceRecord } from '@rezics/conversion';
import { converter_revision as entityRevision, vndbRecordUrl } from '@rezics/conversion/cross-media-entities';
import { bangumiVocabularyRevision } from '@rezics/conversion/bangumi-vocabulary';
import { vndbVocabularyRevision } from '@rezics/conversion/vndb-vocabulary';
import { sourceDigest } from '../../../packages/conversion/src/support.ts';
import { createSourceRegistration } from './source-registry.ts';
import type { CrossMediaPlan, CrossMediaReading } from './cross-media-seed.ts';
import type { CrossMediaMediaOutcome } from './showcase-media.ts';
import { validAvailableCover } from './showcase-media.ts';

export const showcaseLimits = Object.freeze({
  records: 768,
  candidates: 8192,
  vocabulary: 512,
  candidatesPerRecord: 128,
  reviewPage: 100,
  omissions: 256,
});
const nativeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type ShowcaseKind =
  | 'work'
  | 'person'
  | 'character'
  | 'release'
  | 'episode'
  | 'source-vocabulary'
  | 'organization';

export type ShowcaseAcknowledgement = Readonly<{
  command: BatchCommand;
  subjectId?: string;
  candidateId?: string;
  commandDigest: string;
}>;

export type ShowcaseAssertion = Readonly<{
  commandKey: string;
  candidateId: string;
  candidateDigest: string;
  property: string;
  source: BatchCommand['source'];
  statement: BatchStatement;
  rights?: Extract<BatchCommand, { op: 'propose' }>['rights'];
  citations: readonly string[];
}>;

export type ShowcaseRecord = Readonly<{
  provider: 'bangumi' | 'vndb';
  sourceAlias: string;
  sourceKey: string;
  sourceUri: string | null;
  sourceRevision: string;
  rawDigest: string;
  semanticDigest: string;
  converterRevision: string;
  kind: ShowcaseKind;
  subjectId: string | null;
  nativeType: string | null;
  readerRoute: string | null;
  assertions: readonly ShowcaseAssertion[];
}>;

export type ShowcaseVocabularyRecord = Readonly<{
  provider: 'bangumi' | 'vndb';
  sourceAlias: string;
  sourceKey: string;
  sourceUri: string | null;
  subjectId: string;
  nativeType: 'skos:ConceptScheme' | 'skos:Concept';
  schemeId: string | null;
  schemeUri?: string;
  provenance?: 'reviewed-catalogue';
  assertions: readonly ShowcaseAssertion[];
}>;

/** Exact, bounded source vocabulary requirements supplied by a provider adapter. */
export type ShowcaseVocabularyRequirement = Readonly<{
  provider: 'bangumi' | 'vndb';
  ownerKey: string;
  sourceKey: string;
  source: BatchCommand['source'];
  sourceUri: string;
  nativeType: 'skos:ConceptScheme' | 'skos:Concept';
  schemeId?: string;
}>;

export type ShowcaseOmission = Readonly<{
  provider: 'bangumi' | 'vndb';
  sourceKey: string;
  code:
    | 'source-read-missing'
    | 'candidate-ack-missing'
    | 'candidate-limit'
    | 'vocabulary-binding-missing'
    | 'source-claim-withheld'
    | 'cover-source-absent'
    | 'cover-source-unavailable'
    | 'cover-pending'
    | 'cover-rejected'
    | 'cover-fenced'
    | 'cover-candidate-missing'
    | 'cover-not-public';
}>;

export type ShowcaseMediaRecord = Readonly<{
  sourceAlias: string;
  sourceKey: string;
  sourceUri: string;
  sourceRevision: string;
  archiveDigest: string;
  responseDigest?: string;
  etag?: string;
  sourceUrl?: string;
  status: CrossMediaMediaOutcome['status'];
  containerId: string | null;
  mediaId?: string;
  credit?: CrossMediaMediaOutcome['credit'];
  provenance?: CrossMediaMediaOutcome['provenance'];
  candidateId?: string;
  candidateDigest?: string;
  readHandoff?: { subjectId: string; readerRoute: string; property: 'schema:image'; value: string };
  gap?: string;
}>;

export type ShowcaseManifest = Readonly<{
  version: 1;
  digest: string;
  records: readonly ShowcaseRecord[];
  vocabulary: readonly ShowcaseVocabularyRecord[];
  media: readonly ShowcaseMediaRecord[];
  omissions: readonly ShowcaseOmission[];
}>;

export function showcaseDigest(value: unknown): string {
  return createHash('sha256').update(sourceDigest(value)).digest('hex');
}

export function showcasePlanDigest(plan: CrossMediaPlan): string {
  const records = (rows: readonly SourceRecord[]) =>
    rows.map((row) => ({
      source: row.source,
      key: row.key,
      revision: row.revision,
      digest: sourceDigest(row.payload),
    }));
  return showcaseDigest({
    records: { bangumi: records(plan.records.bangumi), vndb: records(plan.records.vndb) },
    entities: { bangumi: records(plan.entities.bangumi), vndb: records(plan.entities.vndb) },
    edges: plan.edges,
    credits: plan.credits,
    memberships: plan.members,
    relationSnapshotDigest: plan.relationSnapshotDigest,
    coverSources: plan.coverSources ?? [],
  });
}

function citations(statement: BatchStatement): string[] {
  const values: string[] = [];
  for (const reference of statement.references ?? []) {
    for (const part of reference.parts) {
      if (part.property.id !== 'schema:url') continue;
      const content = part.value.type === 'value' ? part.value.content : undefined;
      if (typeof content === 'string' && content.length <= 2048) values.push(content);
    }
  }
  return [...new Set(values)].sort();
}

function currentSubject(reading: CrossMediaReading | undefined): { id: string; type: string } | null {
  const subject = reading?.subject.subject as { id?: unknown; type?: unknown } | undefined;
  return typeof subject?.id === 'string' && typeof subject.type === 'string'
    ? { id: subject.id, type: subject.type }
    : null;
}

function candidateAssertion(entry: ShowcaseAcknowledgement): ShowcaseAssertion | null {
  const { command, candidateId } = entry;
  if (
    command.op !== 'propose' ||
    !candidateId ||
    !nativeUuid.test(candidateId) ||
    entry.commandDigest !== showcaseDigest(command)
  )
    return null;
  const property = command.statement.property.id;
  return {
    commandKey: command.key,
    candidateId,
    candidateDigest: showcaseDigest({ source: command.source, statement: command.statement }),
    property,
    source: command.source,
    statement: command.statement,
    ...(command.rights === undefined ? {} : { rights: command.rights }),
    citations: citations(command.statement),
  };
}

function envelopeKey(source: BatchCommand['source']): string {
  return [
    source.source,
    source.external_id,
    source.record_revision,
    source.digest,
    source.converter_revision,
    source.field_group,
  ].join('\0');
}

function selectedEnvelopes(
  plan: CrossMediaPlan,
  aliases: Readonly<Record<'bangumi' | 'vndb', string>>,
  requirements: readonly ShowcaseVocabularyRequirement[],
  mediaOutcomes: readonly CrossMediaMediaOutcome[],
): Set<string> {
  const allowed = new Set<string>();
  for (const provider of ['bangumi', 'vndb'] as const) {
    const registration = createSourceRegistration(provider, {
      source: aliases[provider],
      converterRevision: entityRevision,
    });
    for (const row of [...plan.records[provider], ...plan.entities[provider]]) {
      const context = provider === 'bangumi'
        ? showcaseMediaContext({ plan, outcomes: mediaOutcomes, alias: aliases[provider], externalId: row.key })
        : undefined;
      const converted = registration.convert(
        { external_id: row.key, record_revision: row.revision ?? 'unversioned', record: row.payload },
        { source: aliases[provider], ...(context ?? {}) },
      );
      for (const command of converted.proposals) allowed.add(envelopeKey(command.source));
    }
  }
  for (const edge of plan.edges) {
    if (edge.relation) {
      const relation = edge.relation;
      const digest = sourceDigest(relation.evidence);
      const converterRevision = `${bangumiVocabularyRevision}:relation-${relation.family}@2:${relation.code}:${relation.reciprocalCode ?? 'one-sided'}`;
      for (const externalId of [relation.sourceSubject, relation.sourceEndpoint])
        allowed.add(
          envelopeKey({
            source: edge.alias,
            external_id: externalId,
            record_revision: 'unversioned',
            digest,
            converter_revision: converterRevision,
            field_group: 'facts',
          }),
        );
    }
    if (edge.producerParent) {
      const parent = edge.producerParent;
      const digest = sourceDigest(parent.evidence);
      const converterRevision = `${vndbVocabularyRevision}:${parent.mappingRevision}`;
      for (const externalId of [parent.sourceSubject, parent.sourceEndpoint])
        allowed.add(
          envelopeKey({
            source: edge.alias,
            external_id: externalId,
            record_revision: 'unversioned',
            digest,
            converter_revision: converterRevision,
            field_group: 'facts',
          }),
        );
    }
  }
  for (const requirement of requirements) allowed.add(envelopeKey(requirement.source));
  return allowed;
}

/** Return media IDs only for an exact available cover receipt attached to this selected record. */
export function showcaseMediaContext(input: {
  plan: CrossMediaPlan;
  outcomes: readonly CrossMediaMediaOutcome[];
  alias: string;
  externalId: string;
  containerId?: string;
}): { subjectId: string; mediaIds: Record<string, string> } | undefined {
  const row = [...input.plan.records.bangumi, ...input.plan.entities.bangumi].find(
    (candidate) => candidate.key === input.externalId,
  );
  const outcome = input.outcomes.find(
    (candidate) => candidate.sourceAlias === input.alias && candidate.externalId === input.externalId,
  );
  const receipt = input.plan.coverSources?.find(
    (candidate) => candidate.sourceAlias === input.alias && candidate.externalId === input.externalId,
  );
  const sourceUrl = (row?.payload as { images?: { large?: unknown } } | undefined)?.images?.large;
  if (
    !row ||
    typeof sourceUrl !== 'string' ||
    !outcome ||
    !receipt ||
    outcome.status !== 'available' ||
    outcome.sourceStatus !== 'available' ||
    !outcome.containerId ||
    (input.containerId !== undefined && outcome.containerId !== input.containerId) ||
    !validAvailableCover({
      source: outcome,
      recordKey: row.key,
      sourceAlias: input.alias,
      sourceRevision: row.revision ?? 'unversioned',
      archiveDigest: receipt.archiveDigest,
      containerId: outcome.containerId,
      ...(outcome.mediaId ? { mediaId: outcome.mediaId } : {}),
      sourceUrl,
    }) ||
    receipt.endpoint !== outcome.endpoint ||
    receipt.responseDigest !== outcome.responseDigest ||
    receipt.sourceUrl !== outcome.sourceUrl ||
    outcome.provenance?.source !== input.alias ||
    outcome.provenance.external_id !== row.key ||
    outcome.provenance.record_revision !== (row.revision ?? 'unversioned') ||
    outcome.provenance.field_group !== 'cover' ||
    outcome.provenance.converter_revision.length === 0 ||
    outcome.credit?.rightsHolder !== '(c) rights holder' ||
    outcome.credit.via.name !== 'Bangumi' ||
    outcome.credit.via.url !== `https://bgm.tv/subject/${row.key}` ||
    outcome.credit.license !== 'LicenseRef-unknown'
  )
    return undefined;
  return { subjectId: outcome.containerId, mediaIds: { [sourceUrl]: outcome.mediaId! } };
}

/** Build a finite publication intent only from selected source records and acknowledged native proposals. */
export function buildShowcaseManifest(input: {
  plan: CrossMediaPlan;
  readings: readonly CrossMediaReading[];
  acknowledgements: readonly ShowcaseAcknowledgement[];
  aliases: Readonly<Record<'bangumi' | 'vndb', string>>;
  mediaOutcomes?: readonly CrossMediaMediaOutcome[];
  vocabularyRequirements?: readonly ShowcaseVocabularyRequirement[];
  reviewedVocabulary?: readonly ShowcaseVocabularyRecord[];
  currentBangumiGenreCandidateIds?: readonly string[];
  bangumiGenreOwnerKeys?: readonly string[];
}): ShowcaseManifest {
  const { plan, readings, acknowledgements, aliases } = input;
  const selected = [...plan.records.bangumi, ...plan.entities.bangumi, ...plan.records.vndb, ...plan.entities.vndb];
  if (selected.length > showcaseLimits.records) throw new RangeError('Selected showcase record limit exceeded');

  const readingIndex = new Map(readings.map((reading) => [`${reading.source}\0${reading.externalId}`, reading]));
  const memberIndex = new Map(plan.members.map((member) => [`${member.source}\0${member.key}`, member]));
  const selectedKeys = new Set(selected.map((row) => `${row.source}\0${row.key}`));
  const omissions: ShowcaseOmission[] = [];
  const vocabularyRequirements: ShowcaseVocabularyRequirement[] = [];
  const currentBangumiGenreCandidateIds = new Set(input.currentBangumiGenreCandidateIds ?? []);
  const bangumiGenreOwnerKeys = new Set(input.bangumiGenreOwnerKeys ?? []);
  for (const requirement of input.vocabularyRequirements ?? []) {
    if (vocabularyRequirements.length >= showcaseLimits.vocabulary) {
      omissions.push({
        provider: requirement.provider,
        sourceKey: 'selected-family',
        code: 'vocabulary-binding-missing',
      });
      continue;
    }
    if (
      !selectedKeys.has(`${requirement.provider}\0${requirement.ownerKey}`) ||
      requirement.source.source !== aliases[requirement.provider] ||
      requirement.source.external_id !== requirement.ownerKey ||
      requirement.source.field_group !== 'facts' ||
      !requirement.sourceUri.startsWith('https://')
    ) {
      omissions.push({
        provider: requirement.provider,
        sourceKey: 'selected-family',
        code: 'vocabulary-binding-missing',
      });
      continue;
    }
    vocabularyRequirements.push(requirement);
  }
  const mediaOutcomes = input.mediaOutcomes ?? [];
  const allowedSources = selectedEnvelopes(plan, aliases, vocabularyRequirements, mediaOutcomes);

  const records: ShowcaseRecord[] = [];
  let remainingCandidates: number = showcaseLimits.candidates;
  for (const row of selected) {
    const provider = row.source === 'vndb' ? 'vndb' : 'bangumi';
    const alias = aliases[provider];
    const reading = readingIndex.get(`${provider}\0${row.key}`);
    const subject = currentSubject(reading);
    const mediaContext = provider === 'bangumi'
      ? showcaseMediaContext({
          plan,
          outcomes: mediaOutcomes,
          alias,
          externalId: row.key,
          ...(subject?.id ? { containerId: subject.id } : {}),
        })
      : undefined;
    const registration = createSourceRegistration(provider, { source: alias, converterRevision: entityRevision });
    const conversion = registration.convert(
      { external_id: row.key, record_revision: row.revision ?? 'unversioned', record: row.payload },
      { source: alias, ...(mediaContext ?? {}) },
    );
    const bootstrap = conversion.proposals.find((command) => command.op === 'create');
    const member = memberIndex.get(`${provider}\0${row.key}`);
    const sourceAssertions: ShowcaseAssertion[] = [];
    let candidateOverflow = false;
    for (const ack of acknowledgements) {
      const source = ack.command.source;
      if (
        source.source !== alias ||
        source.external_id !== row.key ||
        !allowedSources.has(envelopeKey(source)) ||
        (subject && ack.command.op === 'propose' && ack.command.subject !== subject.id)
      )
        continue;
      if (
        provider === 'bangumi' &&
        bangumiGenreOwnerKeys.has(row.key) &&
        ack.command.op === 'propose' &&
        ack.command.statement.property.id === 'schema:keywords' &&
        !currentBangumiGenreCandidateIds.has(ack.candidateId ?? '')
      )
        continue;
      const assertion = candidateAssertion(ack);
      if (!assertion) continue;
      if (sourceAssertions.length >= showcaseLimits.candidatesPerRecord || remainingCandidates === 0) {
        candidateOverflow = true;
        continue;
      }
      sourceAssertions.push(assertion);
      remainingCandidates -= 1;
    }
    if (candidateOverflow) omissions.push({ provider, sourceKey: row.key, code: 'candidate-limit' });
    const sourceMetadata = conversion.sourceMetadata as { recordUrl?: unknown } | undefined;
    const sourceUri =
      typeof sourceMetadata?.recordUrl === 'string'
        ? sourceMetadata.recordUrl
        : provider === 'vndb'
          ? vndbRecordUrl(row.key, row.revision)
          : null;
    records.push({
      provider,
      sourceAlias: alias,
      sourceKey: row.key,
      sourceUri,
      sourceRevision: row.revision ?? 'unversioned',
      rawDigest: sourceDigest(row.payload),
      semanticDigest: conversion.digest,
      converterRevision: conversion.converter_revision ?? entityRevision,
      kind: member?.kind ?? (bootstrap?.op === 'create' ? kindFromType(bootstrap.subject.type) : 'work'),
      subjectId: subject?.id ?? null,
      nativeType: subject?.type ?? (bootstrap?.op === 'create' ? bootstrap.subject.type : null),
      readerRoute: reading?.route ?? null,
      assertions: sourceAssertions,
    });
  }

  const media: ShowcaseMediaRecord[] = [];
  for (const outcome of mediaOutcomes.slice(0, 256)) {
    const record = records.find(
      (candidate) => candidate.sourceAlias === outcome.sourceAlias && candidate.sourceKey === outcome.externalId,
    );
    const cover = record?.assertions.find((assertion) => assertion.property === 'schema:image');
    let gap: string | undefined;
    if (outcome.status === 'absent') gap = 'cover-source-absent';
    else if (outcome.status === 'pending') gap = 'cover-pending';
    else if (outcome.status === 'rejected') gap = 'cover-rejected';
    else if (outcome.status === 'fenced') gap = 'cover-fenced';
    else if (outcome.status === 'unavailable') gap = outcome.code ?? 'cover-source-unavailable';
    else if (!cover) gap = 'cover-candidate-missing';
    if (gap) {
      const code: ShowcaseOmission['code'] =
        gap === 'cover-source-absent' ||
        gap === 'cover-pending' ||
        gap === 'cover-rejected' ||
        gap === 'cover-fenced' ||
        gap === 'cover-candidate-missing' ||
        gap === 'cover-not-public'
          ? gap
          : 'cover-source-unavailable';
      omissions.push({ provider: 'bangumi', sourceKey: outcome.externalId, code });
    }
    media.push({
      sourceAlias: outcome.sourceAlias,
      sourceKey: outcome.externalId,
      sourceUri: outcome.endpoint,
      sourceRevision: outcome.sourceRevision,
      archiveDigest: outcome.archiveDigest,
      ...(outcome.responseDigest ? { responseDigest: outcome.responseDigest } : {}),
      ...(outcome.etag ? { etag: outcome.etag } : {}),
      ...(outcome.sourceUrl ? { sourceUrl: outcome.sourceUrl } : {}),
      status: outcome.status,
      containerId: outcome.containerId,
      ...(outcome.mediaId ? { mediaId: outcome.mediaId } : {}),
      ...(outcome.credit ? { credit: outcome.credit } : {}),
      ...(outcome.provenance ? { provenance: outcome.provenance } : {}),
      ...(cover ? { candidateId: cover.candidateId, candidateDigest: cover.candidateDigest } : {}),
      ...(gap ? { gap } : {}),
    });
  }
  if (mediaOutcomes.length > 256)
    omissions.push({ provider: 'bangumi', sourceKey: 'selected-family', code: 'cover-source-unavailable' });

  const vocabulary: ShowcaseVocabularyRecord[] = [];
  for (const requirement of vocabularyRequirements) {
    const create = acknowledgements.find(
      (ack) =>
        ack.command.op === 'create' &&
        ack.command.subject.type === requirement.nativeType &&
        ack.subjectId &&
        ack.commandDigest === showcaseDigest(ack.command) &&
        showcaseSourceMatches(ack.command.source, requirement.source),
    );
    if (!create || create.command.op !== 'create' || !create.subjectId) {
      omissions.push({
        provider: requirement.provider,
        sourceKey: 'selected-family',
        code: 'vocabulary-binding-missing',
      });
      continue;
    }
    const assertions: ShowcaseAssertion[] = [];
    let candidateOverflow = false;
    for (const entry of acknowledgements) {
      if (
        entry.command.op !== 'propose' ||
        entry.command.subject !== create.subjectId ||
        !showcaseSourceMatches(entry.command.source, requirement.source)
      )
        continue;
      const assertion = candidateAssertion(entry);
      if (!assertion) continue;
      if (assertions.length >= showcaseLimits.candidatesPerRecord || remainingCandidates === 0) {
        candidateOverflow = true;
        continue;
      }
      assertions.push(assertion);
      remainingCandidates -= 1;
    }
    if (candidateOverflow)
      omissions.push({ provider: requirement.provider, sourceKey: requirement.sourceKey, code: 'candidate-limit' });
    const schemeValue = assertions.find((assertion) => assertion.property === 'skos:inScheme')?.statement.value;
    const scheme = schemeValue?.type === 'value' ? schemeValue.content : undefined;
    vocabulary.push({
      provider: requirement.provider,
      sourceAlias: requirement.source.source,
      sourceKey: requirement.sourceKey,
      sourceUri: requirement.sourceUri,
      subjectId: create.subjectId,
      nativeType: requirement.nativeType,
      schemeId: requirement.schemeId ?? (typeof scheme === 'string' ? scheme : null),
      assertions,
    });
  }

  for (const record of input.reviewedVocabulary ?? []) {
    if (vocabulary.length >= showcaseLimits.vocabulary) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'candidate-limit' });
      continue;
    }
    const assertions: ShowcaseAssertion[] = [];
    let incomplete = false;
    for (const expected of record.assertions) {
      const acknowledgement = acknowledgements.find((entry) => entry.candidateId === expected.candidateId);
      const actual = acknowledgement ? candidateAssertion(acknowledgement) : null;
      if (
        !actual ||
        actual.commandKey !== expected.commandKey ||
        actual.candidateDigest !== expected.candidateDigest ||
        !showcaseSourceMatches(actual.source, expected.source) ||
        !showcaseStatementMatches(actual.statement, expected.statement)
      ) {
        incomplete = true;
        break;
      }
      assertions.push(actual);
    }
    const scheme = record.nativeType === 'skos:ConceptScheme';
    const schemeRecord = (input.reviewedVocabulary ?? []).find(
      (candidate) => candidate.nativeType === 'skos:ConceptScheme' && candidate.subjectId === record.schemeId,
    );
    if (
      incomplete ||
      record.provenance !== 'reviewed-catalogue' ||
      !record.sourceUri?.startsWith('https://') ||
      !nativeUuid.test(record.subjectId) ||
      !record.schemeUri?.startsWith('https://') ||
      (scheme && (record.schemeId !== null || !assertions.length)) ||
      (!scheme &&
        (!record.schemeId ||
          record.schemeId === record.subjectId ||
          !schemeRecord ||
          schemeRecord.schemeUri !== record.schemeUri))
    ) {
      omissions.push({ provider: record.provider, sourceKey: record.sourceKey, code: 'vocabulary-binding-missing' });
      continue;
    }
    vocabulary.push({ ...record, assertions });
  }

  for (const row of records) {
    if (!row.subjectId)
      omissions.push({ provider: row.provider, sourceKey: row.sourceKey, code: 'source-read-missing' });
    if (!row.assertions.length)
      omissions.push({ provider: row.provider, sourceKey: row.sourceKey, code: 'candidate-ack-missing' });
  }
  if (omissions.length > showcaseLimits.omissions) omissions.length = showcaseLimits.omissions;

  const digest = showcaseDigest({
    plan: showcasePlanDigest(plan),
    records: records.map((record) => ({
      provider: record.provider,
      sourceKey: record.sourceKey,
      semanticDigest: record.semanticDigest,
      subjectId: record.subjectId,
      assertions: record.assertions.map(({ candidateId, candidateDigest }) => ({ candidateId, candidateDigest })),
    })),
    vocabulary: vocabulary.map((record) => ({
      provider: record.provider,
      sourceAlias: record.sourceAlias,
      sourceKey: record.sourceKey,
      sourceUri: record.sourceUri,
      subjectId: record.subjectId,
      nativeType: record.nativeType,
      schemeId: record.schemeId,
      schemeUri: record.schemeUri ?? null,
      provenance: record.provenance ?? null,
      assertions: record.assertions.map(({ candidateId, candidateDigest }) => ({ candidateId, candidateDigest })),
    })),
    media,
  });
  return { version: 1, digest, records, vocabulary, media, omissions };
}

function kindFromType(type: string): ShowcaseKind {
  if (type === 'schema:Person') return 'person';
  if (type === 'schema:Organization') return 'organization';
  if (type === 'schema:Episode') return 'episode';
  if (type === 'wd:Q95074') return 'character';
  if (type === 'wd:Q20631656') return 'release';
  return 'work';
}

export function showcaseSourceMatches(
  actual: BatchCommand['source'] | null,
  expected: BatchCommand['source'],
): boolean {
  return !!actual && showcaseDigest(actual) === showcaseDigest(expected);
}

export function showcaseStatementMatches(actual: BatchStatement | null, expected: BatchStatement): boolean {
  return !!actual && showcaseDigest(actual) === showcaseDigest(expected);
}
