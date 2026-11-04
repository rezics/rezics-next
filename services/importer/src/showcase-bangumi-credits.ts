import { bundledDigest } from '@rezics/definitions/bundled';
import { BATCH_LIMIT, type BatchCommand, type BatchStatement, type Source } from '@rezics/definitions/bulk';
import {
  bangumiStaffRoleMapping,
  bangumiStaffSchemeUri,
  bangumiVocabularyRevision,
} from '@rezics/conversion/bangumi-vocabulary';
import type {
  NativeIdentity,
  ResolvedConcept,
  ResolvedScheme,
  SourceVocabularyBindings,
} from '@rezics/conversion/source-vocabulary';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import { commandKey, sourceDigest, sourceEnvelope } from '../../../packages/conversion/src/support.ts';
import type { SourceRecord } from '@rezics/conversion';
import type { ReviewedSubjectRead } from './import-client.ts';
import type { BangumiCreatorCreditDraft } from './bangumi-creator-credits.ts';
import type { CrossMediaPlan, CrossMediaPort, CrossMediaSeedResult } from './cross-media-seed.ts';
import {
  showcaseDigest,
  showcaseLimits,
  showcaseVocabularyExternalId,
  type ShowcaseAcknowledgement,
  type ShowcaseManifest,
  type ShowcaseVocabularyRecord,
  type ShowcaseVocabularyRequirement,
} from './showcase-manifest.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
  type ShowcasePublicationResult,
  type ShowcaseReviewPort,
} from './showcase-publication.ts';
import type { PublicBulkClient } from './public-bulk-client.ts';

const alias = 'bangumi_cross_media';
const roleVocabularyRevision = `${bangumiVocabularyRevision}:staff-role@1`;
const schemeSourceKey = 'bangumi.staff';
const roleSourceKey = (code: string) => `bangumi.staff:${code}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type BangumiStaffWorkType = 1 | 2 | 4;
type RequiredRole = Readonly<{
  code: string;
  property: string;
  uri: string;
  label: string;
  sourceDefinition: string;
  owner: SourceRecord;
  sourceUri: string;
  source: Source;
}>;

export type BangumiCreditRoleBinding = Readonly<{
  code: string;
  property: string;
  uri: string;
  conceptId: string;
  schemeId: string;
}>;

export type BangumiCreditVocabularyResolution = Readonly<{
  bindings: SourceVocabularyBindings;
  requirements: readonly ShowcaseVocabularyRequirement[];
  roles: readonly BangumiCreditRoleBinding[];
  publication?: BangumiCreditPriorPublication;
}>;

export type BangumiCreditPriorPublication = Pick<ShowcasePublicationResult, 'manifest' | 'published'>;

function sourceStatement(property: string, content: string, citation: string): BatchStatement {
  return {
    property: { id: property },
    value: { type: 'value', content },
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: citation },
          },
        ],
      },
    ],
  };
}

function sameSource(left: Source, right: Source): boolean {
  return (
    left.source === right.source &&
    left.external_id === right.external_id &&
    left.record_revision === right.record_revision &&
    left.digest === right.digest &&
    left.converter_revision === right.converter_revision &&
    left.field_group === right.field_group
  );
}

function sourceRecord(plan: CrossMediaPlan, key: string): SourceRecord | undefined {
  return [...plan.records.bangumi, ...plan.entities.bangumi].find((record) => record.key === key);
}

function needsFor(input: {
  drafts: readonly BangumiCreatorCreditDraft[];
  plan: CrossMediaPlan;
  subjectTypes: readonly BangumiStaffWorkType[];
}): RequiredRole[] {
  const selectedTypes = new Set(input.subjectTypes);
  const required = new Map<string, RequiredRole>();
  for (const draft of input.drafts) {
    if (draft.kind !== 'staff' || !selectedTypes.has(draft.workType as BangumiStaffWorkType)) continue;
    const type = draft.workType as BangumiStaffWorkType;
    const codeNumber = draft.roleCode;
    if (!Number.isSafeInteger(codeNumber) || codeNumber! < 1) continue;
    const mapping = bangumiStaffRoleMapping(type, codeNumber!);
    const owner = sourceRecord(input.plan, draft.work);
    if (!mapping || !owner || required.has(mapping.code)) continue;
    const digest = sourceDigest({
      code: mapping.code,
      property: mapping.property,
      uri: mapping.uri,
      label: mapping.label,
      sourceDefinition: mapping.sourceUri,
    });
    const source = sourceEnvelope(
      {
        source: alias,
        external_id: showcaseVocabularyExternalId(roleSourceKey(mapping.code)),
        record_revision: owner.revision,
        converter_revision: roleVocabularyRevision,
        digest,
      },
      'facts',
    );
    required.set(mapping.code, {
      code: mapping.code,
      property: mapping.property,
      uri: mapping.uri,
      label: mapping.label,
      sourceDefinition: mapping.sourceUri,
      owner,
      sourceUri: mapping.sourceUri,
      source,
    });
  }
  return [...required.values()].sort((left, right) => left.code.localeCompare(right.code)).slice(0, showcaseLimits.vocabulary - 1);
}

function requirementsFor(roles: readonly RequiredRole[], schemeSource: Source): ShowcaseVocabularyRequirement[] {
  if (!roles.length) return [];
  return [
    {
      provider: 'bangumi',
      ownerKey: roles[0]!.owner.key,
      sourceKey: schemeSourceKey,
      source: schemeSource,
      sourceUri: roles[0]!.sourceDefinition,
      nativeType: 'skos:ConceptScheme',
    },
    ...roles.map((role) => ({
      provider: 'bangumi' as const,
      ownerKey: role.owner.key,
      sourceKey: roleSourceKey(role.code),
      source: role.source,
      sourceUri: role.sourceUri,
      nativeType: 'skos:Concept' as const,
    })),
  ];
}

function schemeEnvelope(roles: readonly RequiredRole[]): Source {
  const first = roles[0]!;
  return sourceEnvelope(
    {
      source: alias,
      external_id: showcaseVocabularyExternalId(schemeSourceKey),
      record_revision: first.owner.revision,
      converter_revision: `${roleVocabularyRevision}:scheme`,
      digest: sourceDigest({
        uri: bangumiStaffSchemeUri,
        label: 'Bangumi staff roles',
        sourceDefinition: first.sourceDefinition,
      }),
    },
    'facts',
  );
}

function createCommand(input: {
  source: Source;
  type: 'skos:ConceptScheme' | 'skos:Concept';
  key: string;
  label: string;
}): BatchCommand {
  return {
    op: 'create',
    source: input.source,
    key: input.key,
    subject: { type: input.type, labels: { en: input.label } },
  };
}

function proposeCommand(input: {
  source: Source;
  subject: string;
  property: string;
  value: string;
  key: string;
  citation: string;
}): BatchCommand {
  return {
    op: 'propose',
    source: input.source,
    subject: input.subject,
    key: input.key,
    statement: sourceStatement(input.property, input.value, input.citation),
  };
}

async function writeCommands(input: {
  port: CrossMediaPort;
  journal: ShowcaseJournal;
  commands: readonly BatchCommand[];
  read(id: string): Promise<ReviewedSubjectRead | null>;
}): Promise<Map<string, string>> {
  const acknowledgements = new Map(input.journal.acknowledgedCommands().map((ack) => [ack.command.key, ack]));
  const ids = new Map<string, string>();
  const pending: BatchCommand[] = [];
  for (const command of input.commands) {
    const prior = acknowledgements.get(command.key);
    if (!prior) {
      pending.push(command);
      continue;
    }
    if (prior.commandDigest !== showcaseDigest(command) || showcaseDigest(prior.command) !== prior.commandDigest)
      throw new TypeError('Bangumi staff vocabulary ACK changed under its command key');
    if (command.op === 'create') {
      const id = prior.subjectId;
      if (!id || !uuid.test(id)) throw new TypeError('Bangumi staff vocabulary create ACK has no UUID');
      const current = await input.read(id);
      const subject = current?.subject as { id?: unknown; type?: unknown } | undefined;
      if (subject?.id !== id || subject.type !== command.subject.type)
        throw new TypeError('Bangumi staff vocabulary create ACK is not current');
      ids.set(command.key, id);
    }
  }
  for (let offset = 0; offset < pending.length; offset += BATCH_LIMIT) {
    const page = pending.slice(offset, offset + BATCH_LIMIT);
    const result = await input.port.batch({ commands: [...page] });
    const byKey = new Map(result.results.map((entry) => [entry.key, entry]));
    for (const command of page) {
      const ack = byKey.get(command.key);
      if (!ack || !('value' in ack))
        throw new TypeError(`Bangumi staff vocabulary write failed: ${ack?.status ?? 'missing-ack'}`);
      if (command.op === 'create') {
        if (!('id' in ack.value) || !uuid.test(ack.value.id)) throw new TypeError('Bangumi staff vocabulary ACK has no UUID');
        ids.set(command.key, ack.value.id);
      }
    }
  }
  return ids;
}

function commandKeyFor(source: Source, suffix: string): string {
  return `showcase-bangumi-credit:${commandKey([
    source.source,
    source.external_id,
    source.record_revision,
    source.digest,
    source.converter_revision,
    suffix,
  ])}`;
}

function valueAt(read: ReviewedSubjectRead | null, property: string, expected: string): boolean {
  const subject = read?.subject as
    | { statements?: Record<string, readonly { value?: { type?: unknown; content?: unknown } }[]> }
    | undefined;
  return (
    subject?.statements?.[property]?.some(
      (statement) => statement.value?.type === 'value' && statement.value.content === expected,
    ) ?? false
  );
}

function statementCites(command: BatchCommand, uri: string): boolean {
  return (
    command.op === 'propose' &&
    (command.statement.references ?? []).some((reference) =>
      reference.parts.some(
        (part) =>
          part.property.id === 'schema:url' && part.value.type === 'value' && part.value.content === uri,
      ),
    )
  );
}

function hasValues(read: ReviewedSubjectRead | null, property: string): boolean {
  const subject = read?.subject as { statements?: Record<string, readonly unknown[]> } | undefined;
  return (subject?.statements?.[property]?.length ?? 0) > 0;
}

function vocabularyRecord(
  manifest: ShowcaseManifest,
  sourceKey: string,
): ShowcaseVocabularyRecord | undefined {
  return manifest.vocabulary.find((record) => record.provider === 'bangumi' && record.sourceKey === sourceKey);
}

function publishedRecord(
  published: BangumiCreditPriorPublication['published'],
  record: ShowcaseVocabularyRecord,
): BangumiCreditPriorPublication['published'][number] | undefined {
  return published.find(
    (item) =>
      item.provider === 'bangumi' &&
      item.sourceKey === record.sourceKey &&
      item.subjectId === record.subjectId &&
      item.nativeType === record.nativeType,
  );
}

function exactAcknowledgements(
  record: ShowcaseVocabularyRecord,
  expected: { source: Source; sourceUri: string; sameAs: string; schemeId?: string },
  acknowledgements: readonly ShowcaseAcknowledgement[],
): boolean {
  const create = acknowledgements.find(
    (ack) =>
      ack.command.op === 'create' &&
      ack.subjectId === record.subjectId &&
      ack.command.subject.type === record.nativeType &&
      ack.commandDigest === showcaseDigest(ack.command) &&
      sameSource(ack.command.source, expected.source),
  );
  if (!create) return false;
  const required = new Map<string, string>([
    ['schema:url', expected.sourceUri],
    ['schema:sameAs', expected.sameAs],
    ...(expected.schemeId ? [['skos:inScheme', expected.schemeId] as [string, string]] : []),
  ]);
  for (const assertion of record.assertions) {
    if (!required.has(assertion.property)) continue;
    const ack = acknowledgements.find((entry) => entry.command.key === assertion.commandKey);
    if (
      !ack ||
      ack.command.op !== 'propose' ||
      ack.candidateId !== assertion.candidateId ||
      ack.command.subject !== record.subjectId ||
      !sameSource(ack.command.source, expected.source) ||
      ack.commandDigest !== showcaseDigest(ack.command) ||
      showcaseDigest({ source: ack.command.source, statement: ack.command.statement }) !== assertion.candidateDigest ||
      ack.command.statement.property.id !== assertion.property ||
      ack.command.statement.value.type !== 'value' ||
      ack.command.statement.value.content !== required.get(assertion.property) ||
      !statementCites(ack.command, expected.sourceUri)
    )
      return false;
    required.delete(assertion.property);
  }
  return required.size === 0;
}

async function currentVocabularyRecord(input: {
  record: ShowcaseVocabularyRecord | undefined;
  sourceKey: string;
  type: 'skos:ConceptScheme' | 'skos:Concept';
  source: Source;
  sourceUri: string;
  sameAs: string;
  schemeId?: string;
  published: BangumiCreditPriorPublication['published'];
  acknowledgements: readonly ShowcaseAcknowledgement[];
  read(id: string): Promise<ReviewedSubjectRead | null>;
}): Promise<NativeIdentity | undefined> {
  const record = input.record;
  if (
    !record ||
    !uuid.test(record.subjectId) ||
    record.sourceAlias !== alias ||
    record.nativeType !== input.type ||
    record.sourceUri !== input.sourceUri ||
    (input.type === 'skos:Concept' && record.schemeId !== input.schemeId)
  )
    return undefined;
  const publicRecord = publishedRecord(input.published, record);
  const requiredProperties = input.schemeId ? ['schema:url', 'schema:sameAs', 'skos:inScheme'] : ['schema:url', 'schema:sameAs'];
  if (
    !publicRecord ||
    requiredProperties.some((property) => !publicRecord.assertions.some((assertion) => assertion.property === property)) ||
    !exactAcknowledgements(
      record,
      { source: input.source, sourceUri: input.sourceUri, sameAs: input.sameAs, ...(input.schemeId ? { schemeId: input.schemeId } : {}) },
      input.acknowledgements,
    )
  )
    return undefined;
  if (
    !record.assertions.some(
      (assertion) =>
        assertion.property === 'schema:url' &&
        assertion.statement.value.type === 'value' &&
        assertion.statement.value.content === input.sourceUri &&
        assertion.citations.includes(input.sourceUri),
    )
  )
    return undefined;
  const read = await input.read(record.subjectId);
  const subject = read?.subject as { id?: unknown; type?: unknown } | undefined;
  if (
    subject?.id !== record.subjectId ||
    subject.type !== input.type ||
    !valueAt(read, 'schema:url', input.sourceUri) ||
    !valueAt(read, 'schema:sameAs', input.sameAs) ||
    (input.schemeId !== undefined && !valueAt(read, 'skos:inScheme', input.schemeId))
  )
    return undefined;
  return { id: record.subjectId, type: input.type, releaseDigest: bundledDigest };
}

function requirementBySource(
  requirements: readonly ShowcaseVocabularyRequirement[],
  sourceKey: string,
): ShowcaseVocabularyRequirement | undefined {
  return requirements.find((item) => item.sourceKey === sourceKey);
}

/** Derive only source roles needed by selected work credits and publish through the common local reviewer. */
export async function prepareBangumiCreatorCreditBindings(input: {
  plan: CrossMediaPlan;
  result: CrossMediaSeedResult;
  drafts: readonly BangumiCreatorCreditDraft[];
  port: CrossMediaPort;
  journal: ShowcaseJournal;
  review: ShowcaseReviewPort;
  publicClient: PublicBulkClient;
  prior?: BangumiCreditPriorPublication;
  subjectTypes?: readonly BangumiStaffWorkType[];
  read(subjectId: string): Promise<ReviewedSubjectRead | null>;
}): Promise<BangumiCreditVocabularyResolution> {
  const roles = needsFor({ drafts: input.drafts, plan: input.plan, subjectTypes: input.subjectTypes ?? [2] });
  if (!roles.length) return { bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] }, requirements: [], roles: [] };

  const acknowledgements = input.journal.acknowledgedCommands();
  const schemeSource = schemeEnvelope(roles);
  const schemeRequirement = requirementsFor(roles, schemeSource)[0]!;
  const previousScheme = input.prior ? vocabularyRecord(input.prior.manifest, schemeSourceKey) : undefined;
  const previousSchemeWasPublished =
    previousScheme !== undefined && input.prior !== undefined && publishedRecord(input.prior.published, previousScheme) !== undefined;
  const cachedReads = new Map<string, Promise<ReviewedSubjectRead | null>>();
  const read = async (id: string): Promise<ReviewedSubjectRead | null> => {
    let pending = cachedReads.get(id);
    if (!pending) {
      pending = input.read(id).catch(() => null);
      cachedReads.set(id, pending);
    }
    return pending;
  };

  let scheme = await currentVocabularyRecord({
    record: previousScheme,
    sourceKey: schemeSourceKey,
    type: 'skos:ConceptScheme',
    source: schemeRequirement.source,
    sourceUri: schemeRequirement.sourceUri,
    sameAs: bangumiStaffSchemeUri,
    published: input.prior?.published ?? [],
    acknowledgements,
    read,
  });
  let schemeMustNotRestore = previousSchemeWasPublished && !scheme;
  if (previousScheme && !scheme) {
    const oldRead = await read(previousScheme.subjectId);
    if (hasValues(oldRead, 'schema:sameAs') && !valueAt(oldRead, 'schema:sameAs', bangumiStaffSchemeUri))
      schemeMustNotRestore = true;
  }
  let schemeManifest = input.prior?.manifest;
  let activePublication = input.prior;
  let allRequirements: ShowcaseVocabularyRequirement[] = scheme ? [schemeRequirement] : [];

  if (!scheme && !schemeMustNotRestore) {
    const port = captureShowcaseCommands(input.port, input.journal);
    const create = createCommand({
      source: schemeSource,
      type: 'skos:ConceptScheme',
      key: commandKeyFor(schemeSource, 'scheme:create'),
      label: 'Bangumi staff roles',
    });
    const written = await writeCommands({ port, journal: input.journal, commands: [create], read });
    const schemeId = written.get(create.key);
    if (!schemeId) throw new TypeError('Bangumi staff scheme create was not acknowledged');
    const createdScheme = await read(schemeId);
    const createdSchemeSubject = createdScheme?.subject as { id?: unknown; type?: unknown } | undefined;
    if (createdSchemeSubject?.id !== schemeId || createdSchemeSubject.type !== 'skos:ConceptScheme')
      throw new TypeError('Bangumi staff scheme create ACK is not current');
    const candidates = [
      proposeCommand({
        source: schemeSource,
        subject: schemeId,
        property: 'schema:url',
        value: schemeRequirement.sourceUri,
        key: commandKeyFor(schemeSource, 'scheme:url'),
        citation: schemeRequirement.sourceUri,
      }),
      proposeCommand({
        source: schemeSource,
        subject: schemeId,
        property: 'schema:sameAs',
        value: bangumiStaffSchemeUri,
        key: commandKeyFor(schemeSource, 'scheme:sameAs'),
        citation: schemeRequirement.sourceUri,
      }),
    ];
    await writeCommands({ port, journal: input.journal, commands: candidates, read });
    const publication = await publishShowcase({
      plan: input.plan,
      result: input.result,
      aliases: { bangumi: alias, vndb: 'vndb_cross_media' },
      journal: input.journal,
      review: input.review,
      publicClient: input.publicClient,
      vocabularyRequirements: [schemeRequirement],
    });
    schemeManifest = publication.manifest;
    activePublication = publication;
    cachedReads.clear();
    const schemeRecord = vocabularyRecord(publication.manifest, schemeSourceKey);
    const fresh = await currentVocabularyRecord({
      record: schemeRecord,
      sourceKey: schemeSourceKey,
      type: 'skos:ConceptScheme',
      source: schemeRequirement.source,
      sourceUri: schemeRequirement.sourceUri,
      sameAs: bangumiStaffSchemeUri,
      published: publication.published,
      acknowledgements: input.journal.acknowledgedCommands(),
      read,
    });
    if (fresh) {
      scheme = fresh;
      allRequirements = [schemeRequirement];
    } else {
      schemeMustNotRestore = true;
    }
  }

  if (!scheme || schemeMustNotRestore || !schemeManifest) {
    return { bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] }, requirements: [], roles: [] };
  }

  const roleRequirements = requirementsFor(roles, schemeSource).slice(1);
  const roleBindings: ResolvedConcept[] = [];
  const reachedRoles: BangumiCreditRoleBinding[] = [];
  const missing: RequiredRole[] = [];
  const existingRoleRequirements: ShowcaseVocabularyRequirement[] = [];
  for (let index = 0; index < roles.length; index++) {
    const role = roles[index]!;
    const requirement = roleRequirements[index]!;
    const previousRecord = input.prior ? vocabularyRecord(input.prior.manifest, roleSourceKey(role.code)) : undefined;
    const wasPublished =
      previousRecord !== undefined && input.prior !== undefined && publishedRecord(input.prior.published, previousRecord) !== undefined;
    const bound = await currentVocabularyRecord({
      record: previousRecord,
      sourceKey: roleSourceKey(role.code),
      type: 'skos:Concept',
      source: requirement.source,
      sourceUri: requirement.sourceUri,
      sameAs: role.uri,
      schemeId: scheme.id,
      published: input.prior?.published ?? [],
      acknowledgements,
      read,
    });
    if (bound) {
      roleBindings.push({
        taxonomy: 'bangumi.staff',
        code: role.code,
        id: bound.id,
        type: 'skos:Concept',
        schemeId: scheme.id,
        releaseDigest: bundledDigest,
      });
      reachedRoles.push({ code: role.code, property: role.property, uri: role.uri, conceptId: bound.id, schemeId: scheme.id });
      existingRoleRequirements.push(requirement);
    } else if (
      wasPublished ||
      (previousRecord !== undefined &&
        (hasValues(await read(previousRecord.subjectId), 'schema:sameAs') ||
          hasValues(await read(previousRecord.subjectId), 'skos:inScheme')))
    ) {
      // A retracted or mismatched current role binding is never repaired by replay.
    } else {
      missing.push(role);
    }
  }

  if (missing.length) {
    const port = captureShowcaseCommands(input.port, input.journal);
    const newRequirements = missing.map((role) => roleRequirements[roles.indexOf(role)]!);
    const missingCommands: BatchCommand[] = [];
    for (const [index, role] of missing.entries()) {
      const requirement = newRequirements[index]!;
      const create = createCommand({
        source: requirement.source,
        type: 'skos:Concept',
        key: commandKeyFor(requirement.source, `role:${role.code}:create`),
        label: role.label,
      });
      // The create is acknowledged first so dependent inScheme proposals use its real UUID.
      missingCommands.push(create);
    }
    const createdIds = await writeCommands({ port, journal: input.journal, commands: missingCommands, read });
    const candidates: BatchCommand[] = [];
    for (const [index, role] of missing.entries()) {
      const requirement = newRequirements[index]!;
      const conceptId = createdIds.get(missingCommands[index]!.key);
      if (!conceptId) throw new TypeError('Bangumi staff role create was not acknowledged');
      const createdConcept = await read(conceptId);
      const createdConceptSubject = createdConcept?.subject as { id?: unknown; type?: unknown } | undefined;
      if (createdConceptSubject?.id !== conceptId || createdConceptSubject.type !== 'skos:Concept')
        throw new TypeError('Bangumi staff role create ACK is not current');
      for (const [property, value] of [
        ['schema:url', requirement.sourceUri],
        ['schema:sameAs', role.uri],
        ['skos:inScheme', scheme.id],
      ] as const)
        candidates.push(
          proposeCommand({
            source: requirement.source,
            subject: conceptId,
            property,
            value,
            key: commandKeyFor(requirement.source, `role:${role.code}:${property}`),
            citation: requirement.sourceUri,
          }),
        );
    }
    await writeCommands({ port, journal: input.journal, commands: candidates, read });
    allRequirements = [...allRequirements, ...existingRoleRequirements, ...newRequirements];
    const publication = await publishShowcase({
      plan: input.plan,
      result: input.result,
      aliases: { bangumi: alias, vndb: 'vndb_cross_media' },
      journal: input.journal,
      review: input.review,
      publicClient: input.publicClient,
      vocabularyRequirements: allRequirements,
    });
    schemeManifest = publication.manifest;
    activePublication = publication;
    cachedReads.clear();
    const currentAcks = input.journal.acknowledgedCommands();
    for (const [index, role] of missing.entries()) {
      const requirement = newRequirements[index]!;
      const bound = await currentVocabularyRecord({
        record: vocabularyRecord(publication.manifest, roleSourceKey(role.code)),
        sourceKey: roleSourceKey(role.code),
        type: 'skos:Concept',
        source: requirement.source,
        sourceUri: requirement.sourceUri,
        sameAs: role.uri,
        schemeId: scheme.id,
        published: publication.published,
        acknowledgements: currentAcks,
        read,
      });
      if (!bound) continue;
      roleBindings.push({
        taxonomy: 'bangumi.staff',
        code: role.code,
        id: bound.id,
        type: 'skos:Concept',
        schemeId: scheme.id,
        releaseDigest: bundledDigest,
      });
      reachedRoles.push({ code: role.code, property: role.property, uri: role.uri, conceptId: bound.id, schemeId: scheme.id });
      existingRoleRequirements.push(requirement);
    }
  }

  const schemes: ResolvedScheme[] = [
    {
      taxonomy: 'bangumi.staff',
      uri: bangumiStaffSchemeUri,
      id: scheme.id,
      type: 'skos:ConceptScheme',
      releaseDigest: bundledDigest,
    },
  ];
  const requirements = [schemeRequirement, ...existingRoleRequirements];
  return {
    bindings: { releaseDigest: bundledDigest, schemes, concepts: roleBindings },
    requirements,
    roles: reachedRoles,
    ...(activePublication ? { publication: activePublication } : {}),
  };
}

/** Recheck exact current role identities before a later publication can adopt dependent credits. */
export async function currentBangumiCreatorCreditBindings(input: {
  resolution: BangumiCreditVocabularyResolution;
  manifest?: ShowcaseManifest;
  published?: BangumiCreditPriorPublication['published'];
  acknowledgements: readonly ShowcaseAcknowledgement[];
  read(subjectId: string): Promise<ReviewedSubjectRead | null>;
}): Promise<BangumiCreditVocabularyResolution> {
  const cached = new Map<string, Promise<ReviewedSubjectRead | null>>();
  const manifest = input.manifest ?? input.resolution.publication?.manifest;
  const published = input.published ?? input.resolution.publication?.published ?? [];
  if (!manifest) return { bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] }, requirements: [], roles: [] };
  const read = (id: string) => {
    let pending = cached.get(id);
    if (!pending) {
      pending = input.read(id).catch(() => null);
      cached.set(id, pending);
    }
    return pending;
  };
  const schemeRequirement = requirementBySource(input.resolution.requirements, schemeSourceKey);
  if (!schemeRequirement) return { bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] }, requirements: [], roles: [] };
  const schemeRecord = vocabularyRecord(manifest, schemeSourceKey);
  const scheme = await currentVocabularyRecord({
    record: schemeRecord,
    sourceKey: schemeSourceKey,
    type: 'skos:ConceptScheme',
    source: schemeRequirement.source,
    sourceUri: schemeRequirement.sourceUri,
    sameAs: bangumiStaffSchemeUri,
    published,
    acknowledgements: input.acknowledgements,
    read,
  });
  if (!scheme) return { bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] }, requirements: [], roles: [] };
  const concepts: ResolvedConcept[] = [];
  const roles: BangumiCreditRoleBinding[] = [];
  const requirements = [schemeRequirement];
  for (const role of input.resolution.roles) {
    const requirement = requirementBySource(input.resolution.requirements, roleSourceKey(role.code));
    if (!requirement) continue;
    const current = await currentVocabularyRecord({
      record: vocabularyRecord(manifest, roleSourceKey(role.code)),
      sourceKey: roleSourceKey(role.code),
      type: 'skos:Concept',
      source: requirement.source,
      sourceUri: requirement.sourceUri,
      sameAs: role.uri,
      schemeId: scheme.id,
      published,
      acknowledgements: input.acknowledgements,
      read,
    });
    if (!current || current.id !== role.conceptId) continue;
    concepts.push({
      taxonomy: 'bangumi.staff',
      code: role.code,
      id: current.id,
      type: 'skos:Concept',
      schemeId: scheme.id,
      releaseDigest: bundledDigest,
    });
    roles.push(role);
    requirements.push(requirement);
  }
  return {
    bindings: {
      releaseDigest: bundledDigest,
      schemes: [{ taxonomy: 'bangumi.staff', uri: bangumiStaffSchemeUri, id: scheme.id, type: 'skos:ConceptScheme', releaseDigest: bundledDigest }],
      concepts,
    },
    requirements,
    roles,
    publication: { manifest, published },
  };
}

export function combineBangumiCreditBindings(
  left: SourceVocabularyBindings | undefined,
  right: SourceVocabularyBindings,
): SourceVocabularyBindings {
  if (!left) return right;
  if (left.releaseDigest !== right.releaseDigest) throw new TypeError('Bangumi vocabulary release changed');
  const schemes = new Map<string, ResolvedScheme>();
  for (const scheme of [...left.schemes, ...right.schemes]) {
    const prior = schemes.get(scheme.taxonomy);
    if (prior && (prior.id !== scheme.id || prior.uri !== scheme.uri))
      throw new TypeError('Bangumi vocabulary scheme binding changed');
    schemes.set(scheme.taxonomy, scheme);
  }
  const concepts = new Map<string, ResolvedConcept>();
  for (const concept of [...left.concepts, ...right.concepts]) {
    const key = `${concept.taxonomy}\0${concept.code}`;
    const prior = concepts.get(key);
    if (prior && (prior.id !== concept.id || prior.schemeId !== concept.schemeId))
      throw new TypeError('Bangumi vocabulary concept binding changed');
    concepts.set(key, concept);
  }
  return { releaseDigest: left.releaseDigest, schemes: [...schemes.values()], concepts: [...concepts.values()] };
}
