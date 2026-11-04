import { FILTER_LIMITS } from '@rezics/filter';
import type { CharacterPersonMode } from '../character-person';
import type { ConditionMetadata } from '../condition-editor-model';

/** The UI has a smaller finite selection budget than the native inverse predicate. */
export const CHARACTER_PERSON_WORK_LIMIT = Math.min(8, FILTER_LIMITS.in);
export type CharacterPersonSelectionMetadata = {
  release: string;
  workTargets: string[];
  roleTargets: Record<CharacterPersonMode, string[]>;
};

/** Release admission determines whether role advice is meaningful on this precise statement. */
export function characterPersonSelectionMetadata(
  release: Pick<ConditionMetadata, 'digest' | 'types' | 'properties'>,
): CharacterPersonSelectionMetadata | undefined {
  if (!release.digest) return undefined;
  // Abstract bases need not be independently released types, so read only concrete admitted operands.
  const workTargets = Object.entries(release.types)
    .filter(([id, type]) => id === 'schema:CreativeWork' || type.bases?.includes('schema:CreativeWork'))
    .map(([id]) => id);
  if (!workTargets.length || workTargets.length > FILTER_LIMITS.in) return undefined;
  const qualifier = release.properties['wdt:P3831'];
  const targets =
    qualifier?.datatype === 'wikibase-item'
      ? [...new Set(qualifier.targets ?? [])].filter((type) => Object.hasOwn(release.types, type))
      : [];
  const roleTargets = (property: string) =>
    release.properties[property]?.qualifiers?.includes('wdt:P3831') ? targets : [];
  return {
    release: release.digest,
    workTargets,
    roleTargets: { characters: roleTargets('wdt:P453'), people: roleTargets('wdt:P725') },
  };
}

export type CharacterPersonSelection = { works: string[]; role: string };
export type CharacterPersonSelectionEdit =
  | { kind: 'work'; id: string }
  | { kind: 'remove-work'; index: number }
  | { kind: 'role'; id: string }
  | { kind: 'mode' };

/** Changing the work operands retires role advice, but never a person's other deliberate inputs. */
export function editCharacterPersonSelection(
  value: CharacterPersonSelection,
  edit: CharacterPersonSelectionEdit,
): CharacterPersonSelection {
  if (edit.kind === 'mode') return { ...value, role: '' };
  if (edit.kind === 'role') return { ...value, role: value.works.length ? edit.id : '' };
  if (edit.kind === 'remove-work') return { works: value.works.filter((_, at) => at !== edit.index), role: '' };
  const id = edit.id.toLowerCase();
  if (value.works.some((work) => work.toLowerCase() === id) || value.works.length >= CHARACTER_PERSON_WORK_LIMIT)
    return value;
  return { works: [...value.works, id], role: '' };
}
