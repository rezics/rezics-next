import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import { subjectHref, type SubjectHrefInput } from '../../subject/subject-href';
import type { DiscoveryHit } from '../discovery';
import { releaseDateText } from '../release-search-date';
import { localizedLabel } from '../results';

type WorkContext = NonNullable<Extract<DiscoveryHit, { summary: { kind: 'subject' } }>['workContext']>;
type CurrentWorkContext = Extract<WorkContext, { state: 'current' }>;
type WorkSection = CurrentWorkContext['creators'];
type WorkStatement = Extract<WorkSection, { state: 'current' }>['items'][number];
type WorkValue = WorkStatement['value'];
type WorkContextQualifier = Extract<WorkStatement['qualifiers'], { state: 'current' }>['items'][number];

function messageOptions(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

function suppliedLabel(labels: Record<string, string>, id: string, locale: string) {
  const label = localizedLabel(labels, locale);
  return { text: label.text || id, ...(label.lang ? { lang: label.lang } : {}) };
}

function hrefFor(subject: SubjectHrefInput, locale: string, subjectHrefFor?: (subject: SubjectHrefInput) => string) {
  return subjectHrefFor?.(subject) ?? subjectHref(subject, locale).href;
}

function WorkValueView({
  value,
  locale,
  subjectHrefFor,
}: {
  value: WorkValue;
  locale: string;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
}): ReactNode {
  const options = messageOptions(locale);
  if (value.state === 'somevalue') return m.discovery_work_context_value_somevalue({}, options);
  if (value.state === 'novalue') return m.discovery_work_context_value_novalue({}, options);
  if (value.state === 'unsupported') return m.discovery_work_context_value_unsupported({}, options);
  switch (value.kind) {
    case 'item': {
      const label = suppliedLabel(value.labels, value.id, locale);
      const subject = { id: value.id, label: label.text };
      return (
        <a
          className="text-primary underline underline-offset-4 [overflow-wrap:anywhere]"
          href={hrefFor(subject, locale, subjectHrefFor)}
          lang={label.lang}
          dir="auto"
        >
          {label.text || m.subject_value_unlabelled({}, options)}
        </a>
      );
    }
    case 'text':
      return <span dir="auto">{value.text}</span>;
    case 'quantity':
      return <span dir="auto">{[value.amount, value.unit].filter(Boolean).join(' ')}</span>;
    case 'time': {
      const date = releaseDateText(
        {
          year: value.year,
          ...(value.month === undefined ? {} : { month: value.month }),
          ...(value.day === undefined ? {} : { day: value.day }),
        },
        locale,
      );
      return date ?? m.discovery_work_context_value_unsupported({}, options);
    }
  }
}

function QualifierView({
  qualifier,
  locale,
  subjectHrefFor,
}: {
  qualifier: WorkContextQualifier;
  locale: string;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
}) {
  const property = suppliedLabel(qualifier.property.labels, qualifier.property.id, locale);
  return (
    <li lang={property.lang} dir="auto">
      <span>{property.text}: </span>
      <WorkValueView value={qualifier.value} locale={locale} subjectHrefFor={subjectHrefFor} />
    </li>
  );
}

function sectionStateText(state: string, locale: string) {
  const options = messageOptions(locale);
  switch (state) {
    case 'empty':
      return m.discovery_work_context_empty({}, options);
    case 'withheld':
      return m.discovery_work_context_withheld({}, options);
    case 'unsupported':
      return m.discovery_work_context_unsupported({}, options);
    default:
      return m.discovery_work_context_section_unavailable({}, options);
  }
}

function StatementView({
  statement,
  locale,
  subjectHrefFor,
}: {
  statement: WorkStatement;
  locale: string;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
}) {
  const property = suppliedLabel(statement.property.labels, statement.property.id, locale);
  const qualifiers = statement.qualifiers;
  return (
    <li data-work-context-statement={statement.statementId} className="min-w-0 [overflow-wrap:anywhere]">
      <p lang={property.lang} dir="auto">
        <span>{property.text}: </span>
        <WorkValueView value={statement.value} locale={locale} subjectHrefFor={subjectHrefFor} />
      </p>
      <div className="ml-3 mt-1 text-sm">
        <p className="font-medium">{m.discovery_work_context_qualifiers({}, messageOptions(locale))}</p>
        {qualifiers.state === 'current' ? (
          <ul className="ml-3 list-disc space-y-1">
            {qualifiers.items.map((qualifier, index) => (
              <QualifierView
                key={`${statement.statementId}:${index}`}
                qualifier={qualifier}
                locale={locale}
                subjectHrefFor={subjectHrefFor}
              />
            ))}
          </ul>
        ) : (
          <p>{sectionStateText(qualifiers.state, locale)}</p>
        )}
      </div>
    </li>
  );
}

function SectionView({
  title,
  section,
  locale,
  subjectHrefFor,
}: {
  title: string;
  section: WorkSection;
  locale: string;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
}) {
  return (
    <div data-work-context-section={title} className="min-w-0">
      <p className="font-medium">{title}</p>
      {section.state === 'current' ? (
        <>
          <ul className="ml-3 list-disc space-y-2">
            {section.items.map((statement) => (
              <StatementView
                key={statement.statementId}
                statement={statement}
                locale={locale}
                subjectHrefFor={subjectHrefFor}
              />
            ))}
          </ul>
          {section.overflow ? (
            <p data-work-context-overflow className="mt-1">
              {m.discovery_work_context_overflow({}, messageOptions(locale))}
            </p>
          ) : null}
        </>
      ) : (
        <p>{sectionStateText(section.state, locale)}</p>
      )}
    </div>
  );
}

/** Passive, row-bound display of the optional qualified context; all destinations use disclosed item identity. */
export function WorkContextView({
  context,
  locale,
  subjectHrefFor,
}: {
  context: WorkContext | undefined;
  locale: string;
  subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined;
}) {
  if (!context || context.state === 'unavailable')
    return (
      <li
        data-slot="discovery-work-context"
        data-state="unavailable"
        className="ml-6 list-none rounded-md border px-3 py-2 text-sm"
      >
        {m.discovery_work_context_unavailable({}, messageOptions(locale))}
      </li>
    );

  const options = messageOptions(locale);
  const kind =
    context.kind === 'work'
      ? m.discovery_work_context_kind_work({}, options)
      : context.kind === 'release'
        ? m.discovery_work_context_kind_release({}, options)
        : m.discovery_work_context_kind_recording({}, options);
  return (
    <li
      data-slot="discovery-work-context"
      data-state="current"
      data-kind={context.kind}
      className="ml-6 list-none rounded-md border px-3 py-2 text-sm"
    >
      <p className="mb-2 font-medium">
        {m.discovery_work_context_heading({}, options)} · {kind}
      </p>
      <div className="space-y-2">
        <SectionView
          title={m.discovery_work_context_creators({}, options)}
          section={context.creators}
          locale={locale}
          subjectHrefFor={subjectHrefFor}
        />
        <SectionView
          title={m.discovery_work_context_relations({}, options)}
          section={context.relations}
          locale={locale}
          subjectHrefFor={subjectHrefFor}
        />
        <SectionView
          title={m.discovery_work_context_dates({}, options)}
          section={context.dates}
          locale={locale}
          subjectHrefFor={subjectHrefFor}
        />
      </div>
    </li>
  );
}
