import type { SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame } from '@rezics/ui/content-item';
import type { MouseEvent, Ref } from 'react';
import { ReleasePartValue as PartValue } from './value';
import { m } from '../../../../paraglide/messages.js';
import { timePresentation } from '../../../../subject/time-presentation';
import { isReleaseType, relatedReadable, releaseGroups, selectedStatements } from '../model';
import type { ReleaseRow } from '../read';
import type { AdmittedReleasePage, ReleaseOccurrence } from './state';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8';

type DetailState = 'loading' | 'available' | 'unavailable' | 'concealed' | 'unreadable' | 'stale';

export function ReleaseSelectedDetail({
  page,
  occurrence,
  row,
  locale,
  state,
  detail,
  onRetry,
  onClose,
  onCorrect,
  canCorrect,
  disabled = false,
  headingRef,
}: {
  page: AdmittedReleasePage;
  occurrence: ReleaseOccurrence;
  row?: ReleaseRow | undefined;
  locale: string;
  state: DetailState;
  detail?: SubjectRead | undefined;
  onRetry: (event: MouseEvent<HTMLButtonElement>) => void;
  onClose: () => void;
  onCorrect?: () => void;
  canCorrect: boolean;
  disabled?: boolean | undefined;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const read = page.read;
  const o = { locale: locale as never };
  const summaryLabels =
    row?.readability === 'readable' && row.summary?.label
      ? { [row.summary.label.language]: row.summary.label.value }
      : {};
  const heading = pickText(detail?.subject.labels ?? summaryLabels, locale);
  const type = detail ? pickText(read.release.types[detail.subject.type]?.labels ?? {}, locale) : undefined;
  const scalar = detail ? { release: read.release, public: { related: detail.related } } : undefined;
  const facts =
    detail && isReleaseType(read.release, detail.subject.type)
      ? releaseGroups(read.release, detail.subject.type)
      : undefined;
  const groups = facts
    ? ([
        ['work', facts.work],
        ['classification', facts.classification],
        ['credits', facts.credits],
        ['dates', facts.dates],
        ['identifiers', facts.identifiers],
        ['facts', facts.facts],
        ['relations', facts.relations],
      ] as const)
    : [];
  const displayGroups = groups.flatMap(([id, properties]) => {
    const rows = properties.flatMap((property) => {
      const statements = selectedStatements(detail?.subject.statements[property]);
      return statements.length
        ? [{ property, label: pickText(read.release.properties[property]?.labels ?? {}, locale), statements }]
        : [];
    });
    return rows.length ? [{ id, rows }] : [];
  });
  const groupLabel = (id: (typeof groups)[number][0]) => {
    if (id === 'work') return m.release_fidelity_work({}, o);
    if (id === 'classification') return m.release_fidelity_classification({}, o);
    if (id === 'credits') return m.release_fidelity_credits({}, o);
    if (id === 'dates') return m.release_fidelity_date({}, o);
    if (id === 'identifiers') return m.release_fidelity_identifiers({}, o);
    if (id === 'relations') return m.release_fidelity_related({}, o);
    return m.release_fidelity_facts({}, o);
  };
  return (
    <ContentItemFrame as="div" className="min-w-0 space-y-4 p-4" data-slot="release-detail">
      <header className="min-w-0 space-y-2">
        <h3
          ref={headingRef}
          id="release-selected-detail-heading"
          tabIndex={-1}
          className="break-words font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.release_fidelity_inspector_title({}, o)}
        </h3>
        <p className="break-words" lang={heading.lang ?? undefined}>
          {heading.text || m.subject_value_unlabelled({}, o)}
        </p>
        {type?.text && (
          <p className="text-sm text-muted-foreground" lang={type.lang ?? undefined}>
            {type.text}
          </p>
        )}
        <p className="text-sm text-muted-foreground" data-slot="release-selected-occurrence">
          {m.release_fidelity_selected_relation({}, o)}
        </p>
      </header>

      {row?.statement && row.readability === 'readable' && (
        <section className="min-w-0 space-y-3" data-slot="release-occurrence-evidence">
          <h4 className="font-semibold">{propertyLabel(read, occurrence.relation, locale)}</h4>
          <PropertyStatement
            property={occurrence.relation}
            statement={row.statement}
            read={{ release: read.release, public: { related: { ...read.public.related, ...row.related } } }}
            locale={locale}
          />
          <p className="text-sm">
            {occurrence.direction === 'inverse' ? '←' : '→'} {propertyLabel(read, occurrence.relation, locale)}
          </p>
          <ReleaseStatementEvidence
            statement={row.statement}
            read={{ release: read.release, public: { related: { ...read.public.related, ...row.related } } }}
            locale={locale}
          />
          {row.historical && <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>}
          {row.provenance.map((code, index) => (
            <p key={`${index}:${code}`} className="break-words text-sm text-muted-foreground">
              {m.release_fidelity_related_unknown({ code }, o)}
            </p>
          ))}
        </section>
      )}

      {state === 'loading' && <p role="status">{m.candidate_loading({}, o)}</p>}
      {state === 'unavailable' && <p role="status">{m.release_fidelity_detail_unavailable({}, o)}</p>}
      {state === 'concealed' && <p role="status">{m.release_fidelity_related_concealed({}, o)}</p>}
      {state === 'unreadable' && <p role="status">{m.release_fidelity_related_unreadable({}, o)}</p>}
      {state === 'stale' && <p role="status">{m.release_fidelity_selection_stale({}, o)}</p>}

      {detail && scalar && facts && (
        <div className="min-w-0 space-y-4" data-slot="release-detail-facts">
          {displayGroups.length ? (
            displayGroups.map((group) => (
              <section key={group.id} className="min-w-0 space-y-3">
                <h4 className="font-semibold">{groupLabel(group.id)}</h4>
                {group.rows.map((fact) => (
                  <div key={fact.property} className="min-w-0 space-y-2 rounded-md border p-3">
                    <p className="break-words text-sm text-muted-foreground" lang={fact.label.lang ?? undefined}>
                      {fact.label.text || fact.property}
                    </p>
                    {fact.statements.map((statement) => (
                      <div key={statement.id} className="min-w-0 space-y-2">
                        {fact.property === 'schema:datePublished' ? (
                          <p data-slot="release-detail-publication-date">
                            <ReleaseDateValue value={statement.value} locale={locale} />
                          </p>
                        ) : (
                          <SafePartValue part={statement} read={scalar} locale={locale} />
                        )}
                        {statement.qualifiers.map((part, index) => (
                          <PropertyStatement
                            key={`${part.property.id}:${index}`}
                            property={part.property.id}
                            statement={part}
                            read={scalar}
                            locale={locale}
                          />
                        ))}
                        {statement.references.map((reference, index) => (
                          <div key={index} className="min-w-0 space-y-2 border-s-2 ps-3 text-sm">
                            {reference.parts.map((part, partIndex) => (
                              <PropertyStatement
                                key={`${part.property.id}:${partIndex}`}
                                property={part.property.id}
                                statement={part}
                                read={scalar}
                                locale={locale}
                              />
                            ))}
                          </div>
                        ))}
                        {statement.rezics.release !== detail.subject.release && (
                          <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </section>
            ))
          ) : (
            <p>{m.release_fidelity_empty({}, o)}</p>
          )}
        </div>
      )}
      {detail && !facts && <p role="status">{m.release_fidelity_not_release({}, o)}</p>}
      {detail?.subject.sourceRecords.length ? (
        <section className="min-w-0 space-y-2">
          <h4 className="font-semibold">{m.release_fidelity_sources({}, o)}</h4>
          <ul className="space-y-2">
            {detail.subject.sourceRecords.map((source) => (
              <li key={source.url} className="min-w-0">
                <a href={source.url} className={linkClass} rel="nofollow">
                  {source.name}
                </a>
                {source.licence?.id && <p className="break-words text-sm text-muted-foreground">{source.licence.id}</p>}
                {source.attribution && (
                  <p className="break-words text-sm text-muted-foreground">{source.attribution}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {state !== 'loading' && state !== 'stale' && (
          <Button type="button" variant="outline" className={actionClass} disabled={disabled} onClick={onRetry}>
            {m.release_fidelity_retry_current({}, o)}
          </Button>
        )}
        {canCorrect && onCorrect && (
          <Button type="button" variant="outline" className={actionClass} disabled={disabled} onClick={onCorrect}>
            {m.correction_title({}, o)}
          </Button>
        )}
        <Button type="button" variant="outline" className={actionClass} disabled={disabled} onClick={onClose}>
          {m.release_fidelity_back_to_list({}, o)}
        </Button>
      </div>
    </ContentItemFrame>
  );
}

export function ReleaseStatementEvidence({
  statement,
  read,
  locale,
}: {
  statement: NonNullable<ReleaseRow['statement']>;
  read: Parameters<typeof PartValue>[0]['read'];
  locale: string;
}) {
  const o = { locale: locale as never };
  return (
    <div className="min-w-0 space-y-2" data-slot="release-statement-evidence">
      <p className="break-words text-sm text-muted-foreground">
        {statement.property.id} · {statement.rezics.release}
      </p>
      {statement.qualifiers.map((part, index) => (
        <PropertyStatement key={index} property={part.property.id} statement={part} read={read} locale={locale} />
      ))}
      {statement.references.map((reference, index) => (
        <section key={index} className="min-w-0 space-y-1 rounded-md border p-3">
          <h5 className="text-sm font-semibold">
            {m.correction_references({}, o)} {index + 1}
          </h5>
          {reference.parts.map((part, partIndex) => (
            <PropertyStatement
              key={partIndex}
              property={part.property.id}
              statement={part}
              read={read}
              locale={locale}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

type PartRead = Parameters<typeof PartValue>[0]['read'];

function propertyLabel(read: PartRead, property: string, locale: string) {
  const text = pickText(read.release.properties[property]?.labels ?? {}, locale);
  return text.text || property;
}

function PropertyStatement({
  property,
  statement,
  read,
  locale,
}: {
  property: string;
  statement: Parameters<typeof PartValue>[0]['part'];
  read: Parameters<typeof PartValue>[0]['read'];
  locale: string;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-sm text-muted-foreground">{propertyLabel(read, property, locale)}</p>
      <SafePartValue part={statement} read={read} locale={locale} />
    </div>
  );
}

function SafePartValue({
  part,
  read,
  locale,
}: {
  part: Parameters<typeof PartValue>[0]['part'];
  read: Parameters<typeof PartValue>[0]['read'];
  locale: string;
}) {
  const definition = read.release.properties[part.property.id];
  if (
    definition?.datatype === 'wikibase-item' &&
    part.value.type === 'value' &&
    typeof part.value.content === 'string'
  ) {
    const visibility = relatedReadable(read.public.related, part.value.content);
    if (visibility !== 'readable') {
      const o = { locale: locale as never };
      return (
        <span className="text-muted-foreground">
          {visibility === 'concealed'
            ? m.release_fidelity_related_concealed({}, o)
            : m.release_fidelity_related_unreadable({}, o)}
        </span>
      );
    }
  }
  return <PartValue part={part} read={read} locale={locale} />;
}

function ReleaseDateValue({ value, locale }: { value: unknown; locale: string }) {
  const reading = timePresentation(value, locale);
  const o = { locale: locale as never };
  if (reading.state === 'somevalue') return m.release_fidelity_date_tba({}, o);
  if (reading.state === 'novalue') return m.release_fidelity_date_none({}, o);
  return reading.state === 'supported' ? (
    reading.structuredDate ? (
      <time dateTime={reading.structuredDate}>{reading.text}</time>
    ) : (
      reading.text
    )
  ) : (
    reading.text
  );
}
