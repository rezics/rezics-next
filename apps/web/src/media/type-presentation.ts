import { parseListPresentation, type ListPresentation } from '@rezics/ui/cover';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Adapts the agreed optional release annotation when present. This narrow input boundary does not imply that the
 * current definitions API publishes the annotation.
 */
export function releasedListPresentation(
  types: readonly string[],
  releaseTypes: unknown,
): ListPresentation | undefined {
  if (!isRecord(releaseTypes)) return undefined;

  const pending = [...types];
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const type = pending[index];
    if (typeof type !== 'string' || visited.has(type)) continue;
    visited.add(type);
    if (!Object.hasOwn(releaseTypes, type)) continue;
    const definition = releaseTypes[type];
    if (!isRecord(definition)) continue;

    const presentation = Object.hasOwn(definition, 'listPresentation')
      ? parseListPresentation(definition.listPresentation)
      : undefined;
    if (presentation) return presentation;

    if (Array.isArray(definition.bases))
      for (const base of definition.bases)
        if (typeof base === 'string' && !visited.has(base)) pending.push(base);
  }
  return undefined;
}
