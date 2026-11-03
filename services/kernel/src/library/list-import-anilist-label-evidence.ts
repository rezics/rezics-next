import { object, type AniListRow } from './list-import-anilist-parser.ts';

export const ANILIST_LABEL_LIMITS = {
  rows: 20, values: 32, selected: 8, newLabels: 4, pageBytes: 8_388_608,
} as const;
type State = 'missing' | 'unknown' | 'invalid' | 'empty' | 'available' | 'unsupported' | 'oversized';
export type AniListLabelValue = {
  key: string; value: string; origin: 'customLists' | 'customContainer'; member: boolean;
};
/** Interpret only the retained, documented boolean map and explicitly custom group container. */
export function aniListLabelEvidence(row: AniListRow) {
  const values: AniListLabelValue[] = [];
  const raw = row.evidence.customLists;
  let membership: State = !Object.hasOwn(row.evidence, 'customLists') ? 'missing'
    : raw === null ? 'unknown' : Array.isArray(raw) ? 'unsupported' : !object(raw) ? 'invalid'
    : Object.keys(raw).length > ANILIST_LABEL_LIMITS.values ? 'oversized'
    : !Object.keys(raw).length ? 'empty' : 'available';
  if (membership === 'available' && object(raw)) {
    // Boolean false is explicit nonmembership; malformed values do not become membership.
    for (const [name, member] of Object.entries(raw)) {
      if (typeof member !== 'boolean' || !name.trim()) { membership = 'invalid'; continue; }
      values.push({ key: 'customLists:' + name, value: name, origin: 'customLists', member });
    }
  }
  const media = object(row.evidence.media) ? row.evidence.media : {};
  const tagState = (source: Record<string, unknown>): State => !Object.hasOwn(source, 'tags') ? 'missing'
    : source.tags === null ? 'unknown'
    : source.tags === '' || (Array.isArray(source.tags) && source.tags.length === 0) || (object(source.tags) && Object.keys(source.tags).length === 0) ? 'empty'
    : 'unsupported';
  const tagEvidence = { entry: tagState(row.evidence), media: tagState(media), membership: 'unavailable' as const };
  const group = row.group;
  const grouping = !group ? 'missing' : group.isCustomList === false ? 'default'
    : group.isCustomList === null || !Object.hasOwn(group, 'isCustomList') ? 'unknown'
    : group.isCustomList !== true ? 'invalid'
    : !Object.hasOwn(group, 'name') ? 'missing'
    : typeof group.name !== 'string' ? group.name === null ? 'unknown' : 'invalid'
    : !group.name.trim() ? 'empty' : 'custom';
  if (grouping === 'custom')
    values.push({ key: 'group:name', value: group!.name as string, origin: 'customContainer', member: true });
  // A mixed-invalid map remains visible but cannot be selectively reinterpreted as valid evidence.
  const selectable = values.filter(v => v.member && (v.origin === 'customContainer' || membership === 'available'));
  return {
    membership, grouping, values, selectable,
    tagEvidence,
    tags: tagEvidence.entry !== 'missing' ? tagEvidence.entry : tagEvidence.media,
    reason: 'Media.tags describes media themes, not personal membership; unfamiliar entry tags have no supported membership schema. Status and default display groups are not custom lists',
  };
}
