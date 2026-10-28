import { localeChain } from '@rezics/composition';

/** Languages requested for a reader, so the work's original language can win before English. */
export function requestLanguages(locale: string): string[] {
  if (locale.split('-')[0]?.toLowerCase() === 'en') return ['en'];
  return localeChain(locale).filter((language) => language !== 'en');
}
