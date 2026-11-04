import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ReadingDisclosureScope } from '@rezics/ui/cover';
import { pickText } from '@rezics/composition';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { defaultReader, type Reader } from '../../../subject/reader';
import { ExternalValue, PlainLink, spoilerLevel, type LinkProps, type PageLink } from '../../pages/shared';
import { SpoilerGate } from '../../pages/values';
import { connectionReturnHref, subjectVisitReturn, withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import { catalogueEntries } from '../catalogue-entry';
import { ProfileSourceList } from '../music-reader-view';
import { profileSourceRecords } from '../music-reader';
import { organizationHistory, type OrganizationReading, type OrganizationFact } from './index';
import { useOrganizationEpisode, type OrganizationEpisode } from './reading/episode';
import { OrganizationValue, organizationControl as control } from './reading/value';

type Selection = {
  episode: number;
  id: string;
  property: string;
  opener: HTMLButtonElement;
  keyboard: boolean;
};
type Presentation = { read: OrganizationReading; locale: string; documents?: unknown; link: PageLink };

/** Evidence is always attached to the inspected original assertion, never a similarly titled row. */
function Evidence({ fact, presentation }: { fact: OrganizationFact; presentation: Presentation }) {
  const { read, locale } = presentation;
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
        <section className="space-y-2" aria-label={m.correction_qualifiers({}, o)}>
          <h5 className="font-semibold">{m.correction_qualifiers({}, o)}</h5>
          <dl className="space-y-2">
            {fact.qualifiers.map((part, index) => (
              <div key={index}>
                <dt lang={label(part.property.id).lang ?? undefined} className="text-sm text-muted-foreground">
                  {label(part.property.id).text || m.candidate_value_unavailable({}, o)}
                </dt>
                <dd>
                  <OrganizationValue part={part} {...presentation} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <h5 className="font-semibold">{m.correction_references({}, o)}</h5>
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
                    <OrganizationValue part={part} {...presentation} />
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
        <p>{m.changes_revision({ revision: fact.rezics.revision }, o)}</p>
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
  documents,
  preferences = defaultReader,
  currentHref,
  returnTo,
}: {
  read: OrganizationReading;
  locale: string;
  source?: object;
  reader?: string | null;
  link?: PageLink;
  realm?: string | undefined;
  documents?: unknown;
  preferences?: Reader;
  currentHref?: string | undefined;
  returnTo?: string | undefined;
}) {
  const observationSource = useMemo(() => ({ source, read, documents }), [source, read, documents]);
  const { episode, available } = useOrganizationEpisode(
    observationSource,
    JSON.stringify([
      read.public.subject.id,
      read.public.subject.context,
      locale,
      realm,
      preferences.spoilerLevel,
      preferences.suitability,
    ]),
    reader,
    source,
  );
  const [selected, setSelected] = useState<Selection>();
  const [changed, setChanged] = useState(false);
  if (selected && (selected.episode !== episode.key || !available)) {
    setSelected(undefined);
    setChanged(true);
  }
  const heading = useRef<HTMLHeadingElement>(null);
  const recovery = useRef<HTMLButtonElement>(null);
  const focused = useRef<HTMLElement | undefined>(undefined);
  useLayoutEffect(() => {
    if (focused.current && !focused.current.isConnected && document.activeElement === document.body) {
      (changed && available ? recovery.current : heading.current)?.focus();
      focused.current = undefined;
    }
  });
  const o = { locale: locale as never };
  const title = pickText(read.public.subject.labels, locale);
  const href = currentHref ?? subjectHref({ id: read.public.subject.id, label: title.text }, locale).href;
  return (
    <section
      data-slot="organization-reader"
      className="min-w-0 space-y-5 [overflow-wrap:anywhere] [&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center"
      onFocusCapture={(event) => {
        focused.current = event.target as HTMLElement;
      }}
      onBlurCapture={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focused.current = undefined;
      }}
    >
      <h2
        ref={heading}
        tabIndex={-1}
        className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-ring"
      >
        {m.organization_reader_title({}, o)}
      </h2>
      {available ? (
        <ReadingDisclosureScope.Provider value={`organization:${episode.key}`}>
          {changed && (
            <div className="space-y-2" role="status">
              <p>{m.organization_reader_changed({}, o)}</p>
              <button
                ref={recovery}
                type="button"
                className={control}
                onClick={() => {
                  if (!episode.current()) return;
                  setChanged(false);
                  heading.current?.focus();
                }}
              >
                {m.organization_reader_return({}, o)}
              </button>
            </div>
          )}
          <OrganizationFacts
            key={episode.key}
            read={read}
            documents={documents}
            locale={locale}
            link={link}
            realm={realm}
            episode={episode}
            preferences={preferences}
            selected={selected}
            select={(value) => {
              if (episode.current()) {
                setSelected(value);
                setChanged(false);
              }
            }}
            close={() => {
              if (!episode.current()) return;
              const opener = selected?.opener;
              setSelected(undefined);
              (opener?.isConnected ? opener : heading.current)?.focus();
            }}
            currentHref={href}
            returnTo={returnTo}
          />
        </ReadingDisclosureScope.Provider>
      ) : (
        <div className="space-y-2">
          <p role="status">{m.organization_reader_unavailable({}, o)}</p>
          <a href={href} className={control}>
            {m.organization_reader_refresh({}, o)}
          </a>
        </div>
      )}
    </section>
  );
}

function Inspection({
  fact,
  selected,
  presentation,
  correction,
  close,
  current,
}: {
  fact: OrganizationFact;
  selected: Selection;
  presentation: Presentation;
  correction: string;
  close: () => void;
  current: () => boolean;
}) {
  const region = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (selected.keyboard && current()) region.current?.focus();
  }, [selected]);
  const o = { locale: presentation.locale as never };
  const Link = presentation.link;
  return (
    <div
      ref={region}
      tabIndex={-1}
      role="region"
      aria-label={m.organization_reader_inspect({}, o)}
      className="min-w-0 space-y-3 rounded border p-4 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <Evidence fact={fact} presentation={presentation} />
      <p className="text-sm text-muted-foreground">{m.organization_reader_navigation({}, o)}</p>
      <Link href={correction} className={control}>
        {m.facts_title({}, o)}
      </Link>
      <button type="button" className={control} onClick={close}>
        {m.organization_reader_return({}, o)}
      </button>
    </div>
  );
}

function OrganizationFacts({
  read,
  locale,
  link: Link,
  realm,
  episode,
  documents,
  preferences,
  selected,
  select,
  close,
  currentHref,
  returnTo,
}: {
  read: OrganizationReading;
  locale: string;
  link: PageLink;
  realm?: string | undefined;
  episode: OrganizationEpisode;
  documents?: unknown;
  preferences: Reader;
  selected: Selection | undefined;
  select: (selection: Selection) => void;
  close: () => void;
  currentHref: string;
  returnTo?: string | undefined;
}) {
  const o = { locale: locale as never };
  const model = useMemo(() => organizationHistory(read, locale), [read, locale]);
  const subject = read.public.subject;
  const title = pickText(subject.labels, locale);
  // The installed consumer only understands connections here. Do not invent a statement query/hash.
  const origin = subjectVisitReturn(returnTo, locale) ?? connectionReturnHref(subject.id, title.text, locale, realm);
  const CurrentLink = useMemo(
    () =>
      function CurrentLink(props: LinkProps) {
        return (
          <span
            onClickCapture={(event) => {
              if (!episode.current()) event.preventDefault();
            }}
          >
            <Link {...props} href={withSubjectVisitReturn(props.href, origin, locale)} />
          </span>
        );
      },
    [Link, episode, origin, locale],
  );
  const presentation = { read, documents, locale, link: CurrentLink };
  if (!model) return <p role="status">{m.organization_reader_unavailable({}, o)}</p>;
  const open = (fact: OrganizationFact, event: MouseEvent<HTMLButtonElement>) => {
    if (episode.current())
      select({
        episode: episode.key,
        id: fact.id,
        property: fact.property.id,
        opener: event.currentTarget,
        keyboard: event.detail === 0,
      });
  };
  const sources = profileSourceRecords(subject);
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
      {!model.fields.some((field) => field.kind === 'dates') && (
        <p role="status">
          {m.producer_history_dates({}, o)}: {m.people_biography_unsupported({}, o)}
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
            <p>
              {field.unavailable
                ? m.candidate_value_unavailable({}, o)
                : subject.resolution[field.id] === 'suppressed'
                  ? m.people_facts_suppressed({}, o)
                  : subject.resolution[field.id] === 'unresolved'
                    ? m.people_facts_unresolved({}, o)
                    : m.people_biography_absent({}, o)}
            </p>
          )}
          <ul className="space-y-3">
            {field.facts.map((fact) => {
              const inspecting =
                selected?.episode === episode.key && selected.id === fact.id && selected.property === field.id;
              const content = (
                <div className="min-w-0 space-y-2">
                  <OrganizationValue part={fact} {...presentation} />
                  <button
                    type="button"
                    className={control + ' block text-sm'}
                    onClick={(event) => open(fact, event)}
                    aria-expanded={inspecting}
                  >
                    {m.organization_reader_inspect({}, o)}
                  </button>
                  {inspecting && (
                    <Inspection
                      fact={fact}
                      selected={selected}
                      presentation={presentation}
                      correction={`${catalogueEntries.facts({ id: subject.id, label: title.text, locale }).href}?${new URLSearchParams({ property: fact.property.id, statement: fact.id })}`}
                      close={close}
                      current={episode.current}
                    />
                  )}
                </div>
              );
              return (
                <li key={fact.id} className="min-w-0 space-y-1">
                  {spoilerLevel(fact) > preferences.spoilerLevel ? (
                    <SpoilerGate label={m.subject_spoiler_show({}, o)} hideLabel={m.subject_spoiler_hide({}, o)}>
                      {content}
                    </SpoilerGate>
                  ) : (
                    content
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {!model.fields.length && <p>{m.organization_reader_no_fields({}, o)}</p>}
      {model.limited && <p role="status">{m.organization_reader_bounded({}, o)}</p>}
      <p className="text-sm text-muted-foreground">{m.organization_reader_navigation({}, o)}</p>
      <nav className="flex flex-wrap gap-4" aria-label={m.facts_title({}, o)}>
        <CurrentLink
          href={catalogueEntries.facts({ id: subject.id, label: title.text, locale }).href}
          className={control}
        >
          {m.facts_title({}, o)}
        </CurrentLink>
        <CurrentLink
          href={`${currentHref.split('?')[0]}/relations${realm ? `?${new URLSearchParams({ realm })}` : ''}`}
          className={control}
        >
          {m.subject_relations({}, o)}
        </CurrentLink>
        <CurrentLink
          href={`${currentHref.split('?')[0]}/works${realm ? `?${new URLSearchParams({ realm })}` : ''}`}
          className={control}
        >
          {m.subject_works({}, o)}
        </CurrentLink>
      </nav>
      <ProfileSourceList sources={sources} locale={locale} />
      {sources
        .filter((record) => record.licence)
        .map((record) => (
          <p key={`${record.name}:${record.url}`} className="text-sm">
            {record.name}: {record.licence!.id} {record.licence!.url && <ExternalValue value={record.licence!.url} />}
          </p>
        ))}
    </>
  );
}
