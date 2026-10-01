import type { ZoneReleaseFilterSpec, ZoneReleaseOption } from '@rezics/zone-sdk';

// The release filter's fields as Main's facet registry serves them (`GET /v1/facets`): which facets exist inside
// the release group, the values each admits and its label in every locale. The Zone's spec adds words and
// suggestions; the registry decides what is valid, so a facet added to the registry (a territory, a format) needs
// no change here and a value the registry would refuse is never sent.

/** The part of a served Facet this reads. */
export interface ServedFacet {
  id: string;
  name: string;
  current: boolean;
  within?: string;
  labels: Readonly<Record<string, string>>;
  values: readonly { kind: string; pattern?: string }[];
}

export interface ResolvedField {
  /** The registry facet's name; also the address parameter that carries the choice. */
  facet: string;
  label: string;
  any: string;
  options: ZoneReleaseOption[];
  /** Values the group applies while nothing is chosen. */
  unchosen: string[];
  /** The registry's value pattern. */
  pattern: RegExp;
  /** The whole value set when the pattern is a plain alternation (`^(a|b)$`), else null: any matching value is valid. */
  closed: readonly string[] | null;
}

export interface ResolvedReleaseFilter {
  /** The registry name of the facet the fields sit inside (`release`): the `where` group's facet. */
  group: string;
  fields: ResolvedField[];
}

/** The members of a closed pattern such as `^(complete|partial|trial|unknown)$`; null for an open one. */
export function closedValues(pattern: string): string[] | null {
  const match = /^\^\(([^()\\^$.*+?[\]{}]+)\)\$$/.exec(pattern);
  return match ? match[1]!.split('|') : null;
}

const datatypePattern = (facet: ServedFacet): RegExp | null => {
  const domain = facet.values.find(value => value.kind === 'datatype' && value.pattern);
  try { return domain?.pattern ? new RegExp(domain.pattern) : null; } catch { return null; }
};

/**
 * The spec's fields that the registry serves as current facets of one group. A field whose facet is not served,
 * is not inside the group the first field names, or admits no pattern to check values against is left out, so the
 * control never offers what Main would refuse. `null` when no field remains.
 */
export function resolveReleaseFilter(spec: Pick<ZoneReleaseFilterSpec, 'fields'>, served: readonly ServedFacet[],
  locale: string): ResolvedReleaseFilter | null {
  const fields: ResolvedField[] = [];
  let within: string | null = null;
  for (const field of spec.fields) {
    const facet = served.find(item => item.name === field.facet && item.current);
    const pattern = facet ? datatypePattern(facet) : null;
    if (!facet || !facet.within || !pattern || (within !== null && facet.within !== within)) continue;
    within = facet.within;
    const closed = closedValues(pattern.source);
    const admits = (value: string) => pattern.test(value) && (!closed || closed.includes(value));
    const offered = field.options?.filter(option => admits(option.value))
      ?? (closed ? closed.map(value => ({ value, label: value })) : []);
    fields.push({ facet: facet.name, label: field.label ?? facet.labels[locale] ?? facet.labels.en ?? facet.name,
      any: field.any, options: offered, unchosen: (field.unchosen ?? []).filter(admits), pattern, closed });
  }
  const group = within ? served.find(item => item.id === within && item.current) : null;
  return group && fields.length ? { group: group.name, fields } : null;
}

/** Whether the registry admits a value for the field. */
export const admits = (field: ResolvedField, value: string): boolean =>
  value.length > 0 && field.pattern.test(value) && (!field.closed || field.closed.includes(value));
