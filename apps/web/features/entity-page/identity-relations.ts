import type { AvailableSummary, RelationEntry } from '../work-levels/types.ts';
import type { Loaded, RatingRead, RatingContext } from '../work-page/types.ts';

export const identityKeys = ['variant-of', 'represents', 'holds-title'] as const;
export type IdentityKey = (typeof identityKeys)[number];
export type IdentityDefinitions = ReadonlyMap<IdentityKey, string>;
export type IdentitySectionKind = 'family' | 'units' | 'represents' | 'titles' | 'holders';

export interface IdentityMember {
  summary: AvailableSummary;
  /** Keep each occurrence: the same holder can hold a title in several Works. */
  entry: RelationEntry | null;
  kind: AvailableSummary | null;
  kindKey?: 'persona' | 'counterpart';
  hub: boolean;
  ratings: Loaded<RatingRead> | null;
  applicability: AvailableSummary[] | null;
}
export interface IdentitySectionData {
  kind: IdentitySectionKind;
  hub: AvailableSummary | null;
  members: IdentityMember[];
  /** Members are known to exist but are withheld by the reading boundary. */
  hidden?: boolean;
  legend?: {
    context: RatingContext;
    scope: 'global' | 'realm';
    realm: AvailableSummary['name'] | null;
  };
  /** The next relation page, on the resource whose incidence list was read. */
  next: { resource: AvailableSummary; cursor: string } | null;
}
export interface IdentityData {
  sections: IdentitySectionData[];
  ratings?: Loaded<RatingRead>;
}

export function identityEntries(
  entries: readonly RelationEntry[],
  definitions: IdentityDefinitions,
  key: IdentityKey,
) {
  const definition = definitions.get(key);
  return definition
    ? entries.filter((entry) => entry.rendering?.meaning.definition === definition)
    : [];
}

/** Role keys come from the exact meaning, never translated labels or a guessed resource type. */
export function resourceBinding(entry: RelationEntry, role: string): string | null {
  const binding = entry.rendering?.bindings.find((item) => item.role === role);
  const value = binding?.participant;
  return value &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'resource' &&
    'ref' in value &&
    typeof value.ref === 'string'
    ? value.ref
    : null;
}

export function bindingSummary(
  entry: RelationEntry,
  role: string,
  self: AvailableSummary,
): AvailableSummary | null {
  const ref = resourceBinding(entry, role);
  if (ref === self.reference) return self;
  const summary = entry.counterparts.find((item) => item.reference === ref);
  return summary?.status === 'available' ? summary : null;
}

/** A row from a family read at its hub still links the variant, including on a variant's own page. */
export function fromRole(entry: RelationEntry, role: string): RelationEntry {
  return entry.rendering
    ? { ...entry, rendering: { ...entry.rendering, viewingRole: role } }
    : entry;
}
