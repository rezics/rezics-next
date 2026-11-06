/** Additive successor mapping; callers must publish complete coverage before enabling the field.
 * Historical generations and analyzer/sort definitions are never mutated. */
export const CREDIT_SEARCH_INDEX_FORMAT = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function creditSearchIndexDefinition(base: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(base);
  const mappings = result.mappings as Record<string, unknown> | undefined;
  const properties = mappings?.properties as Record<string, unknown> | undefined;
  const metadata = mappings?._meta as Record<string, unknown> | undefined;
  const names = properties?.names as Record<string, unknown> | undefined;
  if (!mappings || !properties || !metadata || !names || names.type !== 'text' || typeof names.analyzer !== 'string')
    throw new TypeError('Credit search requires the installed names analyzer');
  if (Object.hasOwn(properties, 'credited_names') || Object.hasOwn(properties, 'credit_search_complete'))
    throw new TypeError('Credit field is already mapped');
  metadata.credit_search_format = CREDIT_SEARCH_INDEX_FORMAT;
  properties.credit_search_complete = { type: 'boolean' };
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
        properties: {
          language: { type: 'keyword' },
          value: { type: 'text', analyzer: names.analyzer, index_options: 'offsets' },
        },
      },
    },
  };
  return result;
}

/** A physical mapping carries the credit successor only with its metadata and both root fields. */
export function hasCreditIndexFormat(mappings: unknown): boolean {
  if (!isRecord(mappings) || !isRecord(mappings._meta) || !isRecord(mappings.properties)) return false;
  const credited = mappings.properties.credited_names;
  return (
    mappings._meta.credit_search_format === CREDIT_SEARCH_INDEX_FORMAT &&
    isRecord(credited) &&
    credited.type === 'nested' &&
    Object.hasOwn(mappings.properties, 'credit_search_complete')
  );
}
