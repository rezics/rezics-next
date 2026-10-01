import type { UiLocale } from '../../i18n/define.ts';
import { copyOf } from '../work-levels/messages.ts';
import { namesOf, readRealizations, readReleases, readRelations } from '../work-levels/read.ts';
import { languageName } from './format.ts';
import type { ReviewTarget } from './reviews-grain-model.tsx';
import type { WorkHeader } from './types.ts';

/** How many of each kind the chooser offers; Main's first page of each, which the Work's own pages continue. */
const OFFERED = 8;

/**
 * What the Work's reviews can be about, from Main's own reads: the story (the Work, whose Main Version its ratings
 * count), each edition (release), each translation (realization) and the Works related to it. Which of them has
 * a rating question in the page's scope is Main's answer when one is chosen, never assumed here.
 */
export async function reviewTargets(id: string, work: WorkHeader, locale: UiLocale): Promise<ReviewTarget[]> {
  const [releases, realizations, relations] = await Promise.all([readReleases(id), readRealizations(id),
    readRelations(id, { limit: 32 })]);
  const related = relations.ok ? [...new Set(relations.data.items.flatMap(item => item.counterparts.map(entry => entry.reference)))]
    .filter(reference => reference !== work.id) : [];
  const names = await namesOf(related);
  const words = copyOf(locale);
  const works = related.flatMap(reference => {
    const summary = names.get(reference);
    return summary?.status === 'available' && summary.type === 'work'
      ? [{ grain: 'related' as const, target: reference, label: summary.name.value, language: summary.name.language }] : [];
  }).slice(0, OFFERED);
  return [
    { grain: 'story', target: work.id, label: work.title.value, language: work.title.language },
    ...(releases.ok ? releases.data.items.slice(0, OFFERED).map(release => ({ grain: 'edition' as const, target: release.id,
      label: [release.title.value, release.publisher ?? release.platform, release.publicationYear].filter(Boolean).join(' · '),
      language: release.title.language })) : []),
    ...(realizations.ok ? realizations.data.items.slice(0, OFFERED).map(realization => ({ grain: 'translation' as const,
      target: realization.id, label: [languageName(realization.language, locale),
        realization.kind === 'original' ? words.kindOriginal : words.kindTranslation,
        realization.status === 'official' ? null : words.statusUnofficial].filter(Boolean).join(' · ') })) : []),
    ...works,
  ];
}
