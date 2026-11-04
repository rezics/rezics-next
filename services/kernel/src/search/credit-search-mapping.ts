/** Additive successor mapping; callers must publish complete coverage before enabling the field.
 * Historical generations and analyzer/sort definitions are never mutated. */
export function creditSearchIndexDefinition(base: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(base);
  const mappings = result.mappings as Record<string, unknown> | undefined;
  const properties = mappings?.properties as Record<string, unknown> | undefined;
  const names = properties?.names as Record<string, unknown> | undefined;
  if (!mappings || !properties || !names || names.type !== 'text' || typeof names.analyzer !== 'string')
    throw new TypeError('Credit search requires the installed names analyzer');
  if (Object.hasOwn(properties, 'credited_names')) throw new TypeError('Credit field is already mapped');
  properties.credited_names = {
    type: 'nested',
    dynamic: 'strict',
    properties: {
      workId: { type: 'keyword' },
      statementId: { type: 'keyword' },
      revision: { type: 'long' },
      release: { type: 'keyword' },
      property: { type: 'keyword' },
      targetId: { type: 'keyword' },
      direction: { type: 'keyword' },
      nameRevision: { type: 'keyword' },
      qualifiers: {
        type: 'nested',
        dynamic: 'strict',
        properties: { property: { type: 'keyword' }, value: { type: 'keyword' } },
      },
      name: {
        type: 'object',
        dynamic: 'strict',
        properties: { language: { type: 'keyword' }, value: { type: 'text', analyzer: names.analyzer } },
      },
    },
  };
  return result;
}
