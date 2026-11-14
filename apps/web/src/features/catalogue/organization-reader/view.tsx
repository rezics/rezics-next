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
import { ProfileDetails } from '../../pages/shared';

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
    <div className="min-w-0 space-y-4 rounded-lg bg-muted/20 p-3 sm:p-4">
      <p className="font-medium">
        {m.candidate_rank({}, o)}:{' '}
        {fact.rank === 'preferred'
          ? m.candidate_rank_preferred({}, o)
          : fact.rank === 'normal'
            ? m.candidate_rank_normal({}, o)
            : m.changes_rank_deprecated({}, o)}
      </p>
      {!!fact.qualifiers.length && (
        <section
          className="min-w-0 space-y-2 rounded-lg border bg-background p-3"
          aria-label={m.correction_qualifiers({}, o)}
        >
          <h5 className="text-sm font-semibold">{m.correction_qualifiers({}, o)}</h5>
          <dl className="space-y-2">
            {fact.qualifiers.map((part, index) => (
              <div
                key={index}
                className="grid min-w-0 gap-1 border-t pt-2 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(7rem,0.35fr)_minmax(0,1fr)] sm:gap-4"
              >
                <dt lang={label(part.property.id).lang ?? undefined} className="text-sm text-muted-foreground">
                  {label(part.property.id).text || m.candidate_value_unavailable({}, o)}
                </dt>
                <dd className="min-w-0">
                  <OrganizationValue part={part} {...presentation} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <section className="min-w-0 space-y-2 rounded-lg border bg-background p-3">
        <h5 className="text-sm font-semibold">{m.correction_references({}, o)}</h5>
        {!fact.references.length && (
          <p className="text-sm text-muted-foreground">{m.organization_reader_no_citation({}, o)}</p>
        )}
        <ol className="space-y-3">
          {fact.references.map((reference, index) => (
            <li key={reference.hash || index} className="min-w-0 rounded-lg border p-3">
              <dl className="space-y-2">
                {reference.parts.map((part, at) => (
                  <div
                    key={at}
                    className="grid min-w-0 gap-1 border-t pt-2 first:border-t-0 first:pt-0 sm:grid-cols-[minmax(7rem,0.35fr)_minmax(0,1fr)] sm:gap-4"
                  >
                    <dt className="text-sm text-muted-foreground" lang={label(part.property.id).lang ?? undefined}>
                      {label(part.property.id).text || m.candidate_value_unavailable({}, o)}
                    </dt>
                    <dd className="min-w-0">
                      <OrganizationValue part={part} {...presentation} />
                    </dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ol>
      </section>
      <details className="rounded-lg border bg-background px-3">
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
  preferences: observedPreferences = defaultReader,
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
  preferences?: Reader | null;
  currentHref?: string | undefined;
  returnTo?: string | undefined;
}) {
  const observationSource = useMemo(() => ({ source, read, documents }), [source, read, documents]);
  const preferences = observedPreferences ?? defaultReader;
  const disclosure = JSON.stringify([preferences.spoilerLevel, preferences.suitability]);
  const { episode, available } = useOrganizationEpisode(
    observationSource,
    JSON.stringify([read.public.subject.id, read.public.subject.context, locale, realm]),
    reader,
    source,
    observedPreferences,
  );
  const [selected, setSelected] = useState<Selection>();
  const [changed, setChanged] = useState(false);
  const navigationHash = useRef<string | undefined>(undefined);
  const preservingReturn =
    typeof window !== 'undefined' &&
    navigationHash.current === window.location.hash &&
    !!organizationHistoryVisitReturn(window.location.hash);
  if (selected && (selected.episode !== episode.key || !available)) {
    setSelected(undefined);
    if (!preservingReturn) setChanged(true);
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
      navigationHash.current = organizationHistoryVisitReturn(window.location.hash) ? window.location.hash : undefined;
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
      if (navigationHash.current === window.location.hash) return;
      const address = organizationHistoryAddress(
        href,
        fallbackHref,
        locale,
        read.public.subject.id,
        read.public.subject.context,
        realm,
      );
      const hash = replaceOrganizationHistoryAddress(address);
      if (hash) setReturnHash(hash);
      navigationHash.current = undefined;
    }
  }, [
    episode.key,
    href,
    navigationRevision,
    fallbackHref,
    locale,
    read.public.subject.id,
    read.public.subject.context,
    realm,
  ]);
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
  const previousDisclosure = useRef(disclosure);
  useLayoutEffect(() => {
    if (previousDisclosure.current === disclosure) return;
    previousDisclosure.current = disclosure;
    const fact = selected && read.public.subject.statements[selected.property]?.find((fact) => fact.id === selected.id);
    if (fact && spoilerLevel(fact) > preferences.spoilerLevel && episode.current()) {
      persistVisit();
      setSelected(undefined);
    }
  }, [disclosure, selected, read, episode, preferences.spoilerLevel, persistVisit]);
  return (
    <section
      data-slot="organization-reader"
      className="min-w-0 space-y-6 [overflow-wrap:anywhere] [&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center"
    >
      <h2
        ref={heading}
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-ring"
      >
        {m.organization_reader_title({}, o)}
      </h2>
      {available ? (
        <ReadingDisclosureScope.Provider value={`organization:${episode.key}`}>
          {changed && (
            <div className="space-y-3 rounded-lg border border-dashed bg-muted/20 p-4" role="status">
              <p className="leading-relaxed">{m.organization_reader_changed({}, o)}</p>
              <button
                type="button"
                className={control + ' rounded-md border border-border bg-background px-3'}
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
            preferencesPrepared={observedPreferences !== null}
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
            finishNavigation={() => {
              navigationHash.current = undefined;
            }}
            focusHeader={() => heading.current?.focus()}
            reportChanged={() => setChanged(true)}
          />
        </ReadingDisclosureScope.Provider>
      ) : (
        <div className="min-w-0 space-y-3 rounded-xl border bg-muted/20 p-4 sm:p-5">
          <p role="status" className="leading-relaxed text-muted-foreground">
            {m.organization_reader_unavailable({}, o)}
          </p>
          <a href={href} className={control + ' rounded-md border border-border bg-background px-3'}>
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
      className="min-w-0 space-y-4 rounded-xl border bg-card p-4 shadow-sm focus-visible:outline-2 focus-visible:outline-ring sm:p-5"
    >
      <Evidence fact={fact} presentation={presentation} />
      <div className="space-y-3 border-t pt-3">
        <p className="text-sm leading-relaxed text-muted-foreground">{m.organization_reader_navigation({}, o)}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Link href={correction} className={control + ' rounded-md border border-border bg-background px-3'}>
            {m.facts_title({}, o)}
          </Link>
          <button
            type="button"
            className={control + ' rounded-md border border-border bg-background px-3'}
            onClick={close}
          >
            {m.organization_reader_return({}, o)}
          </button>
        </div>
      </div>
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
  preferencesPrepared,
  selected,
  select,
  close,
  currentHref,
  returnHash,
  persistVisit,
  finishNavigation,
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
  preferencesPrepared: boolean;
  selected: Selection | undefined;
  select: (selection: Selection | undefined) => void;
  close: () => void;
  currentHref: string;
  returnHash: string;
  persistVisit: (fact?: OrganizationFact, keyboard?: boolean) => void;
  finishNavigation: () => void;
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
    if (!intent || !episode.current()) return;
    const field = model?.fields.find((item) => item.id === intent.property);
    const fact = field?.facts.find((item) => item.id === intent.candidate);
    // A fallback display threshold cannot settle a concealed return before actual settings arrive.
    if (!preferencesPrepared && fact && spoilerLevel(fact) > preferences.spoilerLevel) return;
    handledReturn.current = returnHash;
    if (selected?.episode === episode.key) {
      if (selected.id === intent.candidate && selected.property === intent.property) finishNavigation();
      return;
    }
    finishNavigation();
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
      (button) =>
        button.dataset.organizationProperty === intent.property &&
        button.dataset.organizationCandidate === intent.candidate,
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
  }, [
    returnHash,
    selected,
    episode,
    model,
    subject.id,
    subject.context,
    preferences.spoilerLevel,
    preferencesPrepared,
    select,
    reportChanged,
    focusHeader,
    finishNavigation,
  ]);
  if (!model)
    return (
      <p
        role="status"
        className="rounded-lg border border-dashed bg-muted/20 p-4 leading-relaxed text-muted-foreground"
      >
        {m.organization_reader_unavailable({}, o)}
      </p>
    );
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
  const primary = model.fields.filter(
    (field) =>
      read.release.properties[field.id]?.datatype === 'document' ||
      field.unavailable ||
      (field.facts.length > 0 && (field.kind === 'dates' || field.kind === 'relations')),
  );
  const secondary = model.fields.filter((field) => !primary.includes(field));
  const renderField = (field: (typeof model.fields)[number]) => (
    <section
      key={field.id}
      className={`min-w-0 space-y-3 rounded-xl border bg-card p-4 shadow-sm sm:p-5 ${
        field.kind === 'dates'
          ? 'border-t-4 border-t-primary/70'
          : field.kind === 'relations'
            ? 'border-t-4 border-t-muted-foreground/50'
            : ''
      }`}
    >
      <h3
        ref={(node) => {
          if (node) fieldHeadings.current.set(field.id, node);
          else fieldHeadings.current.delete(field.id);
        }}
        data-organization-field={field.id}
        tabIndex={-1}
        lang={field.label.lang ?? undefined}
        className="text-base font-semibold leading-snug focus-visible:outline-2 focus-visible:outline-ring sm:text-lg"
      >
        {field.label.text || m.candidate_value_unavailable({}, o)}
      </h3>
      {field.kind === 'relations' && (
        <p className="border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">
          {m.organization_reader_direction({}, o)}
        </p>
      )}
      {!field.facts.length && (
        <p className="rounded-lg border border-dashed bg-muted/20 p-3 text-sm leading-relaxed text-muted-foreground">
          {field.unavailable
            ? m.candidate_value_unavailable({}, o)
            : subject.resolution[field.id] === 'suppressed'
              ? m.people_facts_suppressed({}, o)
              : subject.resolution[field.id] === 'unresolved'
                ? m.people_facts_unresolved({}, o)
                : m.people_biography_absent({}, o)}
        </p>
      )}
      <ul className="grid min-w-0 gap-3 lg:grid-cols-2">
        {field.facts.map((fact) => {
          const inspecting =
            selected?.episode === episode.key && selected.id === fact.id && selected.property === field.id;
          const content = (
            <div className="min-w-0 space-y-3">
              <div className="min-w-0 text-base leading-relaxed">
                <OrganizationValue part={fact} {...presentation} />
              </div>
              <button
                type="button"
                className={control + ' block border-t border-border pt-2 text-sm'}
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
            <li
              key={fact.id}
              className="min-w-0 rounded-lg border bg-background p-3 [overflow-wrap:anywhere] sm:p-4"
            >
              {spoilerLevel(fact) > preferences.spoilerLevel ? (
                <OrganizationFactDisclosure
                  key={`${preferences.spoilerLevel}:${preferences.suitability}`}
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
  );
  const sources = profileSourceRecords(subject);
  const descriptions = Object.entries(subject.descriptions);
  return (
    <>
      {!!primary.length && <div className="grid min-w-0 gap-4 md:grid-cols-2">{primary.map(renderField)}</div>}
      {!model.fields.length && (
        <p
          className="rounded-lg border border-dashed bg-muted/20 p-4 text-sm leading-relaxed text-muted-foreground"
        >
          {m.organization_reader_no_fields({}, o)}
        </p>
      )}
      {model.limited && (
        <p
          role="status"
          className="rounded-lg border border-dashed p-3 text-sm leading-relaxed text-muted-foreground"
        >
          {m.organization_reader_bounded({}, o)}
        </p>
      )}
      <section className="min-w-0 space-y-3 rounded-xl border bg-muted/20 p-4 sm:p-5">
        <p className="text-sm leading-relaxed text-muted-foreground">{m.organization_reader_navigation({}, o)}</p>
        <nav className="flex flex-col gap-2 sm:flex-row sm:flex-wrap" aria-label={m.facts_title({}, o)}>
          <CurrentLink
            href={`${currentHref.split('?')[0]}/relations${realm ? `?${new URLSearchParams({ realm })}` : ''}`}
            className={control + ' w-full justify-start rounded-md border border-border bg-background px-3 sm:w-auto'}
          >
            {m.subject_relations({}, o)}
          </CurrentLink>
          <CurrentLink
            href={`${currentHref.split('?')[0]}/works${realm ? `?${new URLSearchParams({ realm })}` : ''}`}
            className={control + ' w-full justify-start rounded-md border border-border bg-background px-3 sm:w-auto'}
          >
            {m.subject_works({}, o)}
          </CurrentLink>
        </nav>
      </section>
      <ProfileDetails
        locale={locale}
        reveal={
          selected && secondary.some((field) => field.id === selected.property)
            ? `${selected.episode}:${selected.id}`
            : undefined
        }
      >
        {!!descriptions.length && (
          <div className="min-w-0 space-y-3 border-l-2 border-primary/30 pl-4">
            {descriptions.map(([language, description]) => (
              <p key={language} lang={language} className="leading-relaxed">
                {description}
              </p>
            ))}
          </div>
        )}
        {!!secondary.length && <div className="grid min-w-0 gap-4 md:grid-cols-2">{secondary.map(renderField)}</div>}
        <div className="min-w-0 space-y-2 rounded-lg border border-dashed bg-muted/20 p-4">
          <p lang={model.grain.lang ?? undefined} className="font-medium">
            {model.grain.text}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">{m.organization_reader_intro({}, o)}</p>
        </div>
        {model.authoredUnsupported && (
          <p role="status" className="rounded-lg border border-dashed p-3 text-sm leading-relaxed">
            {m.people_biography_title({}, o)}: {m.people_biography_unsupported({}, o)}
          </p>
        )}
        {!model.fields.some((field) => field.kind === 'dates') && (
          <p role="status" className="rounded-lg border border-dashed p-3 text-sm leading-relaxed">
            {m.producer_history_dates({}, o)}: {m.people_biography_unsupported({}, o)}
          </p>
        )}
        {!!model.unreleased.length && (
          <p role="status" className="rounded-lg border border-dashed p-3 text-sm leading-relaxed">
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
        <div className="min-w-0 space-y-4 border-t pt-4">
          <CurrentLink
            href={catalogueEntries.facts({ id: subject.id, label: title.text, locale }).href}
            className={control + ' rounded-md border border-border bg-background px-3'}
          >
            {m.facts_title({}, o)}
          </CurrentLink>
          <div
            className={
              sources.length
                ? 'min-w-0 space-y-3 rounded-xl border bg-muted/20 p-4'
                : 'min-w-0 space-y-3'
            }
          >
            <ProfileSourceList sources={sources} locale={locale} />
            {sources
              .filter((record) => record.licence)
              .map((record) => (
                <p key={`${record.name}:${record.url}`} className="text-sm leading-relaxed">
                  {record.name}: {record.licence!.id}{' '}
                  {record.licence!.url && <ExternalValue value={record.licence!.url} />}
                </p>
              ))}
          </div>
        </div>
      </ProfileDetails>
    </>
  );
}
