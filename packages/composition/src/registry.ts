// SPDX-License-Identifier: Apache-2.0
import Type, { type TSchema } from 'typebox';
import type { FilterDocument } from '@rezics/filter';
import { publicFilterProp, typeListFilter } from './filter.ts';

import {
  CURIE_PATTERN,
  HREF_PATTERN,
  LOCALE_KEY_PATTERN,
  MAX_LOCALIZED_ENTRIES,
  PLAIN_TEXT_PATTERN,
  type SafetyKind,
  curie,
  href,
  localizedText,
  plainText,
  subjectId,
  safetyKind,
} from './strings.ts';

export const PAGE_GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';
export type SelectedContext = {
  id: string;
  population: { kind: 'global' } | { kind: 'realm'; id: string; title: string };
};
export type PageContinuation = { node: string; cursor: string };

export interface PageContext {
  subject: string | null;
  context?: SelectedContext;
  continuation?: PageContinuation;
  /** The account the page is for, resolved before planning. */
  account?: { id: string; handle: string } | null;
}

export type MemberSource =
  | { kind: 'collection'; id: string }
  | { kind: 'everything' }
  | { kind: 'state'; profileId: string; stateSetId: string; stateId: string };

export type PageFilter = FilterDocument;

type InferredStatementRead = {
  kind: 'search';
  body: {
    filter: { statement: { property: string; in: string[] } };
    sort: 'name';
    limit: number;
  };
};

export type PageRead =
  | { kind: 'members'; source: MemberSource; filter?: string; sort: 'id'; limit: number; cursor?: string }
  | { kind: 'subject'; id: string; context?: string }
  | {
      kind: 'links';
      id: string;
      context?: string;
      property: string;
      filter?: string;
      type?: string;
      limit: number;
      cursor?: string;
    }
  | {
      kind: 'relations';
      id: string;
      context?: string;
      property: string;
      filter?: string;
      type?: string;
      limit: number;
      cursor?: string;
    }
  | {
      kind: 'subjectThreads';
      id: string;
      place: string;
      threadKind: 'discussion' | 'review';
      limit: number;
      cursor?: string;
    }
  | { kind: 'collections'; id: string; limit: number }
  | { kind: 'reactions'; id: string }
  | { kind: 'account'; handle: string }
  | { kind: 'accountThreads'; id: string; threadKind: 'discussion' | 'review'; limit: number }
  | { kind: 'accountPosts'; id: string; limit: number }
  | { kind: 'accountCollections'; id: string; limit: number }
  | {
      kind: 'search';
      cursor?: string;
      body: {
        filter: PageFilter;
        sort: 'name' | 'collections';
        limit: number;
      };
    }
  | InferredStatementRead;

type ComponentRead = (props: CompositionNode['props'], page: PageContext) => PageRead | null;

export const MAX_COMPOSITION_BYTES = 65_536;
export const MAX_COMPOSITION_NODES = 256;
export const MAX_COMPOSITION_DEPTH = 8;

export const APPEARANCE = {
  density: ['compact', 'comfortable'],
  radius: ['sm', 'md', 'lg'],
  surface: ['flat', 'cards'],
  cover: ['portrait', 'square', 'landscape'],
  headingScale: ['md', 'lg'],
} as const;

export const SLOT_NAMES = ['header', 'hero', 'entity', 'aside', 'footer', 'actions', 'personal'] as const;

export interface CompositionNode {
  type: string;
  props: { id: string; [key: string]: unknown };
}

export interface CompositionDocument {
  root: { props: Record<string, unknown> };
  content: CompositionNode[];
}

export type CompositionViolationCode = 'invalid' | 'unknown_type' | 'unsafe' | 'duplicate' | 'limit';

export interface CompositionViolation {
  pointer: string;
  code: CompositionViolationCode;
}

export interface CompositionComponent {
  type: string;
  props: TSchema;
  slots: readonly string[];
  read?: ComponentRead;
}

export interface CompositionRegistry {
  root: TSchema;
  components: readonly CompositionComponent[];
}

export interface SchemaNode {
  '~kind'?: string;
  type?: string;
  format?: string;
  properties?: Record<string, SchemaNode>;
  required?: readonly string[];
  additionalProperties?: unknown;
  patternProperties?: unknown;
  propertyNames?: SchemaNode;
  anyOf?: readonly SchemaNode[];
  items?: SchemaNode;
  const?: unknown;
  pattern?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
}

const TYPE_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/u;
const closed = { additionalProperties: false } as const;

function asSchema(schema: TSchema): SchemaNode {
  return schema as SchemaNode;
}

function refuse(label: string): never {
  throw new Error(`${label} must be plain text, localized text, a link, a CURIE or a literal`);
}

function isSchemaNode(value: unknown): value is SchemaNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainText(schema: SchemaNode): boolean {
  return (
    schema['~kind'] === 'String' &&
    safetyKind(schema) === 'plainText' &&
    schema.pattern === PLAIN_TEXT_PATTERN &&
    typeof schema.maxLength === 'number'
  );
}

/** Plain text, or a map of 1–16 locale keys to that same plain text. */
function isLocalizedText(schema: SchemaNode): boolean {
  if (safetyKind(schema) !== 'localizedText' || schema['~kind'] !== 'Union') return false;
  const members = schema.anyOf;
  if (members === undefined || members.length !== 2) return false;
  const text = members[0];
  const map = members[1];
  if (text === undefined || map === undefined || !isPlainText(text) || map['~kind'] !== 'Object') return false;
  if (map.minProperties !== 1 || map.maxProperties !== MAX_LOCALIZED_ENTRIES) return false;
  if (map.patternProperties !== undefined || Object.keys(map.properties ?? {}).length !== 0) return false;
  const names = map.propertyNames;
  if (names?.['~kind'] !== 'String' || names.pattern !== LOCALE_KEY_PATTERN) return false;
  const values = map.additionalProperties;
  return isSchemaNode(values) && isPlainText(values) && values.maxLength === text.maxLength;
}

function isSafeString(schema: SchemaNode): boolean {
  const kind: SafetyKind | undefined = safetyKind(schema);
  if (schema['~kind'] !== 'String' || typeof schema.pattern !== 'string' || kind === undefined) return false;
  if (kind === 'plainText') return isPlainText(schema);
  if (kind === 'href') return schema.pattern === HREF_PATTERN && schema.maxLength === 2_048;
  if (kind === 'curie') return schema.pattern === CURIE_PATTERN && schema.maxLength === 128;
  if (kind === 'subjectId')
    return (
      schema.pattern === '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\\s\\S])' &&
      schema.format === 'uuid' &&
      schema.minLength === 36 &&
      schema.maxLength === 36
    );
  return false;
}

/** Every string this schema can accept is a safety string or a literal. `label` is `<Type>.<prop>`. */
function assertAdmitted(schema: SchemaNode, label: string): void {
  if (schema === publicFilterProp) return;
  if (safetyKind(schema) === 'localizedText') {
    if (!isLocalizedText(schema)) refuse(label);
    return;
  }
  const kind = schema['~kind'];
  if (kind === 'String') {
    if (!isSafeString(schema)) refuse(label);
    return;
  }
  if (kind === 'Literal' || kind === 'Integer' || kind === 'Number' || kind === 'Boolean') return;
  if (kind === 'Union') {
    if (!schema.anyOf?.length) refuse(label);
    for (const member of schema.anyOf) assertAdmitted(member, label);
    return;
  }
  if (kind === 'Array') {
    if (!schema.items) refuse(label);
    assertAdmitted(schema.items, label);
    return;
  }
  if (kind === 'Object') {
    assertClosed(schema, label);
    for (const [key, property] of Object.entries(schema.properties ?? {})) assertAdmitted(property, `${label}.${key}`);
    return;
  }
  refuse(label);
}

function assertClosed(schema: SchemaNode, label: string): void {
  if (schema['~kind'] !== 'Object' || schema.additionalProperties !== false || schema.patternProperties !== undefined) {
    throw new Error(`${label} must be a closed object`);
  }
}

function enumeration(values: readonly (string | number)[]) {
  const members = values.map((value) => Type.Literal(value));
  const first = members[0];
  if (first === undefined) throw new Error('An enumeration needs a value');
  return Type.Union([first, ...members.slice(1)]);
}

export interface ComponentDefinition {
  type: string;
  props: TSchema;
  slots?: readonly string[];
  read?: ComponentRead;
}

export function defineRegistry(input: {
  root: TSchema;
  components: readonly ComponentDefinition[];
}): CompositionRegistry {
  const root = asSchema(input.root);
  assertClosed(root, 'root');
  for (const [key, property] of Object.entries(root.properties ?? {})) assertAdmitted(property, `root.${key}`);

  const seen = new Set<string>();
  const components: CompositionComponent[] = [];
  for (const component of input.components) {
    if (!TYPE_NAME.test(component.type)) throw new Error(`component type ${component.type} is not a closed name`);
    if (seen.has(component.type)) throw new Error(`duplicate component type ${component.type}`);
    seen.add(component.type);
    const props = asSchema(component.props);
    assertClosed(props, component.type);
    const properties = props.properties ?? {};
    if (Object.hasOwn(properties, 'id')) throw new Error(`${component.type}.id`);
    const slots: string[] = [];
    const slotNames = new Set<string>();
    for (const slot of component.slots ?? []) {
      if (
        typeof slot !== 'string' ||
        slot.length === 0 ||
        slot === 'id' ||
        slotNames.has(slot) ||
        Object.hasOwn(properties, slot)
      ) {
        throw new Error(`${component.type}.${typeof slot === 'string' && slot.length > 0 ? slot : 'slots'}`);
      }
      slotNames.add(slot);
      slots.push(slot);
    }
    for (const [key, property] of Object.entries(properties)) assertAdmitted(property, `${component.type}.${key}`);
    components.push({
      type: component.type,
      props: component.props,
      slots,
      ...(component.read ? { read: component.read } : {}),
    });
  }
  return { root: input.root, components };
}

const appearance = Type.Object(
  {
    density: Type.Optional(enumeration(APPEARANCE.density)),
    radius: Type.Optional(enumeration(APPEARANCE.radius)),
    surface: Type.Optional(enumeration(APPEARANCE.surface)),
    cover: Type.Optional(enumeration(APPEARANCE.cover)),
    headingScale: Type.Optional(enumeration(APPEARANCE.headingScale)),
  },
  closed,
);

const readSubject: ComponentRead = (_props, page) =>
  page.subject === null
    ? null
    : { kind: 'subject', id: page.subject, ...(page.context ? { context: page.context.id } : {}) };

/**
 * The inverse links of the page subject for one property. Appearances and credits share it with `RelationGroups`; a
 * component with `direction: 'forward'` uses the separate native outbound relation stream.
 */
const linkProps = {
  property: curie(),
  filter: Type.Optional(subjectId()),
  type: Type.Optional(curie()),
  limit: Type.Integer({ minimum: 1, maximum: 24 }),
  paged: Type.Optional(Type.Boolean()),
} as const;

const readLinks: ComponentRead = (props, page) =>
  page.subject === null
    ? null
    : {
        kind: 'links',
        id: page.subject,
        ...(page.context ? { context: page.context.id } : {}),
        property: props.property as string,
        ...(props.filter === undefined ? {} : { filter: props.filter as string }),
        ...(props.type === undefined ? {} : { type: props.type as string }),
        limit: props.paged === true ? Math.min(12, props.limit as number) : (props.limit as number),
      };

const readDirected: ComponentRead = (props, page) => {
  const read = readLinks(props, page);
  return props.direction === 'forward' && read?.kind === 'links' ? { ...read, kind: 'relations' } : read;
};

/** The native Content place follows the guarded page population, independently of the factual Context ID. */
const readSubjectThreads =
  (threadKind: 'discussion' | 'review'): ComponentRead =>
  (_props, page) =>
    page.subject === null
      ? null
      : {
          kind: 'subjectThreads',
          id: page.subject,
          place: page.context?.population.kind === 'realm' ? page.context.population.id : PAGE_GLOBAL_CONTEXT,
          threadKind,
          // Preserve the selected-Realm window; Global previews use the adopted six-entry window.
          limit: page.context?.population.kind === 'realm' ? 5 : 6,
        };

export const platformRegistry = defineRegistry({
  root: Type.Object({ appearance: Type.Optional(appearance) }, closed),
  components: [
    {
      type: 'Stack',
      props: Type.Object({ gap: enumeration(['sm', 'md', 'lg']) }, closed),
      slots: ['children'],
    },
    {
      type: 'Columns',
      props: Type.Object({ split: enumeration(['even', 'start', 'end']) }, closed),
      slots: ['start', 'end'],
    },
    {
      type: 'Heading',
      props: Type.Object({ text: localizedText({ maxLength: 200 }), level: enumeration([1, 2, 3, 4]) }, closed),
    },
    {
      type: 'Text',
      props: Type.Object({ text: localizedText({ maxLength: 2_000 }) }, closed),
    },
    {
      type: 'Slot',
      props: Type.Object({ name: enumeration(SLOT_NAMES) }, closed),
      slots: ['children'],
    },
    {
      type: 'SubjectHeader',
      props: Type.Object({}, closed),
      read: readSubject,
    },
    {
      type: 'Statements',
      props: Type.Object({ properties: Type.Array(curie(), { minItems: 1, maxItems: 32, uniqueItems: true }) }, closed),
      read: readSubject,
    },
    {
      type: 'MoreStatements',
      props: Type.Object({}, closed),
      read: readSubject,
    },
    {
      type: 'SubjectList',
      props: Type.Object(
        {
          title: localizedText({ maxLength: 120 }),
          property: curie(),
          limit: Type.Integer({ minimum: 1, maximum: 24 }),
          paged: Type.Optional(Type.Boolean()),
        },
        closed,
      ),
      read: (props, page) =>
        page.subject === null
          ? null
          : {
              kind: 'links',
              id: page.subject,
              ...(page.context ? { context: page.context.id } : {}),
              property: props.property as string,
              limit: props.paged === true ? Math.min(12, props.limit as number) : (props.limit as number),
            },
    },
    {
      type: 'RelationGroups',
      props: Type.Object({ title: Type.Optional(localizedText({ maxLength: 120 })), ...linkProps }, closed),
      read: readLinks,
    },
    {
      type: 'OutgoingRelations',
      props: Type.Object({ title: Type.Optional(localizedText({ maxLength: 120 })), ...linkProps }, closed),
      read: (props, page) => {
        if (props.paged !== true) return readSubject(props, page);
        const read = readLinks(props, page);
        return read?.kind === 'links' ? { ...read, kind: 'relations' } : read;
      },
    },
    {
      type: 'Cover',
      props: Type.Object({}, closed),
      read: readSubject,
    },
    {
      type: 'Summary',
      props: Type.Object({}, closed),
      read: readSubject,
    },
    {
      type: 'Appearances',
      props: Type.Object({ direction: Type.Optional(enumeration(['forward', 'inverse'])), ...linkProps }, closed),
      read: readDirected,
    },
    {
      type: 'Credits',
      props: Type.Object(
        {
          ...linkProps,
          title: Type.Optional(localizedText({ maxLength: 120 })),
          direction: Type.Optional(enumeration(['forward', 'inverse'])),
        },
        closed,
      ),
      // Current Subject previews already carry bounded native rows and their counts, independent of role count.
      read: (props, page) =>
        props.direction === 'forward' && props.paged !== true ? readSubject(props, page) : readDirected(props, page),
    },
    {
      type: 'RatingSummary',
      props: Type.Object({}, closed),
    },
    {
      type: 'ThreadList',
      props: Type.Object({ paged: Type.Optional(Type.Boolean()) }, closed),
      read: readSubjectThreads('discussion'),
    },
    {
      type: 'ReviewList',
      props: Type.Object({ paged: Type.Optional(Type.Boolean()) }, closed),
      read: readSubjectThreads('review'),
    },
    {
      type: 'Sources',
      props: Type.Object({}, closed),
      read: readSubject,
    },
    {
      type: 'CollectionList',
      props: Type.Object(
        {
          title: localizedText({ maxLength: 120 }),
          limit: Type.Integer({ minimum: 1, maximum: 6 }),
          paged: Type.Optional(Type.Boolean()),
        },
        closed,
      ),
      read: (_props, page) =>
        page.subject === null ? null : { kind: 'collections', id: page.subject, limit: _props.limit as number },
    },
    {
      type: 'ReactionSummary',
      props: Type.Object({}, closed),
      read: (_props, page) => (page.subject === null ? null : { kind: 'reactions', id: page.subject }),
    },
    {
      type: 'AccountIdentity',
      props: Type.Object({}, closed),
      read: (_props, page) => (page.account == null ? null : { kind: 'account', handle: page.account.handle }),
    },
    {
      type: 'AccountThreads',
      props: Type.Object(
        {
          threadKind: enumeration(['discussion', 'review']),
          limit: Type.Integer({ minimum: 1, maximum: 20 }),
          paged: Type.Optional(Type.Boolean()),
        },
        closed,
      ),
      read: (props, page) =>
        page.account == null
          ? null
          : {
              kind: 'accountThreads',
              id: page.account.id,
              threadKind: props.threadKind as 'discussion' | 'review',
              limit: props.paged === true ? Math.min(12, props.limit as number) : (props.limit as number),
            },
    },
    {
      type: 'AccountPosts',
      props: Type.Object(
        { limit: Type.Integer({ minimum: 1, maximum: 20 }), paged: Type.Optional(Type.Boolean()) },
        closed,
      ),
      read: (props, page) =>
        page.account == null ? null : { kind: 'accountPosts', id: page.account.id, limit: props.limit as number },
    },
    {
      type: 'AccountCollections',
      props: Type.Object(
        { limit: Type.Integer({ minimum: 1, maximum: 24 }), paged: Type.Optional(Type.Boolean()) },
        closed,
      ),
      read: (props, page) =>
        page.account == null ? null : { kind: 'accountCollections', id: page.account.id, limit: props.limit as number },
    },
    {
      type: 'SearchBox',
      props: Type.Object({ placeholder: localizedText({ maxLength: 80 }) }, closed),
    },
    {
      type: 'LinkGrid',
      props: Type.Object(
        {
          links: Type.Array(Type.Object({ label: localizedText({ maxLength: 60 }), href: href() }, closed), {
            minItems: 1,
            maxItems: 12,
          }),
        },
        closed,
      ),
    },
    {
      type: 'Members',
      props: Type.Object(
        {
          title: localizedText({ maxLength: 120 }),
          source: Type.Union([
            Type.Object({ kind: Type.Literal('everything') }, closed),
            Type.Object({ kind: Type.Literal('collection'), id: subjectId() }, closed),
            Type.Object(
              {
                kind: Type.Literal('state'),
                profileId: plainText({ maxLength: 64 }),
                stateSetId: plainText({ maxLength: 64 }),
                stateId: plainText({ maxLength: 64 }),
              },
              closed,
            ),
          ]),
          // The ordinary common-members GET filter wire; its owner admits grammar and meaning.
          filter: Type.Optional(plainText({ maxLength: 8192 })),
          limit: Type.Integer({ minimum: 1, maximum: 24 }),
          paged: Type.Optional(Type.Boolean()),
        },
        closed,
      ),
      read: (props) => ({
        kind: 'members',
        source: props.source as MemberSource,
        ...(props.filter === undefined ? {} : { filter: props.filter as string }),
        sort: 'id',
        limit: props.paged === true ? Math.min(12, props.limit as number) : (props.limit as number),
      }),
    },
    {
      type: 'TypeList',
      props: Type.Object(
        {
          title: localizedText({ maxLength: 120 }),
          types: Type.Array(curie(), { minItems: 1, maxItems: 8, uniqueItems: true }),
          filter: publicFilterProp,
          paged: Type.Optional(Type.Boolean()),
          sort: enumeration(['name', 'collections']),
          limit: Type.Integer({ minimum: 1, maximum: 24 }),
        },
        closed,
      ),
      read: (props) => ({
        kind: 'search',
        body: {
          filter: typeListFilter(props.types as string[], props.filter),
          sort: props.sort as 'name' | 'collections',
          limit: props.paged === true ? Math.min(12, props.limit as number) : (props.limit as number),
        },
      }),
    },
  ],
});
