import { bundledDigest } from '@rezics/definitions/bundled';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import type { SourceVocabularyBindings, SourceVocabularyGap, SourceVocabularyRequest } from '@rezics/conversion';
import reviewedVocabulary from '../../../packages/definitions/src/reviewed-vocabulary.json';
import type { ImporterOptions } from './importer.ts';
import type { ImportConversion } from './import-contract.ts';
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
  if (plan.releaseFacts) return { facts: plan.releaseFacts, gaps: [] };
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
): Admission {
  const release = vndbReleaseVocabularyAdmission(bindings, facts);
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
  const gaps = [...collected.gaps, ...needed.gaps];
  const groups = bindingGroups(
    collected.facts,
    overlayBindingGroups([
      catalogueVndbReleaseGroups(input.catalogueSubjects, needed.requirements),
      input.groups ?? [],
      groupsFromVndbReleaseBindings(input.bindings),
    ]),
  );
  const bindings =
    input.port && groups.length
      ? await readVndbReleaseBindings(input.port, groups)
      : emptyShowcaseVndbReleaseBindings();
  input.plan.releaseFacts = collected.facts;
  input.plan.gaps.push(...gaps);
  return {
    plan: input.plan,
    facts: collected.facts,
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
