import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import {
  BATCH_LIMIT,
  checkBatchWrite,
  type BatchCommand,
  type BatchReference,
  type BatchStatement,
} from '@rezics/definitions/bulk';
import { converter_revision as entityRevision, vndbRecordUrl } from '@rezics/conversion/cross-media-entities';
import type { SourceVocabularyBindings, SourceVocabularyGap, SourceVocabularyRequest } from '@rezics/conversion';
import { sourceVocabularyLimits } from '@rezics/conversion/source-vocabulary';
import reviewedVocabulary from '../../../packages/definitions/src/reviewed-vocabulary.json';
import {
  commandKey,
  sourceDigest,
  sourceEnvelope,
  vndbReleaseMediumConceptUri,
  vndbReleaseMediumSchemeUri,
  vndbReleasePlatformConceptUri,
  vndbReleasePlatformSchemeUri,
} from '../../../packages/conversion/src/support.ts';
import type { ImporterOptions } from './importer.ts';
import type { ImportConversion } from './import-contract.ts';
import {
  showcaseDigest,
  showcaseLimits,
  showcaseVocabularyExternalId,
  type ShowcaseVocabularyRequirement,
} from './showcase-manifest.ts';
import type { ShowcaseJournal } from './showcase-publication.ts';
import {
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaGap,
  type CrossMediaPlan,
  type CrossMediaPort,
  type CrossMediaSeedExtras,
  type CrossMediaSeedResult,
  type CrossMediaTables,
} from './cross-media-seed.ts';
import {
  planVndbReleasePlatforms,
  vndbReleaseAssociationReleaseCap,
  vndbReleaseClassificationTaxonomies,
  vndbReleasePlatformPayload,
  type VndbReleasePlatformFacts,
} from './vndb-release-platforms.ts';
import {
  decodeVndbDevstatus,
  decodeVndbReleased,
  developmentStatusSchemeUri,
  developmentStatusTaxonomy,
  readVndbReleaseBindings,
  releasedStateSchemeUri,
  releasedStateTaxonomy,
  vndbReleaseIdentity,
  vndbReleaseVocabularyAdmission,
  vndbWorkIdentity,
  type VndbReleaseBindingGroup,
  type VndbReleaseFacts,
  type VndbReleaseFidelityResult,
} from './vndb-release-fidelity.ts';

type Row = Record<string, unknown>;
type Admission = NonNullable<ImporterOptions['vocabularyAdmission']>;
type ReviewedSeed = { key: string; schemeURI: string; literalMember: string; type: string };
const REVIEWED_SEEDS = reviewedVocabulary as ReviewedSeed[];
const REVIEWED_DEVELOPMENT_STATUS = new Set(
  REVIEWED_SEEDS.filter((row) => row.schemeURI === developmentStatusSchemeUri && row.literalMember !== '').map(
    (row) => row.literalMember,
  ),
);
const REVIEWED_RELEASED_STATE = new Set(
  REVIEWED_SEEDS.filter((row) => row.schemeURI === releasedStateSchemeUri && row.literalMember !== '').map(
    (row) => row.literalMember,
  ),
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}

export type ShowcaseVndbReleaseRequirement = {
  taxonomy: string;
  uri: string;
  codes: string[];
};

export type ShowcaseVndbReleaseIdentity = {
  key: string;
  kind: 'work' | 'release';
  subjectId: string;
  type?: string;
  route: string;
};

export type ShowcaseVndbReleasePreparation = {
  plan: CrossMediaPlan;
  facts: VndbReleaseFacts;
  releasePlatforms: ReadonlyMap<string, VndbReleasePlatformFacts>;
  bindings: SourceVocabularyBindings;
  requirements: ShowcaseVndbReleaseRequirement[];
  groups: VndbReleaseBindingGroup[];
  gaps: CrossMediaGap[];
};

export type ShowcaseVndbReleaseResult = VndbReleaseFidelityResult & {
  facts: VndbReleaseFacts;
  bindings: SourceVocabularyBindings;
  requirements: ShowcaseVndbReleaseRequirement[];
  identities: ShowcaseVndbReleaseIdentity[];
  vocabularyGaps: SourceVocabularyGap[];
};

export function emptyShowcaseVndbReleaseBindings(): SourceVocabularyBindings {
  return { releaseDigest: bundledDigest, schemes: [], concepts: [] };
}

const releaseClassificationRevision = 'vndb-release-classification-vocabulary@1';

type ReleaseClassificationNeed = Readonly<{
  taxonomy: string;
  sourceKey: string;
  sourceUri: string;
  citation: string;
  associationPath: string;
  ownerKey: string;
  code?: string;
}>;

const releaseClassificationSchemes = [
  {
    taxonomy: vndbReleaseClassificationTaxonomies()[0]!,
    schemeUri: vndbReleasePlatformSchemeUri,
    schemeKey: vndbReleaseClassificationTaxonomies()[0]!,
    conceptUri: vndbReleasePlatformConceptUri,
    schemeLabel: 'VNDB release platforms',
  },
  {
    taxonomy: vndbReleaseClassificationTaxonomies()[1]!,
    schemeUri: vndbReleaseMediumSchemeUri,
    schemeKey: vndbReleaseClassificationTaxonomies()[1]!,
    conceptUri: vndbReleaseMediumConceptUri,
    schemeLabel: 'VNDB release media',
  },
] as const;

function releaseClassificationNeeds(
  platforms: ReadonlyMap<string, VndbReleasePlatformFacts>,
): { schemes: ReleaseClassificationNeed[]; concepts: ReleaseClassificationNeed[] } {
  const concepts = new Map<string, ReleaseClassificationNeed>();
  const schemes = new Map<string, ReleaseClassificationNeed>();
  const schemeFor = new Map(releaseClassificationSchemes.map((entry) => [entry.taxonomy, entry]));
  for (const [ownerKey, facts] of [...platforms].sort(([left], [right]) => left.localeCompare(right))) {
    for (const [kind, associations] of [
      ['platform', facts.platforms],
      ['medium', facts.media],
    ] as const) {
      const taxonomy =
        kind === 'platform' ? releaseClassificationSchemes[0].taxonomy : releaseClassificationSchemes[1].taxonomy;
      const definition = schemeFor.get(taxonomy)!;
      for (const association of associations) {
        const sourceUri = definition.conceptUri(association.code);
        const citation = vndbRecordUrl(ownerKey);
        const schemeKey = definition.schemeKey;
        if (!schemes.has(taxonomy))
          schemes.set(taxonomy, {
            taxonomy,
            sourceKey: schemeKey,
            sourceUri: definition.schemeUri,
            citation,
            associationPath: association.path,
            ownerKey,
          });
        const sourceKey = `${taxonomy}:${association.code}`;
        const key = `${taxonomy}\0${association.code}`;
        if (!concepts.has(key))
          concepts.set(key, {
            taxonomy,
            sourceKey,
            sourceUri,
            citation,
            associationPath: association.path,
            ownerKey,
            code: association.code,
          });
      }
    }
  }
  return {
    schemes: [...schemes.values()].sort((left, right) => left.taxonomy.localeCompare(right.taxonomy)),
    concepts: [...concepts.values()].sort(
      (left, right) => left.taxonomy.localeCompare(right.taxonomy) || left.code!.localeCompare(right.code!),
    ),
  };
}

function classificationSource(need: ReleaseClassificationNeed) {
  return sourceEnvelope(
    {
      source: 'vndb_cross_media',
      external_id: showcaseVocabularyExternalId(need.sourceKey),
      record_revision: null,
      converter_revision: releaseClassificationRevision,
      digest: sourceDigest({
        taxonomy: need.taxonomy,
        sourceKey: need.sourceKey,
        sourceUri: need.sourceUri,
        citation: need.citation,
        associationPath: need.associationPath,
        adapterRevision: releaseClassificationRevision,
      }),
    },
    'facts',
  );
}

function classificationReferences(sourceUri: string, citation: string): BatchReference[] {
  return [
    {
      parts: [sourceUri, citation].map((content) => ({
        property: { id: 'schema:url' },
        value: { type: 'value' as const, content },
      })),
    },
  ];
}

function classificationCommands(input: {
  need: ReleaseClassificationNeed;
  nativeType: 'skos:ConceptScheme' | 'skos:Concept';
  labels: Record<string, string>;
  subjectId?: string;
  schemeId?: string;
}): BatchCommand[] {
  const source = classificationSource(input.need);
  const create: BatchCommand = {
    op: 'create',
    key: `vndb-release-classification-vocabulary:${commandKey([
      JSON.stringify(source),
      'create',
      input.nativeType,
      JSON.stringify(input.labels),
    ])}`,
    source,
    subject: { type: input.nativeType, labels: input.labels },
  };
  if (!input.subjectId) return [create];
  const references = classificationReferences(input.need.sourceUri, input.need.citation);
  const statements: BatchStatement[] = [
    {
      property: { id: 'schema:url' },
      value: { type: 'value', content: input.need.sourceUri },
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
    key: `vndb-release-classification-vocabulary:${commandKey([
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

function isReleaseClassificationCommand(command: BatchCommand): boolean {
  return (
    command.source.source === 'vndb_cross_media' &&
    command.source.converter_revision === releaseClassificationRevision
  );
}

async function sendReleaseClassificationPages(
  port: Pick<CrossMediaPort, 'batch'>,
  commands: readonly BatchCommand[],
): Promise<void> {
  for (let offset = 0; offset < commands.length; offset += BATCH_LIMIT) {
    const page = commands.slice(offset, offset + BATCH_LIMIT);
    if (checkBatchWrite({ commands: [...page] }, bundledRelease).length)
      throw new TypeError('VNDB release classification commands failed portable validation');
    await port.batch({ commands: [...page] });
  }
}

async function sendMissingReleaseClassificationCommands(input: {
  port: Pick<CrossMediaPort, 'batch'>;
  journal: ShowcaseJournal;
  commands: readonly BatchCommand[];
}): Promise<void> {
  const pending = input.journal.preparedCommands().flatMap((row) =>
    isReleaseClassificationCommand(row.command) ? [row.command] : [],
  );
  if (pending.length) await sendReleaseClassificationPages(input.port, pending);
  const sealed = new Map<string, string>();
  const created = new Set<string>();
  for (const row of [...input.journal.acknowledgedCommands(), ...input.journal.preparedCommands()]) {
    if (!isReleaseClassificationCommand(row.command)) continue;
    sealed.set(row.command.key, row.commandDigest);
    if (row.command.op === 'create') created.add(row.command.source.external_id);
  }
  const commands = input.commands.filter((command) => {
    const digest = sealed.get(command.key);
    if (digest !== undefined) {
      if (digest !== showcaseDigest(command))
        throw new TypeError('VNDB release classification ACK changed its command body');
      return false;
    }
    return command.op !== 'create' || !created.has(command.source.external_id);
  });
  if (commands.length) await sendReleaseClassificationPages(input.port, commands);
}

function acknowledgedReleaseClassificationCreates(journal: ShowcaseJournal): Map<string, string> {
  return new Map(
    journal
      .acknowledgedCommands()
      .flatMap((row) =>
        row.command.op === 'create' &&
        row.subjectId &&
        isReleaseClassificationCommand(row.command)
          ? [[row.command.source.external_id, row.subjectId] as const]
          : [],
      ),
  );
}

function releaseClassificationGroups(
  needs: ReturnType<typeof releaseClassificationNeeds>,
  journal: ShowcaseJournal,
): VndbReleaseBindingGroup[] {
  const creates = acknowledgedReleaseClassificationCreates(journal);
  return releaseClassificationSchemes.flatMap((definition) => {
    const schemeNeed = needs.schemes.find((item) => item.taxonomy === definition.taxonomy);
    if (!schemeNeed) return [];
    const schemeId = creates.get(showcaseVocabularyExternalId(schemeNeed.sourceKey));
    if (!schemeId) return [];
    const concepts = needs.concepts.flatMap((item) => {
      if (item.taxonomy !== definition.taxonomy || !item.code) return [];
      const id = creates.get(showcaseVocabularyExternalId(item.sourceKey));
      return id ? [{ code: item.code, id }] : [];
    });
    return [{ taxonomy: definition.taxonomy, uri: definition.schemeUri, schemeId, concepts }];
  });
}

/** Stage only selected release classification Concepts in the common showcase journal. */
export async function prepareShowcaseVndbReleaseClassifications(input: {
  plan: CrossMediaPlan;
  port: Pick<CrossMediaPort, 'batch' | 'readReviewedSubject'>;
  journal: ShowcaseJournal;
  stage: 'schemes' | 'concepts';
}): Promise<{
  requirements: ShowcaseVocabularyRequirement[];
  bindings: SourceVocabularyBindings;
  groups: VndbReleaseBindingGroup[];
}> {
  const needs = releaseClassificationNeeds(input.plan.releasePlatforms ?? new Map());
  const schemeRequirements = needs.schemes.map((need) => ({
    provider: 'vndb' as const,
    ownerKey: need.ownerKey,
    sourceKey: need.sourceKey,
    source: classificationSource(need),
    sourceUri: need.sourceUri,
    nativeType: 'skos:ConceptScheme' as const,
  }));
  const commands = needs.schemes.flatMap((need) =>
    classificationCommands({
      need,
      nativeType: 'skos:ConceptScheme',
      labels: { en: releaseClassificationSchemes.find((item) => item.taxonomy === need.taxonomy)!.schemeLabel },
    }),
  );
  await sendMissingReleaseClassificationCommands({ port: input.port, journal: input.journal, commands });
  const schemeCreates = acknowledgedReleaseClassificationCreates(input.journal);
  const schemeProposals = needs.schemes.flatMap((need) => {
    const subjectId = schemeCreates.get(showcaseVocabularyExternalId(need.sourceKey));
    return subjectId
      ? classificationCommands({
          need,
          nativeType: 'skos:ConceptScheme',
          labels: { en: releaseClassificationSchemes.find((item) => item.taxonomy === need.taxonomy)!.schemeLabel },
          subjectId,
        })
      : [];
  });
  await sendMissingReleaseClassificationCommands({ port: input.port, journal: input.journal, commands: schemeProposals });
  let groups = releaseClassificationGroups(needs, input.journal);
  let bindings = await readVndbReleaseBindings(input.port, groups);
  if (input.stage === 'schemes' || !needs.concepts.length)
    return { requirements: schemeRequirements, bindings, groups };

  const currentSchemes = new Map(bindings.schemes.map((scheme) => [scheme.taxonomy, scheme.id]));
  const conceptNeeds = needs.concepts.filter((need) => currentSchemes.has(need.taxonomy));
  const limit = Math.min(
    sourceVocabularyLimits.concepts,
    Math.max(0, showcaseLimits.vocabulary - schemeRequirements.length),
  );
  const selectedConceptNeeds = conceptNeeds.slice(0, limit);
  const conceptCommands = selectedConceptNeeds.flatMap((need) =>
    classificationCommands({
      need,
      nativeType: 'skos:Concept',
      labels: { en: need.code! },
    }),
  );
  await sendMissingReleaseClassificationCommands({ port: input.port, journal: input.journal, commands: conceptCommands });
  const creates = acknowledgedReleaseClassificationCreates(input.journal);
  const conceptProposals = selectedConceptNeeds.flatMap((need) => {
    const subjectId = creates.get(showcaseVocabularyExternalId(need.sourceKey));
    const schemeId = currentSchemes.get(need.taxonomy);
    return subjectId && schemeId
      ? classificationCommands({
          need,
          nativeType: 'skos:Concept',
          labels: { en: need.code! },
          subjectId,
          schemeId,
        })
      : [];
  });
  await sendMissingReleaseClassificationCommands({
    port: input.port,
    journal: input.journal,
    commands: conceptProposals,
  });
  const conceptRequirements = selectedConceptNeeds.flatMap((need) => {
    const schemeId = currentSchemes.get(need.taxonomy);
    return schemeId
      ? [
          {
            provider: 'vndb' as const,
            ownerKey: need.ownerKey,
            sourceKey: need.sourceKey,
            source: classificationSource(need),
            sourceUri: need.sourceUri,
            nativeType: 'skos:Concept' as const,
            schemeId,
          },
        ]
      : [];
  });
  groups = releaseClassificationGroups(needs, input.journal);
  bindings = await readVndbReleaseBindings(input.port, groups);
  return { requirements: [...schemeRequirements, ...conceptRequirements], bindings, groups };
}

function fieldsOf(table: string, record: Row): string[] {
  return Object.keys(record)
    .sort()
    .map((field) => `${table}.${field}`);
}

function selectedKeys(plan: CrossMediaPlan, kind: 'work' | 'release'): Set<string> {
  return new Set(plan.members.filter((row) => row.source === 'vndb' && row.kind === kind).map((row) => row.key));
}

function gap(table: string, record: Row, reason: string): CrossMediaGap {
  return { source: 'vndb', fields: fieldsOf(table, record), record, reason };
}

/** Selected-family dates and states only; never the standalone first-64 archive planner. */
export async function collectSelectedVndbReleaseFacts(
  tables: CrossMediaTables,
  plan: CrossMediaPlan,
): Promise<{ facts: VndbReleaseFacts; gaps: CrossMediaGap[] }> {
  const works = selectedKeys(plan, 'work');
  const releases = selectedKeys(plan, 'release');
  const facts: VndbReleaseFacts = { works: new Map(), releases: new Map() };
  const gaps: CrossMediaGap[] = [];
  for await (const row of tables.rows('vndb', 'vn')) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!works.has(id) || !vndbWorkIdentity.test(id)) continue;
    facts.works.set(id, { devstatus: decodeVndbDevstatus(row.devstatus) });
  }
  for (const id of works) {
    if (facts.works.has(id)) continue;
    gaps.push(gap('vn', { id }, 'Missing selected VNDB work for release dates'));
  }
  const links = new Map<string, { vid: string; completeness: string }[]>();
  for await (const row of tables.rows('vndb', 'releases_vn')) {
    const id = typeof row.id === 'string' ? row.id : '';
    const vid = typeof row.vid === 'string' ? row.vid : '';
    if (!vndbReleaseIdentity.test(id) || !vndbWorkIdentity.test(vid)) {
      if (id || vid) gaps.push(gap('releases_vn', row, 'Invalid VNDB release-work identity'));
      continue;
    }
    if (!releases.has(id)) {
      if (works.has(vid)) gaps.push(gap('releases_vn', row, 'Selected work is missing its release membership'));
      continue;
    }
    if (!works.has(vid)) {
      gaps.push(gap('releases_vn', row, 'Release linked to an unselected work remains unused'));
      continue;
    }
    const completeness = typeof row.rtype === 'string' && row.rtype ? row.rtype : '';
    links.set(id, [...(links.get(id) ?? []), { vid, completeness }]);
  }
  for await (const row of tables.rows('vndb', 'releases')) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!releases.has(id)) continue;
    facts.releases.set(id, { released: row.released, links: links.get(id) ?? [] });
  }
  for (const id of releases) {
    if (facts.releases.has(id)) continue;
    gaps.push(gap('releases', { id }, 'Missing selected VNDB release'));
  }
  return { facts, gaps };
}

export function showcaseVndbReleaseRequirements(facts: VndbReleaseFacts): {
  requirements: ShowcaseVndbReleaseRequirement[];
  gaps: CrossMediaGap[];
} {
  const gaps: CrossMediaGap[] = [];
  const development = new Set<string>();
  for (const [id, work] of facts.works) {
    if (work.devstatus === undefined) continue;
    const code = String(work.devstatus);
    if (!REVIEWED_DEVELOPMENT_STATUS.has(code)) {
      gaps.push(
        gap(
          'vn',
          { id, devstatus: work.devstatus },
          'Development-status code is outside the finite reviewed inventory',
        ),
      );
      continue;
    }
    development.add(code);
  }
  const released = new Set<string>();
  for (const [id, fact] of facts.releases) {
    const value = decodeVndbReleased(fact.released);
    if (value !== 'TBA' && value !== 'unknown') continue;
    if (!REVIEWED_RELEASED_STATE.has(value)) {
      gaps.push(
        gap(
          'releases',
          { id, released: fact.released },
          'Released-state Concepts are not in the finite reviewed inventory',
        ),
      );
      continue;
    }
    released.add(value);
  }
  const requirements: ShowcaseVndbReleaseRequirement[] = [];
  if (development.size)
    requirements.push({
      taxonomy: developmentStatusTaxonomy,
      uri: developmentStatusSchemeUri,
      codes: [...development].sort(),
    });
  if (released.size)
    requirements.push({
      taxonomy: releasedStateTaxonomy,
      uri: releasedStateSchemeUri,
      codes: [...released].sort(),
    });
  return { requirements, gaps };
}

function mergeBindings(left: SourceVocabularyBindings, right: SourceVocabularyBindings): SourceVocabularyBindings {
  const schemes = [...left.schemes];
  for (const scheme of right.schemes)
    if (!schemes.some((row) => row.id === scheme.id && row.uri === scheme.uri)) schemes.push(scheme);
  const concepts = [...left.concepts];
  for (const concept of right.concepts)
    if (
      !concepts.some((row) => row.id === concept.id && row.taxonomy === concept.taxonomy && row.code === concept.code)
    )
      concepts.push(concept);
  return { releaseDigest: left.releaseDigest || right.releaseDigest, schemes, concepts };
}

function withoutDuplicateReleaseWork(rows: SourceVocabularyRequest['rows']): SourceVocabularyRequest['rows'] {
  return rows.map((row) => {
    if (row.kind !== 'release-work') return row;
    const { work: _work, ...rest } = row;
    return rest;
  });
}

/** Sibling adapters keep prior bindings and rows; this hook only adds selected-family date/state facts. */
export function composeShowcaseVndbReleaseAdmission(
  next: Admission | undefined,
  bindings: SourceVocabularyBindings,
  facts: VndbReleaseFacts,
  releasePlatforms: ReadonlyMap<string, VndbReleasePlatformFacts> = new Map(),
): Admission {
  const release = vndbReleaseVocabularyAdmission(bindings, facts, new Map(), releasePlatforms);
  return {
    request(input) {
      const ours = release.request?.(input);
      const theirs = next?.request?.(input);
      const rows = ours ? withoutDuplicateReleaseWork(ours.rows) : undefined;
      if (!rows?.length) return theirs;
      if (!theirs) return { ...ours!, rows };
      return {
        bindings: mergeBindings(theirs.bindings, ours!.bindings),
        rows: [...theirs.rows, ...rows],
      };
    },
  };
}

function overlayBindingGroups(layers: readonly (readonly VndbReleaseBindingGroup[])[]): VndbReleaseBindingGroup[] {
  const groups = new Map<string, VndbReleaseBindingGroup>();
  for (const layer of layers)
    for (const group of layer) {
      if (!group || typeof group.taxonomy !== 'string' || typeof group.uri !== 'string') continue;
      groups.set(`${group.taxonomy}\u0000${group.uri}`, group);
    }
  return [...groups.values()];
}

/** Reviewed-catalogue subject IDs for the finite development-status and released-state codes actually selected. */
export function catalogueVndbReleaseGroups(
  subjects: Readonly<Record<string, string>> | undefined,
  requirements: readonly ShowcaseVndbReleaseRequirement[],
): VndbReleaseBindingGroup[] {
  if (!subjects) return [];
  const groups: VndbReleaseBindingGroup[] = [];
  for (const requirement of requirements) {
    const scheme = REVIEWED_SEEDS.find(
      (row) => row.schemeURI === requirement.uri && row.type === 'skos:ConceptScheme' && row.literalMember === '',
    );
    const schemeId = scheme ? subjects[scheme.key] : undefined;
    if (typeof schemeId !== 'string' || !UUID.test(schemeId)) continue;
    const concepts = requirement.codes.flatMap((code) => {
      const seed = REVIEWED_SEEDS.find(
        (row) => row.schemeURI === requirement.uri && row.type === 'skos:Concept' && row.literalMember === code,
      );
      const id = seed ? subjects[seed.key] : undefined;
      return typeof id === 'string' && UUID.test(id) ? [{ code, id }] : [];
    });
    if (!concepts.length) continue;
    groups.push({ taxonomy: requirement.taxonomy, uri: requirement.uri, schemeId, concepts });
  }
  return groups;
}

export function groupsFromVndbReleaseBindings(
  bindings: SourceVocabularyBindings | undefined,
): VndbReleaseBindingGroup[] {
  if (!bindings?.schemes.length) return [];
  return bindings.schemes.flatMap((scheme) => {
    if (
      !scheme ||
      typeof scheme.taxonomy !== 'string' ||
      typeof scheme.uri !== 'string' ||
      typeof scheme.id !== 'string'
    )
      return [];
    return [
      {
        taxonomy: scheme.taxonomy,
        uri: scheme.uri,
        schemeId: scheme.id,
        concepts: bindings.concepts
          .filter((concept) => concept && concept.taxonomy === scheme.taxonomy && concept.schemeId === scheme.id)
          .map((concept) => ({ code: concept.code, id: concept.id })),
      },
    ];
  });
}

/** Optional UUID file: binding groups or current native scheme/concept hints. */
export function parseVndbReleaseStateBindings(value: unknown): {
  groups: VndbReleaseBindingGroup[];
  bindings?: SourceVocabularyBindings;
} {
  if (Array.isArray(value)) {
    ensure(value.length <= 8, 'VNDB release-state bindings exceed the scheme cap');
    const groups: VndbReleaseBindingGroup[] = [];
    for (const item of value) {
      ensure(item !== null && typeof item === 'object' && !Array.isArray(item), 'Invalid VNDB release-state binding');
      const taxonomy = Reflect.get(item, 'taxonomy');
      const uri = Reflect.get(item, 'uri');
      const schemeId = Reflect.get(item, 'schemeId');
      const conceptsValue = Reflect.get(item, 'concepts');
      ensure(
        typeof taxonomy === 'string' &&
          typeof uri === 'string' &&
          typeof schemeId === 'string' &&
          UUID.test(schemeId) &&
          Array.isArray(conceptsValue) &&
          conceptsValue.length <= 64,
        'Invalid VNDB release-state binding group',
      );
      const concepts = conceptsValue.map((concept) => {
        ensure(
          concept !== null && typeof concept === 'object' && !Array.isArray(concept),
          'Invalid VNDB release-state concept binding',
        );
        const code = Reflect.get(concept, 'code');
        const id = Reflect.get(concept, 'id');
        ensure(
          typeof code === 'string' && typeof id === 'string' && UUID.test(id),
          'Invalid VNDB release-state concept',
        );
        return { code, id };
      });
      groups.push({ taxonomy, uri, schemeId, concepts });
    }
    return { groups };
  }
  ensure(value !== null && typeof value === 'object', 'Invalid VNDB release-state bindings');
  const schemes = Reflect.get(value, 'schemes');
  const concepts = Reflect.get(value, 'concepts');
  ensure(Array.isArray(schemes) && Array.isArray(concepts), 'Invalid VNDB release-state bindings');
  const bindings = value as SourceVocabularyBindings;
  return { groups: groupsFromVndbReleaseBindings(bindings), bindings };
}

function neededBindingCodes(facts: VndbReleaseFacts): Map<string, Set<string>> {
  const wanted = new Map<string, Set<string>>();
  const add = (taxonomy: string, uri: string, code: string) => {
    const key = `${taxonomy}\u0000${uri}`;
    const codes = wanted.get(key) ?? new Set<string>();
    codes.add(code);
    wanted.set(key, codes);
  };
  for (const work of facts.works.values()) {
    if (work.devstatus === undefined) continue;
    add(developmentStatusTaxonomy, developmentStatusSchemeUri, String(work.devstatus));
  }
  for (const fact of facts.releases.values()) {
    const value = decodeVndbReleased(fact.released);
    if (value === 'TBA' || value === 'unknown') add(releasedStateTaxonomy, releasedStateSchemeUri, value);
  }
  return wanted;
}

function bindingGroups(
  facts: VndbReleaseFacts,
  supplied: readonly VndbReleaseBindingGroup[] | undefined,
): VndbReleaseBindingGroup[] {
  if (!supplied?.length) return [];
  const wanted = neededBindingCodes(facts);
  const groups: VndbReleaseBindingGroup[] = [];
  for (const group of supplied) {
    const codes = wanted.get(`${group.taxonomy}\u0000${group.uri}`);
    if (!codes) continue;
    const concepts = group.concepts.filter((item) => codes.has(item.code));
    if (!concepts.length) continue;
    groups.push({ ...group, concepts });
  }
  return groups;
}

function classificationBindingGroups(
  platforms: ReadonlyMap<string, VndbReleasePlatformFacts>,
  supplied: readonly VndbReleaseBindingGroup[],
): VndbReleaseBindingGroup[] {
  const wanted = new Map<string, Set<string>>();
  const [platformTaxonomy, mediumTaxonomy] = vndbReleaseClassificationTaxonomies();
  const add = (taxonomy: string, code: string) => {
    const codes = wanted.get(taxonomy) ?? new Set<string>();
    codes.add(code);
    wanted.set(taxonomy, codes);
  };
  for (const facts of platforms.values()) {
    for (const { code } of facts.platforms) add(platformTaxonomy!, code);
    for (const { code } of facts.media) add(mediumTaxonomy!, code);
  }
  const uriByTaxonomy = new Map([
    [platformTaxonomy!, vndbReleasePlatformSchemeUri],
    [mediumTaxonomy!, vndbReleaseMediumSchemeUri],
  ]);
  return supplied.flatMap((group) => {
    const codes = wanted.get(group.taxonomy);
    if (!codes || uriByTaxonomy.get(group.taxonomy) !== group.uri) return [];
    const concepts = group.concepts.filter((item) => codes.has(item.code));
    return concepts.length ? [{ ...group, concepts }] : [];
  });
}

async function selectedReleasePlatforms(
  tables: CrossMediaTables,
  plan: CrossMediaPlan,
  facts: VndbReleaseFacts,
): Promise<ReadonlyMap<string, VndbReleasePlatformFacts>> {
  if (plan.releasePlatforms) return plan.releasePlatforms;
  const releaseIds = [...facts.releases.keys()].sort().slice(0, vndbReleaseAssociationReleaseCap);
  const availableRows = new Map(
    releaseIds.map((id) => [
      id,
      Math.max(0, sourceVocabularyLimits.rows - 1 - (facts.releases.get(id)?.links.length ?? 0)),
    ]),
  );
  const planned = await planVndbReleasePlatforms(tables, releaseIds, availableRows);
  plan.releasePlatforms = planned.byRelease;
  plan.gaps.push(...planned.gaps);
  for (const row of plan.entities.vndb) {
    const associations = planned.byRelease.get(row.key);
    if (!associations) continue;
    row.payload = { ...(row.payload as object), ...vndbReleasePlatformPayload(row.key, associations) };
  }
  return planned.byRelease;
}

export async function prepareShowcaseVndbReleases(input: {
  tables: CrossMediaTables;
  plan: CrossMediaPlan;
  port?: Pick<CrossMediaPort, 'readReviewedSubject'>;
  bindings?: SourceVocabularyBindings;
  groups?: readonly VndbReleaseBindingGroup[];
  catalogueSubjects?: Readonly<Record<string, string>>;
}): Promise<ShowcaseVndbReleasePreparation> {
  const collected = await collectSelectedVndbReleaseFacts(input.tables, input.plan);
  const needed = showcaseVndbReleaseRequirements(collected.facts);
  const releasePlatforms = await selectedReleasePlatforms(input.tables, input.plan, collected.facts);
  const gaps = [...collected.gaps, ...needed.gaps];
  const suppliedGroups = overlayBindingGroups([
    catalogueVndbReleaseGroups(input.catalogueSubjects, needed.requirements),
    input.groups ?? [],
    groupsFromVndbReleaseBindings(input.bindings),
  ]);
  const stateGroups = bindingGroups(collected.facts, suppliedGroups);
  const platformGroups = classificationBindingGroups(releasePlatforms, suppliedGroups);
  const groups = overlayBindingGroups([stateGroups, platformGroups]);
  const bindings =
    input.port && groups.length
      ? await readVndbReleaseBindings(input.port, groups)
      : emptyShowcaseVndbReleaseBindings();
  input.plan.releaseFacts = collected.facts;
  input.plan.releasePlatforms = releasePlatforms;
  input.plan.gaps.push(...gaps);
  return {
    plan: input.plan,
    facts: collected.facts,
    releasePlatforms,
    bindings,
    requirements: needed.requirements,
    groups,
    gaps,
  };
}

function readingIdentity(row: CrossMediaSeedResult['readings'][number]): ShowcaseVndbReleaseIdentity | undefined {
  const subject = row.subject as { subject?: { id?: string; type?: string }; id?: string; type?: string };
  const subjectId = subject.subject?.id ?? subject.id;
  if (!subjectId) return;
  const kind = vndbReleaseIdentity.test(row.externalId)
    ? 'release'
    : vndbWorkIdentity.test(row.externalId)
      ? 'work'
      : undefined;
  if (!kind) return;
  const type = subject.subject?.type ?? subject.type;
  return {
    key: row.externalId,
    kind,
    subjectId,
    ...(type === undefined ? {} : { type }),
    route: row.route,
  };
}

/** Default selected-family caller: family plan, then the release adapter, then the ordinary seed. */
export async function seedShowcaseVndbReleases(input: {
  tables: CrossMediaTables;
  path: string;
  port: CrossMediaPort;
  bindings?: SourceVocabularyBindings;
  groups?: readonly VndbReleaseBindingGroup[];
  catalogueSubjects?: Readonly<Record<string, string>>;
  destination?: { origin: string };
  extras?: CrossMediaSeedExtras;
  characterBindings?: SourceVocabularyBindings;
  plan?: CrossMediaPlan;
}): Promise<ShowcaseVndbReleaseResult> {
  const plan = input.plan ?? (await planCrossMediaSeed(input.tables));
  const catalogueSubjects = input.catalogueSubjects ?? input.extras?.episodeCatalogueSubjects;
  const prepared = await prepareShowcaseVndbReleases({
    tables: input.tables,
    plan,
    port: input.port,
    ...(input.bindings === undefined ? {} : { bindings: input.bindings }),
    ...(input.groups === undefined ? {} : { groups: input.groups }),
    ...(catalogueSubjects === undefined ? {} : { catalogueSubjects }),
  });
  const vocabularyGaps: SourceVocabularyGap[] = [];
  const extras: CrossMediaSeedExtras = {
    ...input.extras,
    vocabularyAdmission: composeShowcaseVndbReleaseAdmission(
      input.extras?.vocabularyAdmission,
      prepared.bindings,
      prepared.facts,
      prepared.releasePlatforms,
    ),
    onConversionOutput(output: ImportConversion) {
      const extra = output as ImportConversion<{ sourceVocabularyGaps?: readonly SourceVocabularyGap[] }>;
      vocabularyGaps.push(...(extra.sourceVocabularyGaps ?? []));
      input.extras?.onConversionOutput?.(output);
    },
  };
  const result = await seedCrossMedia(
    prepared.plan,
    input.path,
    input.port,
    input.destination,
    extras,
    input.characterBindings,
  );
  return {
    ...result,
    converterRevision: entityRevision,
    facts: prepared.facts,
    bindings: prepared.bindings,
    requirements: prepared.requirements,
    identities: result.readings.flatMap((row) => {
      const identity = readingIdentity(row);
      return identity ? [identity] : [];
    }),
    vocabularyGaps,
  };
}

export type { VndbReleaseBindingGroup, VndbReleaseFacts };
