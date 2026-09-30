import { Value } from 'typebox/value';
import { canonicalLanguage } from '../display-language/tag.ts';
import { semanticPredicateOutcome } from '../semantic/schema.ts';
import { resolveTargets } from '../target/resolve.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WikiExtractionSchema, WikiResourceSchema, checkLocator,
  type WikiExtraction, type WikiClaim, WIKI_EXTRACTION_LIMITS } from './protocol.ts';
import { WikiRejected } from './errors.ts';
import { wikiTypes } from './candidates.ts';
import { extractionQuotationUses, quotationPreview, type QuotationReader } from './quotation.ts';
import { wikiScope, type WikiRead } from './read.ts';

export const WIKI_VALIDATION_COST = { units: 256, entities: 128, claims: 256, evidencePerClaim: 16,
  targetBatch: 50, requestBytes: WIKI_EXTRACTION_LIMITS.requestBytes, predicateRows: 256 } as const;

/** Detect passage overflow before structural rejection so holders receive the
 * same typed policy problem for direct quotes and every locator fallback. */
export function checkWikiExtraction(input: unknown): WikiExtraction {
  if (new TextEncoder().encode(JSON.stringify(input)).length > WIKI_VALIDATION_COST.requestBytes) {
    throw new WikiRejected('invalid_wiki_extraction', 400);
  }
  const scan = (value: unknown, key = '', depth = 0) => {
    if (depth > 32) throw new WikiRejected('invalid_wiki_extraction', 400);
    if (typeof value === 'string' && ['quote', 'exact', 'prefix', 'suffix'].includes(key)
      && [...value].length > 200) throw new WikiRejected('wiki_passage_limit');
    if (Array.isArray(value)) value.forEach(item => scan(item, key, depth + 1));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([name, item]) => scan(item, name, depth + 1));
  };
  scan(input);
  if (!Value.Check(WikiExtractionSchema, input)) throw new WikiRejected('invalid_wiki_extraction', 400);
  return input;
}
/** Only current, active property/relation definitions in the shared registry.
 * A type or an arbitrary schema.org predicate is not registration. */
async function predicates(read: WikiRead, claims: readonly WikiClaim[]) {
  const requested = [...new Set(claims.map(claim => claim.predicate))];
  if (!requested.length) return new Map<string, 'property' | 'relation'>();
  if (requested.some(predicate => semanticPredicateOutcome(predicate) !== 'admitted')) {
    throw new WikiRejected('wiki_predicate');
  }
  const rows = await read.session.query(`SELECT ?predicate ?kind WHERE { GRAPH ${iri(GRAPHS.current)} {
    VALUES ?predicate { ${requested.map(predicate => `<${predicate}>`).join(' ')} }
    ?predicate a rv:SemanticDefinition ; rv:definitionKind ?kind ; rv:definitionHead ?head .
    FILTER(?kind IN (rv:RelationDefinition, rv:PropertyDefinition))
  } GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:DefinitionRevision ; rv:component ?predicate ; rv:lifecycle rv:Active }
  } LIMIT 257`, 256);
  const admitted = new Map<string, 'property' | 'relation'>();
  for (const row of rows) {
    const predicate = row.predicate?.value;
    if (!predicate || admitted.has(predicate) || semanticPredicateOutcome(predicate) !== 'admitted') {
      throw new WikiRejected('wiki_predicate');
    }
    admitted.set(predicate, row.kind?.value.endsWith('RelationDefinition') ? 'relation' : 'property');
    if (!await read.work.access.canReadSemanticResource?.(read.principal, read.actingSubject, predicate)) {
      throw new WikiRejected('wiki_predicate');
    }
  }
  if (requested.some(predicate => !admitted.has(predicate))) throw new WikiRejected('wiki_predicate');
  return admitted;
}
export async function validateWikiExtraction(read: WikiRead, reader: QuotationReader, input: unknown) {
  const bundle = checkWikiExtraction(input);
  if (!canonicalLanguage(bundle.source.language)) throw new WikiRejected('invalid_language', 400);
  const scope = await wikiScope(read, bundle.target, bundle.zone);
  const units = new Map(bundle.units.map(unit => [unit.id, unit]));
  const entities = new Map(bundle.entities.map(entity => [entity.id, entity]));
  if (units.size !== bundle.units.length || entities.size !== bundle.entities.length
    || new Set(bundle.units.map(unit => unit.ordinal)).size !== bundle.units.length) throw new WikiRejected('wiki_reference');
  const reveal = (unitId: string) => {
    const unit = units.get(unitId);
    if (!unit) throw new WikiRejected('wiki_reference');
    if (!unit.occurrence) throw new WikiRejected('wiki_unaligned_unit');
  };
  for (const entity of bundle.entities) {
    if (!wikiTypes.has(entity.type)) throw new WikiRejected('wiki_entity_type');
    for (const name of entity.names) {
      reveal(name.revealedAt);
      if (!canonicalLanguage(name.language)) throw new WikiRejected('invalid_language', 400);
    }
  }
  if (bundle.claims.some(claim => claim.continuity !== bundle.continuity)) throw new WikiRejected('wiki_continuity_mismatch');
  const continuityTargets = await resolveTargets(read.session, [bundle.continuity], 'continuity');
  if (continuityTargets.some(target => target.work !== bundle.target)) throw new WikiRejected('wiki_continuity_mismatch');
  const refs = new Set<string>();
  const ref = (value: string) => {
    if (entities.has(value)) return;
    if (!Value.Check(WikiResourceSchema, value)) throw new WikiRejected('wiki_reference');
    refs.add(value);
  };
  for (const claim of bundle.claims) {
    reveal(claim.revealedAt);
    if (claim.continuity !== bundle.continuity) throw new WikiRejected('wiki_continuity_mismatch');
    ref(claim.subject);
    if (claim.object.kind === 'entity') ref(claim.object.ref);
    else if (claim.object.language && !canonicalLanguage(claim.object.language)) throw new WikiRejected('invalid_language', 400);
    for (const evidence of claim.evidence) {
      if (!checkLocator(evidence.locator) || evidence.locator.source.type !== 'external'
        || evidence.locator.source.representationSha256 !== bundle.source.representationSha256
        || evidence.locator.source.mediaType.toLowerCase() !== bundle.source.mediaType.toLowerCase()) {
        throw new WikiRejected('wiki_locator_source');
      }
    }
  }
  const occurrences = [...new Set(bundle.units.flatMap(unit => unit.occurrence ? [unit.occurrence] : []))];
  for (let start = 0; start < occurrences.length; start += 50) {
    const resolved = await resolveTargets(read.session, occurrences.slice(start, start + 50), 'spoiler-boundary');
    if (resolved.some(target => target.work !== bundle.target)) throw new WikiRejected('wiki_occurrence_mismatch');
  }
  for (const entity of bundle.entities) if (entity.match) refs.add(entity.match);
  const resolvedRefs = new Map<string, Awaited<ReturnType<typeof resolveTargets>>[number]>();
  const references = [...refs];
  for (let start = 0; start < references.length; start += 50) {
    for (const target of await resolveTargets(read.session, references.slice(start, start + 50), 'collection-member')) {
      resolvedRefs.set(target.resource, target);
    }
  }
  for (const entity of bundle.entities) if (entity.match) {
    const target = resolvedRefs.get(entity.match);
    if (target?.base !== 'resource' || !target.types.includes(entity.type)) throw new WikiRejected('wiki_match_type');
  }
  const kinds = await predicates(read, bundle.claims);
  if (bundle.claims.some(claim => kinds.get(claim.predicate) === 'relation' && claim.object.kind !== 'entity')) {
    throw new WikiRejected('wiki_predicate');
  }
  const quotations = await quotationPreview(reader, bundle.target, extractionQuotationUses(bundle));
  return { profile: 'wiki-validation-v1' as const, status: 'acceptable' as const,
    target: scope.target!, sourcePosition: read.session.position,
    entities: bundle.entities.map(entity => ({ ...entity, action: entity.match ? 'reuse' as const : 'create' as const,
      revision: entity.match ? resolvedRefs.get(entity.match)!.revision : null })),
    claims: bundle.claims.filter(claim => kinds.get(claim.predicate) === 'property'),
    relations: bundle.claims.filter(claim => kinds.get(claim.predicate) === 'relation'),
    alignment: bundle.units.map(unit => ({ ...unit, status: unit.occurrence ? 'aligned' as const : 'unaligned' as const })),
    quotations };
}
