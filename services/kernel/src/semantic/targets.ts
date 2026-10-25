import type { Release } from '@rezics/definitions';

export function matchesTarget(release: Release, type: string, targets: readonly string[]): boolean {
  if (targets.includes(type)) return true;
  return release.types[type]?.bases.some((base) => targets.includes(base)) ?? false;
}
