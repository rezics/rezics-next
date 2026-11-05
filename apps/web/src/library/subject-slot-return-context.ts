import { href, isView } from '@rezics/composition';
import { validatePageNode, validatePageRealm, validateViewCursor } from '../features/pages/view-cursor';
import { deLocalizeUrl, isLocale, localizeUrl } from '../paraglide/runtime.js';
import { subjectHref, type SubjectHrefInput } from '../subject/subject-href';

const linkSchema = href();
if (!('pattern' in linkSchema) || typeof linkSchema.pattern !== 'string')
  throw new Error('The shared href schema requires a pattern');
const safeHref = new RegExp(linkSchema.pattern, 'u');
const localOrigin = 'https://rezics.invalid';
const progressEntryReturnKey = 'progressSubjectReturnTo';

/** Keep the public Subject reader address in in-app navigation state only. */
export function subjectProgressEntryLocationState(returnTo: string) {
  return { [progressEntryReturnKey]: returnTo };
}

export function subjectProgressEntryReturnFromState(
  value: unknown,
  subject: SubjectHrefInput,
  locale: string,
): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const candidate = (value as Record<string, unknown>)[progressEntryReturnKey];
  if (typeof candidate !== 'string') return;
  return subjectSlotReturnTo(candidate, subject, locale);
}

/** The router's current reader address is navigation only; the destination still checks Auth and Realm access. */
export function subjectSlotReturnTo(
  currentHref: string | undefined,
  subject: SubjectHrefInput,
  locale: string,
): string {
  const fallback = subjectHref(subject, locale).href;
  if (!currentHref?.startsWith('/') || !safeHref.test(currentHref)) return fallback;
  try {
    const target = new URL(currentHref, localOrigin);
    // Encoded separators, controls and nested escapes must not become another route after decoding.
    if (
      target.origin !== localOrigin ||
      /%(?:2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(target.pathname) ||
      !safeHref.test(decodeURIComponent(target.pathname))
    )
      return fallback;

    const path = deLocalizeUrl(target).pathname.split('/');
    if (
      path[1] !== 'subjects' ||
      decodeURIComponent(path[2] ?? '') !== subject.id ||
      !path[3] ||
      (path.length !== 4 && (path.length !== 5 || !isView(path[4]) || path[4] === 'overview'))
    )
      return fallback;

    // Keep only selectors owned by the current reader. Never copy callback credentials, CSRF, undo keys,
    // nested return_to/redirect values or arbitrary query/referrer input into the login transaction.
    const seen = new Set<string>();
    const query = target.search
      .slice(1)
      .split('&')
      .filter((pair) => {
        const [key, value] = new URLSearchParams(pair).entries().next().value ?? [];
        if (key === undefined || value === undefined) return false;
        if (key !== 'realm' && key !== 'node' && key !== 'cursor' && key !== 'slot') return false;
        if (seen.has(key)) throw new Error('Ambiguous reader selector');
        seen.add(key);
        if (key === 'realm') return validatePageRealm(value) !== undefined;
        if (path.length === 5) {
          if (key === 'node') return validatePageNode(value) !== undefined;
          if (key === 'cursor') return validateViewCursor(value) !== undefined;
        }
        return path.length === 4 && key === 'slot' && value === 'collections';
      });
    target.search = query.length ? `?${query.join('&')}` : '';
    target.hash = '';
    // publicHref already includes the locale in production. Support unprefixed router locations as well.
    if (!isLocale(target.pathname.split('/')[1])) {
      if (!isLocale(locale)) return fallback;
      const localized = localizeUrl(target, { locale });
      return localized.pathname + localized.search;
    }
    return target.pathname + target.search;
  } catch {
    return fallback;
  }
}
