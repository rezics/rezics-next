import type { Related, Subject } from '../../../subject/types';
import type { Reader } from '../../../subject/reader';
import { CandidateValue } from '../data';
import type { PageLink } from '../shared';
import type { PublicationOverlayReading } from '../subject-metadata';

export function PublicationOverlayView({
  reading,
  subject,
  related,
  documents,
  locale,
  link,
}: {
  reading: PublicationOverlayReading;
  subject: Subject;
  related: Related;
  documents?: unknown;
  locale: string;
  reader?: Reader;
  link?: PageLink;
}) {
  return (
    <section data-slot={`${reading.kind}-publication`} className="min-w-0 space-y-4">
      <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
        {reading.fields.map((field) => (
          <div key={field.property} className="min-w-0 space-y-1" data-property={field.property}>
            <dt lang={field.label.lang || undefined} className="text-sm font-medium">
              {field.label.text}
            </dt>
            <dd className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
              {field.statements.map((statement) => (
                <CandidateValue
                  key={statement.id}
                  snak={statement}
                  related={related}
                  locale={locale}
                  subject={subject.id}
                  documents={documents}
                  {...(link ? { link } : {})}
                />
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
