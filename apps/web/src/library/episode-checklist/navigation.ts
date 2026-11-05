import { getLocale } from '../../paraglide/runtime.js';
import { subjectHref, type SubjectHrefInput } from '../../subject/subject-href';

/** Return destinations carry only public route identity — never checklist rows, keys or cursors. */
export function checklistWorkHref(subject: SubjectHrefInput, locale = getLocale()): string {
  return subjectHref(subject, locale).href;
}

export function checklistLibraryHref(subjectId: string, locale = getLocale()): string {
  return `/${locale}/library/progress?subjectId=${encodeURIComponent(subjectId)}`;
}

export function checklistSessionHref(sessionId: string, locale = getLocale()): string {
  return `/${locale}/library/progress/${encodeURIComponent(sessionId)}`;
}
