import type { AvailableSummary, RelationEntry, RelationsPage } from '../work-levels/types.ts';
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
  /** Native selected family answer, retained independently of generic Relations. */
  page?: RelationsPage;
  cursor?: string;
  cursorKey?: 'family';
  fallback?: RelationEntry[];
  /** The viewed resource's variant-role selection has its own opaque frontier. */
  discovery?: { page: RelationsPage; cursor?: string; fallback: RelationEntry[] };
}
export interface IdentityData {
  sections: IdentitySectionData[];
  ratings?: Loaded<RatingRead>;
  /** The complete incidence page from which these sections were read, before presentation. */
  relations?: RelationsPage;
}

/**
 * A specialized section can take an occurrence out of generic Relations only after
 * it actually presents that occurrence. Count occurrences rather than identities:
 * a deduplicated family member cannot consume a second returned incidence.
 */
export function remainingIdentityRelations(page: RelationsPage, identity: Loaded<IdentityData> | undefined): RelationEntry[] {
  if (!identity?.ok || !identity.data.relations
    || JSON.stringify(identity.data.relations) !== JSON.stringify(page)) return page.items;
  const members = identity.data.sections.flatMap(section => section.members);
  const used = new Set<number>();
  return page.items.filter(entry => {
    const member = members.findIndex((member, index) => !used.has(index)
      && member.entry?.relation === entry.relation && member.entry.revision === entry.revision
      && JSON.stringify(member.entry) === JSON.stringify(entry)
      && entry.counterparts.length > 0
      && entry.counterparts.every(summary => summary.status === 'available' && summary.reference === member.summary.reference));
    if (member < 0) return true;
    used.add(member);
    return false;
  });
}

export function identityEntries(
  entries: readonly RelationEntry[],
  definitions: IdentityDefinitions,
  key: IdentityKey,
) {
  const definition = definitions.get(key);
  return definition
    ? entries.filter((entry) => entry.rendering?.meaning?.definition === definition)
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
