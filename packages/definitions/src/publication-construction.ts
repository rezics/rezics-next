import { Compile } from 'typebox/schema';
import { Hash } from 'typebox/value';
import schema from '../schema/release.json';

const at = (pointer: string, key: string | number) =>
  `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
// Keep TypeBox's original schema engine as the diagnostic authority, including
// branch-local contexts, traversal order and its eight-node diagnostic budget.
// In pinned TypeBox 1.4.3 the only reduction over an input array is uniqueItems'
// duplicate-index collector. Its repeated accumulator spreads are quadratic.
// A private diagnostic view supplies those exact indices with a linear Set walk;
// the engine still decides whether that keyword runs and whether its error fits.
const validator = Compile(schema);

function duplicateIndices(value: unknown[]): number[] {
  const duplicates: number[] = [];
  const seen = new Set<string>();
  let index = 0;
  for (const member of value) {
    const hash = Hash(member);
    if (seen.has(hash)) duplicates.push(index);
    seen.add(hash);
    index++;
  }
  return duplicates;
}

function diagnosticView(value: unknown): unknown {
  // A privately owned JSON copy keeps ordinary engine property reads fast and
  // also supports frozen caller graphs. Array hashes inspect indexed members,
  // so this non-enumerable engine method cannot change structural identity.
  const copy: unknown = structuredClone(value);
  const pending: [unknown, unknown][] = [[value, copy]];
  const visited = new WeakSet<object>();
  while (pending.length) {
    const [original, view] = pending.pop()!;
    if (original === null || typeof original !== 'object') continue;
    if (visited.has(original)) continue;
    visited.add(original);
    if (Array.isArray(original)) Object.defineProperty(view, 'reduce', { value: () => duplicateIndices(original) });
    for (const [key, child] of Object.entries(original))
      if (child !== null && typeof child === 'object') pending.push([child, (view as Record<string, unknown>)[key]]);
  }
  return copy;
}

export const constructionValidator = {
  // The native Check uniqueness predicate already uses linear map/Set hashing.
  Check: (value: unknown) => validator.Check(value),
  Errors: (value: unknown) => validator.Errors(diagnosticView(value)),
};

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
