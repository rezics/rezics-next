import type { SubjectRead } from '@rezics/client';
import { pickText, type SelectedContext } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { ContentItemHeading } from '@rezics/ui/content-item';
import { m } from '../../../paraglide/messages.js';
import { subjectViewHref } from '../../../subject/subject-href';
import { CandidateValue } from '../../pages/data';
import { relationTargetHref } from '../../pages/edition-work';
import { linkClass, linkColor, PlainLink, type PageLink } from '../../pages/shared';
import { withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import type { RecordingFact, RecordingField, RecordingVisit } from './model';

const actionClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function options(locale: string) {
  return { locale: locale as never };
}

function returnLink(link: PageLink, returnTo: string | undefined, locale: string): PageLink {
  const Link = link;
  return function VisitLink({ href, ...props }) {
    return <Link {...props} href={withSubjectVisitReturn(href, returnTo ?? '', locale)} />;
  };
}

function targetOf(read: SubjectRead, targetId: string, locale: string) {
  if (!Object.hasOwn(read.related, targetId)) return;
  const target = read.related[targetId];
  if (!target) return;
  const label = pickText(target.labels, locale);
  return label.text ? { id: targetId, label: label.text, language: label.lang ?? undefined } : undefined;
}

function qualifiedFacts({
  field,
  fact,
  read,
  release,
  locale,
  link,
  returnTo,
}: {
  field: RecordingField;
  fact: RecordingFact;
  read: SubjectRead;
  release: Release;
  locale: string;
  link: PageLink;
  returnTo?: string;
}) {
  const VisitLink = returnLink(link, returnTo, locale);
  const admitted = new Set(field.definition.qualifiers);
  const notes = fact.qualifiers.flatMap((qualifier, index) => {
    if (!admitted.has(qualifier.property.id)) return [];
    const definition = release.properties[qualifier.property.id];
    if (!definition || definition.datatype !== qualifier.property.data_type) return [];
    const label = pickText(definition.labels, locale);
    if (!label.text) return [];
    return [
      <li key={`${qualifier.property.id}:${index}`} data-property={qualifier.property.id}>
        <span lang={label.lang ?? undefined}>{label.text}: </span>
        <CandidateValue snak={qualifier} related={read.related} locale={locale} link={VisitLink} />
      </li>,
    ];
  });
  return notes.length ? <ul className="text-sm text-muted-foreground">{notes}</ul> : null;
}

function fieldValue({
  field,
  fact,
  read,
  locale,
  context,
  link,
  returnTo,
  release,
}: {
  field: RecordingField;
  fact: RecordingFact;
  read: SubjectRead;
  locale: string;
  context?: SelectedContext;
  link: PageLink;
  returnTo?: string;
  release: Release;
}) {
  const Link = link;
  const VisitLink = returnLink(link, returnTo, locale);
  let value;
  if (field.definition.datatype === 'wikibase-item' && fact.value.type === 'value') {
    const id = fact.value.content;
    const target = typeof id === 'string' ? targetOf(read, id, locale) : undefined;
    value = target ? (
      <Link
        className={actionClass}
        href={withSubjectVisitReturn(relationTargetHref(target, locale, context), returnTo ?? '', locale)}
        lang={target.language}
      >
        {target.label}
      </Link>
    ) : (
      <span className="text-muted-foreground">{m.subject_value_unlabelled({}, options(locale))}</span>
    );
  } else {
    value = (
      <CandidateValue
        snak={fact}
        related={read.related}
        locale={locale}
        link={VisitLink}
        subject={read.subject.id}
      />
    );
  }
  return (
    <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
      {value}
      {field.definition.relation
        ? qualifiedFacts({ field, fact, read, release, locale, link, ...(returnTo ? { returnTo } : {}) })
        : null}
    </div>
  );
}

function FieldGroup({
  title,
  fields,
  read,
  release,
  locale,
  context,
  link,
  returnTo,
}: {
  title: string;
  fields: readonly RecordingField[];
  read: SubjectRead;
  release: Release;
  locale: string;
  context?: SelectedContext;
  link: PageLink;
  returnTo?: string;
}) {
  if (!fields.length) return null;
  return (
    <section className="min-w-0 space-y-3">
      <ContentItemHeading level={3} className="text-xl font-semibold">
        {title}
      </ContentItemHeading>
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
              <ul className="min-w-0 space-y-3">
                {field.facts.map((fact) => (
                  <li key={fact.id} data-statement={fact.id} className="min-w-0 space-y-1">
                    {fieldValue({
                      field,
                      fact,
                      read,
                      locale,
                      ...(context ? { context } : {}),
                      link,
                      ...(returnTo ? { returnTo } : {}),
                      release,
                    })}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ))}
      </dl>
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
  link = PlainLink,
}: {
  visit: RecordingVisit;
  read: SubjectRead;
  release?: Release;
  locale: string;
  context?: SelectedContext;
  returnTo?: string;
  link?: PageLink;
}) {
  const Link = link;
  const stateCopy =
    visit.state === 'loading'
      ? m.candidate_loading({}, options(locale))
      : visit.state === 'unsupported'
        ? m.recording_reader_unsupported({}, options(locale))
        : visit.state === 'empty'
          ? m.recording_reader_empty({}, options(locale))
          : visit.state === 'invalid'
            ? m.recording_reader_unavailable({}, options(locale))
            : m.recording_reader_unavailable({}, options(locale));
  const details = subjectViewHref(
    { id: read.subject.id, label: pickText(read.subject.labels, locale).text },
    locale,
    'details',
  );
  const relations = subjectViewHref(
    { id: read.subject.id, label: pickText(read.subject.labels, locale).text },
    locale,
    'relations',
  );
  const incomplete = visit.bounds.filter((bound) => !bound.complete);
  return (
    <article data-slot="recording-reader" className="min-w-0 space-y-6">
      {visit.state === 'ready' && visit.grain.text ? (
        <ContentItemHeading level={2} className="text-xl font-semibold">
          <span lang={visit.grain.lang ?? undefined}>{visit.grain.text}</span>
        </ContentItemHeading>
      ) : null}
      {visit.state !== 'ready' ? (
        <p role={visit.state === 'loading' || visit.state === 'empty' ? 'status' : 'alert'}>{stateCopy}</p>
      ) : null}
      {visit.state === 'empty' || visit.state === 'unsupported' || visit.state === 'unavailable' ? (
        <p>
          <Link className={actionClass} href={withSubjectVisitReturn(details, returnTo ?? '', locale)}>
            {m.subject_details({}, options(locale))}
          </Link>
        </p>
      ) : null}
      {visit.state === 'ready' && release ? (
        <>
          <FieldGroup
            title={m.music_reader_details({}, options(locale))}
            fields={visit.groups.details}
            read={read}
            release={release}
            locale={locale}
            {...(context ? { context } : {})}
            link={link}
            {...(returnTo ? { returnTo } : {})}
          />
          <FieldGroup
            title={m.recording_reader_contributions({}, options(locale))}
            fields={visit.groups.contributions}
            read={read}
            release={release}
            locale={locale}
            {...(context ? { context } : {})}
            link={link}
            {...(returnTo ? { returnTo } : {})}
          />
          <FieldGroup
            title={m.recording_reader_associations({}, options(locale))}
            fields={visit.groups.associations}
            read={read}
            release={release}
            locale={locale}
            {...(context ? { context } : {})}
            link={link}
            {...(returnTo ? { returnTo } : {})}
          />
        </>
      ) : null}
      {incomplete.length ? (
        <section className="min-w-0 space-y-2" aria-label={m.recording_reader_associations({}, options(locale))}>
          <p className="text-sm text-muted-foreground">
            {m.profile_reader_page_incomplete({ label: incomplete[0]!.property }, options(locale))}
          </p>
          <Link className={`${linkClass} ${linkColor} ${actionClass}`} href={withSubjectVisitReturn(relations, returnTo ?? '', locale)}>
            {m.recording_reader_continue({}, options(locale))}
          </Link>
        </section>
      ) : null}
    </article>
  );
}
