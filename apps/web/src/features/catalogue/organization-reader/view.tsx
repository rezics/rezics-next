import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { pickText } from '@rezics/composition';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { CandidateValue } from '../../pages/data';
import { PlainLink, type Snak, type LinkProps, type PageLink } from '../../pages/shared';
import { connectionReturnHref, withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import { useSubjectCommunityReading } from '../../pages/subject-community-lifetime';
import { catalogueEntries } from '../catalogue-entry';
import { ProfileSourceList } from '../music-reader-view';
import { profileSourceRecords } from '../music-reader';
import { organizationHistory, type OrganizationCurrent, type OrganizationFact } from './index';

const control =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal py-2 text-left underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring [overflow-wrap:anywhere]';

/** A missing related summary cannot authorize a destination; the original identity never follows a redirect. */
function EvidenceValue({
  part,
  read,
  locale,
  link,
}: {
  part: Snak & { id?: string };
  read: OrganizationCurrent;
  locale: string;
  link: PageLink;
}) {
  const o = { locale: locale as never };
  const definition = read.release.properties[part.property.id];
  if (!definition || definition.datatype !== part.property.data_type)
    return <span>{m.candidate_value_unavailable({}, o)}</span>;
  if (part.value.type === 'value' && part.property.data_type === 'wikibase-item') {
    const id = part.value.content;
    const related = read.public.related;
    if (typeof id !== 'string' || !Object.hasOwn(related, id) || !related[id])
      return <span>{m.people_biography_unreadable({}, o)}</span>;
    const target = pickText(related[id].labels, locale);
    const Link = link;
    return (
      <Link
        href={subjectHref({ id, label: target.text }, locale).href}
        lang={target.lang ?? undefined}
        className={control}
      >
        {target.text || m.subject_value_unlabelled({}, o)}
      </Link>
    );
  }
  return (
    <CandidateValue
      snak={part}
      related={read.public.related}
      subject={read.public.subject.id}
      locale={locale}
      link={link}
    />
  );
}

function Evidence({
  fact,
  read,
  locale,
  link,
}: {
  fact: OrganizationFact;
  read: OrganizationCurrent;
  locale: string;
  link: PageLink;
}) {
  const o = { locale: locale as never };
  const label = (id: string) => pickText(read.release.properties[id]?.labels ?? {}, locale);
  return (
    <div className="min-w-0 space-y-3">
      <p>
        {m.candidate_rank({}, o)}:{' '}
        {fact.rank === 'preferred'
          ? m.candidate_rank_preferred({}, o)
          : fact.rank === 'normal'
            ? m.candidate_rank_normal({}, o)
            : m.changes_rank_deprecated({}, o)}
      </p>
      {!!fact.qualifiers.length && (
        <dl className="space-y-2">
          {fact.qualifiers.map((part, index) => (
            <div key={index}>
              <dt lang={label(part.property.id).lang ?? undefined} className="text-sm text-muted-foreground">
                {label(part.property.id).text || m.candidate_value_unavailable({}, o)}
              </dt>
              <dd>
                <EvidenceValue part={part} read={read} locale={locale} link={link} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      <h4 className="font-semibold">{m.correction_references({}, o)}</h4>
      {!fact.references.length && <p>{m.organization_reader_no_citation({}, o)}</p>}
      <ol className="space-y-3">
        {fact.references.map((reference, index) => (
          <li key={reference.hash || index} className="space-y-1">
            <dl>
              {reference.parts.map((part, at) => (
                <div key={at}>
                  <dt className="text-sm text-muted-foreground" lang={label(part.property.id).lang ?? undefined}>
                    {label(part.property.id).text || m.candidate_value_unavailable({}, o)}
                  </dt>
                  <dd>
                    <EvidenceValue part={part} read={read} locale={locale} link={link} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ol>
      <details>
        <summary className={control}>{m.organization_reader_identity({}, o)}</summary>
        <code className="block break-all">{fact.id}</code>
        <code className="block break-all">{JSON.stringify(fact.rezics)}</code>
      </details>
    </div>
  );
}

export function OrganizationReader({
  read,
  locale,
  source = read,
  reader = null,
  link = PlainLink,
  realm,
}: {
  read: OrganizationCurrent;
  locale: string;
  source?: object;
  reader?: string | null;
  link?: PageLink;
  realm?: string | undefined;
}) {
  const observationSource = useMemo(() => ({ source, read }), [source, read]);
  const observation = useSubjectCommunityReading({
    source: observationSource,
    descriptor: JSON.stringify([read.public.subject.id, locale, realm]),
    reader,
  });
  const heading = useRef<HTMLHeadingElement>(null);
  const region = useRef<HTMLElement>(null);
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (!observation.available && focused.current) {
      heading.current?.focus();
      focused.current = false;
    }
  }, [observation.available, observation.key]);
  return (
    <section
      ref={region}
      data-slot="organization-reader"
      className="min-w-0 space-y-5 [overflow-wrap:anywhere]"
      onFocusCapture={() => {
        focused.current = true;
      }}
      onBlurCapture={(event) => {
        focused.current = !!event.relatedTarget && !!region.current?.contains(event.relatedTarget);
      }}
    >
      <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
        {m.organization_reader_title({}, { locale: locale as never })}
      </h2>
      {observation.available ? (
        <OrganizationFacts
          key={observation.key}
          read={read}
          locale={locale}
          link={link}
          realm={realm}
          current={observation.isCurrent}
        />
      ) : (
        <p role="status">{m.organization_reader_unavailable({}, { locale: locale as never })}</p>
      )}
    </section>
  );
}

function OrganizationFacts({
  read,
  locale,
  link: Link,
  realm,
  current,
}: {
  read: OrganizationCurrent;
  locale: string;
  link: PageLink;
  realm?: string | undefined;
  current: () => boolean;
}) {
  const o = { locale: locale as never };
  const model = organizationHistory(read, locale);
  const subject = read.public.subject;
  const title = pickText(subject.labels, locale);
  const origin = connectionReturnHref(subject.id, title.text, locale, realm);
  const href = subjectHref({ id: subject.id, label: title.text }, locale).href;
  const [selected, setSelected] = useState<{ fact: OrganizationFact; opener: HTMLButtonElement }>();
  const detail = useRef<HTMLDivElement>(null);
  const keyboard = useRef(false);
  useLayoutEffect(() => {
    if (selected && keyboard.current && current()) detail.current?.focus();
  }, [selected]);
  const CurrentLink = useMemo(
    () =>
      function CurrentLink(props: LinkProps) {
        return (
          <span
            onClickCapture={(event) => {
              if (!current()) event.preventDefault();
            }}
          >
            <Link {...props} href={withSubjectVisitReturn(props.href, origin, locale)} />
          </span>
        );
      },
    [Link, origin, locale, current],
  );
  if (!model) return <p role="status">{m.organization_reader_unavailable({}, o)}</p>;
  const open = (fact: OrganizationFact, event: MouseEvent<HTMLButtonElement>) => {
    if (!current()) return;
    keyboard.current = event.detail === 0;
    setSelected({ fact, opener: event.currentTarget });
  };
  const close = () => {
    if (!current()) return;
    const opener = selected?.opener;
    setSelected(undefined);
    if (opener?.isConnected) opener.focus();
  };
  const correction = selected
    ? `${href}/edit?${new URLSearchParams({ property: selected.fact.property.id, statement: selected.fact.id })}`
    : catalogueEntries.facts({ id: subject.id, label: title.text, locale }).href;
  return (
    <>
      <p lang={model.grain.lang ?? undefined} className="font-medium">
        {model.grain.text}
      </p>
      <p className="text-muted-foreground">{m.organization_reader_intro({}, o)}</p>
      {Object.entries(subject.descriptions).map(([lang, description]) => (
        <p key={lang} lang={lang}>
          {description}
        </p>
      ))}
      {model.authoredUnsupported && (
        <p role="status">
          {m.people_biography_title({}, o)}: {m.people_biography_unsupported({}, o)}
        </p>
      )}
      {!!model.unreleased.length && (
        <p role="status">
          {m.producer_history_unreleased({}, o)}{' '}
          {model.unreleased
            .map((field) =>
              field.meaning === 'parent'
                ? m.producer_history_parent({}, o)
                : field.meaning === 'predecessor'
                  ? m.producer_history_predecessor({}, o)
                  : m.producer_history_successor({}, o),
            )
            .join(' · ')}
        </p>
      )}
      {model.fields.map((field) => (
        <section key={field.id} className="min-w-0 space-y-2">
          <h3 lang={field.label.lang ?? undefined} className="text-lg font-semibold">
            {field.label.text || m.candidate_value_unavailable({}, o)}
          </h3>
          {field.kind === 'relations' && (
            <p className="text-sm text-muted-foreground">{m.organization_reader_direction({}, o)}</p>
          )}
          {!field.facts.length && (
            <p>{field.unavailable ? m.candidate_value_unavailable({}, o) : m.people_biography_absent({}, o)}</p>
          )}
          <ul className="space-y-3">
            {field.facts.map((fact) => (
              <li key={fact.id} className="min-w-0 space-y-1">
                <EvidenceValue part={fact} read={read} locale={locale} link={CurrentLink} />
                <button
                  type="button"
                  className={control + ' block text-sm'}
                  onClick={(event) => open(fact, event)}
                  aria-expanded={selected?.fact === fact}
                >
                  {m.organization_reader_inspect({}, o)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!model.fields.length && <p>{m.organization_reader_no_fields({}, o)}</p>}
      {model.limited && <p role="status">{m.organization_reader_bounded({}, o)}</p>}
      {selected && (
        <div
          ref={detail}
          tabIndex={-1}
          role="region"
          aria-label={m.organization_reader_inspect({}, o)}
          className="min-w-0 space-y-3 rounded border p-4"
        >
          <EvidenceValue part={selected.fact} read={read} locale={locale} link={CurrentLink} />
          <Evidence fact={selected.fact} read={read} locale={locale} link={CurrentLink} />
          <CurrentLink href={correction} className={control}>
            {m.facts_title({}, o)}
          </CurrentLink>
          <button type="button" className={control} onClick={close}>
            {m.organization_reader_return({}, o)}
          </button>
        </div>
      )}
      <nav className="flex flex-wrap gap-4" aria-label={m.facts_title({}, o)}>
        <CurrentLink
          href={catalogueEntries.facts({ id: subject.id, label: title.text, locale }).href}
          className={control}
        >
          {m.facts_title({}, o)}
        </CurrentLink>
        <CurrentLink href={`${href}/relations`} className={control}>
          {m.subject_relations({}, o)}
        </CurrentLink>
        <CurrentLink href={`${href}/works`} className={control}>
          {m.subject_works({}, o)}
        </CurrentLink>
      </nav>
      <ProfileSourceList sources={profileSourceRecords(subject)} locale={locale} />
    </>
  );
}
