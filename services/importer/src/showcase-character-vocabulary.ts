import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import {
  BATCH_LIMIT,
  checkBatchWrite,
  type BatchCommand,
  type BatchReference,
  type BatchStatement,
} from '@rezics/definitions/bulk';
import type { SourceVocabularyBindings } from '@rezics/conversion';
import { vndbRecordUrl } from '@rezics/conversion/cross-media-entities';
import { vndbAppearanceRoleCodes } from '@rezics/conversion/vndb-vocabulary';
import { commandKey, sourceDigest, sourceEnvelope } from '../../../packages/conversion/src/support.ts';
import {
  appearanceRoleConceptUri,
  appearanceRoleSchemeUri,
  characterTraitConceptUri,
  characterTraitSchemeUri,
  characterTraitTaxonomy,
  appearanceRoleTaxonomy,
  planVndbCharacterTraits,
  readVndbCharacterVocabularyBindings,
  type VndbCharacterTraitPlan,
} from './vndb-character-traits.ts';
import type { CrossMediaPlan, CrossMediaPort, CrossMediaTables } from './cross-media-seed.ts';
import {
  showcaseDigest,
  showcaseLimits,
  showcaseVocabularyExternalId,
  type ShowcaseVocabularyRequirement,
} from './showcase-manifest.ts';
import type { ShowcaseJournal } from './showcase-publication.ts';
import { VNDB_CHARACTER_TRAIT_DICTIONARY_COLUMNS, VNDB_CHARACTER_TRAIT_PARENT_COLUMNS } from './vndb-tables.ts';

const CODE = /^i[1-9][0-9]*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SELECTED_WORK_CAP = 64;
const PARENT_EDGE_CAP = 256;
const PARENT_DEPTH_CAP = 12;
const GAP_CAP = 32;
const adapterRevision = 'vndb-character-vocabulary@1';
const schemeCitation = {
  [characterTraitTaxonomy]: 'https://vndb.org/i',
  [appearanceRoleTaxonomy]: 'https://vndb.org/c',
} as const;
const schemeLabel = {
  [characterTraitTaxonomy]: 'VNDB character traits',
  [appearanceRoleTaxonomy]: 'VNDB appearance roles',
} as const;
type LabelLanguage = 'en' | 'ja' | 'zh-Hant';
type CharacterTaxonomy = typeof characterTraitTaxonomy | typeof appearanceRoleTaxonomy;

export type ShowcaseCharacterTerm = Readonly<{
  provider: 'vndb';
  taxonomy: typeof characterTraitTaxonomy | typeof appearanceRoleTaxonomy;
  schemeUri: string;
  code: string;
  uri: string;
  label: string;
  sourcePath: string;
}>;

export type ShowcaseCharacterParent = Readonly<{
  childCode: string;
  parentCode: string;
  main: boolean;
  sourcePath: string;
}>;

export type VndbCharacterVocabularyRequirements = Readonly<{
  selectedWorkIds: readonly string[];
  terms: readonly ShowcaseCharacterTerm[];
  parents: readonly ShowcaseCharacterParent[];
  associatedCodes: readonly string[];
}>;

/** IDs are only lookup hints. composeVndbCharacterVocabularyBindings verifies every current public subject. */
export type VndbCharacterVocabularyProfile = Readonly<{
  traits?: { schemeId: string; concepts: readonly { code: string; id: string }[] };
  roles?: { schemeId: string; concepts: readonly { code: string; id: string }[] };
}>;

export type ShowcaseCharacterVocabularyPlan = Readonly<{
  plan: VndbCharacterTraitPlan;
  requirements: VndbCharacterVocabularyRequirements;
}>;

export type ShowcaseCharacterVocabularyPublication = Readonly<{
  requirements: ShowcaseVocabularyRequirement[];
  bindings: SourceVocabularyBindings;
  truncated: boolean;
}>;

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function selectedWorks(plan: CrossMediaPlan): string[] {
  const result = [...new Set(Object.values(plan.franchises).flatMap((family) => family.vndb))].sort();
  ensure(result.length <= SELECTED_WORK_CAP, 'Selected VNDB character work set exceeds its bounded cap');
  return result;
}

function addGap(plan: VndbCharacterTraitPlan, fields: string[], recordValue: Record<string, unknown>, reason: string) {
  if (plan.gaps.length >= GAP_CAP) return;
  plan.gaps.push({ source: 'vndb', fields, record: recordValue, reason });
}

function flag(value: unknown): boolean | undefined {
  if (value === 't' || value === true) return true;
  if (value === 'f' || value === false) return false;
  return undefined;
}

function conceptIds(value: unknown, role: boolean): { code: string; id: string }[] {
  const input = record(value);
  ensure(
    input && Array.isArray(input.concepts) && typeof input.schemeId === 'string' && UUID.test(input.schemeId),
    'Invalid VNDB vocabulary profile',
  );
  ensure(input.concepts.length <= 512, 'VNDB vocabulary profile exceeds its concept cap');
  const seen = new Set<string>();
  const concepts: { code: string; id: string }[] = [];
  for (const item of input.concepts) {
    const entry = record(item);
    ensure(
      entry && typeof entry.code === 'string' && typeof entry.id === 'string',
      'Invalid VNDB vocabulary profile concept',
    );
    const codeValid = role
      ? (vndbAppearanceRoleCodes as readonly string[]).includes(entry.code)
      : CODE.test(entry.code);
    ensure(
      codeValid && UUID.test(entry.id) && !seen.has(entry.code),
      'Invalid or duplicate VNDB vocabulary profile concept',
    );
    seen.add(entry.code);
    concepts.push({ code: entry.code, id: entry.id });
  }
  return concepts;
}

export function parseVndbCharacterVocabularyProfile(value: unknown): VndbCharacterVocabularyProfile {
  const input = record(value);
  ensure(input, 'Invalid VNDB character vocabulary profile');
  const trait = record(input.traits);
  const role = record(input.roles);
  ensure(trait && role, 'VNDB character vocabulary profile needs trait and role sections');
  const traits = conceptIds(trait, false);
  const roles = conceptIds(role, true);
  return {
    traits: { schemeId: trait.schemeId as string, concepts: traits },
    roles: { schemeId: role.schemeId as string, concepts: roles },
  };
}

/** Build bounded source vocabulary requirements from the default family selection and current COPY rows. */
export async function planShowcaseCharacterVocabulary(
  tables: CrossMediaTables,
  selectedPlan: CrossMediaPlan,
): Promise<ShowcaseCharacterVocabularyPlan> {
  const works = selectedWorks(selectedPlan);
  const plan = await planVndbCharacterTraits(tables, { selectedWorkIds: works });
  const observedTraits = new Set<string>();
  const observedRoles = new Map<string, string>();
  for (const row of plan.traits) {
    if (
      typeof row.tid === 'string' &&
      CODE.test(row.tid) &&
      flag(row.lie) === false &&
      /^(?:0|1|2)$/.test(String(row.spoil))
    )
      observedTraits.add(row.tid);
  }
  for (const row of plan.appearances) {
    if (
      typeof row.role === 'string' &&
      (vndbAppearanceRoleCodes as readonly string[]).includes(row.role) &&
      (row.rid === null || row.rid === undefined) &&
      /^(?:0|1|2)$/.test(String(row.spoil))
    ) {
      const path = `/chars_vns/${String(row.id)}/${String(row.vid)}`;
      if (!observedRoles.has(row.role) || path < observedRoles.get(row.role)!) observedRoles.set(row.role, path);
    }
  }
  const traits = new Map<string, { label: string }>();
  const ambiguousTraits = new Set<string>();
  const needed = new Set(observedTraits);
  const parents: ShowcaseCharacterParent[] = [];
  let frontier = new Set(observedTraits);
  let parentOverflow = false;
  for (let depth = 0; frontier.size && depth < PARENT_DEPTH_CAP; depth++) {
    const next = new Set<string>();
    for await (const row of tables.rows('vndb', 'traits_parents')) {
      const child = typeof row.id === 'string' && CODE.test(row.id) ? row.id : undefined;
      if (!child || !frontier.has(child)) continue;
      const parent = typeof row.parent === 'string' && CODE.test(row.parent) ? row.parent : undefined;
      const main = flag(row.main);
      if (!parent || main === undefined) {
        addGap(
          plan,
          [...VNDB_CHARACTER_TRAIT_PARENT_COLUMNS.map((column) => `traits_parents.${column}`)],
          { ...(child ? { id: child } : {}), ...(parent ? { parent } : {}) },
          'Invalid VNDB trait parent row',
        );
        continue;
      }
      if (parents.length >= PARENT_EDGE_CAP) {
        parentOverflow = true;
        break;
      }
      parents.push({
        childCode: child,
        parentCode: parent,
        main,
        sourcePath: `/traits_parents/${child}/${parent}`,
      });
      if (!needed.has(parent)) next.add(parent);
      needed.add(parent);
    }
    frontier = next;
    if (parentOverflow) break;
  }
  if (parentOverflow || frontier.size)
    addGap(
      plan,
      ['traits_parents.id', 'traits_parents.parent'],
      {},
      'VNDB trait parent closure exceeded its bounded cap',
    );

  if (needed.size)
    for await (const row of tables.rows('vndb', 'traits')) {
      const code = typeof row.id === 'string' && CODE.test(row.id) ? row.id : undefined;
      if (!code || !needed.has(code)) continue;
      if (ambiguousTraits.has(code)) continue;
      if (traits.has(code)) {
        traits.delete(code);
        ambiguousTraits.add(code);
        addGap(plan, ['traits.id', 'traits.name'], { id: code }, 'Duplicate selected VNDB trait dictionary entry');
        continue;
      }
      if (
        typeof row.name === 'string' &&
        row.name.trim() &&
        row.name.length <= 250 &&
        !/[\u0000-\u001f\u007f]/u.test(row.name)
      )
        traits.set(code, { label: row.name });
    }
  const terms: ShowcaseCharacterTerm[] = [];
  for (const code of [...needed].sort()) {
    const source = traits.get(code);
    if (!source) {
      addGap(
        plan,
        [...VNDB_CHARACTER_TRAIT_DICTIONARY_COLUMNS.map((column) => `traits.${column}`)],
        { id: code },
        'Missing selected VNDB trait label',
      );
      continue;
    }
    terms.push({
      provider: 'vndb',
      taxonomy: characterTraitTaxonomy,
      schemeUri: characterTraitSchemeUri,
      code,
      uri: characterTraitConceptUri(code),
      label: source.label,
      sourcePath: `/traits/${code}`,
    });
  }
  for (const code of [...observedRoles.keys()].sort())
    terms.push({
      provider: 'vndb',
      taxonomy: appearanceRoleTaxonomy,
      schemeUri: appearanceRoleSchemeUri,
      code,
      uri: appearanceRoleConceptUri(code),
      label: code,
      sourcePath: observedRoles.get(code)!,
    });
  const termCodes = new Set(terms.filter((term) => term.taxonomy === characterTraitTaxonomy).map((term) => term.code));
  const supportedParents = parents.filter((edge) => termCodes.has(edge.childCode) && termCodes.has(edge.parentCode));
  supportedParents.sort((a, b) => a.childCode.localeCompare(b.childCode) || a.parentCode.localeCompare(b.parentCode));
  return {
    plan,
    requirements: {
      selectedWorkIds: works,
      terms,
      parents: supportedParents,
      associatedCodes: [...observedTraits, ...observedRoles.keys()].sort(),
    },
  };
}

function emptyBindings(): SourceVocabularyBindings {
  return { releaseDigest: bundledDigest, schemes: [], concepts: [] };
}

function adoptedValues(read: unknown, property: string): string[] {
  const statements = (read as { subject?: { statements?: Record<string, { value?: { content?: unknown } }[]> } })
    .subject?.statements?.[property];
  if (!Array.isArray(statements)) return [];
  return statements.flatMap((statement) =>
    typeof statement.value?.content === 'string' ? [statement.value.content] : [],
  );
}

async function withholdContradictoryTraitParents(
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  bindings: SourceVocabularyBindings,
  parents: readonly ShowcaseCharacterParent[],
): Promise<SourceVocabularyBindings> {
  if (!parents.length) return bindings;
  const byCode = new Map(
    bindings.concepts
      .filter((concept) => concept.taxonomy === characterTraitTaxonomy)
      .map((concept) => [concept.code, concept]),
  );
  const omitted = new Set<string>();
  for (const edge of parents) {
    if (omitted.has(edge.childCode)) continue;
    const child = byCode.get(edge.childCode);
    const parent = byCode.get(edge.parentCode);
    if (!child || !parent) {
      if (child) omitted.add(edge.childCode);
      continue;
    }
    let read;
    try {
      read = await port.readReviewedSubject(child.id);
    } catch {
      omitted.add(edge.childCode);
      continue;
    }
    if (!adoptedValues(read, 'skos:broader').includes(parent.id)) omitted.add(edge.childCode);
  }
  if (!omitted.size) return bindings;
  return {
    ...bindings,
    concepts: bindings.concepts.filter(
      (concept) => concept.taxonomy !== characterTraitTaxonomy || !omitted.has(concept.code),
    ),
  };
}

/** Resolve only selected term IDs, then verify their current public type, URI, adopted scheme membership and taxonomy parents. */
export async function composeVndbCharacterVocabularyBindings(
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  profile: VndbCharacterVocabularyProfile | undefined,
  requirements: VndbCharacterVocabularyRequirements,
): Promise<SourceVocabularyBindings> {
  if (!profile) return emptyBindings();
  const traits = new Set(
    requirements.terms.filter((term) => term.taxonomy === characterTraitTaxonomy).map((term) => term.code),
  );
  const roles = new Set(
    requirements.terms.filter((term) => term.taxonomy === appearanceRoleTaxonomy).map((term) => term.code),
  );
  if (!traits.size && !roles.size) return emptyBindings();
  const bindings = await readVndbCharacterVocabularyBindings(port, {
    ...(traits.size && profile.traits
      ? {
          traits: {
            schemeId: profile.traits.schemeId,
            concepts: profile.traits.concepts.filter((item) => traits.has(item.code)),
          },
        }
      : {}),
    ...(roles.size && profile.roles
      ? {
          roles: {
            schemeId: profile.roles.schemeId,
            concepts: profile.roles.concepts.filter((item) => roles.has(item.code)),
          },
        }
      : {}),
  });
  return withholdContradictoryTraitParents(port, bindings, requirements.parents);
}

function ownerKeyFor(plan: CrossMediaPlan, selectedWorkIds: readonly string[]): string | undefined {
  const selected = new Set(selectedWorkIds);
  return [...plan.records.vndb, ...plan.entities.vndb].find((row) => selected.has(row.key))?.key;
}

function vocabularyKey(taxonomy: CharacterTaxonomy, code?: string): string {
  return code === undefined ? taxonomy : `${taxonomy}:${code}`;
}

function sourceNameLanguage(name: string): LabelLanguage {
  if (/[\u3040-\u30ff]/u.test(name)) return 'ja';
  if (/\p{Script=Han}/u.test(name)) return 'zh-Hant';
  return 'en';
}

function sourceFor(sourceKey: string, uri: string, citations: readonly string[]) {
  return sourceEnvelope(
    {
      source: 'vndb_cross_media',
      external_id: showcaseVocabularyExternalId(sourceKey),
      record_revision: null,
      converter_revision: adapterRevision,
      digest: sourceDigest({ sourceKey, uri, citations, adapterRevision }),
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

function termCitation(term: ShowcaseCharacterTerm): string {
  if (term.taxonomy === characterTraitTaxonomy) return vndbRecordUrl(term.code);
  const match = /^\/chars_vns\/c[1-9][0-9]*\/(v[1-9][0-9]*)$/u.exec(term.sourcePath);
  return match ? vndbRecordUrl(match[1]!) : vndbRecordUrl(term.code);
}

function requirementFor(
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
    source: sourceFor(sourceKey, sourceUri, [sourceUri, citation]),
    sourceUri,
    nativeType,
    ...(schemeId ? { schemeId } : {}),
  };
}

function vocabularyCommands(input: {
  sourceKey: string;
  sourceUri: string;
  citation: string;
  nativeType: 'skos:ConceptScheme' | 'skos:Concept';
  labels: Record<string, string>;
  schemeId?: string;
  broaderIds?: readonly string[];
  subjectId?: string;
}): BatchCommand[] {
  const source = sourceFor(input.sourceKey, input.sourceUri, [input.sourceUri, input.citation]);
  const create: BatchCommand = {
    op: 'create',
    key: `vndb-character-vocabulary:${commandKey([JSON.stringify(source), 'create', input.nativeType, JSON.stringify(input.labels)])}`,
    source,
    subject: { type: input.nativeType, labels: input.labels },
  };
  const subjectId = input.subjectId;
  if (!subjectId) return [create];
  const statements: BatchStatement[] = [
    {
      property: { id: 'schema:url' },
      value: { type: 'value', content: input.sourceUri },
      references: references(input.sourceUri, input.citation),
    },
  ];
  if (input.nativeType === 'skos:Concept' && input.schemeId) {
    statements.push({
      property: { id: 'skos:inScheme' },
      value: { type: 'value', content: input.schemeId },
      references: references(input.sourceUri, input.citation),
    });
  }
  if (input.nativeType === 'skos:Concept')
    for (const broaderId of input.broaderIds ?? [])
      statements.push({
        property: { id: 'skos:broader' },
        value: { type: 'value', content: broaderId },
        references: references(input.sourceUri, input.citation),
      });
  return statements.map((statement) => ({
    op: 'propose' as const,
    key: `vndb-character-vocabulary:${commandKey([JSON.stringify(source), subjectId, 'propose', JSON.stringify(statement)])}`,
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
        ack.command.source.source === 'vndb_cross_media' &&
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
    if (digest !== showcaseDigest(command))
      throw new TypeError('VNDB character vocabulary ACK changed its command body');
    return false;
  });
  for (let offset = 0; offset < commands.length; offset += BATCH_LIMIT) {
    const page = commands.slice(offset, offset + BATCH_LIMIT);
    if (checkBatchWrite({ commands: [...page] }, bundledRelease).length)
      throw new TypeError('VNDB character vocabulary commands failed portable validation');
    await input.port.batch({ commands: [...page] });
  }
}

function neededSchemes(terms: readonly ShowcaseCharacterTerm[]): CharacterTaxonomy[] {
  const seen = new Set<CharacterTaxonomy>();
  for (const term of terms) seen.add(term.taxonomy);
  return [...seen].sort();
}

function identityProfile(
  requirements: VndbCharacterVocabularyRequirements,
  journal: ShowcaseJournal,
): VndbCharacterVocabularyProfile {
  const creates = ackedCreates(journal);
  const traitSchemeId = creates.get(showcaseVocabularyExternalId(vocabularyKey(characterTraitTaxonomy)));
  const roleSchemeId = creates.get(showcaseVocabularyExternalId(vocabularyKey(appearanceRoleTaxonomy)));
  const traits = requirements.terms.flatMap((term) => {
    if (term.taxonomy !== characterTraitTaxonomy) return [];
    const id = creates.get(showcaseVocabularyExternalId(vocabularyKey(term.taxonomy, term.code)));
    return id ? [{ code: term.code, id }] : [];
  });
  const roles = requirements.terms.flatMap((term) => {
    if (term.taxonomy !== appearanceRoleTaxonomy) return [];
    const id = creates.get(showcaseVocabularyExternalId(vocabularyKey(term.taxonomy, term.code)));
    return id ? [{ code: term.code, id }] : [];
  });
  return {
    ...(traitSchemeId ? { traits: { schemeId: traitSchemeId, concepts: traits } } : {}),
    ...(roleSchemeId ? { roles: { schemeId: roleSchemeId, concepts: roles } } : {}),
  };
}

/** Map journal-acknowledged vocabulary identities into the optional profile-file shape. */
export function profileFromCharacterVocabularyBindings(
  bindings: SourceVocabularyBindings,
): VndbCharacterVocabularyProfile | undefined {
  const traitScheme = bindings.schemes.find((scheme) => scheme.taxonomy === characterTraitTaxonomy);
  const roleScheme = bindings.schemes.find((scheme) => scheme.taxonomy === appearanceRoleTaxonomy);
  if (!traitScheme && !roleScheme) return undefined;
  return {
    ...(traitScheme
      ? {
          traits: {
            schemeId: traitScheme.id,
            concepts: bindings.concepts
              .filter((concept) => concept.taxonomy === characterTraitTaxonomy)
              .map((concept) => ({ code: concept.code, id: concept.id })),
          },
        }
      : {}),
    ...(roleScheme
      ? {
          roles: {
            schemeId: roleScheme.id,
            concepts: bindings.concepts
              .filter((concept) => concept.taxonomy === appearanceRoleTaxonomy)
              .map((concept) => ({ code: concept.code, id: concept.id })),
          },
        }
      : {}),
  };
}

function truncatedFrom(plan: VndbCharacterTraitPlan): boolean {
  return plan.gaps.some((gap) => gap.reason.includes('parent closure exceeded'));
}

/** Stage only trait/role schemes then Concepts demanded by selected character rows. */
export async function prepareShowcaseCharacterVocabulary(input: {
  tables: CrossMediaTables;
  selectedPlan: CrossMediaPlan;
  port: Pick<CrossMediaPort, 'batch' | 'readReviewedSubject'>;
  journal: ShowcaseJournal;
  stage: 'schemes' | 'concepts';
}): Promise<ShowcaseCharacterVocabularyPublication> {
  const vocabulary = await planShowcaseCharacterVocabulary(input.tables, input.selectedPlan);
  const ownerKey = ownerKeyFor(input.selectedPlan, vocabulary.requirements.selectedWorkIds);
  if (!ownerKey || !vocabulary.requirements.terms.length)
    return { requirements: [], bindings: emptyBindings(), truncated: truncatedFrom(vocabulary.plan) };
  const schemes = neededSchemes(vocabulary.requirements.terms);
  const schemeCommands = schemes.flatMap((taxonomy) =>
    vocabularyCommands({
      sourceKey: vocabularyKey(taxonomy),
      sourceUri: taxonomy === characterTraitTaxonomy ? characterTraitSchemeUri : appearanceRoleSchemeUri,
      citation: schemeCitation[taxonomy],
      nativeType: 'skos:ConceptScheme',
      labels: { en: schemeLabel[taxonomy] },
    }),
  );
  if (schemeCommands.length) await sendMissing({ port: input.port, journal: input.journal, commands: schemeCommands });
  const schemeCreates = ackedCreates(input.journal);
  const schemeProposals = schemes.flatMap((taxonomy) => {
    const subjectId = schemeCreates.get(showcaseVocabularyExternalId(vocabularyKey(taxonomy)));
    return subjectId
      ? vocabularyCommands({
          sourceKey: vocabularyKey(taxonomy),
          sourceUri: taxonomy === characterTraitTaxonomy ? characterTraitSchemeUri : appearanceRoleSchemeUri,
          citation: schemeCitation[taxonomy],
          nativeType: 'skos:ConceptScheme',
          labels: { en: schemeLabel[taxonomy] },
          subjectId,
        })
      : [];
  });
  if (schemeProposals.length)
    await sendMissing({ port: input.port, journal: input.journal, commands: schemeProposals });
  const schemeRequirements = schemes.map((taxonomy) =>
    requirementFor(
      ownerKey,
      vocabularyKey(taxonomy),
      taxonomy === characterTraitTaxonomy ? characterTraitSchemeUri : appearanceRoleSchemeUri,
      schemeCitation[taxonomy],
      'skos:ConceptScheme',
    ),
  );
  const profile = identityProfile(vocabulary.requirements, input.journal);
  if (input.stage === 'schemes')
    return {
      requirements: schemeRequirements,
      bindings: await composeVndbCharacterVocabularyBindings(input.port, profile, vocabulary.requirements),
      truncated: truncatedFrom(vocabulary.plan),
    };

  const current = await composeVndbCharacterVocabularyBindings(input.port, profile, vocabulary.requirements);
  const currentSchemes = new Map(current.schemes.map((entry) => [entry.taxonomy, entry.id]));
  const budget = Math.max(0, showcaseLimits.vocabulary - schemeRequirements.length);
  const associatedCodes = new Set(vocabulary.requirements.associatedCodes);
  const admitted = vocabulary.requirements.terms.filter((term) => currentSchemes.has(term.taxonomy));
  const associated = admitted.filter((term) => associatedCodes.has(term.code));
  const parentTerms = admitted.filter((term) => !associatedCodes.has(term.code));
  const conceptEntries = [...associated, ...parentTerms].slice(0, budget);
  const truncated = truncatedFrom(vocabulary.plan) || admitted.length > conceptEntries.length;
  const conceptCommands = conceptEntries.flatMap((term) =>
    vocabularyCommands({
      sourceKey: vocabularyKey(term.taxonomy, term.code),
      sourceUri: term.uri,
      citation: termCitation(term),
      nativeType: 'skos:Concept',
      labels: { [sourceNameLanguage(term.label)]: term.label },
    }),
  );
  if (conceptCommands.length)
    await sendMissing({ port: input.port, journal: input.journal, commands: conceptCommands });
  const conceptCreates = ackedCreates(input.journal);
  const parentIds = new Map<string, string[]>();
  for (const edge of vocabulary.requirements.parents) {
    const parentId = conceptCreates.get(
      showcaseVocabularyExternalId(vocabularyKey(characterTraitTaxonomy, edge.parentCode)),
    );
    if (!parentId) continue;
    const existing = parentIds.get(edge.childCode) ?? [];
    if (!existing.includes(parentId)) parentIds.set(edge.childCode, [...existing, parentId]);
  }
  const conceptProposals = conceptEntries.flatMap((term) => {
    const subjectId = conceptCreates.get(showcaseVocabularyExternalId(vocabularyKey(term.taxonomy, term.code)));
    const schemeId = currentSchemes.get(term.taxonomy);
    const broaderIds = term.taxonomy === characterTraitTaxonomy ? parentIds.get(term.code) : undefined;
    return subjectId && schemeId
      ? vocabularyCommands({
          sourceKey: vocabularyKey(term.taxonomy, term.code),
          sourceUri: term.uri,
          citation: termCitation(term),
          nativeType: 'skos:Concept',
          labels: { [sourceNameLanguage(term.label)]: term.label },
          schemeId,
          ...(broaderIds?.length ? { broaderIds } : {}),
          subjectId,
        })
      : [];
  });
  if (conceptProposals.length)
    await sendMissing({ port: input.port, journal: input.journal, commands: conceptProposals });
  const conceptRequirements = conceptEntries.map((term) =>
    requirementFor(
      ownerKey,
      vocabularyKey(term.taxonomy, term.code),
      term.uri,
      termCitation(term),
      'skos:Concept',
      currentSchemes.get(term.taxonomy),
    ),
  );
  const resolved = identityProfile(vocabulary.requirements, input.journal);
  return {
    requirements: [...schemeRequirements, ...conceptRequirements],
    bindings: await composeVndbCharacterVocabularyBindings(input.port, resolved, vocabulary.requirements),
    truncated,
  };
}

/** Resolve only journal-acknowledged UUIDs after exact current public vocabulary checks. */
export async function readShowcaseCharacterVocabulary(input: {
  tables: CrossMediaTables;
  selectedPlan: CrossMediaPlan;
  port: Pick<CrossMediaPort, 'readReviewedSubject'>;
  journal: ShowcaseJournal;
}): Promise<SourceVocabularyBindings> {
  const vocabulary = await planShowcaseCharacterVocabulary(input.tables, input.selectedPlan);
  return composeVndbCharacterVocabularyBindings(
    input.port,
    identityProfile(vocabulary.requirements, input.journal),
    vocabulary.requirements,
  );
}
