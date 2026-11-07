import type { Release } from '@rezics/definitions';
type Definitions = Pick<Release, 'types' | 'properties'>;

export function typeExtends(release: Definitions, type: string, target: string, seen = new Set<string>()): boolean {
  if (type === target) return true;
  if (seen.has(type)) return false;
  seen.add(type);
  return (release.types[type]?.bases ?? []).some((base) => typeExtends(release, base, target, seen));
}
