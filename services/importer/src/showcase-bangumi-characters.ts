import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { BATCH_LIMIT, checkBatchWrite, type BatchCommand, type BatchReference, type BatchStatement } from '@rezics/definitions/bulk';
import type { SourceVocabularyBindings, SourceVocabularyGap } from '@rezics/conversion';
import { mapSourceEnumeration } from '@rezics/conversion/cross-media-entities';
import { commandKey, sourceDigest, sourceEnvelope } from '../../../packages/conversion/src/support.ts';
import { currentBangumiCharacterVocabularyBindings } from './bangumi-character-fidelity.ts';
import type { CrossMediaPlan, CrossMediaPort } from './cross-media-seed.ts';
import { showcaseDigest } from './showcase-manifest.ts';
import type { ShowcaseJournal } from './showcase-publication.ts';
import type { ShowcaseVocabularyRequirement } from './showcase-manifest.ts';

const adapterRevision = 'bangumi-character-vocabulary@1';
const taxonomy = {
  'bangumi.character.role': {
    group: 'character.role',
    scheme: 'https://rezics.com/schemes/bangumi/character-kinds',
    label: 'Bangumi character kinds',
  },
  'bangumi.subject-characters.type': {
    group: 'subject-characters.type',
    scheme: 'https://rezics.com/schemes/bangumi/appearance-roles',
    label: 'Bangumi appearance roles',
  },
} as const;
type Taxonomy = keyof typeof taxonomy;
type MappingEvidence = {
  taxonomy: Taxonomy;
  code: string;
  uri: string;
  schemeUri: string;
  label: string;
  citation: string;
  ownerKey: string;
};
type CharacterVocabularyNeed = {
  schemes: Map<Taxonomy, { ownerKey: string; citation: string }>;
  concepts: MappingEvidence[];
  diagnostics: SourceVocabularyGap[];
};
export type ShowcaseBangumiCharacterVocabulary = {
  requirements: ShowcaseVocabularyRequirement[];
  bindings: SourceVocabularyBindings;
  diagnostics: SourceVocabularyGap[];
};

function mappingEvidence(taxonomyId: Taxonomy, code: unknown, ownerKey: string): MappingEvidence | null {
  if ((typeof code !== 'string' && typeof code !== 'number') || !String(code).trim()) return null;
  const definition = taxonomy[taxonomyId];
  const mapped = mapSourceEnumeration('bangumi', definition.group, code);
  if (
    !mapped ||
    mapped.status !== 'existing' ||
    !mapped.concept ||
    mapped.concept.scheme !== definition.scheme ||
    mapped.concept.id !== `${definition.scheme}/${String(code)}`
  )
    return null;
  const citation = (mapped as typeof mapped & { source?: unknown }).source;
  if (typeof citation !== 'string' || !citation.startsWith('https://')) return null;
  return {
    taxonomy: taxonomyId,
    code: String(code),
    uri: mapped.concept.id,
    schemeUri: mapped.concept.scheme,
    label: mapped.concept.label,
    citation,
    ownerKey,
  };
}

function selectedNeed(plan: CrossMediaPlan): CharacterVocabularyNeed {
  const diagnostics: SourceVocabularyGap[] = [];
  const concepts = new Map<string, MappingEvidence>();
  const appearances = plan.characterAppearances ?? [];
  const animeWorks = new Set(
    [...plan.records.bangumi, ...plan.entities.bangumi]
      .filter((record) => record.payload && typeof record.payload === 'object' && record.payload.type === 2)
      .map((record) => record.key),
  );
  const animeCharacters = new Set(
    appearances.filter((row) => animeWorks.has(row.subjectId)).map((row) => `character:${row.characterId}`),
  );
  const characterRecords = [...plan.records.bangumi, ...plan.entities.bangumi]
    .filter((record) => animeCharacters.has(record.key))
    .sort((left, right) => left.key.localeCompare(right.key));
  for (const record of characterRecords) {
    if (!record.payload || typeof record.payload !== 'object') continue;
    const evidence = mappingEvidence('bangumi.character.role', record.payload.type, record.key);
    if (evidence) concepts.set(`${evidence.taxonomy}\0${evidence.code}`, evidence);
  }
  const orderedAppearances = appearances
    .filter((row) => animeWorks.has(row.subjectId))
    .slice()
    .sort((left, right) => left.subjectId.localeCompare(right.subjectId) || left.sourceIndex - right.sourceIndex);
  for (const appearance of orderedAppearances) {
    const evidence = mappingEvidence('bangumi.subject-characters.type', appearance.roleCode, appearance.subjectId);
    if (evidence) concepts.set(`${evidence.taxonomy}\0${evidence.code}`, evidence);
    else if (typeof appearance.roleCode !== 'number' && typeof appearance.roleCode !== 'string')
      diagnostics.push({
        provider: 'bangumi',
        path: `/subject-characters/${appearance.sourceIndex}/type`,
        endpoint: appearance.subjectId,
        reason: 'invalid_row',
        property: 'subject-characters.type',
      });
  }
  const selectedConcepts = [...concepts.values()].sort(
    (left, right) => left.taxonomy.localeCompare(right.taxonomy) || left.code.localeCompare(right.code),
  );
  const schemes = new Map<Taxonomy, { ownerKey: string; citation: string }>();
  for (const evidence of selectedConcepts) {
    if (!schemes.has(evidence.taxonomy)) schemes.set(evidence.taxonomy, { ownerKey: evidence.ownerKey, citation: evidence.citation });
  }
  return { schemes, concepts: selectedConcepts, diagnostics: diagnostics.slice(0, 64) };
}

function sourceFor(uri: string, citations: readonly string[]) {
  return sourceEnvelope(
    {
      source: 'bangumi_cross_media',
      external_id: uri,
      record_revision: null,
      converter_revision: adapterRevision,
      digest: sourceDigest({ uri, citations, adapterRevision }),
    },
    'facts',
  );
}

function references(uri: string, citation: string): BatchReference[] {
  return [
    {
      parts: [uri, citation].map((content) => ({
        property: { id: 'schema:url' },
        value: { type: 'value' as const, content },
      })),
    },
  ];
}

function requirement(
  entry: MappingEvidence | { taxonomy: Taxonomy; uri: string; ownerKey: string; citation: string },
  nativeType: 'skos:ConceptScheme' | 'skos:Concept',
  schemeId?: string,
): ShowcaseVocabularyRequirement {
  const sourceUri = entry.uri;
  const source = sourceFor(sourceUri, [sourceUri, entry.citation]);
  return {
    provider: 'bangumi',
    ownerKey: entry.ownerKey,
    sourceKey: sourceUri,
    source,
    sourceUri,
    nativeType,
    ...(schemeId ? { schemeId } : {}),
  };
}

function schemeEvidence(need: CharacterVocabularyNeed, id: Taxonomy) {
  const selected = need.schemes.get(id);
  if (!selected) return undefined;
  return {
    taxonomy: id,
    uri: taxonomy[id].scheme,
    ownerKey: selected.ownerKey,
    citation: selected.citation,
  };
}

function vocabularyCommands(input: {
  entry: MappingEvidence | { taxonomy: Taxonomy; uri: string; ownerKey: string; citation: string };
  nativeType: 'skos:ConceptScheme' | 'skos:Concept';
  schemeId?: string;
  subjectId?: string;
}): BatchCommand[] {
  const { entry, nativeType, schemeId, subjectId } = input;
  const definition = taxonomy[entry.taxonomy];
  const isScheme = nativeType === 'skos:ConceptScheme';
  const sourceUri = entry.uri;
  const source = sourceFor(sourceUri, [sourceUri, entry.citation]);
  const labels = isScheme ? { en: definition.label } : { en: (entry as MappingEvidence).label };
  const create: BatchCommand = {
    op: 'create',
    key: `bangumi-character-vocabulary:${commandKey([JSON.stringify(source), 'create', nativeType, JSON.stringify(labels)])}`,
    source,
    subject: { type: nativeType, labels },
  };
  if (!subjectId) return [create];
  const urlStatement: BatchStatement = {
    property: { id: 'schema:url' },
    value: { type: 'value', content: sourceUri },
    references: references(sourceUri, entry.citation),
  };
  const statements: BatchStatement[] = [urlStatement];
  if (!isScheme && schemeId) {
    statements.push({
      property: { id: 'skos:inScheme' },
      value: { type: 'value', content: schemeId },
      references: references(sourceUri, entry.citation),
    });
  }
  return statements.map((statement) => ({
      op: 'propose' as const,
      key: `bangumi-character-vocabulary:${commandKey([JSON.stringify(source), subjectId, 'propose', JSON.stringify(statement)])}`,
      source,
      subject: subjectId,
      statement,
    }));
}

function ackedCreates(journal: ShowcaseJournal): Map<string, string> {
  return new Map(
    journal
      .acknowledgedCommands()
      .flatMap((ack) =>
        ack.command.op === 'create' &&
        ack.subjectId &&
        ack.command.source.source === 'bangumi_cross_media' &&
        ack.command.source.converter_revision === adapterRevision
          ? [[ack.command.source.external_id, ack.subjectId] as const]
          : [],
      ),
  );
}

async function sendMissing(input: {
  port: Pick<CrossMediaPort, 'batch'>;
  journal: ShowcaseJournal;
  commands: readonly BatchCommand[];
}): Promise<void> {
  const acknowledged = new Map(input.journal.acknowledgedCommands().map((ack) => [ack.command.key, ack.commandDigest]));
  const commands = input.commands.filter((command) => {
    const digest = acknowledged.get(command.key);
    if (digest === undefined) return true;
    if (digest !== showcaseDigest(command)) throw new TypeError('Bangumi character vocabulary ACK changed its command body');
    return false;
  });
  for (let offset = 0; offset < commands.length; offset += BATCH_LIMIT) {
    const page = commands.slice(offset, offset + BATCH_LIMIT);
    if (checkBatchWrite({ commands: [...page] }, bundledRelease).length)
      throw new TypeError('Bangumi character vocabulary commands failed portable validation');
    await input.port.batch({ commands: [...page] });
  }
}

function identityBindings(need: CharacterVocabularyNeed, journal: ShowcaseJournal): SourceVocabularyBindings {
  const creates = ackedCreates(journal);
  const schemes = [...need.schemes.keys()].flatMap((id) => {
    const uri = taxonomy[id].scheme;
    const subject = creates.get(uri);
    return subject
      ? [{ taxonomy: id, id: subject, uri, type: 'skos:ConceptScheme' as const, releaseDigest: bundledDigest }]
      : [];
  });
  const schemeIds = new Map(schemes.map((scheme) => [scheme.taxonomy, scheme.id]));
  const concepts = need.concepts.flatMap((entry) => {
    const id = creates.get(entry.uri);
    const schemeId = schemeIds.get(entry.taxonomy);
    return id && schemeId
      ? [{
          taxonomy: entry.taxonomy,
          code: entry.code,
          id,
          type: 'skos:Concept' as const,
          schemeId,
          releaseDigest: bundledDigest,
        }]
      : [];
  });
  return { releaseDigest: bundledDigest, schemes, concepts };
}

/** Stage only vocabulary demanded by actual selected anime character and appearance rows. */
export async function prepareShowcaseBangumiCharacterVocabulary(input: {
  plan: CrossMediaPlan;
  port: Pick<CrossMediaPort, 'batch' | 'readReviewedSubject'>;
  journal: ShowcaseJournal;
  stage: 'schemes' | 'concepts';
}): Promise<ShowcaseBangumiCharacterVocabulary> {
  const need = selectedNeed(input.plan);
  const schemeEntries = [...need.schemes.keys()]
    .sort()
    .map((id) => schemeEvidence(need, id))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const schemeCommands = schemeEntries.flatMap((entry) =>
    vocabularyCommands({ entry, nativeType: 'skos:ConceptScheme' }),
  );
  if (schemeCommands.length) await sendMissing({ port: input.port, journal: input.journal, commands: schemeCommands });
  const schemeCreates = ackedCreates(input.journal);
  const schemeProposals = schemeEntries.flatMap((entry) => {
    const subjectId = schemeCreates.get(entry.uri);
    return subjectId ? vocabularyCommands({ entry, nativeType: 'skos:ConceptScheme', subjectId }) : [];
  });
  if (schemeProposals.length)
    await sendMissing({ port: input.port, journal: input.journal, commands: schemeProposals });
  const schemeRequirements = schemeEntries.map((entry) => requirement(entry, 'skos:ConceptScheme'));
  if (input.stage === 'schemes')
    return {
      requirements: schemeRequirements,
      bindings: await currentBangumiCharacterVocabularyBindings(identityBindings(need, input.journal), input.port),
      diagnostics: need.diagnostics,
    };

  const current = await currentBangumiCharacterVocabularyBindings(identityBindings(need, input.journal), input.port);
  const currentSchemes = new Map(current.schemes.map((entry) => [entry.taxonomy, entry.id]));
  const conceptEntries = need.concepts.filter((entry) => currentSchemes.has(entry.taxonomy));
  const conceptCommands = conceptEntries.flatMap((entry) =>
    vocabularyCommands({ entry, nativeType: 'skos:Concept' }),
  );
  if (conceptCommands.length) await sendMissing({ port: input.port, journal: input.journal, commands: conceptCommands });
  const conceptCreates = ackedCreates(input.journal);
  const conceptProposals = conceptEntries.flatMap((entry) => {
    const subjectId = conceptCreates.get(entry.uri);
    const schemeId = currentSchemes.get(entry.taxonomy);
    return subjectId && schemeId
      ? vocabularyCommands({
          entry,
          nativeType: 'skos:Concept',
          subjectId,
          schemeId,
        })
      : [];
  });
  if (conceptProposals.length)
    await sendMissing({ port: input.port, journal: input.journal, commands: conceptProposals });
  const conceptRequirements = conceptEntries.map((entry) =>
    requirement(entry, 'skos:Concept', currentSchemes.get(entry.taxonomy)),
  );
  const blocked = schemeEntries
    .filter((entry) => !currentSchemes.has(entry.taxonomy))
    .map((entry) => ({
      provider: 'bangumi' as const,
      path: `/source-vocabulary/${entry.taxonomy}`,
      reason: 'missing_scheme' as const,
      property: entry.uri,
    }));
  const bindings = await currentBangumiCharacterVocabularyBindings(identityBindings(need, input.journal), input.port);
  return {
    requirements: [...schemeRequirements, ...conceptRequirements],
    bindings,
    diagnostics: [...need.diagnostics, ...blocked].slice(0, 64),
  };
}

/** Resolve only journal-acknowledged UUIDs after exact current public vocabulary checks. */
export async function readShowcaseBangumiCharacterVocabulary(input: {
  plan: CrossMediaPlan;
  port: Pick<CrossMediaPort, 'readReviewedSubject'>;
  journal: ShowcaseJournal;
}): Promise<SourceVocabularyBindings> {
  const need = selectedNeed(input.plan);
  return currentBangumiCharacterVocabularyBindings(identityBindings(need, input.journal), input.port);
}
