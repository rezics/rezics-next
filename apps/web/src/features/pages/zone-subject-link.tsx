import { Link } from '@tanstack/react-router';
import { useContext } from 'react';
import { PlainLink, type LinkProps } from './shared';
import { ZoneDestinationsContext, zoneSubjectHref } from './zone-destinations';

const zoneSubject = /^\/([^/]+)\/zones\/([^/]+)\/subjects\/([^/?#]+)(?:\/([^/?#]+))?$/;

export function ZoneSubjectLink({ href, lang, className, children }: LinkProps) {
  const destinations = useContext(ZoneDestinationsContext);
  const match = zoneSubject.exec(href);
  if (match) {
    try {
      const locale = decodeURIComponent(match[1]!);
      const zoneId = decodeURIComponent(match[2]!);
      const subjectId = decodeURIComponent(match[3]!);
      const view = match[4] ? decodeURIComponent(match[4]) : undefined;
      const target = zoneSubjectHref(locale, zoneId, subjectId, view);
      return (
        <Link to={target} lang={lang} className={className}>
          {children}
        </Link>
      );
    } catch {
      /* Fall through to a plain localized address. */
    }
  }
  if (destinations && href.startsWith(`/${destinations.locale}/zones/${destinations.zoneId}`))
    return (
      <a href={href} lang={lang} className={className}>
        {children}
      </a>
    );
  return (
    <PlainLink href={href} lang={lang} className={className}>
      {children}
    </PlainLink>
  );
}
