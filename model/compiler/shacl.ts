import { Parser, Store, type Quad_Object, type Quad_Subject } from 'n3';
import {
  profileSnapshot,
  reservedNamespaces,
  type BindingRequirement,
  type CanonicalFocus,
  type ProfileDefinition,
  type PropertyDefinition,
  type Term,
} from './ir.ts';
import { shapeRole } from './registry.ts';

const { sh, rdf, xsd } = reservedNamespaces;
const sources = new WeakMap<ProfileDefinition, string>();

/** Only the loaded Turtle author has custody of its exact source bytes. */
export const isTurtleProfile = (profile: ProfileDefinition): boolean => sources.has(profile);

/** Command metadata belongs beside Turtle, never in its constraint graph. */
export interface TurtleDeclaration {
  id: string;
  /** Canonical routing keyed by shape role. */
  canonical?: Readonly<Record<string, CanonicalFocus>>;
  binding?: BindingRequirement;
}

/** Preserve the author's exact Turtle bytes in the admitted manifest. */
export function profileSource(profile: ProfileDefinition): string {
  const source = sources.get(profile);
  if (source === undefined) throw new Error(`${profile.id} has no captured Turtle source`);
  return source;
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
    if (Object.hasOwn(prefixes, prefix)) throw new Error(`${id} has duplicate prefixes`);
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
  const string = (term: Quad_Object, location: string): string => {
    if (term.termType !== 'Literal' || term.datatype.value !== `${xsd}string`)
      throw new Error(`${location} requires xsd:string`);
    return term.value;
  };
  const integer = (term: Quad_Object, predicate: string): number => {
    if (
      term.termType !== 'Literal' ||
      term.datatype.value !== `${xsd}integer` ||
      !/^[+-]?\d+$/.test(term.value) ||
      !Number.isSafeInteger(Number(term.value))
    )
      throw new Error(`${compact(predicate)} requires a safe xsd:integer`);
    return Number(term.value);
  };
  // Integer fixed values use JSON's exact safe-integer envelope. Other typed
  // literals fail instead of losing their datatype or language tag.
  const fixed = (term: Quad_Object, location: string, allowInteger = false): Term => {
    if (term.termType === 'NamedNode') return compact(term.value);
    if (allowInteger && term.termType === 'Literal' && term.datatype.value === `${xsd}integer`)
      return `${integer(term, `${sh}hasValue`)}`;
    return JSON.stringify(string(term, location)) as Term;
  };
  const list = (head: Quad_Object, location: string): Quad_Object[] => {
    const items: Quad_Object[] = [];
    const visited = new Set<string>();
    let current = head;
    while (!(current.termType === 'NamedNode' && current.value === `${rdf}nil`)) {
      if (current.termType !== 'BlankNode' && current.termType !== 'NamedNode')
        throw new Error(`${location} requires an RDF list ending in rdf:nil`);
      if (visited.has(key(current))) throw new Error(`Cyclic ${location} RDF list`);
      // A source enum is bounded independently of the parser and input graph.
      if (items.length >= 256) throw new Error(`${location} RDF list exceeds 256 members`);
      visited.add(key(current));
      const values = fields(current, [`${rdf}first`, `${rdf}rest`]);
      items.push(one(values, `${rdf}first`, true)!);
      current = one(values, `${rdf}rest`, true)!;
    }
    if (!items.length) throw new Error(`Empty ${location} RDF list`);
    return items;
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
      'pattern',
      'minInclusive',
      'maxInclusive',
      'in',
      'languageIn',
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
    for (const name of ['nodeKind', 'datatype', 'class'] as const) {
      const value = one(values, `${sh}${name}`);
      if (value) result[name] = compact(named(value, `sh:${name}`));
    }
    const hasValue = one(values, `${sh}hasValue`);
    if (hasValue) result.hasValue = fixed(hasValue, 'sh:hasValue', true);
    const enumeration = one(values, `${sh}in`);
    if (enumeration) {
      result.in = list(enumeration, 'sh:in').map((term) => fixed(term, 'sh:in member'));
      if (
        result.in.some((term) => term.startsWith('"')) &&
        result.in.some((term) => !term.startsWith('"'))
      )
        throw new Error('sh:in requires one JSON mapping for every member');
    }
    const languages = one(values, `${sh}languageIn`);
    if (languages)
      result.languageIn = list(languages, 'sh:languageIn').map((term) =>
        string(term, 'sh:languageIn member'),
      );
    const pattern = one(values, `${sh}pattern`);
    if (pattern) {
      result.pattern = string(pattern, 'sh:pattern');
      try {
        new RegExp(result.pattern);
      } catch {
        throw new Error('sh:pattern requires a valid JSON regular expression');
      }
    }
    for (const name of ['minInclusive', 'maxInclusive'] as const) {
      const value = one(values, `${sh}${name}`);
      if (value) result[name] = integer(value, `${sh}${name}`);
    }
    const nodeKind = result.nodeKind && named(one(values, `${sh}nodeKind`)!, 'sh:nodeKind');
    if (nodeKind && nodeKind !== `${sh}IRI` && nodeKind !== `${sh}IRIOrLiteral`) {
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
      if (result.nodeKind || result.class || hasValue?.termType === 'NamedNode')
        throw new Error('Cannot lower sh:nodeKind with sh:datatype');
    }
    const datatype = result.datatype && named(one(values, `${sh}datatype`)!, 'sh:datatype');
    const fixedValues = [...(result.in ?? []), ...(result.hasValue ? [result.hasValue] : [])];
    const literalValues = fixedValues.some((value) => value.startsWith('"'));
    const integerValue = result.hasValue !== undefined && /^-?\d+$/.test(result.hasValue);
    const iriValues = fixedValues.some((value) => !value.startsWith('"') && !/^-?\d+$/.test(value));
    if (
      (literalValues && iriValues) ||
      (literalValues &&
        (result.nodeKind || result.class || (datatype && datatype !== `${xsd}string`))) ||
      (iriValues && datatype) ||
      (integerValue &&
        (result.nodeKind || result.class || (datatype && datatype !== `${xsd}integer`)))
    )
      throw new Error('Fixed values conflict with the property JSON mapping');
    if (result.languageIn && datatype !== `${rdf}langString`)
      throw new Error('sh:languageIn requires the language-string JSON mapping');
    if (
      (result.minInclusive !== undefined || result.maxInclusive !== undefined) &&
      datatype !== `${xsd}integer`
    )
      throw new Error('Numeric bounds require the xsd:integer JSON mapping');
    if (
      result.pattern !== undefined &&
      datatype &&
      ![`${xsd}string`, `${rdf}langString`].includes(datatype)
    )
      throw new Error('sh:pattern requires a string JSON mapping');
    // The current lowerer emits fixed values instead of their other facets.
    // Refuse combinations it cannot preserve rather than silently widening them.
    if (
      fixedValues.length &&
      (result.pattern !== undefined ||
        result.minLength !== undefined ||
        result.maxLength !== undefined ||
        result.minInclusive !== undefined ||
        result.maxInclusive !== undefined)
    )
      throw new Error('Cannot lower fixed values together with facets');
    // The mixed mapping emits Type.Unknown() instead of enum items.
    if (result.in && nodeKind === `${sh}IRIOrLiteral`)
      throw new Error('Cannot lower sh:in with sh:IRIOrLiteral');
    // Fixed enums lower to array items plus contains. The single-item shortcut
    // also preserves the enum only when its required value is a member.
    // Integer mappings bypass enum items in the current lowerer.
    if (result.in && hasValue && (integerValue || !result.in.includes(result.hasValue!)))
      throw new Error('Cannot lower sh:in together with sh:hasValue for this JSON mapping');
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
    const values = fields(subject, [`${rdf}type`, `${sh}property`, `${sh}closed`, `${sh}or`]);
    if (named(one(values, `${rdf}type`, true)!, 'rdf:type') !== `${sh}NodeShape`)
      throw new Error('Expected sh:NodeShape');
    const closed = one(values, `${sh}closed`);
    const disjunction = one(values, `${sh}or`);
    const branches =
      disjunction &&
      list(disjunction, 'sh:or').map((group) => {
        if (group.termType !== 'BlankNode' && group.termType !== 'NamedNode')
          throw new Error('sh:or requires local property groups');
        const properties = fields(group, [`${sh}property`]).get(`${sh}property`) ?? [];
        if (!properties.length || properties.length > 256)
          throw new Error('sh:or requires 1 to 256 properties per local group');
        return properties.map(property);
      });
    if (branches && branches.length < 2)
      throw new Error('sh:or requires at least two local property groups');
    const role = shapeRole(id, subject.value);
    return {
      iri: subject.value,
      properties: (values.get(`${sh}property`) ?? []).map(property),
      ...(branches ? { or: branches } : {}),
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
    prefixes: Object.entries(prefixes),
    shapes,
    ...(declaration?.binding ? { binding: declaration.binding } : {}),
  };
  validateProfile(profile);
  // Consumer inspection cannot change the lowering basis tied to these bytes.
  profileSnapshot(profile);
  sources.set(profile, source);
  return profile;
}

function knownFields(value: object, allowed: readonly string[], location: string): void {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected) throw new Error(`Unsupported profile field ${unexpected} on ${location}`);
}

function validateProperty(property: PropertyDefinition): void {
  knownFields(property, ['path', 'minCount', 'maxCount', 'nodeKind', 'class', 'datatype', 'pattern',
    'in', 'languageIn', 'uniqueLang', 'minLength', 'maxLength', 'minInclusive', 'maxInclusive',
    'hasValue'], `${property.path}`);
  if (property.minCount !== undefined && (!Number.isInteger(property.minCount) || property.minCount < 0)) {
    throw new Error(`Invalid minCount on ${property.path}`);
  }
  if (property.maxCount !== undefined && (!Number.isInteger(property.maxCount) || property.maxCount < 0)) {
    throw new Error(`Invalid maxCount on ${property.path}`);
  }
  if (property.minCount !== undefined && property.maxCount !== undefined && property.minCount > property.maxCount) {
    throw new Error(`minCount exceeds maxCount on ${property.path}`);
  }
  if (property.minLength !== undefined && property.maxLength !== undefined && property.minLength > property.maxLength) {
    throw new Error(`minLength exceeds maxLength on ${property.path}`);
  }
  if (property.minInclusive !== undefined && property.maxInclusive !== undefined && property.minInclusive > property.maxInclusive) {
    throw new Error(`minInclusive exceeds maxInclusive on ${property.path}`);
  }
  if (property.in !== undefined && !property.in.length) throw new Error(`Empty sh:in on ${property.path}`);
  if (property.languageIn !== undefined && !property.languageIn.length) {
    throw new Error(`Empty sh:languageIn on ${property.path}`);
  }
}

function validateProfile(profile: ProfileDefinition): void {
  knownFields(profile, ['id', 'prefixes', 'shapes', 'binding'], profile.id);
  if (profile.binding) knownFields(profile.binding, ['required', 'optional', 'roles', 'demandedBy'], `${profile.id} binding`);
  if (!/^[a-z0-9-]+-v\d+$/.test(profile.id)) throw new Error(`Invalid profile ID: ${profile.id}`);
  if (!profile.shapes.length || new Set(profile.shapes.map(shape => shape.iri)).size !== profile.shapes.length) {
    throw new Error(`${profile.id} must declare distinct named NodeShapes`);
  }
  const prefixNames = new Set(profile.prefixes.map(([name]) => name));
  if (prefixNames.size !== profile.prefixes.length) throw new Error(`${profile.id} has duplicate prefixes`);
  if (!prefixNames.has('sh')) throw new Error(`${profile.id} must declare the sh prefix`);
  for (const [name, iri] of profile.prefixes) {
    const reserved = reservedNamespaces[name as keyof typeof reservedNamespaces];
    if (reserved && iri !== reserved) throw new Error(`${profile.id} binds ${name} to ${iri}, expected ${reserved}`);
  }
  for (const shape of profile.shapes) {
    knownFields(shape, ['iri', 'properties', 'closed', 'or', 'canonical'], shape.iri);
    if (shape.canonical) {
      knownFields(shape.canonical, ['types', 'when'], `${shape.iri} canonical focus`);
      for (const condition of shape.canonical.when ?? []) {
        knownFields(condition, ['path', 'value'], `${shape.iri} discriminator`);
      }
    }
    if (!shape.iri.startsWith(`https://rezics.com/definition/${profile.id}/`)) {
      throw new Error(`${profile.id} has a shape outside its definition namespace`);
    }
    if (!shape.properties.length) throw new Error(`${shape.iri} must have properties`);
    if (shape.or && (shape.or.length < 2 || shape.or.some(branch => !branch.length))) {
      throw new Error('sh:or requires at least two nonempty property groups');
    }
    for (const property of shape.properties) validateProperty(property);
    for (const branch of shape.or ?? []) for (const property of branch) validateProperty(property);
  }
}
