import type { Related, Subject } from '../../../subject/types';
import type { Reader } from '../../../subject/reader';
import { CandidateValue } from '../data';
import type { PageLink } from '../shared';
import type { ReleasePublicationReading } from './model';

export function ReleasePublicationView({
  reading,
  subject,
  related,
  locale,
  link,
}: {
  reading: ReleasePublicationReading;
  subject: Subject;
  related: Related;
  locale: string;
  reader?: Reader;
  link?: PageLink;
}) {
  return (
    <section data-slot="release-publication" className="min-w-0 space-y-4">
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
