import type { Release } from '@rezics/definitions';
import { pickText } from '@rezics/composition';
import type { Subject } from '../../../subject/types';
import { originalLanguage, originalTitle } from '../../../subject/language';

/** A presentation admission budget, not a claim about the native producer's enumeration bound. */
export const WORK_NAMES_BYTES = 262_144;
const languageTag = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
export type WorkName = { text: string; roles: ('title' | 'alias')[] };
export type WorkNameGroup = { language: string; names: WorkName[] };
export type WorkNames =
  | { state: 'unavailable'; bytes: number }
  | {
      state: 'ready';
      bytes: number;
      groups: WorkNameGroup[];
      selected: { text: string; lang: string | null };
      original: ReturnType<typeof originalTitle>;
      originalLanguage: string | undefined;
    };

/** One projection of the admitted Subject terms. Spelling and roles survive exact duplicate grouping. */
export function workNames(subject: Subject, locale: string): WorkNames {
  try { return projectWorkNames(subject, locale); } catch { return { state: 'unavailable', bytes: 0 }; }
}

function projectWorkNames(subject: Subject, locale: string): WorkNames {
  const bytes = new TextEncoder().encode(JSON.stringify({ labels: subject.labels, aliases: subject.aliases })).length;
  if (bytes > WORK_NAMES_BYTES) return { state: 'unavailable', bytes };
  const groups = new Map<string, Map<string, WorkName>>();
  let invalid = false;
  function add(language: string, text: string, role: 'title' | 'alias') {
    if (!languageTag.test(language) || typeof text !== 'string' || !text.trim()) {
      invalid = true;
      return;
    }
    let names = groups.get(language);
    if (!names) groups.set(language, (names = new Map()));
    const name = names.get(text);
    if (!name) names.set(text, { text, roles: [role] });
    else if (!name.roles.includes(role)) name.roles.push(role);
  }
  for (const [language, text] of Object.entries(subject.labels)) add(language, text, 'title');
  for (const [language, names] of Object.entries(subject.aliases))
    for (const text of names) add(language, text, 'alias');
  if (invalid) return { state: 'unavailable', bytes };
  const original = originalLanguage(subject);
  return {
    state: 'ready',
    bytes,
    selected: pickText(subject.labels, locale, original),
    original: originalTitle(subject),
    originalLanguage: original,
    groups: [...groups].map(([language, names]) => ({ language, names: [...names.values()] })),
  };
}

/** These are the actual type and ancestors supplied by the released summary, never a guessed Book. */
export function supportsWorkNames(type: string, ancestors: readonly string[] = []): boolean {
  return [type, ...ancestors].some((id) =>
    ['wd:Q689445', 'schema:Movie', 'schema:TVSeries', 'schema:TVSeason', 'schema:Episode', 'schema:Book'].includes(id),
  );
}

/** Summary.types carries only direct bases; the current admitted release supplies the complete ancestry. */
export function supportsReleasedWorkNames(type: string, release?: Pick<Release, 'types'>): boolean {
  if (!release?.types[type]) return false;
  const seen = new Set<string>();
  const pending = [type];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id) || !release.types[id]) continue;
    seen.add(id);
    if (supportsWorkNames(id)) return true;
    pending.push(...release.types[id]!.bases);
  }
  return false;
}
