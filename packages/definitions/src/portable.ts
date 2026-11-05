export * from './catalogue.ts';
export { releaseDigest } from './release-digest.ts';
export { createReleasedRelationDirectionResolver } from './released-relation-direction.ts';
export type {
  ReleasedRelationDirectionKind,
  ReleasedRelationDirectionResolver,
} from './released-relation-direction.ts';
import type { FilterDocument } from '@rezics/filter';
import schema from '../schema/release.json';
import type { LibraryProfile, LibraryProfileReference } from './library-profile.ts';
export { chooseLabel, languageRanges } from './language.ts';

export type {
  LibraryLabels,
  LibraryCountForms,
  LibraryUnitCountForms,
  LibraryProgressMode,
  LibraryProgressUnit,
  LibraryProfile,
  LibraryProfileReference,
  LibraryProfilePin,
  LibraryProfileSource,
} from './library-profile.ts';

export const RELEASE_FORMAT = 'https://rezics.com/definitions/release/1';
// Headroom over the bundled catalogue plus 100 launch-grain verticals (3 types and 12 properties each).
export const RELEASE_LIMITS = {
  types: 1024,
  properties: 4096,
  propertiesPerType: 64,
  facetsPerType: 16,
  contexts: 256,
  defaultsPerContext: 64,
  bytes: 4 * 1024 * 1024,
} as const;
export const DATA_TYPES = [
  'wikibase-item',
  'string',
  'external-id',
  'url',
  'monolingualtext',
  'quantity',
  'time',
  'document',
  'media',
] as const;
export type DataType = (typeof DATA_TYPES)[number];
export type TypeDefinition = {
  iri: string;
  labels: Record<string, string>;
  descriptions?: Record<string, string>;
  mappings: string[];
  bases: string[];
  properties: string[];
  facets: string[];
  coverRatio?: string;
  /** Effective inert card frame and ordered Search Fact property hints. */
  listPresentation?: {
    imageAspect: 'portrait' | 'landscape' | 'square';
    keyFacts: string[];
  };
  /** Explicit https://schema.org/Type IRI used as JSON-LD @type; absent in older releases. */
  schemaOrgType?: string;
  library?: LibraryProfileReference;
};
export type RelationGroup =
  | 'order'
  | 'derivation'
  | 'world'
  | 'membership'
  | 'association'
  | 'credit'
  | 'appearance'
  | 'classification';
export type RelationDefinition = {
  group: RelationGroup;
  inverse?: string;
  inverseLabels?: Record<string, string>;
  symmetric?: true;
  acyclic?: true;
  order?: 'position' | 'date' | 'name';
  filter?: string | string[];
  slotKey?: string;
};
export type RelationDirection = 'forward' | 'inverse';
export type ReleasedRelationQualifierMeaning = {
  id: string;
  datatype: string;
  labels: Record<string, string>;
};
export type ReleasedRelationDirection = {
  state: 'admitted';
  property: string;
  direction: RelationDirection;
  inverse: string | null;
  sourceTypes: string[];
  targetTypes: string[];
  viaQualifier?: string;
  release: string;
  qualifiers: ReleasedRelationQualifierMeaning[];
};
export type ReleasedRelationDirectionFailure = {
  state: 'unsupported' | 'unavailable';
  property: string;
  direction: RelationDirection;
  release: string | null;
  reason:
    | 'missing-release-pin'
    | 'stale-release'
    | 'missing-property'
    | 'missing-inverse'
    | 'ambiguous-inverse'
    | 'inapplicable-type'
    | 'stale-descriptor';
};
export type ReleasedRelationDirectionResult = ReleasedRelationDirection | ReleasedRelationDirectionFailure;
export type PropertyDefinition = {
  iri: string;
  labels: Record<string, string>;
  relation?: RelationDefinition;
  disclosure?: 'sourceOrConsent';
  descriptions?: Record<string, string>;
  mappings: string[];
  datatype: DataType;
  multivalued: boolean;
  targets?: string[];
  units?: string[];
  minimum?: number;
  minimumExclusive?: boolean;
  maximum?: number;
  qualifiers: string[];
  value: object;
};
export type ContextSettings = {
  labels: Record<string, string>;
  defaults: Record<string, 'inherit' | 'suppress'>;
};
export type SavedFilter = {
  labels: Record<string, string>;
  filter: FilterDocument;
};
export type Release = {
  format: typeof RELEASE_FORMAT;
  catalogue: { id: string; version: string };
  generator: { name: string; version: string };
  prefixes: Record<string, string>;
  types: Record<string, TypeDefinition>;
  properties: Record<string, PropertyDefinition>;
  contexts?: Record<string, ContextSettings>;
  filters?: Record<string, SavedFilter>;
  libraryProfiles?: Record<string, LibraryProfile>;
};
export type ReleaseViolation = { pointer: string; code: 'invalid' | 'unsafe_pattern' | 'limit' };

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const INTEGER = '^[+-](?:0|[1-9][0-9]*)$';
const DECIMAL = '^[+-](?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$';
export type ValueOptions = { pattern?: string; units?: string[]; integer?: boolean; exact?: true };

export function valueSchema(
  datatype: 'monolingualtext',
  options?: ValueOptions,
): Extract<ReturnType<typeof buildValueSchema>, { properties: { text: object } }>;
export function valueSchema(datatype: DataType, options?: ValueOptions): ReturnType<typeof buildValueSchema>;
export function valueSchema(datatype: DataType, options: ValueOptions = {}) {
  return buildValueSchema(datatype, options);
}

function buildValueSchema(datatype: DataType, options: ValueOptions) {
  if (Object.hasOwn(options, 'exact') && (datatype !== 'quantity' || options.exact !== true))
    throw new TypeError('Exact must be true and is only supported for quantity');
  if (
    (datatype === 'document' || datatype === 'media') &&
    (options.units !== undefined || options.integer !== undefined)
  )
    throw new TypeError(`Quantity options are not supported for ${datatype}`);
  if (options.pattern !== undefined && !['string', 'external-id', 'monolingualtext'].includes(datatype))
    throw new TypeError(`Patterns are not supported for ${datatype}`);
  const text = {
    type: 'string',
    minLength: 1,
    maxLength: 1500,
    ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
  };
  switch (datatype) {
    case 'media':
      return { type: 'string', pattern: `${UUID}(?![\\s\\S])` };
    case 'wikibase-item':
      return { type: 'string', pattern: UUID };
    case 'string':
    case 'external-id':
      return text;
    case 'url':
      return { type: 'string', maxLength: 1500, pattern: '^https?://[^\\s]+$' };
    case 'monolingualtext':
      return {
        type: 'object',
        required: ['text', 'language'],
        additionalProperties: false,
        properties: { text, language: { type: 'string', pattern: '^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$' } },
      };
    case 'document':
      return {
        type: 'object',
        required: ['language', 'document'],
        additionalProperties: false,
        properties: {
          language: { type: 'string', pattern: '^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$' },
          document: { type: 'object' },
        },
      };
    case 'quantity':
      return {
        type: 'object',
        required: ['amount', 'unit'],
        additionalProperties: false,
        properties: {
          amount: { type: 'string', pattern: options.integer ? INTEGER : DECIMAL },
          ...(options.exact
            ? {}
            : {
                lowerBound: { type: 'string', pattern: options.integer ? INTEGER : DECIMAL },
                upperBound: { type: 'string', pattern: options.integer ? INTEGER : DECIMAL },
              }),
          unit: options.units?.includes('*')
            ? { type: 'string', pattern: `^(?:1|${schema.$defs.iri.pattern})$` }
            : { enum: [...(options.units ?? [])] },
        },
      };
    case 'time':
      return {
        type: 'object',
        required: ['time', 'precision', 'calendarmodel'],
        additionalProperties: false,
        properties: {
          time: { type: 'string', maxLength: 33, pattern: '^[+-][0-9]{4,16}-[0-9]{2}-[0-9]{2}T00:00:00Z$' },
          precision: { enum: [9, 10, 11] },
          calendarmodel: {
            enum: ['http://www.wikidata.org/entity/Q1985727', 'http://www.wikidata.org/entity/Q1985786'],
          },
          timezone: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
          before: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
          after: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
        },
      };
    default:
      throw new TypeError(`Unknown data type: ${datatype}`);
  }
}
