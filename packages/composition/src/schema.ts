// SPDX-License-Identifier: Apache-2.0
import type { CompositionComponent, CompositionRegistry } from './registry.ts';
import { NODE_ID_PATTERN } from './strings.ts';

const NODE = '#/$defs/node';

function jsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => jsonSchema(item));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('~')) continue;
    result[key] = jsonSchema(item);
  }
  return result;
}

function componentSchema(component: CompositionComponent): Record<string, unknown> {
  const source = jsonSchema(component.props) as { required?: string[]; properties?: Record<string, unknown> };
  const properties: Record<string, unknown> = {
    id: { type: 'string', minLength: 1, maxLength: 64, pattern: NODE_ID_PATTERN },
    ...(source.properties ?? {}),
  };
  for (const slot of component.slots) properties[slot] = { type: 'array', items: { $ref: NODE } };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'props'],
    properties: {
      type: { type: 'string', const: component.type },
      props: {
        type: 'object',
        additionalProperties: false,
        required: ['id', ...(source.required ?? []), ...component.slots],
        properties,
      },
    },
  };
}

/** JSON Schema 2020-12 for one registry. Safety rules are patterns, so schema-only checks match them. */
export function compositionSchema(registry: CompositionRegistry): Record<string, unknown> {
  const $defs: Record<string, unknown> = {
    node: { anyOf: registry.components.map((component) => ({ $ref: `#/$defs/${component.type}` })) },
  };
  for (const component of registry.components) $defs[component.type] = componentSchema(component);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['root', 'content'],
    properties: {
      root: {
        type: 'object',
        additionalProperties: false,
        required: ['props'],
        properties: { props: jsonSchema(registry.root) },
      },
      content: { type: 'array', items: { $ref: NODE } },
    },
    $defs,
  };
}
