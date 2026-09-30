import { createHash } from 'node:crypto';
import { reservedNamespaces, type Term } from './ir.ts';
import { expand } from './outputs.ts';

// A Facet is one admitted, versioned path from a queried Resource to the values a
// reader filters by (docs/contracts/queries.md). Facets define queries only: no
// stored data references them, so they compile to Main's registry, never to shapes
// or to the manifest the Fuseki command module loads.

/** Interface locales (apps/web/i18n/define.ts); an admitted Facet is labelled in each. */
export const facetLocales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
type FacetLocale = typeof facetLocales[number];

/** `any`, `all` and `none` compare the path's values with a Condition's; `range` bounds one ordered value. */
const facetOperators = ['any', 'all', 'none', 'range'] as const;
type FacetOperator = typeof facetOperators[number];

const facetQualifiers = ['interpretation', 'applicability'] as const;
type FacetQualifier = typeof facetQualifiers[number];

type FacetValueDomain =
  /** IRIs of Resources typed with `class`. */
  | { kind: 'class'; class: Term }
  /** skos:Concept IRIs, from `scheme` when given. */
  | { kind: 'concept'; scheme?: Term }
  /** Literals of `datatype`, matching `pattern` and within the inclusive lexical bounds when given. */
  | { kind: 'datatype'; datatype: Term; pattern?: string; min?: string; max?: string }
  /** Source identities without a native IRI, qualified by provider and namespace. */
  | { kind: 'external'; provider: string; namespace: string }
  /** Role IRIs of the relation definition a Condition binds. */
  | { kind: 'role' }
  /** Exact DefinitionRefs. */
  | { kind: 'definition' };

type FacetStep =
  /** One triple of the current graph (or of the exact revision reached, with `graph`), walked from
   * subject to object, or back when `inverse`. The node reached has one of `types` on its current head. */
  | { kind: 'triple'; predicate: Term; inverse?: true; graph?: 'revisions'; types?: readonly Term[] }
  /** The Main Version's public selection in the Query's Context: a Realm's local selection, else Main's default. */
  | { kind: 'selection' }
  /** Count of this unit over the Work's published composition. */
  | { kind: 'units'; unit: Term }
  /** The Work's current, unerased primary credits in `role`: a native Agent, or a human-confirmed source author. */
  | { kind: 'credit'; role: string }
  /** Objects of Statements about the node reached, accepted in the Query's Context. A term left out
   * is the Condition's `predicate` or `relationDefinition` parameter. */
  | { kind: 'statement'; predicate?: Term; relation?: Term }
  /** Co-participants in active occurrences of the bound relation where the node reached, or its Main
   * Version, takes the bound role. A `where` group binds its Conditions to one such occurrence. */
  | { kind: 'occurrence' }
  /** The node's aggregate in the bound rating Context, which must fix these policies and supplies the question. */
  | { kind: 'rating'; target: Term; cadence: Term; population: Term; aggregation: Term;
    scale: { min: number; max: number } };

interface FacetParameter {
  /** A Condition binds it as `bind: { [key]: value }`. */
  key: string;
  value: FacetValueDomain;
}

/** Admission bounds, refined in place; a changed meaning is a new version instead. */
interface FacetCost {
  /** Values, or range bounds, one Condition may name. */
  maxValues: number;
  /** Graph reads one Condition may add to a Query, each batched over its bounded candidates. */
  graphReads: number;
  /** Conditions one `where` group of an occurrence Facet may hold. */
  nested?: number;
}

export interface FacetDefinition {
  /** The camelCase name Conditions use; stable across versions. */
  name: string;
  /** A new meaning is a new version; older versions stay admitted for exact DefinitionRefs. */
  version: number;
  labels: Readonly<Record<FacetLocale, string>>;
  /** Where a Condition starts: the queried Resource, or within an occurrence group, the bound
   * co-participant or its participation. */
  appliesTo: 'resource' | 'participant' | 'participation';
  /** Class of the node the path starts from. */
  subject: Term;
  path: readonly FacetStep[];
  /** Alternative value domains. */
  values: readonly FacetValueDomain[];
  operators: readonly FacetOperator[];
  /** `global`: one value in every Context. `context`: the Query's Context (Global or a Realm's)
   * decides, through its accepted Statements, local publication selection or rating population. */
  source: 'global' | 'context';
  parameters?: readonly FacetParameter[];
  /** Statement meaning qualifiers a Condition may add. */
  qualifiers?: readonly FacetQualifier[];
  /** The path ends in an occurrence; Conditions may group Conditions bound to it under `where`. */
  occurrence?: true;
  cost: FacetCost;
}

const namespaces = new Map<string, string>(Object.entries(reservedNamespaces));
const orderedDatatypes = new Set(['xsd:decimal', 'xsd:integer', 'xsd:date', 'xsd:dateTime']);
const kebab = (name: string) => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);

export const facetId = (facet: Pick<FacetDefinition, 'name' | 'version'>): string =>
  `facet-${kebab(facet.name)}-v${facet.version}`;
export const facetRef = (facet: Pick<FacetDefinition, 'name' | 'version'>): string =>
  `https://rezics.com/definition/${facetId(facet)}`;

function knownFields(value: object, allowed: readonly string[], location: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected) throw new Error(`Unsupported Facet field ${unexpected} on ${location}`);
}

function iri(term: Term, location: string): string {
  const value = expand(term, namespaces);
  if (!/^(?:https?:\/\/|urn:)[^\s<>"{}|\\^`]+$/.test(value)) throw new Error(`${location} is not an IRI: ${term}`);
  return value;
}

function domain(value: FacetValueDomain, location: string): Record<string, unknown> {
  switch (value.kind) {
    case 'class':
      knownFields(value, ['kind', 'class'], location);
      return { kind: 'class', class: iri(value.class, location) };
    case 'concept':
      knownFields(value, ['kind', 'scheme'], location);
      return { kind: 'concept', ...(value.scheme ? { scheme: iri(value.scheme, location) } : {}) };
    case 'datatype': {
      knownFields(value, ['kind', 'datatype', 'pattern', 'min', 'max'], location);
      const bounded = value.min !== undefined || value.max !== undefined;
      if (bounded && !['xsd:decimal', 'xsd:integer'].includes(value.datatype)) {
        throw new Error(`${location} bounds a non-numeric datatype`);
      }
      for (const bound of [value.min, value.max]) {
        if (bound !== undefined && !/^-?\d+(?:\.\d+)?$/.test(bound)) throw new Error(`${location} has a bound that is not a decimal`);
      }
      if (value.min !== undefined && value.max !== undefined && Number(value.min) > Number(value.max)) {
        throw new Error(`${location} has min above max`);
      }
      if (value.pattern !== undefined) new RegExp(value.pattern, 'u');
      return { kind: 'datatype', datatype: iri(value.datatype, location),
        ...(value.pattern === undefined ? {} : { pattern: value.pattern }),
        ...(value.min === undefined ? {} : { min: value.min }), ...(value.max === undefined ? {} : { max: value.max }) };
    }
    case 'external':
      knownFields(value, ['kind', 'provider', 'namespace'], location);
      if (!/^[a-z][a-z0-9-]*$/.test(value.provider) || !/^[a-z][a-z0-9-]*$/.test(value.namespace)) {
        throw new Error(`${location} has an invalid source identity`);
      }
      return { kind: 'external', provider: value.provider, namespace: value.namespace };
    case 'role':
    case 'definition':
      knownFields(value, ['kind'], location);
      return { kind: value.kind };
    default:
      throw new Error(`${location} has an unknown value domain`);
  }
}

function step(value: FacetStep, location: string): Record<string, unknown> {
  switch (value.kind) {
    case 'triple':
      knownFields(value, ['kind', 'predicate', 'inverse', 'graph', 'types'], location);
      if (value.graph !== undefined && value.graph !== 'revisions') throw new Error(`${location} names an unknown graph`);
      if (value.types !== undefined && !value.types.length) throw new Error(`${location} has empty types`);
      return { kind: 'triple', predicate: iri(value.predicate, location), ...(value.inverse ? { inverse: true } : {}),
        ...(value.graph ? { graph: value.graph } : {}),
        ...(value.types ? { types: value.types.map(type => iri(type, location)) } : {}) };
    case 'selection':
    case 'occurrence':
      knownFields(value, ['kind'], location);
      return { kind: value.kind };
    case 'units':
      knownFields(value, ['kind', 'unit'], location);
      return { kind: 'units', unit: iri(value.unit, location) };
    case 'credit':
      knownFields(value, ['kind', 'role'], location);
      if (!/^[a-z]+$/.test(value.role)) throw new Error(`${location} has an invalid credit role`);
      return { kind: 'credit', role: value.role };
    case 'statement':
      knownFields(value, ['kind', 'predicate', 'relation'], location);
      return { kind: 'statement', ...(value.predicate ? { predicate: iri(value.predicate, location) } : {}),
        ...(value.relation ? { relation: iri(value.relation, location) } : {}) };
    case 'rating': {
      knownFields(value, ['kind', 'target', 'cadence', 'population', 'aggregation', 'scale'], location);
      knownFields(value.scale, ['min', 'max'], `${location} scale`);
      const { min, max } = value.scale;
      if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max) throw new Error(`${location} has an invalid scale`);
      return { kind: 'rating', target: iri(value.target, location), cadence: iri(value.cadence, location),
        population: iri(value.population, location), aggregation: iri(value.aggregation, location),
        scale: { min, max } };
    }
    default:
      throw new Error(`${location} has an unknown path step`);
  }
}

/** Parameters each path step needs a Condition to bind. */
function neededParameters(path: readonly FacetStep[]): string[] {
  return path.flatMap(item => item.kind === 'statement'
    ? [...item.predicate ? [] : ['predicate'], ...item.relation ? [] : ['relationDefinition']]
    : item.kind === 'occurrence' ? ['definition', 'role'] : item.kind === 'rating' ? ['ratingContext'] : []);
}

/** The Facet as served, every term expanded; `digest` covers its meaning but not its labels or cost. */
export function compileFacet(facet: FacetDefinition): Record<string, unknown> {
  const id = /^[a-z][a-zA-Z0-9]{0,31}$/.test(facet.name) && Number.isInteger(facet.version) && facet.version > 0
    ? facetId(facet) : null;
  if (!id) throw new Error(`Invalid Facet name or version: ${facet.name} v${facet.version}`);
  knownFields(facet, ['name', 'version', 'labels', 'appliesTo', 'subject', 'path', 'values', 'operators',
    'source', 'parameters', 'qualifiers', 'occurrence', 'cost'], id);
  knownFields(facet.labels, facetLocales, `${id} labels`);
  for (const locale of facetLocales) {
    const label = facet.labels[locale];
    if (typeof label !== 'string' || !label || label !== label.trim() || label.length > 40
      || /[\u0000-\u001f\u007f]/u.test(label)) throw new Error(`${id} needs a ${locale} label`);
  }
  if (!['resource', 'participant', 'participation'].includes(facet.appliesTo)) throw new Error(`${id} applies nowhere`);
  if (!['global', 'context'].includes(facet.source)) throw new Error(`${id} has no Statement source`);
  if (!facet.path.length) throw new Error(`${id} has no path`);
  const path = facet.path.map((item, index) => step(item, `${id} path step ${index + 1}`));
  if (!facet.values.length) throw new Error(`${id} has no value domain`);
  const values = facet.values.map((item, index) => domain(item, `${id} value domain ${index + 1}`));
  if (!facet.operators.length || new Set(facet.operators).size !== facet.operators.length
    || facet.operators.some(operator => !facetOperators.includes(operator))) {
    throw new Error(`${id} has invalid operators`);
  }
  if (facet.operators.includes('range') && facet.values.some(value =>
    value.kind !== 'datatype' || !orderedDatatypes.has(value.datatype))) {
    throw new Error(`${id} ranges over unordered values`);
  }
  const parameters = (facet.parameters ?? []).map((parameter, index) => {
    knownFields(parameter, ['key', 'value'], `${id} parameter ${index + 1}`);
    return { key: parameter.key, value: domain(parameter.value, `${id} parameter ${parameter.key}`) };
  });
  const keys = parameters.map(parameter => parameter.key);
  const needed = neededParameters(facet.path);
  if (new Set(keys).size !== keys.length || [...keys].sort().join() !== [...needed].sort().join()) {
    throw new Error(`${id} parameters must be exactly those its path binds: ${needed.join(', ') || 'none'}`);
  }
  const qualifiers = facet.qualifiers ?? [];
  if (new Set(qualifiers).size !== qualifiers.length || qualifiers.some(item => !facetQualifiers.includes(item))
    || (qualifiers.length && !facet.path.some(item => item.kind === 'statement'))) {
    throw new Error(`${id} qualifies no Statement`);
  }
  const rating = facet.path.find(item => item.kind === 'rating');
  if (rating && facet.values.some(value => value.kind !== 'datatype'
    || value.min !== String(rating.scale.min) || value.max !== String(rating.scale.max))) {
    throw new Error(`${id} values must span its rating scale`);
  }
  if (facet.path.some(item => item.kind === 'units')
    && (facet.path.length !== 1 || facet.appliesTo !== 'resource'
      || facet.subject !== 'schema:CreativeWork' || facet.source !== 'global'
      || facet.operators.join() !== 'range' || facet.values.length !== 1
      || facet.values[0]?.kind !== 'datatype' || facet.values[0].datatype !== 'xsd:integer'
      || facet.values[0].min !== '0')) {
    throw new Error(`${id} units must count nonnegative integers over a Work's composition`);
  }
  const occurrence = facet.path.at(-1)?.kind === 'occurrence';
  if (!!facet.occurrence !== occurrence || facet.path.slice(0, -1).some(item => item.kind === 'occurrence')
    || (occurrence && facet.appliesTo !== 'resource')) {
    throw new Error(`${id} must end in its only occurrence step exactly when it groups occurrence Conditions`);
  }
  knownFields(facet.cost, ['maxValues', 'graphReads', 'nested'], `${id} cost`);
  const { maxValues, graphReads, nested } = facet.cost;
  if (!Number.isInteger(maxValues) || maxValues < 1 || !Number.isInteger(graphReads) || graphReads < 0
    || (nested === undefined) === occurrence || (nested !== undefined && (!Number.isInteger(nested) || nested < 1))) {
    throw new Error(`${id} has an invalid cost`);
  }
  const meaning = { name: facet.name, version: facet.version, appliesTo: facet.appliesTo,
    subject: iri(facet.subject, `${id} subject`), path, values,
    operators: facetOperators.filter(operator => facet.operators.includes(operator)),
    source: facet.source, parameters, qualifiers: facetQualifiers.filter(item => qualifiers.includes(item)),
    occurrence };
  return { id: facetRef(facet), ...meaning, labels: Object.fromEntries(facetLocales.map(locale =>
    [locale, facet.labels[locale]])), cost: { maxValues, graphReads, ...(occurrence ? { nested } : {}) },
  digest: createHash('sha256').update(JSON.stringify(meaning)).digest('hex') };
}

/** Check the admitted set and render `packages/model/src/generated/facets.ts`. */
export function renderFacetRegistry(facets: readonly FacetDefinition[]): string {
  const compiled = facets.map(compileFacet)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)) || Number(a.version) - Number(b.version));
  const versions = new Map<string, number[]>();
  for (const facet of compiled) versions.set(String(facet.name), [...versions.get(String(facet.name)) ?? [], Number(facet.version)]);
  for (const [name, list] of versions) {
    if (list.some((version, index) => version !== index + 1)) throw new Error(`Facet ${name} versions must run 1..n`);
  }
  const current = compiled.filter(facet => versions.get(String(facet.name))!.at(-1) === facet.version);
  for (const locale of facetLocales) {
    const labels = current.map(facet => (facet.labels as Record<FacetLocale, string>)[locale].toLocaleLowerCase(locale));
    if (new Set(labels).size !== labels.length) throw new Error(`Two current Facets share a ${locale} label`);
  }
  const registry = Object.fromEntries(compiled.map(facet => [facet.id,
    { ...facet, current: current.includes(facet) }]));
  const body = JSON.stringify(registry, null, 2);
  return '// Generated by task gen from authored TypeScript Facets. Do not edit.\n'
    + `export const facetLocales = ${JSON.stringify(facetLocales)} as const;\n`
    + '/** Admitted Facets by DefinitionRef, every term expanded. Main serves them at GET /v1/facets. */\n'
    + `export const facetRegistry = ${body} as const;\n`
    + 'export type FacetRef = keyof typeof facetRegistry;\n'
    + '/** Changes whenever any admitted Facet does. */\n'
    + `export const facetRegistryDigest = ${JSON.stringify(createHash('sha256').update(body).digest('hex'))};\n`;
}
