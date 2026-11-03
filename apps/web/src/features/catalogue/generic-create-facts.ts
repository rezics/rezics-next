import type { PropertyDefinition, Release } from '@rezics/definitions';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { checkSubjectInput, type Violation } from '@rezics/definitions/validate';
import type { CreateType, InitialSubject, TermDraft } from './create-subject';
import { initialTerms } from './create-subject';
import {
  creationStatement,
  editableScalar,
  emptyCreationStatement,
  type SnakInput,
  type StatementInput,
} from './statement-editor';
import { factLimit } from './subject-facts';

const gregorian = 'http://www.wikidata.org/entity/Q1985727';
export type GenericCreateDescriptor = CreateType & {
  releaseDigest: string;
  definition: NonNullable<CreateType['definition']>;
  propertyDefinitions: Record<string, PropertyDefinition>;
};
export type GenericCreateFact = {
  holder: string;
  property: string;
  /** Kept with a private draft so withdrawal still has an honest read-only description. */
  definition: PropertyDefinition;
  /** Definitions and exact readable target summaries used by this one private holder only. */
  definitions: Record<string, PropertyDefinition>;
  targets: EntityPickerSubject[];
  statement: StatementInput;
};
export type GenericCreateRead = Pick<Release, 'types' | 'properties'>;
export type GenericCreatePrepared = {
  item: InitialSubject;
  errors: Violation[];
  read: GenericCreateRead;
  factTargets: Record<string, string>;
  unsupported: string[];
  withdrawn: string[];
};

/** Existing creation routes own these exact Types and must remain the only creator for them. */
const specializedCreatePaths: Record<string, string> = {
  'schema:MusicAlbum': '/catalogue/album',
  'schema:ComicSeries': '/catalogue/manga',
  'schema:PublicationVolume': '/catalogue/manga',
  'schema:Person': '/catalogue/people',
  'schema:Organization': '/catalogue/people',
  'schema:Book': '/catalogue/literary',
  'schema:BookSeries': '/catalogue/literary',
  'schema:Movie': '/catalogue/screen',
  'schema:TVSeries': '/catalogue/screen',
  'schema:TVSeason': '/catalogue/screen',
  'schema:Episode': '/catalogue/screen',
  'schema:VideoGame': '/catalogue/game',
  'wd:Q689445': '/catalogue/game',
  'wd:Q209163': '/catalogue/addon',
  'wd:Q20631656': '/catalogue/game',
  'wd:Q95074': '/catalogue/character',
  'schema:Recipe': '/catalogue/recipe',
  'wd:Q2620972': '/catalogue/story-arc',
  'schema:MediaObject': '/catalogue/file',
  'rezics:CatalogueFile': '/catalogue/file',
  'wd:Q82753': '/catalogue/file',
  'rezics:ReleaseGroup': '/catalogue/file',
  'wd:Q55327': '/catalogue/file',
};

export function genericCreateSpecializedPath(
  type: string | Pick<CreateType, 'id' | 'specializedPath'>,
): string | undefined {
  if (typeof type === 'string') return specializedCreatePaths[type];
  return type.specializedPath ?? specializedCreatePaths[type.id];
}

export function genericCreateDescriptor(type: CreateType | null | undefined): GenericCreateDescriptor | undefined {
  if (
    !type ||
    typeof type.releaseDigest !== 'string' ||
    !type.releaseDigest ||
    !type.definition ||
    !Array.isArray(type.definition.properties) ||
    type.definition.properties.length > 64 ||
    !type.propertyDefinitions ||
    typeof type.propertyDefinitions !== 'object' ||
    Array.isArray(type.propertyDefinitions) ||
    type.definition.properties.some((id) => !Object.hasOwn(type.propertyDefinitions!, id))
  )
    return;
  return type as GenericCreateDescriptor;
}

export function genericCreateRead(descriptor: GenericCreateDescriptor): GenericCreateRead {
  return {
    types: { [descriptor.id]: descriptor.definition },
    properties: descriptor.propertyDefinitions,
  };
}

export function genericCreatePropertySupported(definition: PropertyDefinition | undefined): boolean {
  if (!definition) return false;
  if (definition.datatype === 'wikibase-item') return !!definition.targets?.length;
  if (!editableScalar(definition)) return false;
  if (definition.datatype !== 'time') return true;
  const value = definition.value as { properties?: { calendarmodel?: { const?: unknown } } };
  return value.properties?.calendarmodel?.const === gregorian;
}

export function genericCreateFact(
  descriptor: GenericCreateDescriptor,
  property: string,
  holder = crypto.randomUUID(),
): GenericCreateFact | undefined {
  if (!descriptor.definition.properties.includes(property)) return;
  const definition = descriptor.propertyDefinitions[property];
  if (!definition) return;
  const statement = emptyCreationStatement(property, { properties: descriptor.propertyDefinitions });
  if (['monolingualtext', 'time', 'quantity'].includes(definition.datatype))
    statement.value = { type: 'value', content: {} };
  return {
    holder,
    property,
    definition,
    definitions: genericCreateFactDefinitions(statement, descriptor),
    targets: [],
    statement,
  };
}

export function genericCreateFactDefinitions(
  statement: StatementInput,
  descriptor: GenericCreateDescriptor,
  previous: Record<string, PropertyDefinition> = {},
): Record<string, PropertyDefinition> {
  const ids = new Set([
    statement.property.id,
    ...(statement.qualifiers ?? []).map((part) => part.property.id),
    ...statement.references.flatMap((reference) => reference.parts.map((part) => part.property.id)),
  ]);
  const definitions: Record<string, PropertyDefinition> = Object.create(null);
  for (const id of ids) {
    const definition = descriptor.propertyDefinitions[id] ?? previous[id];
    if (definition) definitions[id] = definition;
  }
  return definitions;
}

export function canAddGenericFact(facts: GenericCreateFact[], definition: PropertyDefinition | undefined): boolean {
  if (!definition || facts.length >= factLimit) return false;
  const current = facts.filter((fact) => fact.property === definition.iri).length;
  return definition.multivalued || current === 0;
}

function hasValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasValue);
  if (value && typeof value === 'object')
    return Object.entries(value).some(
      ([key, item]) => !['unit', 'precision', 'calendarmodel', 'language'].includes(key) && hasValue(item),
    );
  return false;
}

export function genericCreateStatementEntered(statement: StatementInput): boolean {
  const partEntered = (part: { value: { type: string; content?: unknown } }) =>
    part.value.type !== 'value' || hasValue(part.value.content);
  return (
    partEntered(statement) ||
    (statement.qualifiers ?? []).some(partEntered) ||
    statement.references.some((reference) => reference.parts.some(partEntered))
  );
}

export function genericCreateTargetIds(statement: StatementInput, except?: SnakInput): Set<string> {
  const parts: SnakInput[] = [
    statement,
    ...(statement.qualifiers ?? []),
    ...statement.references.flatMap((reference) => reference.parts),
  ];
  return new Set(
    parts.flatMap((part) => {
      if (part === except || part.value.type !== 'value' || typeof part.value.content !== 'string') return [];
      return [part.value.content];
    }),
  );
}

const escape = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');

export function refreshGenericCreateFacts(
  facts: GenericCreateFact[],
  descriptor: GenericCreateDescriptor,
): GenericCreateFact[] {
  return facts.map((fact) => {
    const definition = descriptor.definition.properties.includes(fact.property)
      ? descriptor.propertyDefinitions[fact.property]
      : undefined;
    return definition
      ? {
          ...fact,
          definition,
          definitions: genericCreateFactDefinitions(fact.statement, descriptor, fact.definitions),
        }
      : fact;
  });
}

export function prepareGenericCreate(
  type: string,
  rows: TermDraft[],
  facts: GenericCreateFact[],
  descriptor: GenericCreateDescriptor,
): GenericCreatePrepared {
  const terms = initialTerms(type, rows);
  const item: InitialSubject = { ...terms.item };
  const errors = [...terms.errors];
  const factTargets: Record<string, string> = Object.create(null);
  const unsupported: string[] = [];
  const withdrawn: string[] = [];
  const statements: NonNullable<InitialSubject['statements']> = Object.create(null);
  for (const fact of facts) {
    const admitted = descriptor.definition.properties.includes(fact.property);
    const definition = admitted ? descriptor.propertyDefinitions[fact.property] : undefined;
    if (!admitted || !definition) {
      const index = statements[fact.property]?.length ?? 0;
      const pointer = `/statements/${escape(fact.property)}/${index}`;
      factTargets[pointer] = `generic-fact-${fact.holder}`;
      withdrawn.push(fact.holder);
      errors.push({ pointer: `${pointer}/property/id`, code: 'unsupported' });
      continue;
    }
    if (!genericCreatePropertySupported(definition)) {
      if (genericCreateStatementEntered(fact.statement)) unsupported.push(fact.holder);
      continue;
    }
    const prepared = creationStatement(fact.statement, { properties: descriptor.propertyDefinitions });
    if (!genericCreateStatementEntered(prepared)) continue;
    const index = statements[fact.property]?.length ?? 0;
    const pointer = `/statements/${escape(fact.property)}/${index}`;
    factTargets[pointer] = `generic-fact-${fact.holder}`;
    (statements[fact.property] ??= []).push(prepared);
  }
  if (Object.keys(statements).length) item.statements = statements;
  const read = genericCreateRead(descriptor);
  const checked = checkSubjectInput(item, read);
  const seen = new Set(errors.map((error) => `${error.pointer}:${error.code}`));
  for (const error of checked.violations) {
    if (!seen.has(`${error.pointer}:${error.code}`)) errors.push(error);
  }
  return { item, errors: errors.slice(0, 16), read, factTargets, unsupported, withdrawn };
}

export function updateGenericFact(
  facts: GenericCreateFact[],
  holder: string,
  update: (fact: GenericCreateFact) => GenericCreateFact,
): GenericCreateFact[] {
  return facts.map((fact) => (fact.holder === holder ? update(fact) : fact));
}
