import { createContext, useContext } from 'react';
import { CandidateValue } from '../../../pages/data';
import type { LinkProps } from '../../../pages/shared';
import type { PartValue } from '../../statement-editor-view';
import { m } from '../../../../paraglide/messages.js';

/** Only this reader's currently admitted destination composer may create Subject links. */
export const ReleaseDestination = createContext<(href: string) => string | undefined>(() => undefined);

export function ReleaseValueLink({ href, lang, className, children }: LinkProps) {
  const compose = useContext(ReleaseDestination);
  const destination = /^\/[^/]+\/subjects\//u.test(href) ? compose(href) : href;
  return destination ? (
    <a href={destination} lang={lang} className={className}>
      {children}
    </a>
  ) : (
    <span lang={lang} className={className}>
      {children}
    </span>
  );
}

export function ReleasePartValue({ part, read, locale }: Parameters<typeof PartValue>[0]) {
  const definition = read.release.properties[part.property.id];
  if (!definition) return <span>{m.candidate_value_unavailable({}, { locale: locale as never })}</span>;
  if (
    definition.datatype === 'wikibase-item' &&
    part.value.type === 'value' &&
    typeof part.value.content === 'string'
  ) {
    const related = read.public.related[part.value.content];
    if (!related || !Object.values(related.labels).some((label) => label.trim()))
      return <span>{m.release_fidelity_related_unreadable({}, { locale: locale as never })}</span>;
  }
  return (
    <CandidateValue
      snak={{ property: { ...part.property, data_type: definition.datatype }, value: part.value }}
      related={read.public.related}
      locale={locale}
      link={ReleaseValueLink}
    />
  );
}
