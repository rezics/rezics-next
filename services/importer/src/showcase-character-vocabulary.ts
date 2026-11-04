import { bundledDigest } from '@rezics/definitions/bundled';
import type { SourceVocabularyBindings } from '@rezics/conversion';
import { vndbAppearanceRoleCodes } from '@rezics/conversion/vndb-vocabulary';
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
import { VNDB_CHARACTER_TRAIT_DICTIONARY_COLUMNS, VNDB_CHARACTER_TRAIT_PARENT_COLUMNS } from './vndb-tables.ts';

const CODE = /^i[1-9][0-9]*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SELECTED_WORK_CAP = 64;
const PARENT_EDGE_CAP = 256;
const PARENT_DEPTH_CAP = 12;
const GAP_CAP = 32;

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
}>;

/** IDs are only lookup hints. composeVndbCharacterVocabularyBindings verifies every current public subject. */
export type VndbCharacterVocabularyProfile = Readonly<{
  traits: { schemeId: string; concepts: readonly { code: string; id: string }[] };
  roles: { schemeId: string; concepts: readonly { code: string; id: string }[] };
}>;

export type ShowcaseCharacterVocabularyPlan = Readonly<{
  plan: VndbCharacterTraitPlan;
  requirements: VndbCharacterVocabularyRequirements;
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
  ensure(input && Array.isArray(input.concepts) && typeof input.schemeId === 'string' && UUID.test(input.schemeId), 'Invalid VNDB vocabulary profile');
  ensure(input.concepts.length <= 512, 'VNDB vocabulary profile exceeds its concept cap');
  const seen = new Set<string>();
  const concepts: { code: string; id: string }[] = [];
  for (const item of input.concepts) {
    const entry = record(item);
    ensure(entry && typeof entry.code === 'string' && typeof entry.id === 'string', 'Invalid VNDB vocabulary profile concept');
    const codeValid = role ? (vndbAppearanceRoleCodes as readonly string[]).includes(entry.code) : CODE.test(entry.code);
    ensure(codeValid && UUID.test(entry.id) && !seen.has(entry.code), 'Invalid or duplicate VNDB vocabulary profile concept');
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
    addGap(plan, ['traits_parents.id', 'traits_parents.parent'], {}, 'VNDB trait parent closure exceeded its bounded cap');

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
      addGap(plan, [...VNDB_CHARACTER_TRAIT_DICTIONARY_COLUMNS.map((column) => `traits.${column}`)], { id: code }, 'Missing selected VNDB trait label');
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
  return { plan, requirements: { selectedWorkIds: works, terms, parents: supportedParents } };
}

/** Resolve only selected term IDs, then verify their current public type, URI and adopted scheme membership. */
export async function composeVndbCharacterVocabularyBindings(
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  profile: VndbCharacterVocabularyProfile | undefined,
  requirements: VndbCharacterVocabularyRequirements,
): Promise<SourceVocabularyBindings> {
  if (!profile) return { releaseDigest: bundledDigest, schemes: [], concepts: [] };
  const traits = new Set(
    requirements.terms.filter((term) => term.taxonomy === characterTraitTaxonomy).map((term) => term.code),
  );
  const roles = new Set(requirements.terms.filter((term) => term.taxonomy === appearanceRoleTaxonomy).map((term) => term.code));
  if (!traits.size && !roles.size) return { releaseDigest: bundledDigest, schemes: [], concepts: [] };
  return readVndbCharacterVocabularyBindings(port, {
    ...(traits.size
      ? { traits: { schemeId: profile.traits.schemeId, concepts: profile.traits.concepts.filter((item) => traits.has(item.code)) } }
      : {}),
    ...(roles.size
      ? { roles: { schemeId: profile.roles.schemeId, concepts: profile.roles.concepts.filter((item) => roles.has(item.code)) } }
      : {}),
  });
}
