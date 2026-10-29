import { Compile } from 'typebox/schema';
import { Hash } from 'typebox/value';
import schema from '../schema/release.json';

const at = (pointer: string, key: string | number) =>
  `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
type Schema = {
  $ref?: string;
  uniqueItems?: boolean;
  properties?: Record<string, Schema>;
  patternProperties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  [key: string]: unknown;
};

// Only error production changes. Every disabled uniqueness site is supplied by
// the schema-derived walk below; the published schema and format stay untouched.
const diagnosticSchema = structuredClone(schema);
function disableUniqueness(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if ('uniqueItems' in value && value.uniqueItems === true) value.uniqueItems = false;
  for (const child of Object.values(value)) disableUniqueness(child);
}
disableUniqueness(diagnosticSchema);
export const constructionValidator = Compile(diagnosticSchema);

// Resolve the frozen schema once, including the schema's one recursive value ref.
const walks = new Map<Schema, (value: unknown, pointer: string, add: (pointer: string) => void) => void>();
function walker(node: Schema): (value: unknown, pointer: string, add: (pointer: string) => void) => void {
  const known = walks.get(node);
  if (known) return known;
  let run: ReturnType<typeof walker>;
  const visit: ReturnType<typeof walker> = (value, pointer, add) => run(value, pointer, add);
  walks.set(node, visit);
  const ref = node.$ref
    ? walker(
        node.$ref
          .split('/')
          .slice(1)
          .reduce((part: any, key) => part[key], schema),
      )
    : undefined;
  const properties = Object.entries(node.properties ?? {}).map(([key, child]) => [key, walker(child)] as const);
  const patterns = Object.entries(node.patternProperties ?? {}).map(
    ([key, child]) => [new RegExp(key), walker(child)] as const,
  );
  const items = node.items ? walker(node.items) : undefined;
  const alternatives = (node.anyOf ?? []).map(walker);
  run = (value, pointer, add) => {
    if (ref) ref(value, pointer, add);
    for (const alternative of alternatives) alternative(value, pointer, add);
    if (Array.isArray(value)) {
      if (node.uniqueItems === true) {
        const seen = new Set<string>();
        for (const member of value) {
          // Use the pinned TypeBox identity, including structural object key
          // ordering, IEEE754 -0 and its hash collision semantics, not JS identity.
          const hash = Hash(member);
          if (seen.has(hash)) add(pointer);
          seen.add(hash);
        }
      }
      if (items) for (let index = 0; index < value.length; index++) items(value[index], at(pointer, index), add);
    } else if (value !== null && typeof value === 'object') {
      const fields = value as Record<string, unknown>;
      for (const [key, child] of properties) if (Object.hasOwn(fields, key)) child(fields[key], at(pointer, key), add);
      if (patterns.length)
        for (const key of Object.keys(fields)) {
          for (const [pattern, child] of patterns) if (pattern.test(key)) child(fields[key], at(pointer, key), add);
        }
    }
  };
  return visit;
}
export const constructionUniqueness = walker(schema as Schema);

export const PUBLICATION_LIMITS = Object.freeze({ bases: 4096, mappings: 256, qualifiers: 4096 });

/** Additional admission for a new digest, never a historical validity switch. */
export function publicationLimits(value: unknown): { pointer: string; code: 'limit' }[] {
  const violations: { pointer: string; code: 'limit' }[] = [];
  if (!value || typeof value !== 'object') return violations;
  for (const collection of ['types', 'properties'] as const) {
    const definitions = Object.getOwnPropertyDescriptor(value, collection)?.value;
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) continue;
    for (const key of Object.keys(definitions)) {
      const definition = Object.getOwnPropertyDescriptor(definitions, key)?.value;
      if (!definition || typeof definition !== 'object') continue;
      for (const member of collection === 'types'
        ? (['bases', 'mappings'] as const)
        : (['qualifiers', 'mappings'] as const)) {
        const list = Object.getOwnPropertyDescriptor(definition, member)?.value;
        if (Array.isArray(list) && list.length > PUBLICATION_LIMITS[member])
          violations.push({ pointer: at(at(`/${collection}`, key), member), code: 'limit' });
      }
    }
  }
  return violations.sort((a, b) => (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0)).slice(0, 64);
}
