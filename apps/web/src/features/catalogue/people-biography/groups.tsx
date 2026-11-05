import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { ContentItemHeading } from '@rezics/ui/content-item';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { defaultReader } from '../../../subject/reader';
import { personBiographyReturn, withSubjectVisitReturn, type PersonBiographyReturn } from '../../pages/subject-visit-navigation';
import { spoilerLevel } from '../../pages/shared';
import type { CandidateTransport } from '../../../subject/candidate-review';
import type { FactsCurrent, FactsTransport } from '../subject-facts';
import { PeopleBiographyDocuments } from './biography';
import { PeopleSelectedItems } from './items';
import { peopleBiographyAddress } from './current-visit';
import { peopleBiographyAssertionAnchor, peopleBiographyFieldAnchor } from './assertion';
import { useCurrentReadingActive, useCurrentReadingVisible } from '../editor-lifetime';
import {
  peopleAgentType,
  peopleBiographyGroups,
  peopleSubjectLabel,
  type PeopleBiographyGroup,
  type PeopleBiographyKind,
} from './index';

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
  restoredAssertion,
}: {
  group: PeopleBiographyGroup;
  read: FactsCurrent;
  locale: string;
  search?: EntityPickerSearch | undefined;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  restoredAssertion?: string | undefined;
}) {
  const o = { locale: locale as never };
  return (
    <section
      id={`people-group-${group.kind}`}
      tabIndex={-1}
      data-slot={`people-group-${group.kind}`}
      className="min-w-0 space-y-3 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <ContentItemHeading level={2} className="text-xl font-semibold">
        {groupTitle(group.kind, locale)}
      </ContentItemHeading>
      <p className="text-sm text-muted-foreground">{groupHelp(group.kind, locale)}</p>
      {group.fields.map((field) =>
        field.kind === 'biography' ? (
          <PeopleBiographyDocuments
            key={field.id}
            field={field}
            read={read}
            locale={locale}
            restoredAssertion={restoredAssertion}
          />
        ) :
        field.editor === 'relation' ||
        field.status === 'unsupported' ||
        field.facts.length > 0 ||
        (search && field.editor === 'item') ? (
          <PeopleSelectedItems
            key={field.id}
            field={field}
            read={read}
            locale={locale}
            {...(search ? { search } : {})}
            transport={transport}
            review={review}
            restoredAssertion={restoredAssertion}
          />
        ) : (
          <p key={field.id} id={peopleBiographyFieldAnchor(field.id)} tabIndex={-1} role="status">
            {field.label.text}
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
  const active = useCurrentReadingActive();
  const visible = useCurrentReadingVisible();
  const title = peopleSubjectLabel(subject, locale).text;
  const groups = useMemo(
    () => peopleBiographyGroups(read.release, subject.type, locale, read.public, true),
    [read.public, read.release, subject.type, locale],
  );
  const agent = peopleAgentType(read.release, subject.type);
  const [visit, setVisit] = useState<{ locator: PersonBiographyReturn; current: boolean }>();
  const focused = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!visible || !active()) return;
    const url = new URL(window.location.href);
    const locator = personBiographyReturn(url.hash);
    if (!locator) {
      setVisit(undefined);
      focused.current = undefined;
      return;
    }
    const group = groups.find((entry) => entry.kind === locator.window);
    const field = group?.fields.find((entry) => entry.id === locator.field);
    const current =
      url.searchParams.get('context') === locator.context &&
      subject.context === locator.context &&
      !!field &&
      (!locator.assertion || field.facts.some((fact) => fact.id === locator.assertion));
    setVisit({ locator, current });
  }, [active, groups, subject, read.release, visible]);
  useEffect(() => {
    if (!visible || !active() || !visit) return;
    const currentFact = visit.locator.assertion
      ? groups
          .find((group) => group.kind === visit.locator.window)
          ?.fields.find((field) => field.id === visit.locator.field)
          ?.facts.find((fact) => fact.id === visit.locator.assertion)
      : undefined;
    const assertionDisclosed =
      !!currentFact && spoilerLevel(currentFact.statement) <= defaultReader.spoilerLevel;
    const focusId =
      visit.current && visit.locator.assertion && assertionDisclosed
        ? peopleBiographyAssertionAnchor(visit.locator.assertion)
        : peopleBiographyFieldAnchor(visit.locator.field);
    if (focused.current === focusId) return;
    focused.current = focusId;
    const target = document.getElementById(focusId) ?? document.getElementById(`people-group-${visit.locator.window}`);
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  }, [active, groups, visit, visible]);
  const restore = (window: PersonBiographyReturn['window']) =>
    (() => {
      if (!visit?.current || visit.locator.window !== window || !visit.locator.assertion) return undefined;
      const fact = groups
        .find((group) => group.kind === window)
        ?.fields.find((field) => field.id === visit.locator.field)
        ?.facts.find((entry) => entry.id === visit.locator.assertion);
      return fact && spoilerLevel(fact.statement) <= defaultReader.spoilerLevel ? visit.locator.assertion : undefined;
    })();
  const returnAddress = (window: PersonBiographyReturn['window'], field: string, assertion?: string) =>
    peopleBiographyAddress(subject.id, title, locale, subject.context, window, field, assertion);
  const affiliationField = groups.find((group) => group.kind === 'affiliations')?.fields[0];
  const historyReturn = affiliationField
    ? returnAddress('affiliations', affiliationField.id)
    : `${subjectHref({ id: subject.id, label: title }, locale).href}/people?context=${encodeURIComponent(subject.context)}`;
  return (
    <div className="min-w-0 space-y-6 [overflow-wrap:anywhere]">
      {visit && !visit.current ? <p role="status">{m.people_facts_changed({}, o)}</p> : null}
      {groups.map((group) => (
        <BiographyGroup
          key={group.kind}
          group={group}
          read={read}
          locale={locale}
          {...(search ? { search } : {})}
          transport={transport}
          review={review}
          restoredAssertion={restore(group.kind)}
        />
      ))}
      {agent === 'schema:Organization' ? (
        <section data-slot="people-organization-history" className="min-w-0 space-y-3">
          <ContentItemHeading level={2} className="text-xl font-semibold">
            {m.producer_history_title({}, o)}
          </ContentItemHeading>
          <p className="text-sm text-muted-foreground">{m.producer_history_intro({}, o)}</p>
          <a
            className={actionClass}
            href={withSubjectVisitReturn(
              (() => {
                const url = new URL(`${subjectHref({ id: subject.id, label: title }, locale).href}/producer`, 'https://rezics.invalid');
                url.searchParams.set('context', subject.context);
                return `${url.pathname}${url.search}`;
              })(),
              historyReturn,
              locale,
            )}
          >
            {m.producer_history_title({}, o)}
          </a>
        </section>
      ) : null}
    </div>
  );
}
