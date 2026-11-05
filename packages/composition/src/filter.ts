import Type, { type TSchema } from 'typebox';
import {
  FILTER_LIMITS,
  FilterError,
  parseFilter,
  walkFilter,
  createFilterConstruction,
  type FilterDocument,
  type FilterRelease,
} from '@rezics/filter';

const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const text = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$' };
const curie = { ...text, maxLength: 128, pattern: '^[a-z][a-z0-9]*:[A-Za-z][A-Za-z0-9_]*(?![\\s\\S])' };
const selection = (items: unknown) => ({ type: 'array', minItems: 1, maxItems: FILTER_LIMITS.in, items });
const qualifiers = {
  type: 'array',
  minItems: 1,
  maxItems: FILTER_LIMITS.qualifiers,
  items: closed({ property: curie, in: selection(text) }),
};
const range = {
  ...closed({ gte: { type: 'number' }, lte: { type: 'number' }, unit: text }, []),
  anyOf: [{ required: ['gte'] }, { required: ['lte'] }],
};
const leaves = [
  closed({ type: closed({ in: selection(curie) }) }),
  closed({ statement: closed({ property: curie, in: selection(text), qualifiers }, ['property', 'in']) }),
  closed({ statement: closed({ property: curie, range, qualifiers }, ['property', 'range']) }),
  closed({
    saved: { type: 'string', maxLength: 96, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*(?![\\s\\S])' },
  }),
];
const definitions: Record<string, unknown> = { leaf: { anyOf: leaves } };
for (let depth = FILTER_LIMITS.depth; depth >= 0; depth--) {
  for (const underNot of [false, true]) {
    const children = { $ref: `#/$defs/node${depth + 1}` };
    definitions[`node${depth}${underNot ? 'Not' : ''}`] = {
      anyOf: [
        { $ref: '#/$defs/leaf' },
        ...(depth === FILTER_LIMITS.depth
          ? []
          : [
              closed({ and: { type: 'array', minItems: 1, maxItems: FILTER_LIMITS.leaves, items: children } }),
              closed({ or: { type: 'array', minItems: 1, maxItems: FILTER_LIMITS.or, items: children } }),
              ...(underNot ? [] : [closed({ not: { $ref: `#/$defs/node${depth + 1}Not` } })]),
            ]),
      ],
    };
  }
}

/** The schema closes the wire shape; the shared parser owns aggregate leaf/byte/range limits. */
export const publicFilterProp = Type.Optional({
  '~kind': 'PublicFilter',
  $id: 'https://rezics.com/presentation/filter/1',
  $defs: definitions,
  anyOf: [{ $ref: '#/$defs/node0' }, { type: 'string', maxLength: 8192 }],
} as unknown as TSchema);

export function parsePublicPageFilter(value: unknown): FilterDocument {
  const filter = parseFilter(value);
  for (const node of walkFilter(filter))
    if ('owner' in node) throw new FilterError('unsupported_query', '/owner', 'unsupported');
  return filter;
}

/** Serialized composition filters use the same public grammar and release admission as object configuration. */
export function parseConfiguredPageFilter(value: unknown): FilterDocument {
  if (typeof value !== 'string') return parsePublicPageFilter(value);
  if (value.length > 8192) throw new FilterError('unsupported_query', '', 'out_of_range');
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new FilterError('unsupported_query', '', 'unsupported');
  }
  return parsePublicPageFilter(decoded);
}

/** Configuration can narrow a TypeList, including multiple types, but cannot replace its type restriction. */
export function typeListFilter(types: readonly string[], value?: unknown): FilterDocument {
  const type = { type: { in: types } };
  if (value === undefined) return parseFilter(type);
  const filter = parseConfiguredPageFilter(value);
  return parsePublicPageFilter({ and: [type, ...('and' in filter ? filter.and : [filter])] });
}

/** Release admission uses the same construction and public defaults as standalone Search. */
export function validateDocumentFilters(
  registry: import('./registry.ts').CompositionRegistry,
  document: import('./registry.ts').CompositionDocument,
  release: FilterRelease,
): import('./registry.ts').CompositionViolation[] {
  const admission = createFilterConstruction(release);
  const components = new Map(registry.components.map((component) => [component.type, component]));
  const errors: import('./registry.ts').CompositionViolation[] = [];
  const visit = (nodes: import('./registry.ts').CompositionNode[], pointer: string) => {
    nodes.forEach((node, index) => {
      const component = components.get(node.type)!;
      const path = `${pointer}/${index}/props`;
      const read = component.read?.(node.props, { subject: '00000000-0000-8000-8000-000000000000' });
      if (node.type === 'TypeList' && read?.kind === 'search') {
        for (const error of admission.validateFilter(read.body.filter))
          errors.push({
            pointer: `${path}/filter${error.pointer}`,
            code: error.code === 'out_of_range' ? 'limit' : 'invalid',
          });
      }
      for (const slot of component.slots)
        visit(node.props[slot] as import('./registry.ts').CompositionNode[], `${path}/${slot}`);
    });
  };
  visit(document.content, '/content');
  return errors;
}
