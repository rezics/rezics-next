import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { ReadingDisclosureScope } from '@rezics/ui/cover';
import { pickText } from '@rezics/composition';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { defaultReader, type Reader } from '../../../subject/reader';
import { ExternalValue, PlainLink, spoilerLevel, type LinkProps, type PageLink } from '../../pages/shared';
import {
  organizationHistoryVisitReturn,
  type OrganizationHistoryVisitReturn,
} from '../../pages/subject-visit-navigation';
import { catalogueEntries } from '../catalogue-entry';
import { ProfileSourceList } from '../music-reader-view';
import { profileSourceRecords } from '../music-reader';
import { organizationHistory, type OrganizationReading, type OrganizationFact } from './index';
import { useOrganizationEpisode, type OrganizationEpisode } from './reading/episode';
import {
  organizationHistoryAddress,
  organizationHistoryDestinationHref,
  replaceOrganizationHistoryAddress,
} from './reading/visit';
import { OrganizationValue, organizationControl as control } from './reading/value';

type Selection = {
  episode: number;
  id: string;
  property: string;
  opener: HTMLButtonElement;
  keyboard: boolean;
};
type Presentation = { read: OrganizationReading; locale: string; documents?: unknown; link: PageLink };

function organizationLocator(
  read: OrganizationReading,
  fact: OrganizationFact,
  keyboard: boolean,
  locale: string,
  realm?: string,
): OrganizationHistoryVisitReturn {
  return {
    holder: read.public.subject.id,
    context: read.public.subject.context,
    locale,
    ...(realm ? { realm } : {}),
    property: fact.property.id,
    candidate: fact.id,
    revision: fact.rezics.revision,
    release: fact.rezics.release,
    focus: keyboard ? 'keyboard' : 'pointer',
  };
}

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
  const o = { locale: locale as never };
  const title = pickText(read.public.subject.labels, locale);
  const fallbackHref = subjectHref({ id: read.public.subject.id, label: title.text }, locale).href;
  const href = organizationHistoryAddress(
    currentHref ?? returnTo,
    fallbackHref,
    locale,
    read.public.subject.id,
    read.public.subject.context,
    realm,
  );
  const [returnHash, setReturnHash] = useState(() => (typeof window === 'undefined' ? '' : window.location.hash));
  const [navigationRevision, setNavigationRevision] = useState(0);
  const previousVisit = useRef({ episode: episode.key, href, navigationRevision });
  useEffect(() => {
    const update = () => setReturnHash(window.location.hash);
    const navigate = () => {
      update();
      setNavigationRevision((value) => value + 1);
    };
    update();
    window.addEventListener('hashchange', navigate);
    window.addEventListener('popstate', navigate);
    return () => {
      window.removeEventListener('hashchange', navigate);
      window.removeEventListener('popstate', navigate);
    };
  }, []);
  useLayoutEffect(() => {
    const previous = previousVisit.current;
    const addressChanged = previous.href !== href;
    const episodeChanged = previous.episode !== episode.key;
    const navigated = previous.navigationRevision !== navigationRevision;
    previousVisit.current = { episode: episode.key, href, navigationRevision };
    if (addressChanged) {
      setReturnHash(window.location.hash);
      return;
    }
    if (episodeChanged && !navigated && organizationHistoryVisitReturn(window.location.hash)) {
      const address = organizationHistoryAddress(href, fallbackHref, locale, read.public.subject.id, read.public.subject.context, realm);
      const hash = replaceOrganizationHistoryAddress(address);
      if (hash) setReturnHash(hash);
    }
  }, [episode.key, href, navigationRevision, fallbackHref, locale, read.public.subject.id, read.public.subject.context, realm]);
  const persistVisit = (fact?: OrganizationFact, keyboard = false) => {
    if (!episode.current()) return;
    const address = organizationHistoryAddress(
      href,
      fallbackHref,
      locale,
      read.public.subject.id,
      read.public.subject.context,
      realm,
      fact ? organizationLocator(read, fact, keyboard, locale, realm) : undefined,
    );
    const hash = replaceOrganizationHistoryAddress(address);
    if (hash) setReturnHash(hash);
  };
  return (
    <section
      data-slot="organization-reader"
      className="min-w-0 space-y-5 [overflow-wrap:anywhere] [&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center"
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
              persistVisit();
              setSelected(undefined);
              (opener?.isConnected ? opener : heading.current)?.focus();
            }}
            currentHref={href}
            returnHash={returnHash}
            persistVisit={persistVisit}
            focusHeader={() => heading.current?.focus()}
            reportChanged={() => setChanged(true)}
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

/** Hide removes the fact and its links immediately, including an open inspection. */
function OrganizationFactDisclosure({
  children,
  locale,
  current,
  onHide,
}: {
  children: ReactNode;
  locale: string;
  current: () => boolean;
  onHide: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const o = { locale: locale as never };
  return (
    <div className="min-w-0 space-y-2">
      <button
        type="button"
        className={control}
        aria-expanded={revealed}
        onClick={() => {
          if (!current()) return;
          if (revealed) onHide();
          setRevealed(!revealed);
        }}
      >
        {revealed ? m.subject_spoiler_hide({}, o) : m.subject_spoiler_show({}, o)}
      </button>
      {revealed && children}
    </div>
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
  returnHash,
  persistVisit,
  focusHeader,
  reportChanged,
}: {
  read: OrganizationReading;
  locale: string;
  link: PageLink;
  realm?: string | undefined;
  episode: OrganizationEpisode;
  documents?: unknown;
  preferences: Reader;
  selected: Selection | undefined;
  select: (selection: Selection | undefined) => void;
  close: () => void;
  currentHref: string;
  returnHash: string;
  persistVisit: (fact?: OrganizationFact, keyboard?: boolean) => void;
  focusHeader: () => void;
  reportChanged: () => void;
}) {
  const o = { locale: locale as never };
  const model = useMemo(() => organizationHistory(read, locale), [read, locale]);
  const fieldHeadings = useRef(new Map<string, HTMLHeadingElement>());
  const handledReturn = useRef('');
  const subject = read.public.subject;
  const title = pickText(subject.labels, locale);
  const fallbackHref = subjectHref({ id: subject.id, label: title.text }, locale).href;
  const selectedFact =
    selected?.episode === episode.key
      ? model?.fields.find((field) => field.id === selected.property)?.facts.find((fact) => fact.id === selected.id)
      : undefined;
  const selectedLocator =
    selectedFact && spoilerLevel(selectedFact) <= preferences.spoilerLevel
      ? organizationLocator(read, selectedFact, !!selected?.keyboard, locale, realm)
      : undefined;
  const origin = organizationHistoryAddress(
    currentHref,
    fallbackHref,
    locale,
    subject.id,
    subject.context,
    realm,
    selectedLocator,
  );
  const CurrentLink = useMemo(
    () =>
      function CurrentLink(props: LinkProps) {
        return (
          <span
            onClickCapture={(event) => {
              if (!episode.current()) event.preventDefault();
            }}
          >
            <Link
              {...props}
              href={organizationHistoryDestinationHref(props.href, subject.context, realm, origin, locale)}
            />
          </span>
        );
      },
    [Link, episode, origin, locale, realm, subject.context],
  );
  const presentation = { read, documents, locale, link: CurrentLink };
  useEffect(() => {
    if (handledReturn.current === returnHash) return;
    const intent = organizationHistoryVisitReturn(returnHash);
    handledReturn.current = returnHash;
    if (!intent || selected?.episode === episode.key || !episode.current()) return;
    const field = model?.fields.find((item) => item.id === intent.property);
    const fact = field?.facts.find((item) => item.id === intent.candidate);
    const exact =
      intent.holder === subject.id &&
      intent.context === subject.context &&
      intent.locale === locale &&
      intent.realm === realm &&
      fact?.property.id === intent.property &&
      fact.rezics.revision === intent.revision &&
      fact.rezics.release === intent.release;
    if (!exact || (!!fact && spoilerLevel(fact) > preferences.spoilerLevel)) {
      reportChanged();
      const fieldHeading = fieldHeadings.current.get(intent.property);
      if (fieldHeading) fieldHeading.focus();
      else focusHeader();
      return;
    }
    const opener = [...document.querySelectorAll<HTMLButtonElement>('button[data-organization-property]')].find(
      (button) => button.dataset.organizationProperty === intent.property && button.dataset.organizationCandidate === intent.candidate,
    );
    if (!opener) {
      reportChanged();
      const fieldHeading = fieldHeadings.current.get(intent.property);
      if (fieldHeading) fieldHeading.focus();
      else focusHeader();
      return;
    }
    select({
      episode: episode.key,
      id: fact.id,
      property: fact.property.id,
      opener,
      keyboard: intent.focus === 'keyboard',
    });
  }, [returnHash, selected, episode, model, subject.id, subject.context, preferences.spoilerLevel, select, reportChanged, focusHeader]);
  if (!model) return <p role="status">{m.organization_reader_unavailable({}, o)}</p>;
  const open = (fact: OrganizationFact, event: MouseEvent<HTMLButtonElement>) => {
    if (episode.current()) {
      const keyboard = event.detail === 0;
      select({
        episode: episode.key,
        id: fact.id,
        property: fact.property.id,
        opener: event.currentTarget,
        keyboard,
      });
      persistVisit(fact, keyboard);
    }
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
          <h3
            ref={(node) => {
              if (node) fieldHeadings.current.set(field.id, node);
              else fieldHeadings.current.delete(field.id);
            }}
            tabIndex={-1}
            lang={field.label.lang ?? undefined}
            className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring"
          >
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
                    data-organization-property={field.id}
                    data-organization-candidate={fact.id}
                  >
                    {m.organization_reader_inspect({}, o)}
                  </button>
                  {inspecting && (
                    <Inspection
                      fact={fact}
                      selected={selected}
                      presentation={presentation}
                      correction={organizationHistoryDestinationHref(
                        `${catalogueEntries.facts({ id: subject.id, label: title.text, locale }).href}?${new URLSearchParams({ property: fact.property.id, statement: fact.id })}`,
                        subject.context,
                        realm,
                        organizationHistoryAddress(
                          currentHref,
                          fallbackHref,
                          locale,
                          subject.id,
                          subject.context,
                          realm,
                          organizationLocator(read, fact, selected?.keyboard ?? false, locale, realm),
                        ),
                        locale,
                      )}
                      close={close}
                      current={episode.current}
                    />
                  )}
                </div>
              );
              return (
                <li key={fact.id} className="min-w-0 space-y-1">
                  {spoilerLevel(fact) > preferences.spoilerLevel ? (
                    <OrganizationFactDisclosure
                      locale={locale}
                      current={episode.current}
                      onHide={() => {
                        if (inspecting) {
                          persistVisit();
                          select(undefined);
                        }
                      }}
                    >
                      {content}
                    </OrganizationFactDisclosure>
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
