/** Generic calendar projection format, independent of catalogue subtype or property identity. */
export const CALENDAR_INDEX_FORMAT = 1;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An inert successor definition; never upgrades or certifies an existing physical generation. */
export function calendarIndexDefinition(base: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(base);
  const mappings = result.mappings;
  if (!record(mappings) || !record(mappings.properties) || !record(mappings._meta))
    throw new TypeError('Calendar projection requires a versioned Search mapping');
  const facts = mappings.properties.facts;
  if (!record(facts) || facts.type !== 'nested' || !record(facts.properties))
    throw new TypeError('Calendar projection requires nested Search facts');
  mappings._meta.calendar_range_format = CALENDAR_INDEX_FORMAT;
  Object.assign(facts.properties, {
    year: { type: 'long', coerce: false },
    month: { type: 'integer', coerce: false },
    day: { type: 'integer', coerce: false },
    time_lower: { type: 'keyword' },
    time_upper: { type: 'keyword' },
  });
  return result;
}

/** Mapping compatibility alone is not population readiness or publication authority. */
export function hasCalendarIndexFormat(mappings: unknown): boolean {
  if (
    !record(mappings) ||
    !record(mappings._meta) ||
    mappings._meta.calendar_range_format !== CALENDAR_INDEX_FORMAT ||
    !record(mappings.properties)
  )
    return false;
  const facts = mappings.properties.facts;
  if (!record(facts) || facts.type !== 'nested' || !record(facts.properties)) return false;
  const fields = facts.properties;
  return ['year', 'month', 'day', 'time_lower', 'time_upper'].every((field) => {
    const definition = fields[field];
    return (
      record(definition) &&
      definition.type === (field === 'year' ? 'long' : field.startsWith('time_') ? 'keyword' : 'integer') &&
      definition.doc_values !== false &&
      (field.startsWith('time_')
        ? definition.normalizer === undefined && definition.ignore_above === undefined
        : definition.coerce === false)
    );
  });
}
