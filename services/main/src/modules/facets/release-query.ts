import type { FilterCondition, FilterGroup, FilterNode } from '../../../../../model/definitions/filter-document-v1.ts';
import { QueryRejected, type AdmittedQuery } from '../query/compile.ts';
import { RELEASE_QUERY_COST } from './release-contract.ts';
import { resolveFacet, type AdmittedFacet } from './registry.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { WORK_SEMANTIC_TYPES } from '../work/activate.ts';
import { publicWork, publishedWork } from '../work/public-patterns.ts';

export interface ReleaseQuery {
  context: AdmittedQuery['context']; scope: Exclude<AdmittedQuery['scope'], { kind: 'mine' }>;
  sort: 'newest'; groups: FilterCondition[]; conditions: FilterCondition[];
  limit: number; cursor?: string;
}
const unsupported = (message: string): never => { throw new QueryRejected('unsupported_query_shape', message); };
// Expanded registry terms include RDF/schema/vocabulary IRIs; the Work command
// serializer intentionally admits only native identity/definition IRIs.
const term = (value: string): string => {
  if (!/^(?:https?:\/\/|urn:)[^\s<>"{}|\\^`]+$/.test(value)) return unsupported('Invalid Facet term');
  return `<${value}>`;
};

export const relatedCondition = (condition: FilterCondition): boolean =>
  resolveFacet(condition.facet)!.path.at(-1)!.kind === 'related';

/** Release groups share the FilterDocument's one grouping mechanism. Other templates stay unchanged. */
export function compileReleaseQuery(query: AdmittedQuery, conditions: FilterCondition[]): ReleaseQuery {
  if (query.text || query.sort !== 'newest' || query.scope.kind === 'mine') {
    unsupported('Release discovery admits newest inventories in all or Realm scope');
  }
  if (query.scope.kind === 'realm' && (query.context === 'global' || query.context.realm !== query.scope.realm)) {
    unsupported('A Zone scope needs the same Realm Context');
  }
  if (query.page.size > RELEASE_QUERY_COST.pageSize) {
    throw new QueryRejected('query_budget_exceeded', 'Release discovery page exceeds its bound');
  }
  if (query.page.continuation !== undefined && typeof query.page.continuation !== 'string') {
    unsupported('Release discovery continuation has the wrong form');
  }
  const groups = conditions.filter(relatedCondition);
  const rest = conditions.filter(condition => !relatedCondition(condition));
  if (groups.length > RELEASE_QUERY_COST.groups) {
    throw new QueryRejected('query_budget_exceeded', 'Release groups exceed the bounded explanation reads');
  }
  for (const group of groups) {
    if (!group.where || group.none || group.all || group.range || group.bind || group.interpretation || group.applicability) {
      unsupported('Release discovery needs a where group, optionally with included release IDs');
    }
    if (group.any?.some(value => typeof value !== 'string'
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(value))) {
      unsupported('Release discovery needs native release IDs');
    }
  }
  for (const condition of rest) {
    const facet = resolveFacet(condition.facet)!;
    if (!['type', 'language', 'status'].includes(facet.name) || condition.range || condition.bind
      || condition.interpretation || condition.applicability || condition.where) {
      unsupported(`${facet.name} has no release discovery template`);
    }
    if (facet.name === 'type' && [condition.any, condition.all, condition.none].flat().some(value =>
      value !== undefined && !(WORK_SEMANTIC_TYPES as readonly unknown[]).includes(value))) {
      unsupported('Release discovery does not admit this Work type');
    }
  }
  return { context: query.context, scope: query.scope as ReleaseQuery['scope'],
    sort: query.sort as ReleaseQuery['sort'], groups, conditions: rest, limit: query.page.size,
    ...(query.page.continuation !== undefined ? { cursor: query.page.continuation as string } : {}) };
}

/** EXISTS keeps any/all/none cardinality on the same bound node without multiplying Work rows.
 * https://www.w3.org/TR/sparql11-query/#negation (SPARQL 1.1, 2013). */
function valueTest(condition: FilterCondition, node: string, facet: AdmittedFacet, key: string): string {
  const path = facet.path.at(-1)!;
  if (path.kind !== 'triple') return unsupported('Release comparison needs a declared triple');
  const lexical = facet.values.every(domain => domain.kind === 'datatype');
  const values = (condition.any ?? condition.all ?? condition.none)! as string[];
  const terms = values.map(value => lexical ? lit(value) : term(value));
  const exists = (chosen: string[]) => `EXISTS { GRAPH ${iri(GRAPHS.current)} {
    ${node} ${term(path.predicate)} ?value${key} . FILTER(?value${key} IN (${chosen.join(', ')})) } }`;
  return condition.all ? terms.map(term => exists([term])).join(' && ')
    : `${condition.none ? '!' : ''}${exists(terms)}`;
}

type CoverageBinding = { predicate: string; entry: string; legacy?: 'v1' | 'v2' };
function groupTest(group: FilterGroup, release: string, key: string, coverage?: CoverageBinding): string {
  const all = 'all' in group;
  return '(' + (all ? group.all : group.any).map((node: FilterNode, index) => {
    if (!('facet' in node)) return groupTest(node, release, `${key}_${index}`, coverage);
    const facet = resolveFacet(node.facet)!;
    const scoped = facet.path[0]?.kind === 'triple' && facet.path[0].predicate === coverage?.predicate;
    const target = scoped && !coverage?.legacy ? coverage!.entry : release;
    if (scoped && coverage?.legacy === 'v1') {
      const values = (node.any ?? node.all ?? node.none)! as string[];
      const last = facet.path.at(-1)!;
      if (last.kind !== 'triple') return unsupported('Legacy coverage needs a triple');
      const language = last.predicate === 'https://rezics.com/vocab/contentLanguage';
      const test = (value: string) => language ? `EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${release} rv:contentLanguages ?legacyLanguages${key}_${index} .
        FILTER(CONTAINS(CONCAT(" ", STR(?legacyLanguages${key}_${index}), " "), ${lit(` ${value} `)})) } }`
        : String(value === 'unknown');
      return `(${node.none ? '!' : ''}(${values.map(test).join(node.all ? ' && ' : ' || ')}))`;
    }
    return valueTest(node, target, facet, `${key}_${index}`);
  }).join(all ? ' && ' : ' || ') + ')';
}

// A nested public-work pattern must have fresh internal variables. Otherwise its
// selection/erasure tests accidentally correlate with the outer Work's selection.
function coveredPublic(): string {
  return publicWork('?coveredWork', '?coveredMain').replace(/\?(\w+)/g, (_, name: string) =>
    name === 'coveredWork' || name === 'coveredMain' ? `?${name}` : `?covered_${name}`);
}

/** V3 binds all coverage children to one entry of the queried Work, while publication fields
 * stay on that entry's release. Frozen v2 records only support release-level correlation;
 * v1 coverage is unknown. Every covered Work must be public in every branch. */
export function releaseGroupPattern(condition: FilterCondition, release: string, key: string): string {
  const related = resolveFacet(condition.facet)!.path.at(-1)!;
  if (related.kind !== 'related') return unsupported('Release group has no related path');
  const path = related.path.map(step => `${step.inverse ? '^' : ''}${term(step.predicate)}`).join('/');
  const entry = `?coverage${key}`;
  const correlation = related.correlation;
  const binding = correlation ? { predicate: correlation.predicate, entry } : undefined;
  const v3 = `<https://rezics.com/definition/release-v3>`;
  const head = `GRAPH ${iri(GRAPHS.current)} { ?work (${path}|^rv:work) ${release} .
    VALUES ?releaseType${key} { ${related.types.map(term).join(' ')} }
    ${release} a ?releaseType${key} ; rv:releaseHead ?releaseHead${key} . }
    GRAPH ${iri(GRAPHS.revisions)} { ?releaseHead${key} a rv:ReleaseRevision ; rv:component ${release} }`;
  // A single UNION lets Jena reorder the legacy branches across every coverage
  // entry. On a v3 catalogue that plan exceeds the release read deadline.
  // Separate subqueries keep each definition's join on its own branch.
  const project = `?work ${release} ?releaseHead${key}`;
  const branch = (body: string) => `{ SELECT ${project} WHERE { ${head} ${body} } }`;
  return `${branch(`GRAPH ${iri(GRAPHS.revisions)} { ?releaseHead${key} rv:modelRevision ${v3} }
      ${correlation ? `GRAPH ${iri(GRAPHS.current)} {
        ${release} ${term(correlation.predicate)} ${entry} .
        ${entry} ${term(correlation.resource)} ?work ; a ?coverageType${key} .
        VALUES ?coverageType${key} { ${correlation.types.map(term).join(' ')} } }` : ''}
      FILTER(${groupTest(condition.where!, release, key, binding)})`)} UNION ${branch(`
      GRAPH ${iri(GRAPHS.revisions)} { ?releaseHead${key} rv:component ${release} ; rv:modelRevision <https://rezics.com/definition/release-v2> }
      FILTER(${groupTest(condition.where!, release, key, binding ? { ...binding, legacy: 'v2' } : undefined)})`)} UNION ${branch(`
      GRAPH ${iri(GRAPHS.revisions)} { ?releaseHead${key} rv:component ${release} ; rv:modelRevision <https://rezics.com/definition/release-v1> }
      FILTER(${groupTest(condition.where!, release, key, binding ? { ...binding, legacy: 'v1' } : undefined)})`)}
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${release} rv:protectionHead ?releaseProtection${key} } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?releaseHead${key} a rv:ErasedRevision } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${release} rv:work|rv:coverageWork|rv:coverage/rv:work ?coveredWork }
      FILTER NOT EXISTS { ${coveredPublic()} } }
    ${condition.any ? `FILTER(${release} IN (${(condition.any as string[]).map(iri).join(', ')}))` : ''}`;
}

/** Resource Conditions retain their Work/selected-publication meaning outside the release group. */
export function releaseWorkConditions(query: ReleaseQuery, publicContribution: string): string {
  return query.conditions.map((condition, index) => {
    const facet = resolveFacet(condition.facet)!;
    if (facet.name !== 'language') return `FILTER(${valueTest(condition, '?work', facet, `work${index}`)})`;
    const realm = query.context === 'global' ? null : query.context.realm;
    const selected = realm ? `GRAPH ${iri(GRAPHS.current)} { ?languageSlot rv:realm ${iri(realm)} ;
      rv:work ?work ; rv:selectionHead ?languageSelection }
      GRAPH ${iri(GRAPHS.revisions)} { ?languageSelection rv:contribution ?languageContribution ;
        rv:publicationDecision ?languageDecision ; rv:selectedDraft ?languageDraft }
      GRAPH ${iri(GRAPHS.current)} { ?languageContribution rv:publicationHead ?languageDecision }
      GRAPH ${iri(GRAPHS.revisions)} { ?languageDecision rv:disclosure rv:Public }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?languageDraft a rv:ErasedRevision } }`
      : `${publishedWork('?work', '?main')}
        BIND(${publicContribution} AS ?languageContribution)`;
    const values = (condition.any ?? condition.all ?? condition.none)! as string[];
    const exists = (chosen: string[]) => `EXISTS { ${selected}
      GRAPH ${iri(GRAPHS.current)} { ?languageContribution rv:language ?workLanguage }
      FILTER(?workLanguage IN (${chosen.map(lit).join(', ')})) }`;
    return `FILTER(${condition.all ? values.map(value => exists([value])).join(' && ')
      : `${condition.none ? '!' : ''}${exists(values)}`})`;
  }).join('\n');
}
