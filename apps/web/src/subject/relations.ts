import { pickText } from '@rezics/composition';
import { m } from '../paraglide/messages.js';

/** The display groups of the Relations view, in the order the page shows them; `other` holds what has no group yet. */
export const RELATION_GROUPS = ['order', 'derivation', 'world', 'membership', 'association', 'other'] as const;
export type RelationGroup = (typeof RELATION_GROUPS)[number];

/** How one relation property reads from the page subject's side of the inverse read. */
export type RelationDefinition = {
  label: string;
  forwardLabel?: string;
  /** Inert reader presentation; semantic property labels and identities retain their own meaning. */
  readerLabel?: string;
  forwardReaderLabel?: string;
  group: RelationGroup;
  symmetric: boolean;
};

type ReleaseProperty = {
  labels?: Record<string, string>;
  relation?: {
    group?: string;
    symmetric?: boolean;
    inverseLabels?: Record<string, string>;
  };
};

function isGroup(value: unknown): value is RelationGroup {
  return typeof value === 'string' && (RELATION_GROUPS as readonly string[]).includes(value);
}

/** Forward copy/release-to-work controls: complete-empty stays visible; a counted but hidden member is withheld. */
export function copyWorkDisclosureControl(input: {
  items: readonly unknown[];
  count?: { value: number } | null | undefined;
}): 'available' | 'empty' | 'withheld' {
  if (input.items.length > 0) return 'available';
  if (input.count && input.count.value > 0) return 'withheld';
  return 'empty';
}

/**
 * The reader-side label and group of each property, from the definition release. A page reads the subjects that point
 * at it, so a directed property reads under its inverse label and a symmetric one under its own label on both sides.
 * A property with no relation definition yet falls back to its label and the `other` group; one the release does not
 * know is absent.
 */
export function relationDefinitions(
  release: { properties: Record<string, unknown> },
  properties: Iterable<string>,
  locale: string,
): Record<string, RelationDefinition> {
  const definitions: Record<string, RelationDefinition> = {};
  for (const property of properties) {
    if (!Object.hasOwn(release.properties, property)) continue;
    const definition = release.properties[property] as ReleaseProperty | undefined;
    if (!definition) continue;
    const relation = definition.relation;
    const symmetric = relation?.symmetric === true;
    const names = !symmetric && relation?.inverseLabels ? relation.inverseLabels : definition.labels;
    const label = names ? pickText(names, locale).text : '';
    const options = { locale: locale as never };
    // Use admitted relation meaning, never a node ID, target type, or another statement's qualifiers.
    const presentation =
      relation?.group === 'credit'
        ? {
            readerLabel: m.subject_works({}, options),
            forwardReaderLabel: property === 'wdt:P725' ? m.subject_cast({}, options) : m.subject_credits({}, options),
          }
        : property === 'schema:character'
          ? { readerLabel: m.subject_appearances({}, options), forwardReaderLabel: m.subject_characters({}, options) }
          : property === 'schema:exampleOfWork'
            ? { readerLabel: m.subject_editions({}, options), forwardReaderLabel: m.subject_work({}, options) }
            : property === 'schema:workExample'
              ? { readerLabel: m.subject_work({}, options), forwardReaderLabel: m.subject_editions({}, options) }
              : {};
    definitions[property] = {
      ...presentation,
      label: label || (definition.labels ? pickText(definition.labels, locale).text : ''),
      forwardLabel: definition.labels ? pickText(definition.labels, locale).text : '',
      group: isGroup(relation?.group) ? relation.group : 'other',
      symmetric,
    };
  }
  return definitions;
}
