import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { ContentItemHeading } from '@rezics/ui/content-item';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import type { CandidateTransport } from '../../../subject/candidate-review';
import type { FactsCurrent, FactsTransport } from '../subject-facts';
import { catalogueEntries } from '../catalogue-entry';
import { PeopleBiographyDocuments } from './biography';
import { PeopleSelectedItems } from './items';
import { peopleAgentType, peopleBiographyGroups, type PeopleBiographyGroup, type PeopleBiographyKind } from './index';

const actionClass =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center whitespace-normal py-2 [overflow-wrap:anywhere] underline md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';

function groupTitle(kind: PeopleBiographyKind, locale: string) {
  const o = { locale: locale as never };
  return kind === 'biography'
    ? m.people_biography_title({}, o)
    : kind === 'occupations'
      ? m.people_occupations_title({}, o)
      : kind === 'languages'
        ? m.people_languages_title({}, o)
        : m.people_affiliations_title({}, o);
}

function groupHelp(kind: PeopleBiographyKind, locale: string) {
  const o = { locale: locale as never };
  return kind === 'biography'
    ? m.people_biography_help({}, o)
    : kind === 'occupations'
      ? m.people_occupations_help({}, o)
      : kind === 'languages'
        ? m.people_languages_help({}, o)
        : m.people_affiliations_help({}, o);
}

function BiographyGroup({
  group,
  read,
  locale,
  search,
  transport,
  review,
  returnHref,
}: {
  group: PeopleBiographyGroup;
  read: FactsCurrent;
  locale: string;
  search?: EntityPickerSearch | undefined;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  returnHref: string;
}) {
  const o = { locale: locale as never };
  return (
    <section data-slot={`people-group-${group.kind}`} className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
      <ContentItemHeading level={2} className="text-xl font-semibold">
        {groupTitle(group.kind, locale)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{groupHelp(group.kind, locale)}</p>
      {group.fields.map((field) =>
        field.kind === 'biography' ? (
          <PeopleBiographyDocuments key={field.id} field={field} read={read} locale={locale} returnHref={returnHref} />
        ) : search && (field.editor === 'item' || field.editor === 'relation' || field.status === 'unsupported') ? (
          <PeopleSelectedItems
            key={field.id}
            field={field}
            read={read}
            locale={locale}
            search={search}
            transport={transport}
            review={review}
            returnHref={returnHref}
          />
        ) : (
          <p key={field.id} role="status">
            {field.status === 'unsupported' ? m.people_biography_unsupported({}, o) : field.label.text}
          </p>
        ),
      )}
    </section>
  );
}

/** Labelled Person and Organization field groups; property IDs stay in technical details only. */
export function PeopleBiographyGroups({
  read,
  locale,
  search,
  transport,
  review,
}: {
  read: FactsCurrent;
  locale: string;
  search?: EntityPickerSearch | undefined;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
}) {
  const o = { locale: locale as never };
  const subject = read.public.subject;
  const title = Object.values(subject.labels)[0] ?? '';
  const returnHref = catalogueEntries.people({ id: subject.id, label: title, locale }).href;
  const groups = peopleBiographyGroups(read.release, subject.type, locale, read.public, true);
  const agent = peopleAgentType(read.release, subject.type);
  return (
    <div className="min-w-0 space-y-6 [overflow-wrap:anywhere]">
      {groups.map((group) => (
        <BiographyGroup
          key={group.kind}
          group={group}
          read={read}
          locale={locale}
          {...(search ? { search } : {})}
          transport={transport}
          review={review}
          returnHref={returnHref}
        />
      ))}
      {agent === 'schema:Organization' ? (
        <section data-slot="people-organization-history" className="min-w-0 space-y-3">
          <ContentItemHeading level={2} className="text-xl font-semibold">
            {m.producer_history_title({}, o)}
          </ContentItemHeading>
          <p className="text-sm text-muted-foreground">{m.producer_history_intro({}, o)}</p>
          <a className={actionClass} href={`${subjectHref({ id: subject.id, label: title }, locale).href}/producer`}>
            {m.producer_history_title({}, o)}
          </a>
        </section>
      ) : null}
    </div>
  );
}
