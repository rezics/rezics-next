import type { SelectedContext } from '@rezics/composition';
import { subjectHref, type SubjectHrefInput } from '../../subject/subject-href';

/** Follow a disclosed canonical target while letting its page resolve the current Realm Context again. */
export function relationTargetHref(subject: SubjectHrefInput, locale: string, context?: SelectedContext): string {
  const href = subjectHref(subject, locale).href;
  return context?.population.kind === 'realm'
    ? `${href}?${new URLSearchParams({ realm: context.population.id })}`
    : href;
}
