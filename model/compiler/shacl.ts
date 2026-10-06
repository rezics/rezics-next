import { Parser, Store, type Quad_Object, type Quad_Subject } from 'n3';
import {
  renderProfile,
  reservedNamespaces,
  type ProfileDefinition,
  type PropertyDefinition,
  type Term,
} from './ir.ts';
import { shapeRole, type EstablishedDeclaration } from './registry.ts';

const { sh, rdf, xsd } = reservedNamespaces;
const sources = new WeakMap<ProfileDefinition, string>();

/** Command metadata belongs beside Turtle, never in its constraint graph. */
export interface TurtleDeclaration extends EstablishedDeclaration {
  id: string;
}

/** Preserve the author's exact Turtle bytes in the admitted manifest. */
export function profileSource(profile: ProfileDefinition): string {
  return sources.get(profile) ?? renderProfile(profile);
}

/**
 * A bounded RDF-term converter, not a SHACL implementation. JSON remains the
 * existing node envelope: predicate arrays, no null, language value objects;
 * graph-wide class membership is checked by Jena. See https://www.w3.org/TR/shacl/.
 */
export function parseTurtleProfile(
  id: string,
  source: string,
  declaration?: TurtleDeclaration,
): ProfileDefinition {
  if (declaration && declaration.id !== id)
    throw new Error(`Turtle declaration differs from ${id}`);
  const prefixes: Record<string, string> = {};
  const parser = new Parser({ format: 'text/turtle' });
  const quads = parser.parse(source, undefined, (prefix, term) => {
    prefixes[prefix] = term.value;
  });
  const store = new Store(quads);
  const consumed = new Set<string>();
  const key = (subject: Quad_Subject) => `${subject.termType}:${subject.value}`;
  const named = (term: Quad_Object, location: string): string => {
    if (term.termType !== 'NamedNode')
      throw new Error(`${location} requires a simple IRI, received ${term.termType}`);
    return term.value;
  };
  const compact = (iri: string): Term => {
    const prefix = Object.entries(prefixes).find(
      ([, namespace]) =>
        iri.startsWith(namespace) && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(iri.slice(namespace.length)),
    );
    return prefix ? `${prefix[0]}:${iri.slice(prefix[1].length)}` : `<${iri}>`;
  };
  const fields = (subject: Quad_Subject, allowed: readonly string[]) => {
    consumed.add(key(subject));
    const values = new Map<string, Quad_Object[]>();
    for (const quad of store.getQuads(subject, null, null, null)) {
      const predicate = quad.predicate.value;
      if (!allowed.includes(predicate))
        throw new Error(`Unsupported SHACL construct ${compact(predicate)} on ${subject.value}`);
      values.set(predicate, [...(values.get(predicate) ?? []), quad.object]);
    }
    return values;
  };
  const one = (
    values: Map<string, Quad_Object[]>,
    predicate: string,
    required = false,
  ): Quad_Object | undefined => {
    const found = values.get(predicate) ?? [];
    if (found.length > 1 || (required && !found.length))
      throw new Error(`${compact(predicate)} requires exactly one value`);
    return found[0];
  };
  const count = (term: Quad_Object, predicate: string): number => {
    if (
      term.termType !== 'Literal' ||
      term.datatype.value !== `${xsd}integer` ||
      !/^\+?\d+$/.test(term.value) ||
      !Number.isSafeInteger(Number(term.value))
    ) {
      throw new Error(`${compact(predicate)} requires a nonnegative xsd:integer`);
    }
    return Number(term.value);
  };
  const boolean = (term: Quad_Object, predicate: string): boolean => {
    if (
      term.termType !== 'Literal' ||
      term.datatype.value !== `${xsd}boolean` ||
      !['true', 'false', '1', '0'].includes(term.value)
    )
      throw new Error(`${compact(predicate)} requires xsd:boolean`);
    return ['true', '1'].includes(term.value);
  };
  const property = (subject: Quad_Object): PropertyDefinition => {
    if (subject.termType !== 'BlankNode' && subject.termType !== 'NamedNode')
      throw new Error('sh:property requires a shape node');
    const predicates = [
      'path',
      'minCount',
      'maxCount',
      'hasValue',
      'nodeKind',
      'datatype',
      'uniqueLang',
      'minLength',
      'maxLength',
      'class',
    ];
    const values = fields(
      subject,
      predicates.map((name) => `${sh}${name}`),
    );
    const result: PropertyDefinition = {
      path: compact(named(one(values, `${sh}path`, true)!, 'sh:path')),
    };
    for (const name of ['minCount', 'maxCount', 'minLength', 'maxLength'] as const) {
      const value = one(values, `${sh}${name}`);
      if (value) result[name] = count(value, `${sh}${name}`);
    }
    for (const name of ['hasValue', 'nodeKind', 'datatype', 'class'] as const) {
      const value = one(values, `${sh}${name}`);
      if (value) result[name] = compact(named(value, `sh:${name}`));
    }
    if (result.nodeKind && named(one(values, `${sh}nodeKind`)!, 'sh:nodeKind') !== `${sh}IRI`) {
      throw new Error(`Unsupported sh:nodeKind ${result.nodeKind}`);
    }
    if (result.datatype) {
      const datatype = named(one(values, `${sh}datatype`)!, 'sh:datatype');
      if (
        ![
          `${xsd}string`,
          `${xsd}integer`,
          `${xsd}boolean`,
          `${xsd}dateTime`,
          `${rdf}langString`,
        ].includes(datatype)
      ) {
        throw new Error(`Unsupported sh:datatype ${result.datatype}`);
      }
      if (result.nodeKind || result.class || result.hasValue)
        throw new Error('Cannot lower an IRI constraint with sh:datatype');
    }
    const unique = one(values, `${sh}uniqueLang`);
    if (unique) {
      result.uniqueLang = boolean(unique, `${sh}uniqueLang`);
      if (
        result.uniqueLang &&
        (!result.datatype ||
          named(one(values, `${sh}datatype`)!, 'sh:datatype') !== `${rdf}langString`)
      ) {
        throw new Error('sh:uniqueLang requires the language-string JSON mapping');
      }
    }
    if (result.maxCount === 0 && result.hasValue)
      throw new Error('sh:hasValue conflicts with sh:maxCount 0');
    return result;
  };
  const nodes = store.getQuads(null, `${rdf}type`, `${sh}NodeShape`, null);
  const shapes = nodes.map(({ subject }) => {
    if (subject.termType !== 'NamedNode')
      throw new Error('Turtle profiles require a named NodeShape');
    const values = fields(subject, [`${rdf}type`, `${sh}property`, `${sh}closed`]);
    if (named(one(values, `${rdf}type`, true)!, 'rdf:type') !== `${sh}NodeShape`)
      throw new Error('Expected sh:NodeShape');
    const closed = one(values, `${sh}closed`);
    const role = shapeRole(id, subject.value);
    return {
      iri: subject.value,
      properties: (values.get(`${sh}property`) ?? []).map(property),
      ...(closed && boolean(closed, `${sh}closed`) ? { closed: true as const } : {}),
      ...(declaration?.canonical?.[role] ? { canonical: declaration.canonical[role] } : {}),
    };
  });
  for (const quad of quads) {
    if (!consumed.has(key(quad.subject)))
      throw new Error(
        `Unsupported SHACL construct ${compact(quad.predicate.value)} on ${quad.subject.value}`,
      );
  }
  for (const role of Object.keys(declaration?.canonical ?? {})) {
    if (!shapes.some((shape) => shapeRole(id, shape.iri) === role))
      throw new Error(`${id} declares an unknown canonical role ${role}`);
  }
  const profile: ProfileDefinition = {
    id,
    comments: [],
    prefixes: Object.entries(prefixes),
    layout: 'compact',
    shapes,
    ...(declaration?.binding ? { binding: declaration.binding } : {}),
  };
  // Reuse the DSL's namespace, identity and cardinality invariants for both sources.
  renderProfile(profile);
  sources.set(profile, source);
  return profile;
}
