import { APPEARANCE, UI_LOCALES, platformRegistry, validateComposition } from '@rezics/composition';
import type { CompositionDocument, CompositionRegistry } from '@rezics/composition';
import type { Config } from '@puckeditor/core';

type Schema = {
  '~kind'?: string;
  '~safety'?: string;
  const?: unknown;
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: unknown;
  patternProperties?: unknown;
  items?: Schema;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
};

type EditorNode = {
  type: string;
  props: Record<string, unknown>;
  _localizedValues?: Record<string, unknown>;
  [key: string]: unknown;
};

export type PageEditorData = {
  root: { props: Record<string, unknown>; _compositionRootProps?: Record<string, unknown>; [key: string]: unknown };
  content: EditorNode[];
  [key: string]: unknown;
};

const appearanceNames = Object.keys(APPEARANCE) as (keyof typeof APPEARANCE)[];

function asSchema(value: unknown): Schema {
  return value as Schema;
}

function schemaProperties(schema: Schema): Record<string, Schema> {
  return schema.properties ?? {};
}

function enumeration(schema: Schema): unknown[] | null {
  if (schema['~kind'] === 'Literal' && Object.hasOwn(schema, 'const')) return [schema.const];
  if (schema['~kind'] !== 'Union' || !schema.anyOf?.length) return null;
  if (!schema.anyOf.every((member) => member['~kind'] === 'Literal' && Object.hasOwn(member, 'const'))) return null;
  return schema.anyOf.map((member) => member.const);
}

function localized(schema: Schema): boolean {
  return schema['~safety'] === 'localizedText';
}

function curie(schema: Schema): boolean {
  return schema['~kind'] === 'String' && schema['~safety'] === 'curie';
}

function href(schema: Schema): boolean {
  return schema['~kind'] === 'String' && schema['~safety'] === 'href';
}

function subjectId(schema: Schema): boolean {
  return schema['~kind'] === 'String' && schema['~safety'] === 'subjectId';
}

function curieArray(schema: Schema): boolean {
  return schema['~kind'] === 'Array' && schema.items !== undefined && curie(schema.items);
}

function closedObject(schema: Schema | undefined): schema is Schema {
  return (
    schema !== undefined &&
    schema['~kind'] === 'Object' &&
    schema.additionalProperties === false &&
    schema.patternProperties === undefined
  );
}

function unsupported(component: string, prop: string): never {
  throw new TypeError(`Unsupported schema for ${component}.${prop}`);
}

function displayName(locale: string): string {
  return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
}

function objectChoices(schema: Schema): boolean {
  return schema['~kind'] === 'Union' && !!schema.anyOf?.length && schema.anyOf.every(closedObject);
}

function integerBounds(schema: Schema): { lower: number; upper: number } {
  const lower = Math.max(
    schema.minimum === undefined ? Number.NEGATIVE_INFINITY : Math.ceil(schema.minimum),
    schema.exclusiveMinimum === undefined ? Number.NEGATIVE_INFINITY : Math.floor(schema.exclusiveMinimum) + 1,
  );
  const upper = Math.min(
    schema.maximum === undefined ? Number.POSITIVE_INFINITY : Math.floor(schema.maximum),
    schema.exclusiveMaximum === undefined ? Number.POSITIVE_INFINITY : Math.ceil(schema.exclusiveMaximum) - 1,
  );
  if (lower > upper) throw new TypeError('Integer schema has no valid default');
  return { lower, upper };
}

function fieldFor(schema: Schema, component: string, prop: string, locale = 'en'): Record<string, unknown> {
  if (schema['~kind'] === 'PublicFilter') return { type: 'textarea' };
  const values = enumeration(schema);
  if (values !== null) {
    return {
      type: 'select',
      options: values.map((value) => ({ label: String(value), value })),
    };
  }

  if (localized(schema)) {
    return {
      type: 'object',
      objectFields: Object.fromEntries(
        UI_LOCALES.map((locale) => [locale, { type: 'textarea', label: displayName(locale) }]),
      ),
    };
  }

  if (schema['~kind'] === 'Integer') {
    const { lower, upper } = integerBounds(schema);
    return {
      type: 'number',
      ...(Number.isFinite(lower) ? { min: lower } : {}),
      ...(Number.isFinite(upper) ? { max: upper } : {}),
      step: 1,
    };
  }

  if (objectChoices(schema) || schema['~safety'] === 'plainText') return { type: 'textarea' };
  if (curie(schema) || href(schema) || subjectId(schema)) return { type: 'text' };

  if (curieArray(schema)) {
    return {
      type: 'array',
      arrayFields: { value: { type: 'text' } },
      ...(schema.minItems !== undefined ? { min: schema.minItems } : {}),
      ...(schema.maxItems !== undefined ? { max: schema.maxItems } : {}),
      defaultItemProps: { value: 'schema:name' },
    };
  }

  const itemSchema = schema['~kind'] === 'Array' ? schema.items : undefined;
  if (closedObject(itemSchema)) {
    return {
      type: 'array',
      arrayFields: Object.fromEntries(
        Object.entries(schemaProperties(itemSchema)).map(([field, fieldSchema]) => [
          field,
          fieldFor(fieldSchema, component, `${prop}.${field}`, locale),
        ]),
      ),
      ...(schema.minItems !== undefined ? { min: schema.minItems } : {}),
      ...(schema.maxItems !== undefined ? { max: schema.maxItems } : {}),
      defaultItemProps: defaultFor(itemSchema, component, prop, locale),
    };
  }

  if (schema['~kind'] === 'Boolean') {
    return {
      type: 'radio',
      options: [
        { label: 'true', value: true },
        { label: 'false', value: false },
      ],
    };
  }

  return unsupported(component, prop);
}

function integerDefault(schema: Schema): number {
  const { lower, upper } = integerBounds(schema);
  if (Number.isFinite(lower)) return lower;
  return upper < 0 ? upper : 0;
}

function defaultFor(schema: Schema, component: string, prop: string, locale: string): unknown {
  const values = enumeration(schema);
  if (values !== null) return values[0];
  if (localized(schema)) return { [UI_LOCALES.includes(locale as (typeof UI_LOCALES)[number]) ? locale : 'en']: '' };
  if (schema['~kind'] === 'Integer') return integerDefault(schema);
  if (objectChoices(schema)) return JSON.stringify(defaultFor(schema.anyOf![0]!, component, prop, locale));
  if (schema['~safety'] === 'plainText') return '';
  if (href(schema)) return '/';
  if (curie(schema)) return 'schema:name';
  if (subjectId(schema)) return '00000000-0000-8000-8000-000000000000';
  if (curieArray(schema)) {
    const count = Math.max(0, schema.minItems ?? 0);
    if (schema.maxItems !== undefined && count > schema.maxItems) {
      throw new TypeError(`No valid default for ${component}.${prop}`);
    }
    return Array.from({ length: count }, (_, index) => ({ value: `schema:property${index + 1}` }));
  }
  const itemSchema = schema['~kind'] === 'Array' ? schema.items : undefined;
  if (closedObject(itemSchema)) {
    const count = Math.max(0, schema.minItems ?? 0);
    if (schema.maxItems !== undefined && count > schema.maxItems) {
      throw new TypeError(`No valid default for ${component}.${prop}`);
    }
    return Array.from({ length: count }, () => defaultFor(itemSchema, component, prop, locale));
  }
  if (closedObject(schema)) {
    return Object.fromEntries(
      Object.entries(schemaProperties(schema)).map(([field, fieldSchema]) => [
        field,
        defaultFor(fieldSchema, component, `${prop}.${field}`, locale),
      ]),
    );
  }
  if (schema['~kind'] === 'Boolean') return false;
  return unsupported(component, prop);
}

type RegistryComponent = { schema: Schema; slots: readonly string[] };

function registryComponents(registry: CompositionRegistry): Map<string, RegistryComponent> {
  const components = new Map<string, RegistryComponent>();
  for (const component of registry.components) {
    components.set(component.type, { schema: asSchema(component.props), slots: component.slots });
  }
  return components;
}

function transformLocalized(
  value: unknown,
  direction: 'to' | 'from',
  path: (string | number)[],
  originals: Record<string, unknown>,
): unknown {
  const key = JSON.stringify(path);
  if (direction === 'from') {
    if (typeof value === 'string') {
      originals[key] = value;
      return { en: value };
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      originals[key] = { ...value };
      return { ...value };
    }
    return value;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;

  const source = originals[key];
  const sourceMap = typeof source === 'string' ? { en: source } : source;
  // Keep authored key order for the draft comparison, and retain languages with no editor control.
  const retained =
    sourceMap !== null && typeof sourceMap === 'object' && !Array.isArray(sourceMap)
      ? Object.fromEntries(
          Object.entries(sourceMap).filter(
            ([locale]) => Object.hasOwn(value, locale) || !UI_LOCALES.includes(locale as (typeof UI_LOCALES)[number]),
          ),
        )
      : {};
  // A blank existing locale is saved text; a blank newly visited control adds no translation.
  const entries = Object.entries({ ...retained, ...value }).filter(
    ([locale, text]) => text !== '' || Object.hasOwn(retained, locale),
  );
  if (typeof source === 'string' && entries.every(([locale]) => locale === 'en')) {
    return entries.length === 0 ? '' : entries[0]![1];
  }
  return entries.length > 0 ? Object.fromEntries(entries) : { en: '' };
}

function transformValue(
  value: unknown,
  schema: Schema,
  direction: 'to' | 'from',
  path: (string | number)[],
  localizedValues: Record<string, unknown>,
): unknown {
  if (schema['~kind'] === 'PublicFilter' || objectChoices(schema)) {
    if (direction === 'from') return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (schema['~kind'] === 'PublicFilter' && value === '') return undefined;
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (localized(schema)) {
    return transformLocalized(value, direction, path, localizedValues);
  }

  if (curieArray(schema) && Array.isArray(value)) {
    return direction === 'from'
      ? value.map((item) => (typeof item === 'string' ? { value: item } : item))
      : value.map((item) => {
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            return (item as Record<string, unknown>).value;
          }
          return item;
        });
  }

  const itemSchema = schema['~kind'] === 'Array' ? schema.items : undefined;
  if (closedObject(itemSchema) && Array.isArray(value)) {
    return value.map((item, index) =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? transformValue(item, itemSchema, direction, [...path, index], localizedValues)
        : item,
    );
  }

  if (closedObject(schema) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const result = { ...(value as Record<string, unknown>) };
    for (const [prop, propSchema] of Object.entries(schemaProperties(schema))) {
      if (Object.hasOwn(result, prop)) {
        result[prop] = transformValue(result[prop], propSchema, direction, [...path, prop], localizedValues);
      }
    }
    return result;
  }

  return value;
}

function transformNode(
  node: EditorNode,
  direction: 'to' | 'from',
  components: Map<string, RegistryComponent>,
): EditorNode {
  const definition = components.get(node.type);
  const schema = definition?.schema;
  const slots = definition?.slots ?? [];
  const props: Record<string, unknown> = { ...node.props };
  const localizedValues = direction === 'to' ? (node._localizedValues ?? {}) : {};

  if (schema !== undefined) {
    for (const [prop, propSchema] of Object.entries(schemaProperties(schema))) {
      if (Object.hasOwn(props, prop)) {
        props[prop] = transformValue(props[prop], propSchema, direction, [prop], localizedValues);
        if (propSchema['~kind'] === 'PublicFilter' && props[prop] === undefined) delete props[prop];
      }
    }
  }

  for (const slot of slots) {
    const children = props[slot];
    if (Array.isArray(children)) {
      props[slot] = children.map((child) =>
        child !== null && typeof child === 'object' && !Array.isArray(child)
          ? transformNode(child as EditorNode, direction, components)
          : child,
      );
    }
  }

  return {
    type: node.type,
    props,
    ...(direction === 'from' && Object.keys(localizedValues).length > 0 ? { _localizedValues: localizedValues } : {}),
  };
}

/** Build Puck's editor fields and valid initial props directly from the platform schemas. */
export function editorConfig(registry: CompositionRegistry, { locale }: { locale: string }): Config {
  const components: Record<string, unknown> = {};
  for (const component of registry.components) {
    const schema = asSchema(component.props);
    const fields: Record<string, unknown> = {};
    const defaultProps: Record<string, unknown> = {};

    for (const [prop, propSchema] of Object.entries(schemaProperties(schema))) {
      fields[prop] = fieldFor(propSchema, component.type, prop, locale);
      // An optional prop starts absent, so a new node does not carry a filter or type nobody chose.
      if (schema.required?.includes(prop)) defaultProps[prop] = defaultFor(propSchema, component.type, prop, locale);
    }
    for (const slot of component.slots) {
      fields[slot] = { type: 'slot' };
      defaultProps[slot] = [];
    }

    components[component.type] = { fields, defaultProps, render: () => null };
  }

  const root = asSchema(registry.root);
  const appearance = root.properties?.appearance;
  const appearanceProperties = appearance === undefined ? {} : schemaProperties(appearance);
  const rootFields: Record<string, unknown> = {};
  for (const name of appearanceNames) {
    const schema = appearanceProperties[name];
    if (schema !== undefined) rootFields[name] = fieldFor(schema, 'root', name, locale);
  }

  return { components, root: { fields: rootFields } } as Config;
}

/** Convert a composition document into the props layout Puck uses for editing. */
export function fromComposition(
  document: CompositionDocument,
  registry: CompositionRegistry = platformRegistry,
): PageEditorData {
  const source = document as unknown as {
    root?: { props?: Record<string, unknown> };
    content?: EditorNode[];
  };
  const sourceProps = source.root?.props ?? {};
  const components = registryComponents(registry);
  const sourceAppearance = sourceProps.appearance;
  const rootProps: Record<string, unknown> = {};
  if (sourceAppearance !== null && typeof sourceAppearance === 'object' && !Array.isArray(sourceAppearance)) {
    for (const name of appearanceNames) {
      if (Object.hasOwn(sourceAppearance, name)) {
        rootProps[name] = (sourceAppearance as Record<string, unknown>)[name];
      }
    }
  }
  return {
    root: { props: rootProps, _compositionRootProps: sourceProps },
    content: (source.content ?? []).map((node) => transformNode(node, 'from', components)),
  };
}

/** Drop Puck's editor metadata and restore composition's nested appearance and schema values. */
export function toComposition(
  data: PageEditorData,
  registry: CompositionRegistry = platformRegistry,
): CompositionDocument {
  const components = registryComponents(registry);
  const rootProps: Record<string, unknown> = {};
  const sourceRootProps = data.root._compositionRootProps;
  if (sourceRootProps !== undefined) {
    for (const [name, value] of Object.entries(sourceRootProps)) {
      if (name !== 'appearance') rootProps[name] = value;
    }
  }
  const appearance: Record<string, unknown> = {};
  const sourceAppearance = sourceRootProps?.appearance;
  let hasSourceAppearance = sourceRootProps !== undefined && Object.hasOwn(sourceRootProps, 'appearance');
  let sourceHadAppearanceToken = false;
  if (sourceAppearance !== null && typeof sourceAppearance === 'object' && !Array.isArray(sourceAppearance)) {
    for (const [name, value] of Object.entries(sourceAppearance as Record<string, unknown>)) {
      if (!appearanceNames.includes(name as keyof typeof APPEARANCE)) appearance[name] = value;
      else sourceHadAppearanceToken = true;
    }
  } else if (hasSourceAppearance) {
    rootProps.appearance = sourceAppearance;
    hasSourceAppearance = false;
  }
  for (const name of appearanceNames) {
    if (Object.hasOwn(data.root.props, name)) appearance[name] = data.root.props[name];
  }
  if (
    Object.keys(appearance).length > 0 ||
    (hasSourceAppearance && !sourceHadAppearanceToken && Object.keys(appearance).length === 0)
  ) {
    rootProps.appearance = appearance;
  }

  return {
    root: { props: rootProps },
    content: data.content.map((node) =>
      transformNode(node, 'to', components),
    ) as unknown as CompositionDocument['content'],
  };
}

/** The composition validator remains the sole authority for whether a page can publish. */
export function publishErrors(registry: CompositionRegistry, data: PageEditorData) {
  return validateComposition(registry, toComposition(data, registry));
}
