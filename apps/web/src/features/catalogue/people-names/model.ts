import type { Subject } from '../../../subject/types';
import { WORK_NAMES_BYTES, workNames, type WorkNameGroup } from '../work-names/model';
import type { TermsPageAuthority } from '../subject-terms';

export const PEOPLE_NAME_GROUP_WINDOW = 8;
export const PEOPLE_NAME_ROW_WINDOW = 24;
export const PEOPLE_NAME_FILTER_LENGTH = 250;
export type PeopleNames =
  | { state: 'oversized' | 'malformed' }
  | { state: 'ready'; bytes: number; groups: WorkNameGroup[]; selected: { text: string; lang: string | null } };

/** The shared producer owns admission, language validation, exact grouping and role retention. */
export function peopleNames(subject: Subject, locale: string): PeopleNames {
  try {
    // Reject malformed containers before the producer iterates aliases. No language interpretation here.
    if (
      !subject.labels ||
      !subject.aliases ||
      Array.isArray(subject.labels) ||
      Array.isArray(subject.aliases) ||
      typeof subject.labels !== 'object' ||
      typeof subject.aliases !== 'object' ||
      !Object.values(subject.aliases).every(Array.isArray)
    )
      return { state: 'malformed' };
    // Person/Character display selection has no work original-title/original-language metadata.
    const names = workNames({ ...subject, statements: {} }, locale);
    if (names.state === 'unavailable') return { state: names.bytes > WORK_NAMES_BYTES ? 'oversized' : 'malformed' };
    return { state: 'ready', bytes: names.bytes, groups: names.groups, selected: names.selected };
  } catch {
    return { state: 'malformed' };
  }
}

/** Search only the admitted local spellings. Never normalize punctuation, diacritics or scripts. */
export function filterPeopleNames(groups: WorkNameGroup[], query: string): WorkNameGroup[] {
  const needle = query.toLowerCase();
  if (!needle) return groups;
  return groups.flatMap((group) => {
    const names = group.names.filter((name) => name.text.toLowerCase().includes(needle));
    return names.length ? [{ language: group.language, names }] : [];
  });
}

export type NamesAdvice = 'signed-out' | 'unavailable' | 'pending' | 'denied' | 'allowed';
export function peopleNamesAdvice(authority: TermsPageAuthority): NamesAdvice {
  if (authority.viewer === 'signed-out') return 'signed-out';
  if (authority.viewer !== 'signed-in' || authority.actions.state !== 'ready') return 'unavailable';
  return authority.actions.actions.some(
    (entry) => entry.action === 'statement:propose' && entry.operations.includes('subject.terms'),
  )
    ? 'allowed'
    : 'denied';
}
