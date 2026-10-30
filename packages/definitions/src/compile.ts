import { LinkML, type SchemaValidationReport } from '@neverblink/linkml';
import { createFilterConstruction, type FilterDocument, type FilterValidationError } from '@rezics/filter';
import canonicalize from 'canonicalize';
import { posix } from 'node:path';
import { safePattern } from './pattern-safety.ts';
import releaseSchema from '../schema/release.json';
import { compileLibraryProfiles } from './compile-library-profiles.ts';
import {
  DATA_TYPES,
  RELEASE_FORMAT,
  RELEASE_LIMITS,
  validateRelease,
  valueSchema,
  type ContextSettings,
  type DataType,
  type PropertyDefinition,
  type RelationDefinition,
  type RelationGroup,
  type Release,
  type SavedFilter,
  type TypeDefinition,
} from './index.ts';

export type CatalogueViolation = {
  file: string;
  pointer: string;
  code: 'unsupported' | 'invalid' | 'limit' | 'unsafe_pattern' | 'linkml' | 'duplicate' | 'missing_label';
  message: string;
};
export class CatalogueError extends Error {
  readonly violations: CatalogueViolation[];
  constructor(violations: CatalogueViolation[]) {
    super('Catalogue compilation failed');
    this.name = 'CatalogueError';
    this.violations = violations.sort((a, b) => compare(a.file, b.file) || compare(a.pointer, b.pointer)).slice(0, 64);
  }
}

type Node = Record<string, unknown>;
type Location = { file: string; pointer: string };
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const record = (value: unknown): value is Node => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A code facet is a string property whose release definition declares a pattern. */
function codeFacet(property: PropertyDefinition): boolean {
  if (property.datatype !== 'string' || !record(property.value)) return false;
  const pattern = property.value.pattern;
  return typeof pattern === 'string' && pattern.length > 0;
}

function facetable(property: PropertyDefinition): boolean {
  return (
    property.datatype === 'wikibase-item' ||
    property.datatype === 'time' ||
    property.datatype === 'quantity' ||
    codeFacet(property)
  );
}
const object = (value: unknown): Node => (record(value) ? value : (Object.create(null) as Node));
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const at = (pointer: string, key: string | number) =>
  `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const unique = (items: string[]) => [...new Set(items)].sort(compare);
const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const words = (value: unknown) => (typeof value === 'string' ? value.trim().split(/\s+/u).filter(Boolean) : []);
const schemaKeys =
  'id name title description version license prefixes default_prefix default_range imports classes slots';
const classKeys = 'class_uri description is_a abstract slots slot_usage exact_mappings close_mappings annotations';
const slotKeys =
  'description range any_of multivalued pattern minimum_value maximum_value exact_mappings close_mappings annotations';
const iri = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u0020\u007f-\u009f<>"{}|\\^`]*$(?![\s\S])/u;
const normalize = (file: string) => posix.normalize(file).replace(/\.ya?ml$/u, '');
const languagePattern = new RegExp(Object.keys(releaseSchema.$defs.labels.patternProperties)[0]!, 'u');
const presentationGroup = (file: string) => posix.basename(file).replace(/\.ya?ml$/u, '');
const subjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const filterName = /^[a-z][a-z0-9-]{0,63}$(?![\s\S])/u;
const relationGroups = [
  'order',
  'derivation',
  'world',
  'membership',
  'association',
  'credit',
  'appearance',
  'classification',
] as const;
const relationOrders = ['position', 'date', 'name'] as const;
const relationAnnotationKeys = [
  'relation_group',
  'inverse',
  'symmetric',
  'acyclic',
  'relation_order',
  'relation_filter',
  'relation_slot_key',
] as const;
const schemaOrgType = /^https:\/\/schema\.org\/[A-Za-z0-9_-]+$(?![\s\S])/u;
const coverRatio = /^(?:[1-9]|[1-5][0-9]|6[0-4]):(?:[1-9]|[1-5][0-9]|6[0-4])$(?![\s\S])/u;

function savedFilterCode(error: FilterValidationError): 'invalid' | 'limit' {
  return error.problem === 'unsupported_query' && error.code === 'out_of_range' ? 'limit' : 'invalid';
}

// A shipped filter names types, facets, years and amounts. Subject ids differ per deployment.
function visitSubjectIds(value: unknown, pointer: string, add: (pointer: string) => void): void {
  if (typeof value === 'string') {
    if (subjectIdPattern.test(value)) add(pointer);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) visitSubjectIds(value[index], at(pointer, index), add);
    return;
  }
  if (!record(value)) return;
  for (const key of Object.keys(value)) visitSubjectIds(value[key], at(pointer, key), add);
}

export async function compileCatalogue(input: {
  root: string;
  schemas: Record<string, string>;
  presentation: Record<string, string>;
  contexts?: Record<string, string>;
  filters?: Record<string, string>;
}): Promise<Release> {
  const errors: CatalogueViolation[] = [];
  const add = (location: Location, code: CatalogueViolation['code'], message: string) => {
    if (!errors.some((e) => e.file === location.file && e.pointer === location.pointer && e.code === code))
      errors.push({ ...location, code, message });
  };
  const stop = () => {
    if (errors.length) throw new CatalogueError(errors);
  };
  const parse = (text: string, file: string, pointer = ''): Node => {
    try {
      const value: unknown = Bun.YAML.parse(text);
      if (record(value)) return value;
      add({ file, pointer }, 'invalid', 'Expected a YAML object');
    } catch (error) {
      add({ file, pointer }, 'invalid', String(error));
    }
    return object(undefined);
  };
  const allowed = (value: unknown, keys: string, location: Location) => {
    if (!record(value)) {
      add(location, 'invalid', 'Expected an object');
      return;
    }
    for (const key of Object.keys(value))
      if (!keys.split(' ').includes(key))
        add({ ...location, pointer: at(location.pointer, key) }, 'unsupported', 'Unsupported key');
  };
  const parsed = dictionary<Node>();
  type ListDeclaration = { value: NonNullable<TypeDefinition['listPresentation']>; location: Location };
  const listDeclarations = new Map<string, ListDeclaration>();
  const files = Object.keys(input.schemas).sort(compare);
  const maxSchemaFiles = 256;
  if (files.length > maxSchemaFiles)
    add({ file: input.root, pointer: '' }, 'limit', `At most ${maxSchemaFiles} schema files are allowed`);
  for (const file of files.slice(0, maxSchemaFiles)) {
    if (Buffer.byteLength(input.schemas[file]!, 'utf8') > 256 * 1024)
      add({ file, pointer: '' }, 'limit', 'Schema exceeds 256 KiB');
    else parsed[file] = parse(input.schemas[file]!, file);
  }
  const safety = new Map<unknown, boolean>();
  const slotProfile = (slot: unknown, location: Location, usage = false) => {
    allowed(slot, usage ? slotKeys : `slot_uri ${slotKeys}`, location);
    if (!record(slot)) return;
    if (slot.annotations !== undefined)
      allowed(slot.annotations, `datatype units exact qualifiers disclosure ${relationAnnotationKeys.join(' ')}`, {
        ...location,
        pointer: at(location.pointer, 'annotations'),
      });
    const annotations = object(slot.annotations);
    if (Object.hasOwn(annotations, 'exact') && annotations.exact !== true)
      add({ ...location, pointer: at(at(location.pointer, 'annotations'), 'exact') }, 'invalid', 'Exact must be true');
    if (slot.any_of !== undefined) {
      if (!Array.isArray(slot.any_of))
        add({ ...location, pointer: at(location.pointer, 'any_of') }, 'invalid', 'Expected a list');
      else
        slot.any_of.forEach((entry, i) =>
          allowed(entry, 'range', { ...location, pointer: at(at(location.pointer, 'any_of'), i) }),
        );
    }
    if (slot.pattern !== undefined) {
      let safe = safety.get(slot.pattern);
      if (safe === undefined) {
        safe = safePattern(slot.pattern);
        safety.set(slot.pattern, safe);
      }
      if (!safe)
        add(
          { ...location, pointer: at(location.pointer, 'pattern') },
          'unsafe_pattern',
          'Pattern must be safe Unicode syntax of at most 256 characters',
        );
    }
  };
  for (const [file, source] of Object.entries(parsed)) {
    allowed(source, schemaKeys, { file, pointer: '' });
    for (const collection of ['classes', 'slots'] as const) {
      if (source[collection] !== undefined && !record(source[collection]))
        add({ file, pointer: `/${collection}` }, 'invalid', 'Expected an object');
      for (const [name, value] of Object.entries(object(source[collection]))) {
        const location = { file, pointer: at(`/${collection}`, name) };
        if (collection === 'slots') slotProfile(value, location);
        else {
          allowed(value, classKeys, location);
          const definition = object(value);
          if (definition.annotations !== undefined) {
            const annotationLocation = { ...location, pointer: at(location.pointer, 'annotations') };
            allowed(
              definition.annotations,
              'facets cover_ratio schema_org_type library list_presentation',
              annotationLocation,
            );
            const annotations = object(definition.annotations);
            if (Object.hasOwn(annotations, 'list_presentation')) {
              const location = { file, pointer: at(annotationLocation.pointer, 'list_presentation') };
              const hint = annotations.list_presentation;
              allowed(hint, 'imageAspect keyFacts', location);
              if (record(hint)) {
                if (!['portrait', 'landscape', 'square'].includes(hint.imageAspect as string))
                  add(
                    { ...location, pointer: at(location.pointer, 'imageAspect') },
                    'invalid',
                    'Expected portrait, landscape or square',
                  );
                if (!Array.isArray(hint.keyFacts))
                  add(
                    { ...location, pointer: at(location.pointer, 'keyFacts') },
                    'invalid',
                    'Expected a list of property CURIEs',
                  );
                else {
                  if (hint.keyFacts.length > 4)
                    add(
                      { ...location, pointer: at(location.pointer, 'keyFacts') },
                      'limit',
                      'At most four key facts are allowed',
                    );
                  const seen = new Set<string>();
                  hint.keyFacts.forEach((key, index) => {
                    const pointer = at(at(location.pointer, 'keyFacts'), index);
                    if (typeof key !== 'string') add({ file, pointer }, 'invalid', 'Expected a property CURIE');
                    else if (seen.has(key)) add({ file, pointer }, 'duplicate', 'Duplicate key fact');
                    else seen.add(key);
                  });
                }
                listDeclarations.set(name, { value: hint as ListDeclaration['value'], location });
              }
            }
            const facets = annotations.facets;
            if (facets !== undefined && typeof facets !== 'string')
              add(
                { ...annotationLocation, pointer: at(annotationLocation.pointer, 'facets') },
                'invalid',
                'Facets must be space-separated slot names',
              );
            if (
              annotations.cover_ratio !== undefined &&
              (typeof annotations.cover_ratio !== 'string' || !coverRatio.test(annotations.cover_ratio))
            )
              add(
                { ...annotationLocation, pointer: at(annotationLocation.pointer, 'cover_ratio') },
                'invalid',
                'Cover ratio must be W:H with positive integer sides from 1 to 64',
              );
            if (
              annotations.schema_org_type !== undefined &&
              (typeof annotations.schema_org_type !== 'string' ||
                annotations.schema_org_type.length > 256 ||
                !schemaOrgType.test(annotations.schema_org_type))
            )
              add(
                { ...annotationLocation, pointer: at(annotationLocation.pointer, 'schema_org_type') },
                'invalid',
                'Schema.org type must be https://schema.org/ followed by one term of letters, digits, underscores or hyphens',
              );
          }
          const usage = definition.slot_usage;
          if (usage !== undefined && !record(usage))
            add({ file, pointer: at(location.pointer, 'slot_usage') }, 'invalid', 'Expected an object');
          for (const [slot, definition] of Object.entries(object(usage)))
            slotProfile(definition, { file, pointer: at(at(location.pointer, 'slot_usage'), slot) }, true);
        }
      }
    }
    if (source.imports !== undefined && !Array.isArray(source.imports))
      add({ file, pointer: '/imports' }, 'invalid', 'Expected a list');
    if (Array.isArray(source.imports))
      source.imports.forEach((entry, i) => {
        if (
          entry !== 'linkml:types' &&
          (typeof entry !== 'string' ||
            !files.some((candidate) => normalize(candidate) === normalize(posix.join(posix.dirname(file), entry))))
        )
          add(
            { file, pointer: at('/imports', i) },
            'unsupported',
            'Import must name a supplied schema or linkml:types',
          );
      });
  }
  if (!Object.hasOwn(input.schemas, input.root))
    add({ file: input.root, pointer: '' }, 'invalid', 'Root schema is missing');
  const library = compileLibraryProfiles(parsed, add);
  stop();

  // Native inert mappings are compiler data, outside LinkML's scalar annotations ABI.
  // Preserve every other source field and all ordinary LinkML induction and linting.
  const linkmlSchemas = { ...input.schemas };
  for (const [file, source] of Object.entries(parsed)) {
    const copy = structuredClone(source);
    let changed = false;
    for (const definition of Object.values(object(copy.classes))) {
      const annotations = object(object(definition).annotations);
      if (Object.hasOwn(annotations, 'library')) {
        delete annotations.library;
        changed = true;
      }
      if (Object.hasOwn(annotations, 'list_presentation')) {
        delete annotations.list_presentation;
        changed = true;
      }
    }
    if (changed) linkmlSchemas[file] = JSON.stringify(copy);
  }

  const fileFor = (id: unknown) => files.find((file) => parsed[file]!.id === id) ?? input.root;
  const report = (value: SchemaValidationReport) => {
    for (const issue of value.issues)
      if (issue.severity !== 'WARNING') {
        const source = 'source_uri' in issue ? issue.source_uri : undefined;
        add(
          {
            file: source && Object.hasOwn(parsed, source) ? source : fileFor(issue.location.schema_id),
            pointer: issue.location.json_pointer ?? '',
          },
          'linkml',
          issue.message ?? issue.issue_type,
        );
      }
  };
  let derived: Node = object(undefined);
  let globals: Node = object(undefined);
  try {
    const loaded = LinkML.loadFromPath(input.root, linkmlSchemas);
    report(loaded.report);
    if (loaded.view) report(LinkML.lint(loaded.view));
    stop();
    if (!loaded.view) add({ file: input.root, pointer: '' }, 'linkml', 'LinkML did not produce a schema');
    stop();
    derived = JSON.parse(LinkML.linkml(loaded.view!, 'skip', false, undefined, 'json')) as Node;
    // Derived LinkML emits slots only as class attributes. Induce every global slot
    // on an auxiliary abstract class so unused qualifier slots are retained, too.
    const inventory = object(JSON.parse(LinkML.linkml(loaded.view!, 'skip', true, undefined, 'json')));
    let carrier = '__catalogue_slots';
    while (Object.hasOwn(object(inventory.classes), carrier)) carrier += '_';
    let path = posix.join(posix.dirname(input.root), '__catalogue.yaml');
    while (files.some((file) => normalize(file) === normalize(path))) path += '.yaml';
    const wrapper = JSON.stringify({
      id: 'urn:rezics:compiler:slots',
      name: 'catalogue_slots',
      imports: [`./${posix.basename(input.root)}`],
      classes: { [carrier]: { abstract: true, slots: Object.keys(object(inventory.slots)).sort(compare) } },
    });
    const all = LinkML.loadFromPath(path, { ...linkmlSchemas, [path]: wrapper });
    report(all.report);
    stop();
    if (!all.view) throw new Error('Cannot induce catalogue slots');
    const induced = object(JSON.parse(LinkML.linkml(all.view, 'skip', false, undefined, 'json')));
    globals = object(object(object(induced.classes)[carrier]).attributes);
  } catch (error) {
    if (error instanceof CatalogueError) throw error;
    add({ file: input.root, pointer: '' }, 'linkml', String(error));
  }
  stop();

  const release: Release = {
    format: RELEASE_FORMAT,
    catalogue: { id: parsed[input.root]!.id as string, version: parsed[input.root]!.version as string },
    generator: { name: '@neverblink/linkml', version: LinkML.buildInfo().linkml_scala_version },
    prefixes: dictionary<string>(),
    types: dictionary(),
    properties: dictionary(),
  };
  const prefixes = object(derived.prefixes);
  const expand = (value: unknown, location: Location, retain = true): string | undefined => {
    if (typeof value === 'string') {
      const match = /^([a-z][a-z0-9_]*):([^\s]+)$(?![\s\S])/u.exec(value);
      const base = match && (object(parsed[location.file]?.prefixes)[match[1]!] ?? prefixes[match[1]!]);
      if (match && typeof base === 'string' && iri.test(base + match[2]!)) {
        if (retain) {
          const previous = release.prefixes[match[1]!];
          if (previous !== undefined && previous !== base)
            add(location, 'invalid', 'Prefix has conflicting expansions');
          else release.prefixes[match[1]!] = base;
        }
        return base + match[2]!;
      }
    }
    add(location, 'invalid', 'Expected a CURIE with a declared prefix');
    return undefined;
  };
  type Term = { name: string; value: Node; location: Location; key: string };
  const terms = (collection: 'classes' | 'slots', values: Node): Term[] => {
    const uri = collection === 'classes' ? 'class_uri' : 'slot_uri';
    const entries = Object.entries(values)
      .map(([name, value]) => {
        const node = object(value);
        return {
          name,
          value: node,
          location: { file: fileFor(node.from_schema), pointer: at(`/${collection}`, name) },
          key: node[uri] as string,
        };
      })
      .sort((a, b) => compare(a.location.file, b.location.file) || compare(a.location.pointer, b.location.pointer));
    const seen = new Set<string>();
    return entries.filter((term) => {
      if (collection === 'classes' && term.value.abstract === true) return false;
      const source = object(object(parsed[term.location.file]![collection])[term.name]);
      if (!Object.hasOwn(source, uri) || !expand(term.key, term.location)) {
        add(term.location, 'invalid', `${uri} must be explicit in the source`);
        return false;
      }
      if (seen.has(term.key)) {
        add(term.location, 'duplicate', `Duplicate key ${term.key}`);
        return false;
      }
      seen.add(term.key);
      return true;
    });
  };
  const classes = terms('classes', object(derived.classes));
  const sourceClasses = new Map<string, { value: Node; location: Location }>();
  const parents = new Map<string, string>();
  for (const [file, source] of Object.entries(parsed))
    for (const [name, definition] of Object.entries(object(source.classes))) {
      sourceClasses.set(name, { value: object(definition), location: { file, pointer: at('/classes', name) } });
      if (typeof object(definition).is_a === 'string') parents.set(name, object(definition).is_a as string);
    }
  // Use induced attributes for properties used by concrete classes. A global
  // property cannot represent two different class-specific value contracts.
  const effective = new Map<string, string>();
  for (const term of classes) {
    for (const [name, attribute] of Object.entries(object(term.value.attributes))) {
      const slot = object(attribute);
      const contract = canonicalize(
        Object.fromEntries(
          `slot_uri ${slotKeys}`
            .split(' ')
            .filter((key) => !['description', 'close_mappings'].includes(key))
            .map((key) => [
              key,
              key === 'range'
                ? (slot.range ?? parsed[fileFor(slot.from_schema)]?.default_range ?? 'string')
                : slot[key],
            ])
            .filter(([, value]) => value !== undefined),
        ),
      )!;
      const previous = effective.get(name);
      if (previous !== undefined && previous !== contract)
        add(
          { file: term.location.file, pointer: at(at(term.location.pointer, 'slot_usage'), name) },
          'invalid',
          'Induced property contracts disagree across concrete classes',
        );
      else {
        effective.set(name, contract);
        globals[name] = slot;
      }
    }
  }
  const slots = terms('slots', globals);
  const slotKeysByName = new Map(slots.map((term) => [term.name, term.key]));
  const propertyLocations = new Map<string, Location>();
  const classChain = (name: string) => {
    const result: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = name;
    while (current && !seen.has(current)) {
      result.push(current);
      seen.add(current);
      current = parents.get(current);
    }
    return result;
  };
  const children = new Map<string, string[]>();
  for (const [name, parent] of parents) children.set(parent, [...(children.get(parent) ?? []), name]);
  const classUri = (name: string): string | undefined => {
    const value = sourceClasses.get(name)?.value.class_uri;
    return typeof value === 'string' ? value : undefined;
  };
  // A named range contributes its own CURIE. A class without one contributes the
  // nearest descendants that have one, not their further subtypes.
  const declaredRange = (range: string): string[] => {
    if (classUri(range)) return [range];
    if (!sourceClasses.has(range)) return [];
    const found: string[] = [];
    const seen = new Set<string>();
    const queue = [...(children.get(range) ?? [])];
    while (queue.length) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      if (classUri(name)) found.push(name);
      else for (const child of children.get(name) ?? []) queue.push(child);
    }
    return found;
  };
  const mappings = (term: Term) => {
    const result = unique(names(term.value.exact_mappings));
    for (const mapping of result)
      expand(mapping, { ...term.location, pointer: at(term.location.pointer, 'exact_mappings') });
    return result;
  };
  const facetOrigins = new Map<string, Map<string, { name: string; location: Location }>>();
  // Memoize the nearest explicit whole object, including absence. LinkML has
  // already rejected inheritance cycles; no emitted reader needs an ancestor walk.
  const effectiveLists = new Map<string, ListDeclaration | undefined>();
  const listFor = (name: string): ListDeclaration | undefined => {
    if (effectiveLists.has(name)) return effectiveLists.get(name);
    const parent = parents.get(name);
    const value = listDeclarations.get(name) ?? (parent ? listFor(parent) : undefined);
    effectiveLists.set(name, value);
    return value;
  };
  for (const term of classes) {
    const properties = unique(
      Object.keys(object(term.value.attributes)).flatMap((name) => slotKeysByName.get(name) ?? []),
    );
    if (properties.length > RELEASE_LIMITS.propertiesPerType)
      add(term.location, 'limit', `A type may have at most ${RELEASE_LIMITS.propertiesPerType} properties`);
    const bases: string[] = [];
    const seenBases = new Set<string>();
    for (const ancestor of classChain(term.name).slice(1)) {
      const definition = sourceClasses.get(ancestor);
      const classUri = definition?.value.class_uri;
      if (typeof classUri !== 'string') continue;
      const location = { ...definition!.location, pointer: at(definition!.location.pointer, 'class_uri') };
      if (!expand(classUri, location) || classUri === term.key || seenBases.has(classUri)) continue;
      seenBases.add(classUri);
      bases.push(classUri);
    }
    let effectiveCoverRatio: string | undefined;
    for (const ancestor of classChain(term.name)) {
      const ratio = object(sourceClasses.get(ancestor)?.value.annotations).cover_ratio;
      if (typeof ratio === 'string') {
        effectiveCoverRatio = ratio;
        break;
      }
    }
    // Explicit and per class: nothing is derived from names, mappings or ancestors.
    const ownSchemaOrgType = object(sourceClasses.get(term.name)?.value.annotations).schema_org_type;
    const facets: string[] = [];
    const facetNames = new Set<string>();
    const origins = new Map<string, { name: string; location: Location }>();
    for (const ancestor of classChain(term.name).reverse()) {
      const definition = sourceClasses.get(ancestor);
      if (!definition) continue;
      const annotation = object(definition.value.annotations);
      const declaration = annotation.facets;
      if (declaration === undefined || typeof declaration !== 'string') continue;
      const location = {
        ...definition.location,
        pointer: at(at(definition.location.pointer, 'annotations'), 'facets'),
      };
      for (const name of words(declaration)) {
        const property = slotKeysByName.get(name);
        if (!property || !properties.includes(property)) {
          add(location, 'invalid', `Facet slot ${name} is not a property of type ${term.name}`);
          continue;
        }
        if (facetNames.has(property)) {
          add(location, 'duplicate', `Facet slot ${name} is listed more than once in the type hierarchy`);
          continue;
        }
        facetNames.add(property);
        origins.set(property, { name, location });
        if (facets.length === RELEASE_LIMITS.facetsPerType) {
          add(location, 'limit', `Facet slot ${name} exceeds the limit of ${RELEASE_LIMITS.facetsPerType} facets`);
          continue;
        }
        facets.push(property);
      }
    }
    facetOrigins.set(term.key, origins);
    release.types[term.key] = {
      iri: expand(term.key, term.location)!,
      labels: dictionary(),
      mappings: mappings(term),
      bases,
      properties,
      facets,
      ...(effectiveCoverRatio === undefined ? {} : { coverRatio: effectiveCoverRatio }),
      ...(listFor(term.name) === undefined ? {} : { listPresentation: structuredClone(listFor(term.name)!.value) }),
      ...(typeof ownSchemaOrgType === 'string' ? { schemaOrgType: ownSchemaOrgType } : {}),
    };
    const reference = library.reference(term.name);
    if (reference) release.types[term.key]!.library = reference;
  }
  for (const term of slots) {
    const { value: slot, location } = term;
    const field = (key: string) => ({ ...location, pointer: at(location.pointer, key) });
    const annotation = (key: string) => ({ ...location, pointer: at(at(location.pointer, 'annotations'), key) });
    const annotations = object(slot.annotations);
    const datatype = annotations.datatype as DataType;
    if (Object.hasOwn(annotations, 'exact') && datatype !== 'quantity')
      add(annotation('exact'), 'invalid', 'Exact is only allowed for quantity');
    const range = slot.range ?? parsed[location.file]?.default_range ?? 'string';
    const ranges = Array.isArray(slot.any_of) ? slot.any_of.map((entry) => object(entry).range) : [range];
    const declaredClasses = ranges.flatMap((candidate) =>
      typeof candidate === 'string' ? declaredRange(candidate) : [],
    );
    const agrees =
      DATA_TYPES.includes(datatype) &&
      ranges.length > 0 &&
      ranges.every((range) => {
        if (datatype === 'wikibase-item') return typeof range === 'string' && declaredRange(range).length > 0;
        const expected =
          datatype === 'quantity'
            ? ['integer', 'decimal']
            : datatype === 'time'
              ? ['date']
              : datatype === 'url'
                ? ['uri']
                : ['string'];
        return typeof range === 'string' && expected.includes(range);
      });
    if (!agrees) {
      add(annotation('datatype'), 'invalid', 'Data type must agree with the range');
      continue;
    }
    const exact = mappings(term);
    if (datatype === 'external-id' && (exact.length !== 1 || !/^wd:P[0-9]+$(?![\s\S])/u.test(exact[0]!)))
      add(field('exact_mappings'), 'invalid', 'External identifiers require exactly one wd:P mapping');
    if (slot.pattern !== undefined && !['string', 'external-id', 'monolingualtext'].includes(datatype))
      add(field('pattern'), 'invalid', 'Pattern is not allowed for this data type');
    const property: PropertyDefinition = {
      iri: expand(term.key, location)!,
      labels: dictionary(),
      mappings: exact,
      datatype,
      multivalued: slot.multivalued === true,
      qualifiers: [],
      value: {},
    };
    if (annotations.disclosure !== undefined) {
      if (annotations.disclosure !== 'sourceOrConsent')
        add(annotation('disclosure'), 'invalid', 'Disclosure must be sourceOrConsent');
      else property.disclosure = 'sourceOrConsent';
    }
    propertyLocations.set(term.key, location);
    if (annotations.qualifiers !== undefined && typeof annotations.qualifiers !== 'string')
      add(annotation('qualifiers'), 'invalid', 'Qualifiers must be space-separated slot names');
    for (const name of words(annotations.qualifiers)) {
      const key = slotKeysByName.get(name);
      if (key) property.qualifiers.push(key);
      else add(annotation('qualifiers'), 'invalid', `Unknown qualifier ${name}`);
    }
    property.qualifiers = unique(property.qualifiers);
    if (relationAnnotationKeys.some((key) => Object.hasOwn(annotations, key))) {
      const group = annotations.relation_group;
      const hasInverse = Object.hasOwn(annotations, 'inverse');
      const hasSymmetric = Object.hasOwn(annotations, 'symmetric');
      if (!relationGroups.includes(group as (typeof relationGroups)[number]))
        add(annotation('relation_group'), 'invalid', 'Relation group is required and must be recognized');
      if (hasInverse === hasSymmetric)
        add(
          hasSymmetric ? annotation('symmetric') : annotation('relation_group'),
          'invalid',
          'A relation requires exactly one of inverse or symmetric',
        );
      if (datatype !== 'wikibase-item')
        add(annotation('relation_group'), 'invalid', 'Relations are only allowed on item properties');

      const direction: Partial<RelationDefinition> = {};
      if (hasInverse) {
        const inverse = annotations.inverse;
        if (
          typeof inverse !== 'string' ||
          (inverse !== 'none' && !/^([a-z][a-z0-9_]*):([^\s]+)$(?![\s\S])/u.test(inverse))
        )
          add(annotation('inverse'), 'invalid', 'Inverse must be a CURIE or none');
        else {
          direction.inverse = inverse;
          if (inverse !== 'none') expand(inverse, annotation('inverse'));
        }
      }
      if (hasSymmetric) {
        if (annotations.symmetric !== true) add(annotation('symmetric'), 'invalid', 'Symmetric must be true');
        else direction.symmetric = true;
      }
      if (Object.hasOwn(annotations, 'acyclic')) {
        if (annotations.acyclic !== true) add(annotation('acyclic'), 'invalid', 'Acyclic must be true');
        else if (annotations.symmetric === true)
          add(annotation('acyclic'), 'invalid', 'Symmetric relations cannot be acyclic');
        else direction.acyclic = true;
      }
      const order = annotations.relation_order;
      if (order !== undefined && !relationOrders.includes(order as (typeof relationOrders)[number]))
        add(annotation('relation_order'), 'invalid', 'Relation order must be position, date or name');
      if (order === 'position' && !property.qualifiers.includes('schema:position'))
        add(annotation('relation_order'), 'invalid', 'Position order requires the schema:position qualifier');
      const slotKey = annotations.relation_slot_key;
      if (slotKey !== undefined && (typeof slotKey !== 'string' || !property.qualifiers.includes(slotKey)))
        add(annotation('relation_slot_key'), 'invalid', 'Relation slot key must be an admitted item qualifier');
      const filter = annotations.relation_filter;
      const filters = Array.isArray(filter) ? filter : filter === undefined ? [] : [filter];
      if (
        filter !== undefined &&
        (filters.length < 1 ||
          filters.length > 2 ||
          new Set(filters).size !== filters.length ||
          filters.some((key) => typeof key !== 'string' || !property.qualifiers.includes(key)))
      )
        add(
          annotation('relation_filter'),
          'invalid',
          'Relation filter must name one or two distinct admitted item qualifiers',
        );
      if (relationGroups.includes(group as (typeof relationGroups)[number])) {
        property.relation = {
          group: group as RelationGroup,
          order: (relationOrders.includes(order as (typeof relationOrders)[number]) ? order : 'name') as
            | 'position'
            | 'date'
            | 'name',
          ...direction,
          ...(typeof filter === 'string' || Array.isArray(filter) ? { filter: filter as string | string[] } : {}),
          ...(typeof slotKey === 'string' ? { slotKey } : {}),
        };
      }
    }
    if (datatype === 'wikibase-item') {
      const targets: string[] = [];
      for (const name of declaredClasses) {
        const definition = sourceClasses.get(name);
        const uri = definition?.value.class_uri;
        if (typeof uri !== 'string') continue;
        const uriLocation = { ...definition!.location, pointer: at(definition!.location.pointer, 'class_uri') };
        if (expand(uri, uriLocation)) targets.push(uri);
      }
      property.targets = unique(targets);
    }
    if (datatype === 'quantity') {
      const units = words(annotations.units);
      if (!units.length || units.length > 16)
        add(annotation('units'), 'invalid', 'Quantity needs between one and 16 units');
      if (units.includes('*') && units.length !== 1)
        add(annotation('units'), 'invalid', 'Any-unit wildcard must be used alone');
      property.units = unique(
        units.map((unit) => (unit === '1' || unit === '*' ? unit : (expand(unit, annotation('units'), false) ?? unit))),
      );
    } else if (annotations.units !== undefined)
      add(annotation('units'), 'invalid', 'Units are only allowed for quantity');
    for (const [source, target] of [
      ['minimum_value', 'minimum'],
      ['maximum_value', 'maximum'],
    ] as const) {
      if (slot[source] === undefined) continue;
      if (datatype !== 'quantity' || typeof slot[source] !== 'number' || !Number.isFinite(slot[source]))
        add(field(source), 'invalid', 'Bounds require a finite quantity');
      else property[target] = slot[source];
    }
    if (property.minimum !== undefined && property.maximum !== undefined && property.minimum > property.maximum)
      add(field('maximum_value'), 'invalid', 'Maximum is below minimum');
    if (property.targets && property.targets.length > RELEASE_LIMITS.types)
      add(field('any_of'), 'limit', `At most ${RELEASE_LIMITS.types} targets are allowed`);
    property.value = valueSchema(datatype, {
      ...(typeof slot.pattern === 'string' && ['string', 'external-id', 'monolingualtext'].includes(datatype)
        ? { pattern: slot.pattern }
        : {}),
      ...(property.units ? { units: property.units, integer: range === 'integer' } : {}),
      ...(datatype === 'quantity' && annotations.exact === true ? { exact: true } : {}),
    });
    release.properties[term.key] = property;
  }
  const propertyIris = new Set(Object.values(release.properties).map((property) => property.iri));
  for (const [key, property] of Object.entries(release.properties)) {
    const location = propertyLocations.get(key);
    if (!property.relation || !location) continue;
    const relation = property.relation;
    if (relation.inverse && relation.inverse !== 'none') {
      const inverseIri = expand(relation.inverse, {
        ...location,
        pointer: at(at(location.pointer, 'annotations'), 'inverse'),
      });
      if (
        Object.hasOwn(release.properties, relation.inverse) ||
        (inverseIri !== undefined && propertyIris.has(inverseIri))
      )
        add(
          { ...location, pointer: at(at(location.pointer, 'annotations'), 'inverse') },
          'invalid',
          'The inverse property must not also be present in the release',
        );
    }
    if (
      relation.filter &&
      (Array.isArray(relation.filter) ? relation.filter : [relation.filter]).some(
        (key) => release.properties[key]?.datatype !== 'wikibase-item',
      )
    )
      add(
        { ...location, pointer: at(at(location.pointer, 'annotations'), 'relation_filter') },
        'invalid',
        'Relation filters must name an admitted item qualifier',
      );
    if (relation.slotKey && release.properties[relation.slotKey]?.datatype !== 'wikibase-item')
      add(
        { ...location, pointer: at(at(location.pointer, 'annotations'), 'relation_slot_key') },
        'invalid',
        'Relation slot keys must name an admitted item qualifier',
      );
  }
  for (const [key, type] of Object.entries(release.types))
    for (const facet of type.facets) {
      const property = release.properties[facet];
      if (property && !facetable(property)) {
        const origin = facetOrigins.get(key)?.get(facet);
        add(
          origin?.location ?? { file: input.root, pointer: at(at('/types', key), 'facets') },
          'invalid',
          `Facet slot ${origin?.name ?? facet} has unfilterable datatype ${property.datatype}`,
        );
      }
    }
  // Check every authored declaration, including unused abstract bases. Retain
  // its actual source pointer when an inherited selection is invalid.
  for (const [name, declaration] of listDeclarations) {
    const attributes = object(object(object(derived.classes)[name]).attributes);
    const properties = new Set(Object.keys(attributes).flatMap((slot) => slotKeysByName.get(slot) ?? []));
    declaration.value.keyFacts.forEach((key, index) => {
      const location = { ...declaration.location, pointer: at(at(declaration.location.pointer, 'keyFacts'), index) };
      const property = release.properties[key];
      if (!expand(key, location) || !properties.has(key) || !property || !facetable(property))
        add(location, 'invalid', `Key fact ${key} must be an effective property representable by Search Fact`);
    });
  }
  if (classes.length > RELEASE_LIMITS.types || slots.length > RELEASE_LIMITS.properties)
    add({ file: input.root, pointer: '' }, 'limit', 'Release collection limit exceeded');
  if (typeof release.catalogue.id !== 'string' || !iri.test(release.catalogue.id))
    add({ file: input.root, pointer: '/id' }, 'invalid', 'Catalogue id must be an IRI');
  if (typeof release.catalogue.version !== 'string' || !release.catalogue.version.length)
    add({ file: input.root, pointer: '/version' }, 'invalid', 'Catalogue version is required');
  stop();

  const seenLabels = new Set<string>();
  for (const key of Object.keys(input.presentation).sort(compare)) {
    const parts = key.split('/');
    const tag = parts.length === 1 ? parts[0]! : parts.length === 2 ? parts[1]! : '';
    const file = `presentation/${key}`;
    const labels = parse(input.presentation[key]!, file);
    // Use the release schema's complete BCP 47 grammar, including grandfathered tags.
    if (
      !languagePattern.test(tag) ||
      (parts.length === 2 && !/^[a-z][a-z0-9-]{0,63}$(?![\s\S])/u.test(parts[0]!)) ||
      parts.length > 2
    )
      add({ file, pointer: '' }, 'invalid', 'Expected a BCP 47 language tag or <group>/<tag>');
    allowed(labels, 'types properties inverseProperties typeDescriptions propertyDescriptions libraryProfiles', {
      file,
      pointer: '',
    });
    if (Object.hasOwn(labels, 'libraryProfiles'))
      library.presentation(parts.length === 2 ? parts[0] : undefined, tag, labels.libraryProfiles, file);
    for (const collection of ['types', 'properties'] as const) {
      if (labels[collection] !== undefined && !record(labels[collection]))
        add({ file, pointer: `/${collection}` }, 'invalid', 'Expected a label object');
      for (const [key, label] of Object.entries(object(labels[collection]))) {
        const location = { file, pointer: at(`/${collection}`, key) };
        if (!Object.hasOwn(release[collection], key)) add(location, 'invalid', 'Unknown term');
        else if (typeof label !== 'string' || !label.length || [...label].length > 256)
          add(location, 'invalid', 'Label must contain between one and 256 characters');
        else {
          const identity = `${tag}\0${collection}\0${key}`;
          if (seenLabels.has(identity)) add(location, 'duplicate', 'Term already has a label in this language');
          else {
            seenLabels.add(identity);
            release[collection][key]!.labels[tag] = label;
          }
        }
      }
    }
    if (labels.typeDescriptions !== undefined && !record(labels.typeDescriptions))
      add({ file, pointer: '/typeDescriptions' }, 'invalid', 'Expected a description object');
    for (const [key, description] of Object.entries(object(labels.typeDescriptions))) {
      const location = { file, pointer: at('/typeDescriptions', key) };
      const type = release.types[key];
      if (!type) add(location, 'invalid', 'Unknown type');
      else if (typeof description !== 'string' || !description.length || [...description].length > 1500)
        add(location, 'invalid', 'Description must contain between one and 1500 characters');
      else {
        const identity = `${tag}\0typeDescriptions\0${key}`;
        if (seenLabels.has(identity)) add(location, 'duplicate', 'Term already has a description in this language');
        else {
          seenLabels.add(identity);
          type.descriptions ??= dictionary();
          type.descriptions[tag] = description;
        }
      }
    }
    if (labels.propertyDescriptions !== undefined && !record(labels.propertyDescriptions))
      add({ file, pointer: '/propertyDescriptions' }, 'invalid', 'Expected a description object');
    for (const [key, description] of Object.entries(object(labels.propertyDescriptions))) {
      const location = { file, pointer: at('/propertyDescriptions', key) };
      const property = release.properties[key];
      if (!property) add(location, 'invalid', 'Unknown property');
      else if (typeof description !== 'string' || !description.length || [...description].length > 1500)
        add(location, 'invalid', 'Description must contain between one and 1500 characters');
      else {
        const identity = `${tag}\0propertyDescriptions\0${key}`;
        if (seenLabels.has(identity)) add(location, 'duplicate', 'Term already has a description in this language');
        else {
          seenLabels.add(identity);
          property.descriptions ??= dictionary();
          property.descriptions[tag] = description;
        }
      }
    }
    if (labels.inverseProperties !== undefined && !record(labels.inverseProperties))
      add({ file, pointer: '/inverseProperties' }, 'invalid', 'Expected a label object');
    for (const [key, label] of Object.entries(object(labels.inverseProperties))) {
      const location = { file, pointer: at('/inverseProperties', key) };
      const property = release.properties[key];
      if (!property) add(location, 'invalid', 'Unknown property');
      else if (!property.relation?.inverse || property.relation.inverse === 'none')
        add(location, 'invalid', 'Inverse labels require a relation with an inverse CURIE');
      else {
        const sourceFile = propertyLocations.get(key)?.file ?? '';
        const home = presentationGroup(sourceFile);
        if (parts.length !== 2 || parts[0] !== home)
          add(location, 'invalid', `Inverse labels belong in presentation/${home}/${tag}`);
        else if (typeof label !== 'string' || !label.length || [...label].length > 256)
          add(location, 'invalid', 'Label must contain between one and 256 characters');
        else {
          const identity = `${tag}\0inverseProperties\0${key}`;
          if (seenLabels.has(identity))
            add(location, 'duplicate', 'Term already has an inverse label in this language');
          else {
            seenLabels.add(identity);
            property.relation!.inverseLabels ??= dictionary();
            property.relation!.inverseLabels[tag] = label;
          }
        }
      }
    }
  }
  for (const collection of ['types', 'properties'] as const)
    for (const [key, term] of Object.entries(release[collection]))
      if (!Object.hasOwn(term.labels, 'en'))
        add(
          { file: 'presentation/en', pointer: at(`/${collection}`, key) },
          'missing_label',
          'English label is required',
        );
  for (const [key, property] of Object.entries(release.properties))
    if (property.relation?.inverse && property.relation.inverse !== 'none' && !property.relation.inverseLabels?.en) {
      const sourceFile = propertyLocations.get(key)?.file ?? '';
      const home = presentationGroup(sourceFile);
      add(
        { file: `presentation/${home}/en`, pointer: at('/inverseProperties', key) },
        'missing_label',
        'English inverse label is required',
      );
    }
  stop();

  const contextIds = Object.keys(input.contexts ?? {}).sort(compare);
  if (contextIds.length > 256)
    add({ file: 'contexts', pointer: '/contexts' }, 'limit', 'At most 256 context settings are allowed');
  const contextId = /^[a-z][a-z0-9-]{0,63}$(?![\s\S])/u;
  const contexts = dictionary<ContextSettings>();
  for (const id of contextIds) {
    const file = `contexts/${id}`;
    const pointer = at('/contexts', id);
    if (!contextId.test(id)) {
      add({ file, pointer }, 'invalid', 'Context id must match ^[a-z][a-z0-9-]{0,63}$');
      continue;
    }
    const source = parse(input.contexts![id]!, file, pointer);
    allowed(source, 'labels defaults', { file, pointer });
    const labels = dictionary<string>();
    if (!Object.hasOwn(source, 'labels'))
      add({ file, pointer: at(pointer, 'labels') }, 'invalid', 'Labels are required');
    else if (!record(source.labels))
      add({ file, pointer: at(pointer, 'labels') }, 'invalid', 'Expected a label object');
    else {
      for (const tag of Object.keys(source.labels).sort(compare)) {
        const label = source.labels[tag];
        const location = { file, pointer: at(at(pointer, 'labels'), tag) };
        if (!languagePattern.test(tag)) add(location, 'invalid', 'Label language must be a BCP 47 tag');
        else if (typeof label !== 'string' || !label.length || [...label].length > 256)
          add(location, 'invalid', 'Label must contain between one and 256 characters');
        else labels[tag] = label;
      }
      if (!Object.hasOwn(labels, 'en'))
        add({ file, pointer: at(at(pointer, 'labels'), 'en') }, 'missing_label', 'English label is required');
    }
    const defaults = dictionary<'inherit' | 'suppress'>();
    if (!Object.hasOwn(source, 'defaults'))
      add({ file, pointer: at(pointer, 'defaults') }, 'invalid', 'Defaults are required');
    else if (!record(source.defaults))
      add({ file, pointer: at(pointer, 'defaults') }, 'invalid', 'Expected a defaults object');
    else {
      const properties = Object.keys(source.defaults).sort(compare);
      if (properties.length > 64)
        add({ file, pointer: at(pointer, 'defaults') }, 'limit', 'At most 64 defaults are allowed');
      else
        for (const property of properties) {
          const mode = source.defaults[property];
          const location = { file, pointer: at(at(pointer, 'defaults'), property) };
          if (!Object.hasOwn(release.properties, property))
            add(location, 'invalid', 'Default names a property that is not in the release');
          else if (mode !== 'inherit' && mode !== 'suppress')
            add(location, 'invalid', 'A default is inherit or suppress; replace needs a per-subject selection');
          else defaults[property] = mode;
        }
    }
    contexts[id] = { labels, defaults };
  }
  if (contextIds.length && errors.length === 0) release.contexts = contexts;
  stop();

  const savedEntries: { key: string; value: SavedFilter }[] = [];
  const filterConstruction = createFilterConstruction(release);
  let filterCount = 0;
  for (const group of Object.keys(input.filters ?? {}).sort(compare)) {
    const file = `filters/${group}`;
    const groupPointer = at('/filters', group);
    if (!filterName.test(group)) {
      add({ file, pointer: groupPointer }, 'invalid', 'Filter group must match ^[a-z][a-z0-9-]{0,63}$');
      continue;
    }
    const source = parse(input.filters![group]!, file, groupPointer);
    const slugs = Object.keys(source).sort(compare);
    filterCount += slugs.length;
    if (slugs.length > 64) {
      add({ file, pointer: groupPointer }, 'limit', 'At most 64 saved filters are allowed in a group');
      continue;
    }
    for (const slug of slugs) {
      const key = `${group}/${slug}`;
      const pointer = at('/filters', key);
      if (!filterName.test(slug)) {
        add({ file, pointer }, 'invalid', 'Filter slug must match ^[a-z][a-z0-9-]{0,63}$');
        continue;
      }
      const raw = source[slug];
      if (!record(raw)) {
        add({ file, pointer }, 'invalid', 'Expected a saved filter');
        continue;
      }
      const before = errors.length;
      allowed(raw, 'labels filter', { file, pointer });
      const labels = dictionary<string>();
      if (!Object.hasOwn(raw, 'labels'))
        add({ file, pointer: at(pointer, 'labels') }, 'invalid', 'Labels are required');
      else if (!record(raw.labels)) add({ file, pointer: at(pointer, 'labels') }, 'invalid', 'Expected a label object');
      else {
        for (const tag of Object.keys(raw.labels).sort(compare)) {
          const label = raw.labels[tag];
          const location = { file, pointer: at(at(pointer, 'labels'), tag) };
          if (!languagePattern.test(tag)) add(location, 'invalid', 'Label language must be a BCP 47 tag');
          else if (typeof label !== 'string' || !label.length || [...label].length > 256)
            add(location, 'invalid', 'Label must contain between one and 256 characters');
          else labels[tag] = label;
        }
        if (!Object.hasOwn(labels, 'en'))
          add({ file, pointer: at(at(pointer, 'labels'), 'en') }, 'missing_label', 'English label is required');
      }
      const filterPointer = at(pointer, 'filter');
      if (!Object.hasOwn(raw, 'filter')) add({ file, pointer: filterPointer }, 'invalid', 'Filter is required');
      else {
        for (const error of filterConstruction.validateFilter(raw.filter, { saved: false }))
          add(
            { file, pointer: `${filterPointer}${error.pointer}` },
            savedFilterCode(error),
            'Saved filter is not admissible',
          );
        visitSubjectIds(raw.filter, filterPointer, (subjectPointer) =>
          add(
            { file, pointer: subjectPointer },
            'invalid',
            'A saved filter names types, facets, years and amounts only',
          ),
        );
      }
      if (errors.length === before) savedEntries.push({ key, value: { labels, filter: raw.filter as FilterDocument } });
    }
  }
  if (filterCount > 1024)
    add({ file: 'filters', pointer: '/filters' }, 'limit', 'At most 1,024 saved filters are allowed');
  if (filterCount > 0 && errors.length === 0) {
    const filters = dictionary<SavedFilter>();
    for (const item of savedEntries.sort((left, right) => compare(left.key, right.key))) filters[item.key] = item.value;
    release.filters = filters;
  }
  stop();
  const registry = library.registry();
  if (registry) release.libraryProfiles = registry;
  stop();
  const defects = validateRelease(release);
  if (defects.length) throw new Error(`Compiler produced an invalid release: ${JSON.stringify(defects)}`);
  return release;
}
