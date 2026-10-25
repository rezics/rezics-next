// SPDX-License-Identifier: Apache-2.0
import Type, { type TSchema } from 'typebox';

import {
  CURIE_PATTERN,
  HREF_PATTERN,
  PLAIN_TEXT_PATTERN,
  type SafetyKind,
  curie,
  plainText,
  safetyKind,
} from './strings.ts';

export interface PageContext {
  subject: string | null;
}

export type PageRead =
  | { kind: 'subject'; id: string }
  | {
      kind: 'search';
      body: {
        filter: { statement: { property: string; in: string[] } };
        sort: 'name';
        limit: number;
      };
    };

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

export const SLOT_NAMES = ['header', 'hero', 'entity', 'aside', 'footer'] as const;

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
  properties?: Record<string, SchemaNode>;
  required?: readonly string[];
  additionalProperties?: unknown;
  patternProperties?: unknown;
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
}

const TYPE_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/u;
const closed = { additionalProperties: false } as const;

function asSchema(schema: TSchema): SchemaNode {
  return schema as SchemaNode;
}

function refuse(label: string): never {
  throw new Error(`${label} must be plain text, a link, a CURIE or a literal`);
}

function isSafeString(schema: SchemaNode): boolean {
  const kind: SafetyKind | undefined = safetyKind(schema);
  if (schema['~kind'] !== 'String' || typeof schema.pattern !== 'string' || kind === undefined) return false;
  if (kind === 'plainText') return schema.pattern === PLAIN_TEXT_PATTERN && typeof schema.maxLength === 'number';
  if (kind === 'href') return schema.pattern === HREF_PATTERN && schema.maxLength === 2_048;
  return schema.pattern === CURIE_PATTERN && schema.maxLength === 128;
}

/** Every string this schema can accept is a safety string or a literal. `label` is `<Type>.<prop>`. */
function assertAdmitted(schema: SchemaNode, label: string): void {
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
  page.subject === null ? null : { kind: 'subject', id: page.subject };

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
      props: Type.Object({ text: plainText({ maxLength: 200 }), level: enumeration([2, 3, 4]) }, closed),
    },
    {
      type: 'Text',
      props: Type.Object({ text: plainText({ maxLength: 2_000 }) }, closed),
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
          title: plainText({ maxLength: 120 }),
          property: curie(),
          limit: Type.Integer({ minimum: 1, maximum: 24 }),
        },
        closed,
      ),
      read: (props, page) =>
        page.subject === null
          ? null
          : {
              kind: 'search',
              body: {
                filter: { statement: { property: props.property as string, in: [page.subject] } },
                sort: 'name',
                limit: props.limit as number,
              },
            },
    },
  ],
});
