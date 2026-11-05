import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { releaseDigest, valueSchema, type PropertyDefinition, type Release, type TypeDefinition } from './index.ts';

/**
 * A term extension adds custom relation types to one Context. It holds item properties only, refers to the Global
 * release for types and qualifiers, and is addressed by the digest of its canonical form.
 */
export const EXTENSION_FORMAT = 'https://rezics.com/definitions/extension/1';
export const EXTENSION_LIMITS = { terms: 64, domain: 16, mappings: 8, bytes: 512 * 1024 } as const;
export const EXTENSION_GROUPS = ['order', 'derivation', 'world', 'membership', 'association'] as const;
export const EXTENSION_MAPPINGS = ['owl:equivalentProperty', 'skos:exactMatch', 'skos:closeMatch'] as const;
/** Qualifier vocabulary a term may use: position, the part or range a statement applies to, spoiler level, note. */
export const EXTENSION_QUALIFIER_IRIS = [
  'http://schema.org/position',
  'https://rezics.com/vocab/appliesToPart',
  'https://rezics.com/vocab/spoilerLevel',
  'https://rezics.com/vocab/note',
] as const;

export type ExtensionGroup = (typeof EXTENSION_GROUPS)[number];
export type ExtensionMapping = { predicate: (typeof EXTENSION_MAPPINGS)[number]; iri: string };
export type TermDefinition = {
  description: Record<string, string>;
  labels: Record<string, string>;
  domain: string[];
  targets: string[];
  multivalued: boolean;
  qualifiers?: string[];
  mappings?: ExtensionMapping[];
  relation: {
    group: ExtensionGroup;
    inverse?: string;
    inverseLabels?: Record<string, string>;
    symmetric?: true;
    acyclic?: true;
    order?: 'position' | 'date' | 'name';
  };
  deprecated?: { replacedBy: string };
};
export type Extension = { format: typeof EXTENSION_FORMAT; context: string; terms: Record<string, TermDefinition> };
export type ExtensionViolation = {
  pointer: string;
  code: 'required' | 'unknown_field' | 'invalid_type' | 'invalid_format' | 'out_of_range' | 'unsupported';
};

const own = (value: object, key: string) => Object.hasOwn(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const at = (pointer: string, key: string | number) =>
  `${pointer}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
const LOCAL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]+$/;

/** The CURIE prefix that scopes a Context's terms. */
export function termPrefix(context: string): string {
  return `c${context.replaceAll('-', '')}`;
}

/** The Context a term CURIE belongs to, or null when it is not a Context term. */
export function termContext(curie: string): string | null {
  const match = /^c([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12}):[^\s:]+$/.exec(curie);
  return match ? match.slice(1).join('-') : null;
}

export function termIri(context: string, localName: string): string {
  return `https://rezics.com/contexts/${context}/terms/${localName}`;
}

export function extensionDigest(extension: Extension): string {
  return `sha256:${createHash('sha256').update(canonicalize(extension)!, 'utf8').digest('hex')}`;
}

export function releaseHasTerm(release: Release, curie: string): boolean {
  return own(release.properties, curie);
}

function targetNames(base: Release): Set<string> {
  const names = new Set(Object.keys(base.types));
  for (const type of Object.values(base.types)) for (const name of type.bases) names.add(name);
  return names;
}

function qualifierKeys(base: Release): Set<string> {
  const iris = new Set<string>(EXTENSION_QUALIFIER_IRIS);
  return new Set(
    Object.entries(base.properties)
      .filter(([, property]) => iris.has(property.iri) && !property.relation)
      .map(([key]) => key),
  );
}

function sortedUnique(values: unknown[]): boolean {
  return values.every(
    (item, index) => typeof item === 'string' && (index === 0 || (values[index - 1] as string) < item),
  );
}

export type ExtensionContext = {
  /** The Context the extension is published for. */
  context: string;
  /**
   * Active extensions of the other Contexts, by Context id. Only Global's extension may carry terms of another
   * Context, and only a copy of a term that Context's active extension holds.
   */
  sources?: ReadonlyMap<string, Extension>;
};

/** Structural and semantic violations of an extension against the release it extends; empty when it is valid. */
export function validateExtension(value: unknown, base: Release, scope: ExtensionContext): ExtensionViolation[] {
  const found = new Map<string, ExtensionViolation['code']>();
  const add = (pointer: string, code: ExtensionViolation['code'] = 'invalid_format') => {
    if (!found.has(pointer)) found.set(pointer, code);
  };
  const result = () =>
    [...found]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 64)
      .map(([pointer, code]) => ({ pointer, code }));
  try {
    if (!record(value)) return [{ pointer: '', code: 'invalid_type' }];
    if (Buffer.byteLength(JSON.stringify(value)) > EXTENSION_LIMITS.bytes)
      return [{ pointer: '', code: 'out_of_range' }];
    canonicalize(value);
    for (const key of Object.keys(value))
      if (!['format', 'context', 'terms'].includes(key)) add(at('', key), 'unknown_field');
    if (value.format !== EXTENSION_FORMAT) add('/format', own(value, 'format') ? 'invalid_format' : 'required');
    if (value.context !== scope.context) add('/context', own(value, 'context') ? 'invalid_format' : 'required');
    if (!record(value.terms)) {
      add('/terms', own(value, 'terms') ? 'invalid_type' : 'required');
      return result();
    }
    const terms = value.terms;
    const keys = Object.keys(terms);
    if (keys.length > EXTENSION_LIMITS.terms) {
      add('/terms', 'out_of_range');
      return result();
    }
    const names = targetNames(base);
    const qualifiers = qualifierKeys(base);
    const own32 = termPrefix(scope.context);
    const isGlobal = scope.context === '00000000-0000-8000-8000-000000000000';
    const inverses = new Set<string>();
    const languages = (field: unknown, pointer: string, limit: number) => {
      if (field === undefined) return add(pointer, 'required');
      if (!record(field)) return add(pointer, 'invalid_type');
      if (!own(field, 'en')) add(at(pointer, 'en'), 'required');
      for (const [language, text] of Object.entries(field)) {
        if (!LANGUAGE.test(language)) add(at(pointer, language));
        else if (typeof text !== 'string') add(at(pointer, language), 'invalid_type');
        else if (text.length < 1 || text.trim() !== text) add(at(pointer, language));
        else if (text.length > limit) add(at(pointer, language), 'out_of_range');
      }
    };
    const strings = (
      field: unknown,
      pointer: string,
      member: (item: string) => boolean,
      limit: number,
      empty = false,
    ) => {
      if (field === undefined) return add(pointer, 'required');
      if (!Array.isArray(field)) return add(pointer, 'invalid_type');
      if (field.length > limit) return add(pointer, 'out_of_range');
      if (!empty && field.length === 0) return add(pointer, 'required');
      if (!sortedUnique(field)) return add(pointer, 'invalid_format');
      field.forEach((item, index) => {
        if (!member(item as string)) add(at(pointer, index));
      });
    };
    for (const key of keys) {
      const pointer = at('/terms', key);
      const term = terms[key];
      const [prefix, local] = key.split(':') as [string, string | undefined];
      const foreign = prefix !== own32;
      if (foreign && !isGlobal) add(pointer);
      if (!/^c[0-9a-f]{32}$/.test(prefix) || local === undefined || !LOCAL_NAME.test(local)) add(pointer);
      if (!record(term)) {
        add(pointer, 'invalid_type');
        continue;
      }
      if (foreign) {
        // Global adopts a community term as a copy: the same CURIE and body.
        const source = scope.sources?.get(termContext(key) ?? '')?.terms[key];
        if (!source || canonicalize(source) !== canonicalize(term)) add(pointer, 'unsupported');
        continue;
      }
      for (const member of Object.keys(term))
        if (
          ![
            'description',
            'labels',
            'domain',
            'targets',
            'multivalued',
            'qualifiers',
            'mappings',
            'relation',
            'deprecated',
          ].includes(member)
        )
          add(at(pointer, member), 'unknown_field');
      languages(term.description, at(pointer, 'description'), 2000);
      languages(term.labels, at(pointer, 'labels'), 256);
      strings(term.domain, at(pointer, 'domain'), (item) => own(base.types, item), EXTENSION_LIMITS.domain);
      strings(term.targets, at(pointer, 'targets'), (item) => names.has(item), 1024);
      if (typeof term.multivalued !== 'boolean')
        add(at(pointer, 'multivalued'), own(term, 'multivalued') ? 'invalid_type' : 'required');
      if (term.qualifiers !== undefined)
        strings(term.qualifiers, at(pointer, 'qualifiers'), (item) => qualifiers.has(item), 4, true);
      if (term.mappings !== undefined) {
        const mappings = at(pointer, 'mappings');
        if (!Array.isArray(term.mappings)) add(mappings, 'invalid_type');
        else if (term.mappings.length > EXTENSION_LIMITS.mappings) add(mappings, 'out_of_range');
        else
          term.mappings.forEach((mapping, index) => {
            const entry = at(mappings, index);
            if (!record(mapping)) return add(entry, 'invalid_type');
            for (const member of Object.keys(mapping))
              if (!['predicate', 'iri'].includes(member)) add(at(entry, member), 'unknown_field');
            if (!(EXTENSION_MAPPINGS as readonly unknown[]).includes(mapping.predicate)) add(at(entry, 'predicate'));
            if (typeof mapping.iri !== 'string' || !ABSOLUTE_IRI.test(mapping.iri)) add(at(entry, 'iri'));
          });
      }
      const relation = term.relation;
      const relationPointer = at(pointer, 'relation');
      if (!record(relation)) {
        add(relationPointer, own(term, 'relation') ? 'invalid_type' : 'required');
      } else {
        for (const member of Object.keys(relation))
          if (!['group', 'inverse', 'inverseLabels', 'symmetric', 'acyclic', 'order'].includes(member))
            add(at(relationPointer, member), 'unknown_field');
        if (!(EXTENSION_GROUPS as readonly unknown[]).includes(relation.group))
          add(at(relationPointer, 'group'), own(relation, 'group') ? 'invalid_format' : 'required');
        const hasInverse = own(relation, 'inverse');
        const hasSymmetric = own(relation, 'symmetric');
        if (hasInverse === hasSymmetric) add(relationPointer);
        if (hasSymmetric && relation.symmetric !== true) add(at(relationPointer, 'symmetric'));
        if (hasSymmetric && own(relation, 'acyclic')) add(at(relationPointer, 'acyclic'));
        if (own(relation, 'acyclic') && relation.acyclic !== true) add(at(relationPointer, 'acyclic'));
        if (hasInverse && relation.inverse !== 'none') {
          const inverse = relation.inverse;
          const inversePointer = at(relationPointer, 'inverse');
          const inverseLocal =
            typeof inverse === 'string' && inverse.startsWith(`${own32}:`) ? inverse.slice(own32.length + 1) : '';
          if (
            !LOCAL_NAME.test(inverseLocal) ||
            inverse === key ||
            own(terms, inverse as string) ||
            inverses.has(inverse as string)
          )
            add(inversePointer);
          else inverses.add(inverse as string);
          languages(relation.inverseLabels, at(relationPointer, 'inverseLabels'), 256);
        } else if (own(relation, 'inverseLabels')) add(at(relationPointer, 'inverseLabels'));
        if (own(relation, 'order') && !['position', 'date', 'name'].includes(relation.order as string))
          add(at(relationPointer, 'order'));
        if (
          relation.order === 'position' &&
          !(Array.isArray(term.qualifiers) && term.qualifiers.includes('schema:position'))
        )
          add(at(relationPointer, 'order'));
      }
      if (own(term, 'deprecated')) {
        const deprecated = term.deprecated;
        const deprecatedPointer = at(pointer, 'deprecated');
        if (!record(deprecated)) add(deprecatedPointer, 'invalid_type');
        else {
          for (const member of Object.keys(deprecated))
            if (member !== 'replacedBy') add(at(deprecatedPointer, member), 'unknown_field');
          const replacement = deprecated.replacedBy;
          if (typeof replacement !== 'string')
            add(at(deprecatedPointer, 'replacedBy'), own(deprecated, 'replacedBy') ? 'invalid_type' : 'required');
          else if (
            replacement === key ||
            !own(terms, replacement) ||
            (terms[replacement] as { deprecated?: unknown })?.deprecated
          )
            add(at(deprecatedPointer, 'replacedBy'));
        }
      }
    }
    // An inverse name is part of a term's identity too: another term cannot take it.
    for (const key of keys) if (inverses.has(key)) add(at('/terms', key));
    for (const key of keys) if (own(base.properties, key)) add(at('/terms', key));
    return result();
  } catch {
    return [{ pointer: '', code: 'invalid_format' }];
  }
}

const IMMUTABLE_FIELDS = ['description', 'domain', 'targets', 'multivalued'] as const;

/**
 * The next extension of a Context may add terms, change labels and deprecate a term. A term keeps its meaning for
 * its lifetime, so these fields of an existing term may not change.
 */
export function checkExtensionUpdate(previous: Extension, next: Extension): ExtensionViolation[] {
  const violations: ExtensionViolation[] = [];
  const same = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);
  for (const [key, before] of Object.entries(previous.terms)) {
    const pointer = at('/terms', key);
    const after = next.terms[key];
    if (!after) {
      violations.push({ pointer, code: 'required' });
      continue;
    }
    for (const field of IMMUTABLE_FIELDS)
      if (!same(before[field], after[field])) violations.push({ pointer: at(pointer, field), code: 'unsupported' });
    const relation = at(pointer, 'relation');
    if (before.relation.group !== after.relation.group)
      violations.push({ pointer: at(relation, 'group'), code: 'unsupported' });
    if (before.relation.acyclic !== after.relation.acyclic)
      violations.push({ pointer: at(relation, 'acyclic'), code: 'unsupported' });
    if (before.relation.symmetric !== after.relation.symmetric)
      violations.push({ pointer: at(relation, 'symmetric'), code: 'unsupported' });
    if (before.relation.inverse !== after.relation.inverse)
      violations.push({ pointer: at(relation, 'inverse'), code: 'unsupported' });
    if (before.deprecated && !same(before.deprecated, after.deprecated))
      violations.push({ pointer: at(pointer, 'deprecated'), code: 'unsupported' });
  }
  // A name an earlier extension used as an inverse stays taken.
  for (const before of Object.values(previous.terms)) {
    const inverse = before.relation.inverse;
    if (inverse && inverse !== 'none' && own(next.terms, inverse))
      violations.push({ pointer: at('/terms', inverse), code: 'unsupported' });
  }
  return violations;
}

function fullUuid(prefix: string): string {
  const hex = prefix.slice(1);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The release as one Context sees it: the base plus the extension's terms, each a relation property that holds on its
 * domain types. A pure function of both bodies. Parts the base does not offer (a type, a target, a qualifier) drop out,
 * and a term left without a domain or a target is not offered, so a later base never breaks reads.
 */
export function applyExtension(base: Release, extension: Extension): Release {
  const names = targetNames(base);
  const properties: Record<string, PropertyDefinition> = { ...base.properties };
  const types: Record<string, TypeDefinition> = { ...base.types };
  const prefixes: Record<string, string> = { ...base.prefixes };
  const added = new Map<string, Set<string>>();
  for (const [key, term] of Object.entries(extension.terms)) {
    const [prefix, local] = key.split(':') as [string, string];
    const domain = term.domain.filter((name) => own(base.types, name));
    const targets = term.targets.filter((name) => names.has(name));
    if (own(base.properties, key) || !domain.length || !targets.length) continue;
    const context = fullUuid(prefix);
    prefixes[prefix] = `https://rezics.com/contexts/${context}/terms/`;
    const qualifiers = (term.qualifiers ?? []).filter((name) => own(base.properties, name));
    const relation: NonNullable<PropertyDefinition['relation']> = { group: term.relation.group };
    if (term.relation.inverse !== undefined) {
      relation.inverse = term.relation.inverse;
      if (term.relation.inverse !== 'none') {
        const inversePrefix = term.relation.inverse.split(':')[0]!;
        prefixes[inversePrefix] = `https://rezics.com/contexts/${context}/terms/`;
        relation.inverseLabels = term.relation.inverseLabels!;
      }
    }
    if (term.relation.symmetric) relation.symmetric = true;
    if (term.relation.acyclic) relation.acyclic = true;
    if (term.relation.order && (term.relation.order !== 'position' || qualifiers.includes('schema:position')))
      relation.order = term.relation.order;
    properties[key] = {
      iri: termIri(context, local),
      labels: term.labels,
      mappings: [],
      datatype: 'wikibase-item',
      multivalued: term.multivalued,
      targets,
      qualifiers,
      value: valueSchema('wikibase-item'),
      relation,
    };
    for (const name of domain) (added.get(name) ?? added.set(name, new Set()).get(name)!).add(key);
  }
  for (const [name, keys] of added) {
    const type = base.types[name]!;
    types[name] = { ...type, properties: [...new Set([...type.properties, ...keys])].sort() };
  }
  return { ...base, prefixes, types, properties };
}

export function composedDigest(base: Release, extension: Extension): string {
  return releaseDigest(applyExtension(base, extension));
}
