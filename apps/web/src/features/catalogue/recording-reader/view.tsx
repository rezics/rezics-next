import type { SubjectRead } from '@rezics/client';
import { pickText, type SelectedContext } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { useCallback, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { m } from '../../../paraglide/messages.js';
import { subjectVisitReturn, withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import { subjectViewHref } from '../../../subject/subject-href';
import { CandidateValue } from '../../pages/data';
import { relationTargetHref } from '../../pages/edition-work';
import { linkClass, linkColor, PlainLink, type PageLink } from '../../pages/shared';
import { ValueExplanationEntry } from '../value-explanation-entry';
import type { RecordingFact, RecordingField, RecordingGroup, RecordingVisit } from './model';
import { recordingStatementDomId, recordingStatementReturnHref } from './review/navigation';
import { useRecordingFactSelection } from './review/selection';

const actionClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

const live = () => true;

function options(locale: string) {
  return { locale: locale as never };
}

function targetOf(read: SubjectRead, targetId: string, locale: string) {
  if (!Object.hasOwn(read.related, targetId)) return;
  const target = read.related[targetId];
  if (!target) return;
  const label = pickText(target.labels, locale);
  return label.text ? { id: targetId, label: label.text, language: label.lang ?? undefined } : undefined;
}

function returnLink(link: PageLink, returnTo: string | undefined, locale: string): PageLink {
  const Link = link;
  return function VisitLink({ href, ...props }) {
    return <Link {...props} href={withSubjectVisitReturn(href, returnTo ?? '', locale)} />;
  };
}

function qualifierList({
  field,
  fact,
  read,
  release,
  locale,
  link,
}: {
  field: RecordingField;
  fact: RecordingFact;
  read: SubjectRead;
  release: Release;
  locale: string;
  link: PageLink;
}) {
  const admitted = new Set(field.definition.qualifiers);
  const notes = fact.qualifiers.flatMap((qualifier, index) => {
    if (!admitted.has(qualifier.property.id)) return [];
    const definition = release.properties[qualifier.property.id];
    if (!definition || definition.datatype !== qualifier.property.data_type) return [];
    const label = pickText(definition.labels, locale);
    if (!label.text) return [];
    return [
      <li key={`${qualifier.property.id}:${index}`} className="[overflow-wrap:anywhere]">
        <span lang={label.lang ?? undefined} className="font-medium">
          {label.text}:{' '}
        </span>
        <CandidateValue snak={qualifier} related={read.related} locale={locale} link={link} />
      </li>,
    ];
  });
  return notes.length ? <ul className="space-y-1 text-sm text-muted-foreground">{notes}</ul> : null;
}

function valueContent({
  field,
  fact,
  read,
  release,
  locale,
  context,
  link,
}: {
  field: RecordingField;
  fact: RecordingFact;
  read: SubjectRead;
  release: Release;
  locale: string;
  context?: SelectedContext;
  link: PageLink;
}) {
  const Link = link;
  let value: ReactNode;
  if (field.definition.datatype === 'wikibase-item' && fact.value.type === 'value') {
    const id = fact.value.content;
    const target = typeof id === 'string' ? targetOf(read, id, locale) : undefined;
    value = target ? (
      <Link
        className={actionClass}
        href={relationTargetHref(target, locale, context)}
        lang={target.language}
      >
        {target.label}
      </Link>
    ) : (
      <span className="text-muted-foreground">{m.subject_value_unlabelled({}, options(locale))}</span>
    );
  } else {
    value = <CandidateValue snak={fact} related={read.related} locale={locale} link={link} subject={read.subject.id} />;
  }
  const qualifiers = qualifierList({ field, fact, read, release, locale, link });
  return (
    <div className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
      <div>{value}</div>
      {qualifiers}
    </div>
  );
}

function findStatement(visit: RecordingVisit, statement: string) {
  for (const group of Object.keys(visit.groups) as RecordingGroup[]) {
    for (const field of visit.groups[group]) {
      const fact = field.facts.find((candidate) => candidate.id === statement);
      if (fact) return { field, fact, group };
    }
  }
  return undefined;
}

function fieldGroupTitle(group: RecordingGroup, locale: string) {
  return group === 'details'
    ? m.music_reader_details({}, options(locale))
    : group === 'contributions'
      ? m.recording_reader_contributions({}, options(locale))
      : m.recording_reader_associations({}, options(locale));
}

function FieldGroup({
  group,
  fields,
  read,
  release,
  locale,
  context,
  link,
  returnTo,
  selectedStatement,
  onInspect,
}: {
  group: RecordingGroup;
  fields: readonly RecordingField[];
  read: SubjectRead;
  release: Release;
  locale: string;
  context?: SelectedContext;
  link: PageLink;
  returnTo?: string;
  selectedStatement?: string;
  onInspect: (statement: string, button: HTMLButtonElement) => void;
}) {
  if (!fields.length) return null;
  return (
    <section className="min-w-0 space-y-3">
      <h3 className="text-xl font-semibold">{fieldGroupTitle(group, locale)}</h3>
      <dl className="min-w-0 space-y-4">
        {fields.map((field) => (
          <div
            key={field.property}
            className="grid min-w-0 gap-y-2 border-b border-border/60 pb-4 last:border-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)] sm:gap-x-6"
          >
            <dt lang={field.label.lang ?? undefined} className="min-w-0 font-semibold [overflow-wrap:anywhere]">
              {field.label.text}
            </dt>
            <dd className="min-w-0 space-y-3">
              <ul className="min-w-0 space-y-4">
                {field.facts.map((fact) => {
                  const selected = selectedStatement === fact.id;
                  const statementReturn = recordingStatementReturnHref(returnTo, read.subject.id, fact.id, locale);
                  const VisitLink = returnLink(link, statementReturn ?? returnTo, locale);
                  return (
                    <li
                      id={recordingStatementDomId(fact.id)}
                      key={fact.id}
                      data-statement={fact.id}
                      data-recording-statement={fact.id}
                      tabIndex={-1}
                      className="min-w-0 space-y-2 rounded-sm focus:outline-2 focus:outline-offset-2 focus:outline-ring"
                    >
                      {valueContent({
                        field,
                        fact,
                        read,
                        release,
                        locale,
                        ...(context ? { context } : {}),
                        link: VisitLink,
                      })}
                      <button
                        type="button"
                        className={actionClass}
                        aria-expanded={selected}
                        aria-controls="recording-fact-inspection"
                        onClick={(event) => onInspect(fact.id, event.currentTarget)}
                      >
                        {selected
                          ? m.recording_reader_close_inspection({}, options(locale))
                          : m.recording_reader_inspect({}, options(locale))}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function FactInspection({
  field,
  fact,
  group,
  read,
  release,
  locale,
  context,
  link,
  statementReturn,
  onClose,
  headingRef,
}: {
  field: RecordingField;
  fact: RecordingFact;
  group: RecordingGroup;
  read: SubjectRead;
  release: Release;
  locale: string;
  context?: SelectedContext;
  link: PageLink;
  statementReturn?: string;
  onClose: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const subjectTitle = pickText(read.subject.labels, locale).text;
  const returnValue = returnLink(link, statementReturn, locale);
  const groupLabel = fieldGroupTitle(group, locale);
  return (
    <section
      id="recording-fact-inspection"
      aria-labelledby="recording-fact-inspection-heading"
      className="min-w-0 space-y-4 rounded-md border border-border p-4"
    >
      <div className="space-y-2">
        <h3
          id="recording-fact-inspection-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-lg font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-ring"
        >
          {m.recording_reader_fact_inspection({}, options(locale))}
        </h3>
        <p className="text-sm text-muted-foreground">{groupLabel}</p>
        <p className="text-sm [overflow-wrap:anywhere]">
          {m.recording_reader_direction({ field: field.label.text }, options(locale))}
        </p>
      </div>
      <dl className="grid min-w-0 gap-x-4 gap-y-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
        <dt className="font-semibold">{m.recording_reader_direction_label({}, options(locale))}</dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">
          <span lang={pickText(read.subject.labels, locale).lang ?? undefined}>{subjectTitle}</span>
          <span aria-hidden="true" className="px-2">→</span>
          {valueContent({
            field,
            fact,
            read,
            release,
            locale,
            ...(context ? { context } : {}),
            link: returnValue,
          })}
        </dd>
        <dt className="font-semibold">{m.recording_reader_released_field({}, options(locale))}</dt>
        <dd lang={field.label.lang ?? undefined} className="min-w-0 [overflow-wrap:anywhere]">
          {field.label.text}
        </dd>
      </dl>
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2 [&_a]:ms-0">
        <ValueExplanationEntry
          id={read.subject.id}
          title={subjectTitle}
          statement={fact.id}
          property={field.property}
          context={read.subject.context}
          locale={locale}
        />
        <button type="button" className={actionClass} onClick={onClose}>
          {m.recording_reader_close_inspection({}, options(locale))}
        </button>
      </div>
    </section>
  );
}

export function RecordingReader({
  visit,
  read,
  release,
  locale,
  context,
  returnTo,
  currentHref,
  retryAvailable = false,
  retrying = false,
  onRetry,
  scope = 0,
  active = live,
  link = PlainLink,
}: {
  visit: RecordingVisit;
  read: SubjectRead;
  release?: Release;
  locale: string;
  context?: SelectedContext;
  returnTo?: string;
  currentHref?: string;
  retryAvailable?: boolean;
  retrying?: boolean;
  onRetry?: (onCurrentSuccess?: () => void) => Promise<boolean>;
  scope?: number;
  active?: () => boolean;
  link?: PageLink;
}) {
  const Link = link;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const subjectTitle = pickText(read.subject.labels, locale).text;
  const currentAddress = useMemo(() => {
    const accepted = currentHref ? subjectVisitReturn(currentHref, locale) : undefined;
    if (accepted) return withSubjectVisitReturn(accepted, returnTo ?? '', locale);
    return subjectVisitReturn(returnTo, locale);
  }, [currentHref, locale, returnTo]);
  const selected = (statement: string) => findStatement(visit, statement);
  const hasStatement = useCallback((statement: string) => !!findStatement(visit, statement), [visit]);
  const selection = useRecordingFactSelection({
    scope,
    active,
    ...(currentHref ? { currentHref } : {}),
    subjectId: read.subject.id,
    locale,
    hasStatement,
    loading: visit.state === 'loading',
  });
  const selectedFact = selection.selectedStatement ? selected(selection.selectedStatement) : undefined;
  const details = subjectViewHref(
    { id: read.subject.id, label: subjectTitle },
    locale,
    'details',
  );
  const relations = subjectViewHref(
    { id: read.subject.id, label: subjectTitle },
    locale,
    'relations',
  );
  const stateCopy =
    visit.state === 'loading'
      ? m.candidate_loading({}, options(locale))
      : visit.state === 'unsupported'
        ? m.recording_reader_unsupported({}, options(locale))
        : visit.state === 'empty'
          ? m.recording_reader_empty({}, options(locale))
          : visit.state === 'invalid'
            ? m.recording_reader_invalid({}, options(locale))
          : m.recording_reader_unavailable({}, options(locale));
  const incomplete = visit.bounds.flatMap((bound) => {
    const field = [...visit.groups.details, ...visit.groups.contributions, ...visit.groups.associations].find(
      (candidate) => candidate.property === bound.property,
    );
    return !bound.complete && field ? [{ field }] : [];
  });
  const directionReturn = (statement: string) =>
    recordingStatementReturnHref(currentAddress, read.subject.id, statement, locale) ?? currentAddress;
  const showRecovery = retryAvailable || retrying;
  const handleRetry = () => {
    if (!retryAvailable || retrying || !onRetry || !active()) return;
    const ownsFocus = typeof document !== 'undefined' && document.activeElement === retryRef.current;
    void onRetry(() => {
      if (
        ownsFocus &&
        active() &&
        typeof document !== 'undefined' &&
        document.activeElement === retryRef.current
      )
        headingRef.current?.focus();
    });
  };

  return (
    <article data-slot="recording-reader" className="min-w-0 space-y-6">
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-xl font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-ring"
      >
        {visit.state === 'ready' && visit.grain.text ? (
          <span lang={visit.grain.lang ?? undefined}>{visit.grain.text}</span>
        ) : (
          m.recording_reader_heading({}, options(locale))
        )}
      </h2>
      {visit.state !== 'ready' ? (
        <p role={visit.state === 'loading' || visit.state === 'empty' ? 'status' : 'alert'}>{stateCopy}</p>
      ) : null}
      {showRecovery ? (
        <div className="space-y-2" aria-live="polite">
          {retrying ? <p role="status">{m.recording_reader_retrying({}, options(locale))}</p> : null}
          <button
            ref={retryRef}
            type="button"
            aria-disabled={retrying}
            className={actionClass}
            onClick={handleRetry}
          >
            {m.recording_reader_retry({}, options(locale))}
          </button>
        </div>
      ) : null}

      {visit.state === 'ready' && release ? (
        <>
          <FieldGroup
            group="details"
            fields={visit.groups.details}
            read={read}
            release={release}
            locale={locale}
            {...(context ? { context } : {})}
            link={link}
            {...(currentAddress ? { returnTo: currentAddress } : {})}
            selectedStatement={selection.selectedStatement}
            onInspect={selection.inspect}
          />
          <FieldGroup
            group="contributions"
            fields={visit.groups.contributions}
            read={read}
            release={release}
            locale={locale}
            {...(context ? { context } : {})}
            link={link}
            {...(currentAddress ? { returnTo: currentAddress } : {})}
            selectedStatement={selection.selectedStatement}
            onInspect={selection.inspect}
          />
          <FieldGroup
            group="associations"
            fields={visit.groups.associations}
            read={read}
            release={release}
            locale={locale}
            {...(context ? { context } : {})}
            link={link}
            {...(currentAddress ? { returnTo: currentAddress } : {})}
            selectedStatement={selection.selectedStatement}
            onInspect={selection.inspect}
          />
        </>
      ) : null}

      {selectedFact && release ? (
        <FactInspection
          field={selectedFact.field}
          fact={selectedFact.fact}
          group={selectedFact.group}
          read={read}
          release={release}
          locale={locale}
          {...(context ? { context } : {})}
          link={link}
          {...(directionReturn(selectedFact.fact.id)
            ? { statementReturn: directionReturn(selectedFact.fact.id) }
            : {})}
          onClose={selection.close}
          headingRef={selection.inspectionHeading}
        />
      ) : null}
      {selection.selectedStatement && !selectedFact && visit.state !== 'loading' ? (
        <section aria-live="polite" className="space-y-2 rounded-md border border-border p-4">
          <p role="status">{m.recording_reader_fact_retired({}, options(locale))}</p>
          <button type="button" className={actionClass} onClick={selection.restart}>
            {m.recording_reader_restart({}, options(locale))}
          </button>
        </section>
      ) : null}

      {incomplete.length ? (
        <section className="min-w-0 space-y-2" aria-label={m.recording_reader_associations({}, options(locale))}>
          <ul className="space-y-2 text-sm text-muted-foreground">
            {incomplete.map(({ field }) => (
              <li key={field.property}>
                {m.recording_reader_incomplete({ label: field.label.text }, options(locale))}
              </li>
            ))}
          </ul>
          <Link
            className={`${linkClass} ${linkColor} ${actionClass}`}
            href={withSubjectVisitReturn(relations, currentAddress ?? '', locale)}
          >
            {m.subject_relations({}, options(locale))}
          </Link>
        </section>
      ) : null}

      <nav aria-label={m.recording_reader_navigation({}, options(locale))} className="flex flex-wrap gap-x-4 gap-y-2">
        <Link className={`${linkClass} ${linkColor} ${actionClass}`} href={withSubjectVisitReturn(details, currentAddress ?? '', locale)}>
          {m.subject_details({}, options(locale))}
        </Link>
        <Link className={`${linkClass} ${linkColor} ${actionClass}`} href={withSubjectVisitReturn(relations, currentAddress ?? '', locale)}>
          {m.subject_relations({}, options(locale))}
        </Link>
      </nav>
    </article>
  );
}
