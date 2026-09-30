import { createHash } from 'node:crypto';
import { reservedNamespaces, type ProfileDefinition, type Term } from './ir.ts';
import { expand } from './outputs.ts';

export const typeLocales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
export const typeBases = ['work', 'resource', 'record'] as const;
export const typePresentations = [
  'book',
  'recipe',
  'prompt',
  'skill',
  'guide',
  'game',
  'media',
  'default',
] as const;
export const typeCovers = ['portrait', 'landscape', 'square', 'document'] as const;
export const typeInterests = ['books', 'software', 'ai', 'recipes', 'media'] as const;
export const typePrimaryActions = ['read', 'install', 'copy', 'watch', 'visit'] as const;
export const typeCreationPolicies = ['administrator', 'contributor'] as const;

export interface TypeMetadata {
  base: (typeof typeBases)[number];
  creation: (typeof typeCreationPolicies)[number];
  interest: (typeof typeInterests)[number] | null;
  primaryAction: (typeof typePrimaryActions)[number];
  presentation: (typeof typePresentations)[number];
  cover: (typeof typeCovers)[number];
  /** Lower values select the more specific presentation when a Work has multiple types. */
  priority: number;
  labels: Readonly<Record<(typeof typeLocales)[number], { one: string; other: string }>>;
}

export interface TypeRegistryDefinition {
  id: 'types-v1';
  /** Presentation fallbacks, not additional types admitted by a write operation. */
  defaults: Readonly<Record<(typeof typeBases)[number], Term>>;
  types: Readonly<Record<Term, TypeMetadata>>;
}

const namespaces = new Map<string, string>(Object.entries(reservedNamespaces));
const iri = (term: Term): string => {
  const value = expand(term, namespaces);
  if (!/^(?:https?:\/\/|urn:)[^\s<>"{}|\\^`]+$/.test(value))
    throw new Error(`Type is not an IRI: ${term}`);
  return value;
};
const knownFields = (value: object, fields: readonly string[], location: string): void => {
  const extra = Object.keys(value).find((key) => !fields.includes(key));
  if (extra) throw new Error(`Unsupported Type field ${extra} on ${location}`);
};

/** Read the owning Work shape's sh:in, never an unrelated revision shape's rdf:type. */
export function profileWorkTypes(profile: ProfileDefinition): string[] {
  const properties = profile.shapes
    .flatMap((shape) => shape.properties)
    .filter(
      (property) => property.path === 'rdf:type' && property.hasValue === 'schema:CreativeWork',
    );
  if (properties.length !== 1 || !properties[0]!.in?.length) {
    throw new Error(`${profile.id} must declare one Work rdf:type sh:in`);
  }
  const values = properties[0]!.in!.map(iri);
  if (new Set(values).size !== values.length || !values.includes(iri('schema:CreativeWork'))) {
    throw new Error(`${profile.id} must admit distinct Work types including CreativeWork`);
  }
  return values;
}

/** Fail closed when authored metadata, creation or type-edit admission drifts from its owner. */
export function compileTypes(
  definition: TypeRegistryDefinition,
  workKind: ProfileDefinition,
  workType: ProfileDefinition,
) {
  if (definition.id !== 'types-v1') throw new Error('Unsupported Type registry profile');
  knownFields(definition, ['id', 'defaults', 'types'], definition.id);
  knownFields(definition.defaults, typeBases, 'defaults');
  const defaults = new Map(typeBases.map((base) => [base, iri(definition.defaults[base])]));
  if (new Set(defaults.values()).size !== defaults.size)
    throw new Error('Type bases need distinct defaults');
  const workTypes = profileWorkTypes(workKind);
  const creatable = profileWorkTypes(workType).filter(
    (type) => type !== iri('schema:CreativeWork'),
  );
  if (creatable.some((type) => !workTypes.includes(type)))
    throw new Error('Type-edit profile admits an unknown Work type');
  const entries = Object.entries(definition.types)
    .map(([term, metadata]) => {
      const type = iri(term as Term);
      knownFields(
        metadata,
        [
          'base',
          'creation',
          'interest',
          'primaryAction',
          'presentation',
          'cover',
          'priority',
          'labels',
        ],
        type,
      );
      if (
        !typeBases.includes(metadata.base) ||
        !typeCreationPolicies.includes(metadata.creation) ||
        (metadata.interest !== null && !typeInterests.includes(metadata.interest)) ||
        !typePrimaryActions.includes(metadata.primaryAction) ||
        !typePresentations.includes(metadata.presentation) ||
        !typeCovers.includes(metadata.cover) ||
        !Number.isSafeInteger(metadata.priority) ||
        metadata.priority < 0
      )
        throw new Error(`Invalid Type metadata for ${type}`);
      knownFields(metadata.labels, typeLocales, `${type} labels`);
      for (const locale of typeLocales) {
        const forms = metadata.labels[locale];
        if (!forms) throw new Error(`${type} needs ${locale} labels`);
        knownFields(forms, ['one', 'other'], `${type} ${locale} labels`);
        for (const form of ['one', 'other'] as const) {
          const label = forms[form];
          if (
            typeof label !== 'string' ||
            !label ||
            label !== label.trim() ||
            label.length > 64 ||
            /[\u0000-\u001f\u007f]/u.test(label)
          )
            throw new Error(`${type} needs a ${locale} ${form} label`);
        }
      }
      return {
        type,
        base: metadata.base,
        default: defaults.get(metadata.base) === type,
        creatable: creatable.includes(type),
        creation: metadata.creation,
        interest: metadata.interest,
        primaryAction: metadata.primaryAction,
        presentation: metadata.presentation,
        cover: metadata.cover,
        priority: metadata.priority,
        labels: Object.fromEntries(
          typeLocales.map((locale) => [locale, metadata.labels[locale]]),
        ) as TypeMetadata['labels'],
      };
    })
    .sort((a, b) => a.type.localeCompare(b.type));
  if (new Set(entries.map((entry) => entry.type)).size !== entries.length)
    throw new Error('Duplicate Type IRI');
  for (const base of typeBases) {
    if (entries.filter((entry) => entry.base === base && entry.default).length !== 1) {
      throw new Error(`Type base ${base} needs one default entry`);
    }
  }
  const authoredWorkTypes = entries
    .filter((entry) => entry.base === 'work')
    .map((entry) => entry.type);
  if ([...authoredWorkTypes].sort().join() !== [...workTypes].sort().join()) {
    throw new Error('Type metadata and Work profile differ');
  }
  if (defaults.get('work') !== iri('schema:CreativeWork'))
    throw new Error('Work default must be CreativeWork');
  return entries;
}

export function renderTypeRegistry(
  definition: TypeRegistryDefinition,
  workKind: ProfileDefinition,
  workType: ProfileDefinition,
): string {
  const types = compileTypes(definition, workKind, workType);
  const body = JSON.stringify(
    Object.fromEntries(types.map((entry) => [entry.type, entry])),
    null,
    2,
  );
  return (
    '// Generated by task gen from types-v1 and the Work profiles. Do not edit.\n' +
    `export const typeLocales = ${JSON.stringify(typeLocales)} as const;\n` +
    `export const typeBases = ${JSON.stringify(typeBases)} as const;\n` +
    `export const typePresentations = ${JSON.stringify(typePresentations)} as const;\n` +
    `export const typeCovers = ${JSON.stringify(typeCovers)} as const;\n` +
    `export const typeInterests = ${JSON.stringify(typeInterests)} as const;\n` +
    `export const typePrimaryActions = ${JSON.stringify(typePrimaryActions)} as const;\n` +
    `export const typeCreationPolicies = ${JSON.stringify(typeCreationPolicies)} as const;\n` +
    '/** Owner profile order, retained by Main admission enums and catalogue consumers. */\n' +
    `export const workSemanticTypeOrder = ${JSON.stringify(profileWorkTypes(workKind).filter((type) => type !== iri('schema:CreativeWork')))} as const;\n` +
    `export const creatableWorkTypeOrder = ${JSON.stringify(profileWorkTypes(workType).filter((type) => type !== iri('schema:CreativeWork')))} as const;\n` +
    '/** Every admitted type once; Main serves this registry at GET /v1/types. */\n' +
    `export const typeRegistry = ${body} as const;\n` +
    'export type AdmittedType = keyof typeof typeRegistry;\n' +
    `export const typeRegistryDigest = ${JSON.stringify(createHash('sha256').update(body).digest('hex'))};\n`
  );
}
