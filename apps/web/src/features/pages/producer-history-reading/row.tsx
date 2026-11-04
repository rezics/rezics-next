import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { ListRowLink } from '@rezics/ui/list-row';
import { Button } from '@rezics/ui/shadcn/button';
import type { ProducerHistoryRead, ProducerHistoryRow, ProducerHistoryStream } from '../../catalogue/producer-history';
import { producerHistoryCorrection } from '../../catalogue/producer-history';
import { CandidateValue } from '../data';
import { subjectHref } from '../../../subject/subject-href';
import { m } from '../../../paraglide/messages.js';
import { actionClass, focusClass } from './presentation';

type Admitted = Extract<ProducerHistoryRead, { ok: true }>;

/** The index is an occurrence in one admitted slice, never a cross-page statement lookup. */
export function HistoryRow({
  row,
  stream,
  read,
  locale,
  headingId,
  selected,
  correctionLocked,
  select,
  correct,
}: {
  row: ProducerHistoryRow;
  stream: ProducerHistoryStream;
  read: Admitted;
  locale: string;
  headingId: string;
  selected: boolean;
  correctionLocked: boolean;
  select: (button: HTMLButtonElement) => void;
  correct: (button: HTMLButtonElement) => void;
}) {
  const o = { locale: locale as never };
  return (
    <li data-slot="list-row" aria-current={selected ? 'true' : undefined}>
      <ContentItemFrame as="div" className="min-w-0 space-y-3 py-3 sm:py-4">
        {row.summary && (
          <ListRowLink
            href={`${subjectHref({ id: row.summary.id, label: row.summary.label?.value ?? '' }, locale).href}/producer`}
            lang={row.summary.label?.language}
            aria-labelledby={headingId}
          >
            {row.summary.label?.value || m.subject_value_unlabelled({}, o)}
          </ListRowLink>
        )}
        <ContentItemHeading
          id={headingId}
          lang={row.summary?.label?.language}
          tabIndex={-1}
          className={`font-sans text-lg font-semibold ${focusClass}`}
        >
          {row.summary
            ? row.summary.label?.value || m.subject_value_unlabelled({}, o)
            : m.producer_history_concealed({}, o)}
        </ContentItemHeading>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={selected ? 'secondary' : 'outline'}
            className={actionClass}
            aria-expanded={selected}
            aria-controls={`${headingId}-detail`}
            onClick={(event) => select(event.currentTarget)}
          >
            {m.producer_history_inspect({}, o)}
          </Button>
          {producerHistoryCorrection(row, stream) && (
            <Button
              className={actionClass}
              variant="outline"
              disabled={correctionLocked}
              onClick={(event) => correct(event.currentTarget)}
            >
              {correctionLocked ? m.producer_history_stale({}, o) : m.producer_history_correct({}, o)}
            </Button>
          )}
        </div>
        {selected && (
          <section id={`${headingId}-detail`} aria-labelledby={headingId} className="space-y-3 text-sm">
            {row.statement ? (
              <>
                {/* Missing summary is a concealed target, not permission to turn its ID into a link. */}
                {row.summary ? (
                  <CandidateValue snak={row.statement} related={row.related} locale={locale} />
                ) : (
                  <p>{m.producer_history_concealed({}, o)}</p>
                )}
                {row.statement.qualifiers.map((snak, index) => (
                  <div key={index}>
                    <p lang={read.labels[snak.property.id]?.lang ?? undefined} className="text-muted-foreground">
                      {read.labels[snak.property.id]?.text || m.producer_history_dates({}, o)}
                    </p>
                    <CandidateValue snak={snak} related={row.related} locale={locale} />
                  </div>
                ))}
                <section className="space-y-2" aria-label={m.sources_citations({}, o)}>
                  <h3 className="font-medium">{m.producer_history_sources({}, o)}</h3>
                  {row.statement.references.length ? (
                    row.statement.references.map((reference, index) => (
                      <div key={index} className="space-y-2">
                        {reference.parts.map((snak, at) => (
                          <CandidateValue key={at} snak={snak} related={row.related} locale={locale} />
                        ))}
                      </div>
                    ))
                  ) : (
                    <p>{m.sources_no_citations({}, o)}</p>
                  )}
                </section>
              </>
            ) : (
              <p>{m.producer_history_concealed({}, o)}</p>
            )}
          </section>
        )}
      </ContentItemFrame>
    </li>
  );
}
