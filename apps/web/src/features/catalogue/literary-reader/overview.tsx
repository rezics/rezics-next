import { useEffect, useRef } from 'react';
import { useLiteraryVisitLocation } from '../literary-visit/location';
import type { SelectedContext } from '@rezics/composition';
import { m } from '../../../paraglide/messages.js';
import { literaryAddress } from './navigation';
import { literaryStyle } from './style';
import { HostedBookSubjectReaderLink } from '../../../books/reader/route';
import { BookShelfLink } from '../../../books/catalogue/shelf-link';

/** Fresh destinations deliberately omit preview node/cursor: the full view owns its native plan. */
export function LiteraryOverviewDestinations({
  subject,
  locale,
  views,
  context,
  realm,
  anchor = false,
  readingType,
}: {
  subject: string;
  locale: string;
  views: readonly string[];
  context?: SelectedContext | null | undefined;
  realm?: string | undefined;
  anchor?: boolean;
  readingType?: string | undefined;
}) {
  const visit = useLiteraryVisitLocation();
  const heading = useRef<HTMLHeadingElement>(null);
  const missingFocus = anchor && !visit.invalid && !!visit.focus;
  useEffect(() => {
    if (missingFocus && document.activeElement === document.body) heading.current?.focus();
  }, [missingFocus, subject]);
  const o = { locale: locale as never };
  const destinations = [
    { view: 'contents', label: m.subject_contents({}, o) },
    { view: 'editions', label: m.subject_editions({}, o) },
    { view: 'relations', label: m.subject_relations({}, o) },
  ].filter(({ view }) => views.includes(view));
  if (!destinations.length && !missingFocus && !readingType) return null;
  return (
    <nav
      id={anchor ? 'literary-reader' : undefined}
      data-slot="literary-overview-destinations"
      aria-label={m.literary_reader_explore({}, o)}
      className={literaryStyle.separator}
    >
      <h2
        ref={heading}
        id={anchor ? 'literary-reader-title' : undefined}
        tabIndex={-1}
        className={literaryStyle.heading}
      >
        {m.literary_reader_explore({}, o)}
      </h2>
      {missingFocus && (
        <p role="status" className={literaryStyle.muted}>
          {m.literary_visit_currentness({}, o)}
        </p>
      )}
      <ul className="divide-y divide-border">
        {readingType && (
          <li className="flex flex-wrap gap-x-6">
            <HostedBookSubjectReaderLink subjectId={subject} locale={locale} />
            <BookShelfLink locale={locale} type={readingType} />
          </li>
        )}
        {destinations.map(({ view, label }) => (
          <li key={view}>
            <a
              className={`${literaryStyle.link} w-full justify-between gap-4`}
              href={literaryAddress({ id: subject, label: '', locale, view, realm, context }).replace(
                /#literary-reader$/,
                view === 'relations' ? '' : '#literary-reader',
              )}
            >
              {label}
              <span aria-hidden="true">→</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

import type { Subject, Related } from '../../../subject/read-contract';
import type { Reader } from '../../../subject/reader';
import type { ReleasedRelationDirectionResult } from '@rezics/definitions';
import { literarySelected, type LiteraryDefinitions } from './model';
import { LiteraryFacts } from './facts';

/** The generic About renders supplied facts; these two absent values still have literary meaning. */
export function LiteraryOverviewGaps({
  work,
  related,
  definitions,
  directions,
  digest,
  reader,
  locale,
}: {
  work: Subject;
  related: Related;
  definitions: LiteraryDefinitions;
  directions: ReleasedRelationDirectionResult[] | undefined;
  digest: string | undefined;
  reader: Reader;
  locale: string;
}) {
  const properties = ['schema:wordCount', 'schema:exampleOfWork'].filter(
    (property) => !literarySelected(work, property, reader).length,
  );
  return (
    <LiteraryFacts
      work={work}
      related={related}
      definitions={definitions}
      directions={directions}
      digest={digest}
      reader={reader}
      locale={locale}
      view="overview"
      properties={properties}
      returnToFor={() => ''}
      linkFor={() =>
        ({ href, ...props }) => <a href={href} {...props} />}
      currentFocus={undefined}
    />
  );
}
