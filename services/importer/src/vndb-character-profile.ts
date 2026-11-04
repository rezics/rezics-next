import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import {
  BATCH_LIMIT,
  checkBatchWrite,
  type BatchCommand,
  type BatchReference,
  type BatchStatement,
} from '@rezics/definitions/bulk';
import {
  projectVndbCharacterBloodType,
  vndbCharacterBloodTypeCodes,
  type VndbCharacterBloodTypeCode,
  vndbRecordUrl,
} from '@rezics/conversion/cross-media-entities';
import type { NativeIdentity, SourceVocabularyBindings } from '@rezics/conversion/source-vocabulary';
import { vndbCharacterBloodTypeSchemeUri, vndbCharacterBloodTypeTaxonomy } from '@rezics/conversion/vndb-vocabulary';
import { commandKey, sourceDigest, sourceEnvelope } from '../../../packages/conversion/src/support.ts';
import type { ImporterOptions } from './importer.ts';
import type { CrossMediaPlan, CrossMediaPort } from './cross-media-seed.ts';
import {
  showcaseDigest,
  showcaseVocabularyExternalId,
  type ShowcaseVocabularyRequirement,
} from './showcase-manifest.ts';
import { captureShowcaseCommands, type ShowcaseJournal } from './showcase-publication.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const characterKey = /^c[1-9][0-9]{0,31}$/u;
const profileCharacterLimit = 256;
const adapterRevision = 'vndb-character-profile-vocabulary@1';
const emptyBindings: SourceVocabularyBindings = { releaseDigest: bundledDigest, schemes: [], concepts: [] };
type VocabularyCommand = Extract<BatchCommand, { op: 'create' | 'propose' }>;
export type VndbCharacterProfileVocabularyIssue = Readonly<{
  sourceKey: string;
  operation: 'create' | 'propose';
  outcome: 'refused' | 'unavailable';
  status: number;
}>;

export const vndbCharacterBloodTypeConceptUri = (code: VndbCharacterBloodTypeCode) =>
  `${vndbCharacterBloodTypeSchemeUri}/${code}`;

export type VndbCharacterProfileReferences = Readonly<{
  schemeId: string;
  concepts: readonly { code: VndbCharacterBloodTypeCode; id: string }[];
}>;

export type VndbCharacterProfileRequirement = Readonly<{
  taxonomy: typeof vndbCharacterBloodTypeTaxonomy;
  code: VndbCharacterBloodTypeCode;
  schemeUri: typeof vndbCharacterBloodTypeSchemeUri;
  conceptUri: string;
}>;

export type VndbCharacterProfileOmission = Readonly<{
  externalId: string;
  field: 'bloodt' | 'gender' | 'spoil_gender';
  reason:
    | 'missing_source_value'
    | 'source_unknown'
    | 'unknown_source_code'
    | 'invalid_source_value'
    | 'native_gender_variant_not_admitted';
}>;

type BloodTypeRow = Readonly<{
  code: string | null;
  omission?: 'missing_source_value' | 'invalid_source_value';
}>;

export type VndbCharacterProfilePlan = Readonly<{
  characters: ReadonlyMap<string, BloodTypeRow>;
  requirements: readonly VndbCharacterProfileRequirement[];
  omissions: readonly VndbCharacterProfileOmission[];
}>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse only the finite source-code-to-native-UUID binding file; public reads establish every association. */
export function parseVndbCharacterProfileReferences(value: unknown): VndbCharacterProfileReferences {
  if (!object(value)) throw new TypeError('Invalid VNDB character profile bindings');
  const schemeId = value.schemeId;
  const rawConcepts = value.concepts;
  if (typeof schemeId !== 'string' || !uuid.test(schemeId) || !Array.isArray(rawConcepts) || rawConcepts.length > 4)
    throw new TypeError('Invalid VNDB character profile scheme bindings');
  const codes = new Set<string>();
  const concepts = rawConcepts.map((raw) => {
    if (!object(raw)) throw new TypeError('Invalid VNDB character profile Concept binding');
    const code = raw.code;
    const id = raw.id;
    if (
      typeof code !== 'string' ||
      !(vndbCharacterBloodTypeCodes as readonly string[]).includes(code) ||
      typeof id !== 'string' ||
      !uuid.test(id) ||
      codes.has(code)
    )
      throw new TypeError('Invalid VNDB character profile Concept binding');
    codes.add(code);
    return { code: code as VndbCharacterBloodTypeCode, id };
  });
  concepts.sort((left, right) => left.code.localeCompare(right.code));
  return { schemeId, concepts };
}

function hasAdoptedContent(read: unknown, property: string, expected: string): boolean {
  if (!object(read) || !object(read.subject) || !object(read.subject.statements)) return false;
  const rows = read.subject.statements[property];
  return Array.isArray(rows) && rows.some((row) => object(row) && object(row.value) && row.value.content === expected);
}

/** Verify exact current public type, URI and scheme associations before a code can be proposed. */
export async function readVndbCharacterProfileBindings(
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  known?: VndbCharacterProfileReferences,
): Promise<SourceVocabularyBindings> {
  if (!known) return emptyBindings;
  let schemeRead: unknown;
  try {
    schemeRead = await port.readReviewedSubject(known.schemeId);
  } catch {
    return emptyBindings;
  }
  if (
    !object(schemeRead) ||
    !object(schemeRead.subject) ||
    schemeRead.subject.id !== known.schemeId ||
    schemeRead.subject.type !== 'skos:ConceptScheme' ||
    !hasAdoptedContent(schemeRead, 'schema:url', vndbCharacterBloodTypeSchemeUri)
  )
    return emptyBindings;

  const concepts: SourceVocabularyBindings['concepts'][number][] = [];
  for (const item of known.concepts) {
    let conceptRead: unknown;
    try {
      conceptRead = await port.readReviewedSubject(item.id);
    } catch {
      continue;
    }
    if (
      !object(conceptRead) ||
      !object(conceptRead.subject) ||
      conceptRead.subject.id !== item.id ||
      conceptRead.subject.type !== 'skos:Concept' ||
      !hasAdoptedContent(conceptRead, 'schema:url', vndbCharacterBloodTypeConceptUri(item.code)) ||
      !hasAdoptedContent(conceptRead, 'skos:inScheme', known.schemeId)
    )
      continue;
    concepts.push({
      taxonomy: vndbCharacterBloodTypeTaxonomy,
      code: item.code,
      id: item.id,
      type: 'skos:Concept',
      schemeId: known.schemeId,
      releaseDigest: bundledDigest,
    });
  }
  return {
    releaseDigest: bundledDigest,
    schemes: [
      {
        taxonomy: vndbCharacterBloodTypeTaxonomy,
        id: known.schemeId,
        uri: vndbCharacterBloodTypeSchemeUri,
        type: 'skos:ConceptScheme',
        releaseDigest: bundledDigest,
      },
    ],
    concepts,
  };
}

function sourceCell(value: unknown, present: boolean): BloodTypeRow {
  const projection = projectVndbCharacterBloodType(value, present);
  switch (projection.status) {
    case 'explicit':
      return { code: projection.code };
    case 'unsupported':
      return { code: projection.code };
    case 'unknown':
      return { code: 'unknown' };
    case 'missing':
      return { code: null, omission: 'missing_source_value' };
    case 'malformed':
      return { code: null, omission: 'invalid_source_value' };
  }
}

function omissionReason(value: unknown, present: boolean): VndbCharacterProfileOmission['reason'] | undefined {
  const projection = projectVndbCharacterBloodType(value, present);
  switch (projection.status) {
    case 'explicit':
      return;
    case 'missing':
      return 'missing_source_value';
    case 'unknown':
      return 'source_unknown';
    case 'unsupported':
      return 'unknown_source_code';
    case 'malformed':
      return 'invalid_source_value';
  }
}

/** Project only selected, already bounded VNDB Character identities and their three profile variants. */
export function planVndbCharacterProfile(plan: CrossMediaPlan): VndbCharacterProfilePlan {
  const characters = new Map<string, BloodTypeRow>();
  const requirements = new Map<VndbCharacterBloodTypeCode, VndbCharacterProfileRequirement>();
  const omissions: VndbCharacterProfileOmission[] = [];
  const selected = new Set(
    plan.members
      .filter((member) => member.source === 'vndb' && member.kind === 'character' && member.franchise !== undefined)
      .map((member) => member.key),
  );
  for (const record of plan.entities.vndb) {
    if (
      !selected.has(record.key) ||
      !characterKey.test(record.key) ||
      !object(record.payload) ||
      characters.size >= profileCharacterLimit
    )
      continue;
    const payload = record.payload;
    const present = Object.hasOwn(payload, 'bloodt');
    const bloodt = Object.getOwnPropertyDescriptor(payload, 'bloodt')?.value;
    characters.set(record.key, sourceCell(bloodt, present));
    const reason = omissionReason(bloodt, present);
    if (reason) omissions.push({ externalId: record.key, field: 'bloodt', reason });
    else if (typeof bloodt === 'string') {
      const projection = projectVndbCharacterBloodType(bloodt, true);
      if (projection.status === 'explicit')
        requirements.set(projection.code, {
          taxonomy: vndbCharacterBloodTypeTaxonomy,
          code: projection.code,
          schemeUri: vndbCharacterBloodTypeSchemeUri,
          conceptUri: vndbCharacterBloodTypeConceptUri(projection.code),
        });
    }
    for (const field of ['gender', 'spoil_gender'] as const) {
      if (!Object.hasOwn(payload, field)) continue;
      const value = Object.getOwnPropertyDescriptor(payload, field)?.value;
      if (value === null || value === '' || value === undefined) continue;
      omissions.push({
        externalId: record.key,
        field,
        reason: 'native_gender_variant_not_admitted',
      });
    }
  }
  return {
    characters,
    requirements: [...requirements.values()].sort((left, right) => left.code.localeCompare(right.code)),
    omissions: omissions.slice(0, profileCharacterLimit * 3),
  };
}

/** Join proposals to the current selected Character owner after the ordinary importer resolves its identity. */
export function vndbCharacterProfileAdmission(
  plan: VndbCharacterProfilePlan,
  bindings: SourceVocabularyBindings,
): NonNullable<ImporterOptions['vocabularyAdmission']> {
  return {
    request({ owner, subject }) {
      if (!subject || !characterKey.test(owner.external_id)) return;
      const source = plan.characters.get(owner.external_id);
      if (!source) return;
      const character: NativeIdentity = { id: subject, type: 'wd:Q95074', releaseDigest: bundledDigest };
      return {
        bindings,
        rows: [
          {
            kind: 'character-blood-type',
            path: '/chars/bloodt',
            character,
            code: source.code,
            ...(source.omission ? { omission: source.omission } : {}),
          },
        ],
      };
    },
  };
}

function profileOwnerKey(plan: CrossMediaPlan): string | undefined {
  const works = new Set(plan.records.vndb.map((record) => record.key));
  return plan.members.find((member) => member.source === 'vndb' && member.kind === 'work' && works.has(member.key))
    ?.key;
}

function profileCitation(plan: CrossMediaPlan, code?: VndbCharacterBloodTypeCode): string {
  if (code) {
    const character = [...planVndbCharacterProfile(plan).characters].find(([, row]) => row.code === code)?.[0];
    if (character) return vndbRecordUrl(character);
  }
  const owner = profileOwnerKey(plan);
  return owner ? vndbRecordUrl(owner) : vndbCharacterBloodTypeSchemeUri;
}

function profileSource(sourceKey: string, uri: string, citation: string) {
  return sourceEnvelope(
    {
      source: 'vndb_cross_media',
      external_id: showcaseVocabularyExternalId(sourceKey),
      record_revision: null,
      converter_revision: adapterRevision,
      digest: sourceDigest({ sourceKey, uri, citation, adapterRevision }),
    },
    'facts',
  );
}

function profileReferences(uri: string, citation: string): BatchReference[] {
  return [
    {
      parts: [uri, citation].map((content) => ({
        property: { id: 'schema:url' },
        value: { type: 'value' as const, content },
      })),
    },
  ];
}

function profileRequirement(
  ownerKey: string,
  sourceKey: string,
  sourceUri: string,
  citation: string,
  nativeType: 'skos:ConceptScheme' | 'skos:Concept',
  schemeId?: string,
): ShowcaseVocabularyRequirement {
  return {
    provider: 'vndb',
    ownerKey,
    sourceKey,
    source: profileSource(sourceKey, sourceUri, citation),
    sourceUri,
    nativeType,
    ...(schemeId ? { schemeId } : {}),
  };
}

function profileCommands(input: {
  sourceKey: string;
  sourceUri: string;
  citation: string;
  nativeType: 'skos:ConceptScheme' | 'skos:Concept';
  labels: Record<string, string>;
  schemeId?: string;
  subjectId?: string;
}): VocabularyCommand[] {
  const source = profileSource(input.sourceKey, input.sourceUri, input.citation);
  const create: VocabularyCommand = {
    op: 'create',
    key: `vndb-character-profile-vocabulary:${commandKey([
      JSON.stringify(source),
      'create',
      input.nativeType,
      JSON.stringify(input.labels),
    ])}`,
    source,
    subject: { type: input.nativeType, labels: input.labels },
  };
  if (!input.subjectId) return [create];
  const references = profileReferences(input.sourceUri, input.citation);
  const statements: BatchStatement[] = [
    {
      property: { id: 'schema:url' },
      value: { type: 'value', content: input.sourceUri },
      references,
    },
  ];
  if (input.nativeType === 'skos:Concept' && input.schemeId)
    statements.push({
      property: { id: 'skos:inScheme' },
      value: { type: 'value', content: input.schemeId },
      references,
    });
  return statements.map((statement) => ({
    op: 'propose' as const,
    key: `vndb-character-profile-vocabulary:${commandKey([
      JSON.stringify(source),
      input.subjectId!,
      'propose',
      JSON.stringify(statement),
    ])}`,
    source,
    subject: input.subjectId!,
    statement,
  }));
}

function isProfileVocabularyCommand(command: BatchCommand): boolean {
  return command.source.source === 'vndb_cross_media' && command.source.converter_revision === adapterRevision;
}

function acknowledgedProfileCreates(journal: ShowcaseJournal): Map<string, string> {
  return new Map(
    journal
      .acknowledgedCommands()
      .flatMap((row) =>
        row.command.op === 'create' && row.subjectId && isProfileVocabularyCommand(row.command)
          ? [[row.command.source.external_id, row.subjectId] as const]
          : [],
      ),
  );
}

async function sendProfilePages(
  port: Pick<CrossMediaPort, 'batch'>,
  commands: readonly VocabularyCommand[],
  issues: VndbCharacterProfileVocabularyIssue[],
): Promise<void> {
  for (let offset = 0; offset < commands.length; offset += BATCH_LIMIT) {
    const page = commands.slice(offset, offset + BATCH_LIMIT);
    if (checkBatchWrite({ commands: [...page] }, bundledRelease).length)
      throw new TypeError('VNDB character profile vocabulary commands failed portable validation');
    const result = await port.batch({ commands: [...page] });
    const byKey = new Map(result.results.map((entry) => [entry.key, entry]));
    for (const command of page) {
      const response = byKey.get(command.key);
      if (!response)
        throw new Error('VNDB character profile vocabulary delivery unknown: batch response omitted a command');
      const status = Number(response.status);
      if (status === 200 || status === 201) continue;
      if (status === 429) {
        issues.push({
          sourceKey: command.source.external_id,
          operation: command.op,
          outcome: 'unavailable',
          status,
        });
        continue;
      }
      if (status >= 400 && status < 500) {
        issues.push({
          sourceKey: command.source.external_id,
          operation: command.op,
          outcome: 'refused',
          status,
        });
        continue;
      }
      throw new Error(`VNDB character profile vocabulary delivery unknown: unexpected command status ${status}`);
    }
  }
}

async function sendMissingProfileCommands(input: {
  port: Pick<CrossMediaPort, 'batch'>;
  journal: ShowcaseJournal;
  commands: readonly VocabularyCommand[];
}): Promise<VndbCharacterProfileVocabularyIssue[]> {
  const captured = captureShowcaseCommands(input.port, input.journal);
  const issues: VndbCharacterProfileVocabularyIssue[] = [];
  const outgoingKeys = new Set(input.commands.map((command) => command.key));
  const outgoingCreates = new Set(
    input.commands.flatMap((command) => (command.op === 'create' ? [command.source.external_id] : [])),
  );
  const prepared = input.journal.preparedCommands().flatMap((row) => {
    if (!isProfileVocabularyCommand(row.command)) return [];
    if (outgoingKeys.has(row.command.key)) return [row.command as VocabularyCommand];
    if (row.command.op === 'create' && outgoingCreates.has(row.command.source.external_id))
      return [row.command as VocabularyCommand];
    return [];
  });
  if (prepared.length) await sendProfilePages(captured, prepared, issues);
  const sealed = new Map<string, string>();
  const created = new Set<string>();
  for (const row of [...input.journal.acknowledgedCommands(), ...input.journal.preparedCommands()]) {
    if (!isProfileVocabularyCommand(row.command)) continue;
    sealed.set(row.command.key, row.commandDigest);
    if (row.command.op === 'create') created.add(row.command.source.external_id);
  }
  const commands = input.commands.filter((command) => {
    const digest = sealed.get(command.key);
    if (digest !== undefined) {
      if (digest !== showcaseDigest(command))
        throw new TypeError('VNDB character profile vocabulary ACK changed its command body');
      return false;
    }
    return command.op !== 'create' || !created.has(command.source.external_id);
  });
  if (commands.length) await sendProfilePages(captured, commands, issues);
  return issues;
}

function profileVocabularyNeed(plan: CrossMediaPlan): {
  ownerKey: string;
  scheme: ShowcaseVocabularyRequirement;
  concepts: ShowcaseVocabularyRequirement[];
  codes: readonly VndbCharacterBloodTypeCode[];
} | undefined {
  const ownerKey = profileOwnerKey(plan);
  const planned = planVndbCharacterProfile(plan);
  if (!ownerKey || !planned.requirements.length) return undefined;
  const schemeKey = vndbCharacterBloodTypeTaxonomy;
  const schemeCitation = profileCitation(plan);
  const scheme = profileRequirement(
    ownerKey,
    schemeKey,
    vndbCharacterBloodTypeSchemeUri,
    schemeCitation,
    'skos:ConceptScheme',
  );
  const concepts = planned.requirements.slice(0, 4).map((requirement) =>
    profileRequirement(
      ownerKey,
      `${requirement.taxonomy}:${requirement.code}`,
      requirement.conceptUri,
      profileCitation(plan, requirement.code),
      'skos:Concept',
    ),
  );
  return { ownerKey, scheme, concepts, codes: planned.requirements.slice(0, 4).map((requirement) => requirement.code) };
}

function journalProfileReferences(
  journal: ShowcaseJournal,
  need: NonNullable<ReturnType<typeof profileVocabularyNeed>>,
): VndbCharacterProfileReferences | undefined {
  const creates = acknowledgedProfileCreates(journal);
  const schemeId = creates.get(showcaseVocabularyExternalId(need.scheme.sourceKey));
  if (!schemeId) return undefined;
  const concepts = need.codes.flatMap((code) => {
    const id = creates.get(showcaseVocabularyExternalId(`${vndbCharacterBloodTypeTaxonomy}:${code}`));
    return id ? [{ code, id }] : [];
  });
  return parseVndbCharacterProfileReferences({ schemeId, concepts });
}

/** Stage the source blood-type scheme, then only selected explicit Concepts, through the existing journal. */
export async function prepareShowcaseVndbCharacterProfileVocabulary(input: {
  plan: CrossMediaPlan;
  port: Pick<CrossMediaPort, 'batch' | 'readReviewedSubject'>;
  journal: ShowcaseJournal;
  stage: 'schemes' | 'concepts';
}): Promise<{
  requirements: ShowcaseVocabularyRequirement[];
  bindings: SourceVocabularyBindings;
  issues: readonly VndbCharacterProfileVocabularyIssue[];
}> {
  const need = profileVocabularyNeed(input.plan);
  if (!need)
    return { requirements: [], bindings: emptyBindings, issues: [] };
  const issues = await sendMissingProfileCommands({
    port: input.port,
    journal: input.journal,
    commands: profileCommands({
      sourceKey: need.scheme.sourceKey,
      sourceUri: need.scheme.sourceUri,
      citation: profileCitation(input.plan),
      nativeType: 'skos:ConceptScheme',
      labels: { en: 'VNDB character blood types' },
    }),
  });
  const schemeCreates = acknowledgedProfileCreates(input.journal);
  const schemeId = schemeCreates.get(showcaseVocabularyExternalId(need.scheme.sourceKey));
  if (schemeId)
    issues.push(
      ...(await sendMissingProfileCommands({
        port: input.port,
        journal: input.journal,
        commands: profileCommands({
          sourceKey: need.scheme.sourceKey,
          sourceUri: need.scheme.sourceUri,
          citation: profileCitation(input.plan),
          nativeType: 'skos:ConceptScheme',
          labels: { en: 'VNDB character blood types' },
          subjectId: schemeId,
        }),
      })),
    );
  const schemeRequirements = [need.scheme];
  const currentScheme = await readVndbCharacterProfileBindings(
    input.port,
    journalProfileReferences(input.journal, { ...need, codes: [] }),
  );
  if (input.stage === 'schemes' || !currentScheme.schemes.length)
    return { requirements: schemeRequirements, bindings: currentScheme, issues };
  const currentSchemeId = currentScheme.schemes[0]!.id;
  const conceptCommands = need.concepts.flatMap((requirement, index) =>
    profileCommands({
      sourceKey: requirement.sourceKey,
      sourceUri: requirement.sourceUri,
      citation: profileCitation(input.plan, need.codes[index]),
      nativeType: 'skos:Concept',
      labels: { und: need.codes[index]! },
    }),
  );
  issues.push(
    ...(await sendMissingProfileCommands({
      port: input.port,
      journal: input.journal,
      commands: conceptCommands,
    })),
  );
  const conceptCreates = acknowledgedProfileCreates(input.journal);
  const conceptProposals = need.concepts.flatMap((requirement, index) => {
    const subjectId = conceptCreates.get(showcaseVocabularyExternalId(requirement.sourceKey));
    return subjectId
      ? profileCommands({
          sourceKey: requirement.sourceKey,
          sourceUri: requirement.sourceUri,
          citation: profileCitation(input.plan, need.codes[index]),
          nativeType: 'skos:Concept',
          labels: { und: need.codes[index]! },
          schemeId: currentSchemeId,
          subjectId,
        })
      : [];
  });
  issues.push(
    ...(await sendMissingProfileCommands({
      port: input.port,
      journal: input.journal,
      commands: conceptProposals,
    })),
  );
  const conceptRequirements = need.concepts.map((requirement) => ({ ...requirement, schemeId: currentSchemeId }));
  const bindings = await readVndbCharacterProfileBindings(
    input.port,
    journalProfileReferences(input.journal, need),
  );
  return { requirements: [...schemeRequirements, ...conceptRequirements], bindings, issues };
}

/** Resolve only journal-acknowledged UUIDs after exact current public type, URI and inScheme checks. */
export async function readShowcaseVndbCharacterProfileVocabulary(input: {
  plan: CrossMediaPlan;
  port: Pick<CrossMediaPort, 'readReviewedSubject'>;
  journal: ShowcaseJournal;
}): Promise<SourceVocabularyBindings> {
  const need = profileVocabularyNeed(input.plan);
  if (!need) return emptyBindings;
  return readVndbCharacterProfileBindings(input.port, journalProfileReferences(input.journal, need));
}
