import { bundledDigest } from '@rezics/definitions/bundled';
import type { SourceVocabularyBindings } from '@rezics/conversion';
import {
  vndbPublicTagConceptUri,
  vndbPublicTagScheme,
  vndbPublicTagTaxonomy,
  type VndbPublicTagCategory,
} from '@rezics/conversion/vndb-vocabulary';
import { type CrossMediaGap } from './showcase-contract.ts';
import { type ShowcaseTagParentBinding } from './showcase-contract.ts';
import type { ShowcaseTagSourceParent } from './showcase-tags.ts';

export { vndbPublicTagParentCommand as showcaseTagParentCommand } from '@rezics/conversion/vndb-vocabulary';

/** Facts carry rights through native source-record provenance, not summary-only bulk rights. */
export function showcaseTagParentMetadata(binding: ShowcaseTagParentBinding) {
  return {
    source: 'vndb_cross_media',
    external_id: binding.path,
    metadata: {
      name: `VNDB tags_parents ${binding.child} → ${binding.parent}`,
      url: `https://vndb.org/${binding.child}#${binding.path}`,
      licence: { id: 'ODbL-1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/' },
      attribution: 'VNDB (database: ODbL-1.0; permitted metadata contents: DbCL-1.0)',
    },
    expected_metadata_revision: null,
  };
}

export async function showcaseTagParentSourceFence(
  fence: (input: { source: string; externalId: string; fieldGroup: 'facts' }) => Promise<{
    fenced: boolean;
    securityRevision: string | null;
  }>,
  binding: ShowcaseTagParentBinding,
): Promise<'open' | 'fenced' | 'unavailable'> {
  const current = await fence({ source: 'vndb_cross_media', externalId: binding.path, fieldGroup: 'facts' });
  if (current.fenced) return 'fenced';
  return current.securityRevision === null ? 'open' : 'unavailable';
}

/** Resolve source parent edges only through the current exact category/Scheme bindings. */
export function bindShowcaseTagParents(input: {
  sourceParents: readonly ShowcaseTagSourceParent[];
  invalidParentTags: readonly string[];
  bindings: SourceVocabularyBindings;
}): { tagParentEvidence: ShowcaseTagParentBinding[]; unavailableTagCodes: string[]; gaps: CrossMediaGap[] } {
  const schemes = new Map<VndbPublicTagCategory, SourceVocabularyBindings['schemes'][number]>();
  for (const scheme of input.bindings.schemes) {
    if (scheme.type !== 'skos:ConceptScheme' || scheme.releaseDigest !== bundledDigest) continue;
    const category = categoryForTaxonomy(scheme.taxonomy);
    if (category && scheme.uri === vndbPublicTagScheme(category)) schemes.set(category, scheme);
  }

  const concepts = new Map<string, SourceVocabularyBindings['concepts'][number]>();
  for (const concept of input.bindings.concepts) {
    if (concept.type !== 'skos:Concept' || concept.releaseDigest !== bundledDigest) continue;
    const category = categoryForTaxonomy(concept.taxonomy);
    if (category) concepts.set(`${category}\0${concept.code}`, concept);
  }

  const unavailable = new Set(input.invalidParentTags);
  const gaps: CrossMediaGap[] = [];
  const resolved = new Map<string, ShowcaseTagParentBinding>();
  const childrenByParent = new Map<string, string[]>();

  for (const edge of input.sourceParents) {
    const child = concepts.get(`${edge.category}\0${edge.child}`);
    const parent = concepts.get(`${edge.category}\0${edge.parent}`);
    const scheme = schemes.get(edge.category);
    const sourceKey = `${edge.child}\0${edge.parent}`;
    const children = childrenByParent.get(edge.parent) ?? [];
    children.push(edge.child);
    childrenByParent.set(edge.parent, children);
    if (!child || !parent || !scheme || child.schemeId !== scheme.id || parent.schemeId !== scheme.id) {
      unavailable.add(edge.child);
      gaps.push({
        source: 'vndb',
        fields: ['tags_parents.id', 'tags_parents.parent'],
        record: { id: edge.child, parent: edge.parent },
        reason: 'VNDB tag parent lacks exact current child, parent and category Scheme bindings',
      });
      continue;
    }
    resolved.set(sourceKey, {
      ...edge,
      childId: child.id,
      parentId: parent.id,
      schemeId: scheme.id,
      childUri: vndbPublicTagConceptUri(edge.category, edge.child),
      parentUri: vndbPublicTagConceptUri(edge.category, edge.parent),
      schemeUri: vndbPublicTagScheme(edge.category),
      releaseDigest: bundledDigest,
    });
  }

  // A child depends on the complete source ancestry below each required parent.
  const queue = [...unavailable];
  for (let offset = 0; offset < queue.length; offset += 1) {
    for (const child of childrenByParent.get(queue[offset]!) ?? []) {
      if (unavailable.has(child)) continue;
      unavailable.add(child);
      queue.push(child);
    }
  }

  const tagParentEvidence = [...resolved.values()]
    .filter((edge) => !unavailable.has(edge.child) && !unavailable.has(edge.parent))
    .sort((left, right) => left.path.localeCompare(right.path));
  return { tagParentEvidence, unavailableTagCodes: [...unavailable].sort(), gaps };
}

export function withholdShowcaseTagAssociations<T extends { tag: string }>(
  associations: readonly T[],
  unavailableTagCodes: readonly string[],
): T[] {
  const unavailable = new Set(unavailableTagCodes);
  return associations.filter((association) => !unavailable.has(association.tag));
}

function categoryForTaxonomy(taxonomy: string): VndbPublicTagCategory | undefined {
  for (const category of ['cont', 'ero', 'tech'] as const)
    if (taxonomy === vndbPublicTagTaxonomy(category)) return category;
  return undefined;
}
