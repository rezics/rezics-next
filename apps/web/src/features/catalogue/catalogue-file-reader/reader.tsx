import type { SubjectRead } from '@rezics/client';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { pickText } from '@rezics/composition';
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { m } from '../../../paraglide/messages.js';
import { languageName } from '../../../subject/language';
import { subjectHref } from '../../../subject/subject-href';
import { CatalogueFileProfileEntry } from '../catalogue-file-profile/entry';
import { CandidateValue } from '../../pages/data';
import { ProfileBoundNotes, ProfileSourceList } from '../music-reader-view';
import type { SubjectPageData } from '../../pages/subject';
import { boundedProfileRelations, profileRelationPages } from '../../pages/views';
import { linkClass, linkColor, PlainLink, type PageLink } from '../../pages/shared';
import { catalogueFileDestinationHref, catalogueFileSourceId, catalogueFileSourceReturnHref } from './navigation';
import {
  catalogueFileReaderCandidate,
  catalogueFileReaderVisit,
  exactFileItem,
  type CatalogueFileAssociation,
  type CatalogueFileFact,
  type CatalogueFileReaderVisit,
} from './model';
import { useCatalogueFileReading } from './reading/current';

const readerLinkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8';
const readerControlClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60';

type Statement = SubjectRead['subject']['statements'][string][number];
type FilePart = Statement | Statement['qualifiers'][number];
type Evidence = {
  key: string;
  kind: 'assertion' | 'association';
  group: string;
  property: string;
  label: { text: string; lang: string | null };
  statement: Statement;
  association?: CatalogueFileAssociation;
};

function options(locale: string) {
  return { locale: locale as never };
}

function factGroupTitle(id: keyof CatalogueFileReaderVisit['groups'], locale: string) {
  const o = options(locale);
  if (id === 'identifiers') return m.catalogue_file_identifiers({}, o);
  if (id === 'technical') return m.catalogue_file_technical({}, o);
  if (id === 'language') return m.catalogue_file_language({}, o);
  if (id === 'group') return m.catalogue_file_group({}, o);
  if (id === 'credits') return m.catalogue_file_creator_credits({}, o);
  return m.facts_title({}, o);
}

function assertionKey(visit: CatalogueFileReaderVisit, property: string, statement: Statement) {
  return JSON.stringify(['assertion', visit.public.subject.id, property, statement.id]);
}

function associationKey(visit: CatalogueFileReaderVisit, association: CatalogueFileAssociation) {
  return JSON.stringify([
    'association',
    visit.public.subject.id,
    association.direction,
    association.property,
    association.statement.id,
    association.key,
  ]);
}

function propertyLabel(visit: CatalogueFileReaderVisit, property: string) {
  const label = pickText(visit.release?.properties[property]?.labels ?? {}, visit.locale);
  return { text: label.text || property, lang: label.lang };
}

function qualifierGroups(qualifiers: readonly FilePart[]) {
  const groups = new Map<string, FilePart[]>();
  for (const part of qualifiers) {
    const group = groups.get(part.property.id) ?? [];
    group.push(part);
    groups.set(part.property.id, group);
  }
  return [...groups];
}

function FileValue({
  part,
  publicRead,
  locale,
  link,
}: {
  part: FilePart;
  publicRead: SubjectRead;
  locale: string;
  link: PageLink;
}) {
  const o = options(locale);
  const content = part.value.type === 'value' ? part.value.content : undefined;
  if (part.property.data_type === 'wikibase-item' && typeof content === 'string') {
    const item = exactFileItem(part, publicRead.related);
    if (!item) return <span>{m.candidate_value_unavailable({}, o)}</span>;
    const picked = pickText(item.labels, locale);
    const label = picked.text || m.subject_value_unlabelled({}, o);
    const Link = link;
    return (
      <Link
        className={`${readerLinkClass} ${linkClass} ${linkColor}`}
        href={subjectHref({ id: item.id, label }, locale).href}
        {...(picked.lang ? { lang: picked.lang } : {})}
      >
        {label}
      </Link>
    );
  }
  if (part.property.id === 'schema:inLanguage' && typeof content === 'string') {
    const name = languageName(content, locale);
    if (name !== undefined)
      return (
        <span>
          {name} <span className="text-muted-foreground">({content})</span>
        </span>
      );
    return <span data-raw={content}>{content}</span>;
  }
  return <CandidateValue snak={part} related={publicRead.related} locale={locale} link={link} />;
}

function FactValue({
  fact,
  visit,
  link,
  group,
  heading,
  reading,
}: {
  fact: CatalogueFileFact;
  visit: CatalogueFileReaderVisit;
  link: PageLink;
  group: keyof CatalogueFileReaderVisit['groups'];
  heading: () => HTMLElement | undefined;
  reading: ReturnType<typeof useCatalogueFileReading>;
}) {
  const o = options(visit.locale);
  return (
    <section className="min-w-0 space-y-2" data-property={fact.property}>
      <h3 lang={fact.label.lang ?? undefined} className="text-sm font-medium text-muted-foreground">
        {fact.label.text || fact.property}
      </h3>
      <ol className="min-w-0 space-y-3">
        {fact.statements.map((statement) => (
          <li key={statement.id} className="min-w-0" data-evidence-kind="assertion">
            <ContentItemFrame as="div" className="min-w-0 space-y-3 p-4">
              <div className="min-w-0 [overflow-wrap:anywhere]">
                <FileValue part={statement} publicRead={visit.public} locale={visit.locale} link={link} />
              </div>
              <button
                type="button"
                className={readerControlClass}
                data-inspection-trigger
                data-inspection-kind="assertion"
                aria-controls={
                  reading.selection?.key === assertionKey(visit, fact.property, statement)
                    ? 'catalogue-file-inspection'
                    : undefined
                }
                aria-expanded={reading.selection?.key === assertionKey(visit, fact.property, statement)}
                onClick={(event) =>
                  reading.select(
                    { key: assertionKey(visit, fact.property, statement), group, kind: 'assertion' },
                    event.currentTarget,
                    heading(),
                    event.detail === 0,
                  )
                }
              >
                {m.catalogue_file_inspect_assertion({}, o)}
              </button>
            </ContentItemFrame>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AssociationList({
  visit,
  link,
  reading,
  heading,
}: {
  visit: CatalogueFileReaderVisit;
  link: PageLink;
  reading: ReturnType<typeof useCatalogueFileReading>;
  heading: (element: HTMLElement | null) => void;
}) {
  const Link = link;
  const o = options(visit.locale);
  const current = pickText(visit.public.subject.labels, visit.locale);
  const currentTitle = current.text || m.subject_value_unlabelled({}, o);
  return (
    <section className="min-w-0 space-y-3" data-slot="catalogue-file-reader-associations">
      <h2
        ref={heading}
        tabIndex={-1}
        className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {m.catalogue_file_related({}, o)}
      </h2>
      {!visit.associations.length && <p>{m.catalogue_file_empty({}, o)}</p>}
      <ul className="min-w-0 space-y-3">
        {visit.associations.map((association) => {
          const related = association.direction === 'forward' ? association.target : association.source;
          const destination = subjectHref({ id: related.id, label: related.label }, visit.locale).href;
          const href = catalogueFileDestinationHref(destination, visit.public.subject.id, visit.locale);
          const readable = association.readability === 'readable' && !association.historical && href;
          const concealed =
            association.kind === 'episode'
              ? m.catalogue_file_episode_concealed({}, o)
              : m.candidate_value_unavailable({}, o);
          const relatedLabel =
            association.readability === 'concealed' ? concealed : related.label || m.candidate_value_unavailable({}, o);
          const sourceLabel = association.direction === 'forward' ? currentTitle : relatedLabel;
          const targetLabel = association.direction === 'forward' ? relatedLabel : currentTitle;
          const relationLabel = association.label.text || association.property;
          const kindLabel =
            association.kind === 'episode'
              ? m.catalogue_file_episode({}, o)
              : association.kind === 'release'
                ? m.catalogue_file_release({}, o)
                : association.kind === 'group'
                  ? m.catalogue_file_group({}, o)
                  : m.catalogue_file_title({}, o);
          return (
            <li key={association.key} data-evidence-kind="association">
              <ContentItemFrame as="div" className="min-w-0 space-y-2 p-4">
                <p className="text-sm text-muted-foreground">{kindLabel}</p>
                <p
                  className="min-w-0 [overflow-wrap:anywhere]"
                  aria-label={`${sourceLabel} ${relationLabel} ${targetLabel}`}
                  data-direction={association.direction}
                >
                  <span
                    lang={
                      association.direction === 'forward'
                        ? (current.lang ?? undefined)
                        : association.readability === 'concealed'
                          ? undefined
                          : association.source.lang
                    }
                  >
                    {sourceLabel}
                  </span>{' '}
                  <span lang={association.label.lang ?? undefined} className="text-muted-foreground">
                    {relationLabel}
                  </span>{' '}
                  <span
                    lang={
                      association.direction === 'inverse'
                        ? (current.lang ?? undefined)
                        : association.readability === 'concealed'
                          ? undefined
                          : association.target.lang
                    }
                  >
                    {targetLabel}
                  </span>
                </p>
                {readable && href ? (
                  <Link className={`${readerLinkClass} ${linkClass} ${linkColor}`} href={href}>
                    {related.label || m.subject_value_unlabelled({}, o)}
                  </Link>
                ) : null}
                {association.historical && (
                  <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
                )}
                {association.readability === 'concealed' ? (
                  <p>{concealed}</p>
                ) : association.readability === 'unreadable' ? (
                  <p>{m.release_fidelity_work_unreadable({}, o)}</p>
                ) : null}
                <button
                  type="button"
                  className={readerControlClass}
                  data-inspection-trigger
                  data-inspection-kind="association"
                  aria-controls={
                    reading.selection?.key === associationKey(visit, association)
                      ? 'catalogue-file-inspection'
                      : undefined
                  }
                  aria-expanded={reading.selection?.key === associationKey(visit, association)}
                  onClick={(event) =>
                    reading.select(
                      {
                        key: associationKey(visit, association),
                        group: 'associations',
                        kind: 'association',
                      },
                      event.currentTarget,
                      undefined,
                      event.detail === 0,
                    )
                  }
                >
                  {m.catalogue_file_inspect_association({}, o)}
                </button>
              </ContentItemFrame>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function selectedEvidence(visit: CatalogueFileReaderVisit, reading: ReturnType<typeof useCatalogueFileReading>) {
  const selection = reading.selection;
  if (!selection) return;
  if (selection.kind === 'assertion') {
    for (const [group, facts] of Object.entries(visit.groups)) {
      if (selection.group !== group) continue;
      for (const fact of facts) {
        for (const statement of fact.statements) {
          if (assertionKey(visit, fact.property, statement) === selection.key)
            return {
              key: selection.key,
              kind: 'assertion' as const,
              group,
              property: fact.property,
              label: fact.label,
              statement,
            } satisfies Evidence;
        }
      }
    }
    return;
  }
  const association = visit.associations.find((item) => associationKey(visit, item) === selection.key);
  if (!association) return;
  return {
    key: selection.key,
    kind: 'association' as const,
    group: selection.group,
    property: association.property,
    label: association.label,
    statement: association.statement,
    association,
  } satisfies Evidence;
}

function InspectionPanel({
  evidence,
  visit,
  link,
  reading,
  heading,
  fallback,
}: {
  evidence: Evidence;
  visit: CatalogueFileReaderVisit;
  link: PageLink;
  reading: ReturnType<typeof useCatalogueFileReading>;
  heading: RefObject<HTMLHeadingElement | null>;
  fallback: () => HTMLElement | undefined;
}) {
  const o = options(visit.locale);
  const Link = link;
  const statement = evidence.statement;
  const association = evidence.association;
  const currentRelease = visit.digest;
  const current = pickText(visit.public.subject.labels, visit.locale);
  const currentTitle = current.text || m.subject_value_unlabelled({}, o);
  const related = association
    ? association.direction === 'forward'
      ? association.target
      : association.source
    : undefined;
  const destination =
    association && related
      ? catalogueFileDestinationHref(
          subjectHref({ id: related.id, label: related.label }, visit.locale).href,
          visit.public.subject.id,
          visit.locale,
        )
      : undefined;
  const destinationAllowed =
    !!association && association.readability === 'readable' && !association.historical && !!destination;
  const concealed = association
    ? association.kind === 'episode'
      ? m.catalogue_file_episode_concealed({}, o)
      : m.candidate_value_unavailable({}, o)
    : undefined;
  const sourceLabel = association
    ? association.direction === 'forward'
      ? currentTitle
      : association.readability === 'concealed'
        ? concealed
        : association.source.label || m.candidate_value_unavailable({}, o)
    : undefined;
  const targetLabel = association
    ? association.direction === 'forward'
      ? association.readability === 'concealed'
        ? concealed
        : association.target.label || m.candidate_value_unavailable({}, o)
      : currentTitle
    : undefined;
  const kindLabel =
    association?.kind === 'episode'
      ? m.catalogue_file_episode({}, o)
      : association?.kind === 'release'
        ? m.catalogue_file_release({}, o)
        : association?.kind === 'group'
          ? m.catalogue_file_group({}, o)
          : association
            ? m.catalogue_file_title({}, o)
            : undefined;
  const property = evidence.label.text || evidence.property;
  const labelLanguage = evidence.label.lang || m.subject_value_unknown({}, o);

  return (
    <section
      id="catalogue-file-inspection"
      role="region"
      aria-labelledby="catalogue-file-inspection-heading"
      aria-live="polite"
      className="min-w-0 space-y-4 rounded-lg border border-border bg-muted/30 p-4"
      data-slot="catalogue-file-inspection"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2
            ref={heading}
            id="catalogue-file-inspection-heading"
            tabIndex={-1}
            className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.catalogue_file_inspection_title({}, o)}
          </h2>
          <p
            lang={evidence.label.lang ?? undefined}
            className="break-words text-muted-foreground [overflow-wrap:anywhere]"
          >
            {property}
          </p>
        </div>
        <button type="button" className={readerControlClass} onClick={() => reading.close(fallback())}>
          {m.catalogue_file_inspection_close({}, o)}
        </button>
      </header>

      {association ? (
        <div className="min-w-0 space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            {m.catalogue_file_inspection_original_value({}, o)}
          </h3>
          <p className="text-sm text-muted-foreground">{kindLabel}</p>
          <p
            className="min-w-0 break-words [overflow-wrap:anywhere]"
            aria-label={`${sourceLabel} ${association.label.text || association.property} ${targetLabel}`}
          >
            <span
              lang={
                association.direction === 'forward'
                  ? (current.lang ?? undefined)
                  : association.readability === 'concealed'
                    ? undefined
                    : association.source.lang
              }
            >
              {sourceLabel}
            </span>{' '}
            <span lang={association.label.lang ?? undefined} className="text-muted-foreground">
              {association.label.text || association.property}
            </span>{' '}
            <span
              lang={
                association.direction === 'inverse'
                  ? (current.lang ?? undefined)
                  : association.readability === 'concealed'
                    ? undefined
                    : association.target.lang
              }
            >
              {targetLabel}
            </span>
          </p>
          {destinationAllowed && destination && related ? (
            <Link className={`${readerLinkClass} ${linkClass} ${linkColor}`} href={destination}>
              {related.label || m.subject_value_unlabelled({}, o)}
            </Link>
          ) : null}
          {association.historical && (
            <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
          )}
          {association.readability === 'concealed' && <p>{concealed}</p>}
          {association.readability === 'unreadable' && <p>{m.release_fidelity_work_unreadable({}, o)}</p>}
        </div>
      ) : (
        <div className="min-w-0 space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            {m.catalogue_file_inspection_original_value({}, o)}
          </h3>
          <div className="min-w-0 break-words [overflow-wrap:anywhere]">
            <FileValue part={statement} publicRead={visit.public} locale={visit.locale} link={link} />
          </div>
          {statement.rezics.release !== currentRelease && (
            <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
          )}
        </div>
      )}

      {currentRelease && (
        <p className="text-sm text-muted-foreground">
          {m.catalogue_file_reader_current_release({ digest: currentRelease }, o)}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        {m.catalogue_file_statement_provenance(
          { digest: statement.rezics.release, revision: String(statement.rezics.revision) },
          o,
        )}
      </p>
      <dl className="min-w-0 text-sm">
        <div className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <dt className="text-muted-foreground">{m.catalogue_file_language({}, o)}</dt>
          <dd lang={evidence.label.lang ?? undefined} className="min-w-0 break-words [overflow-wrap:anywhere]">
            {labelLanguage}
          </dd>
        </div>
      </dl>

      <section className="min-w-0 space-y-2" data-slot="catalogue-file-inspection-qualifiers">
        <h3 className="text-sm font-medium">{m.correction_qualifiers({}, o)}</h3>
        {statement.qualifiers.length ? (
          <dl className="min-w-0 space-y-2 text-sm">
            {qualifierGroups(statement.qualifiers).map(([propertyId, parts]) => {
              const label = propertyLabel(visit, propertyId);
              return (
                <div
                  key={propertyId}
                  data-qualifier-property={propertyId}
                  className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
                >
                  <dt lang={label.lang ?? undefined} className="text-muted-foreground">
                    {label.text}
                  </dt>
                  <dd className="min-w-0 break-words [overflow-wrap:anywhere]">
                    <ol className="space-y-1">
                      {parts.map((part, index) => (
                        <li key={index}>
                          <FileValue part={part} publicRead={visit.public} locale={visit.locale} link={link} />
                        </li>
                      ))}
                    </ol>
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{m.catalogue_file_reader_no_qualifiers({}, o)}</p>
        )}
      </section>

      <section className="min-w-0 space-y-2" data-slot="catalogue-file-inspection-references">
        <h3 className="text-sm font-medium">{m.correction_references({}, o)}</h3>
        {statement.references.length ? (
          <ol className="min-w-0 space-y-3">
            {statement.references.map((reference, referenceIndex) => (
              <li key={referenceIndex} className="min-w-0 border-s-2 border-border ps-3 text-sm">
                <p className="mb-2 text-muted-foreground">
                  {m.correction_references({}, o)} {referenceIndex + 1}
                </p>
                <ul className="min-w-0 space-y-1">
                  {reference.parts.map((part, partIndex) => {
                    const label = propertyLabel(visit, part.property.id);
                    return (
                      <li
                        key={partIndex}
                        className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
                      >
                        <span lang={label.lang ?? undefined} className="text-muted-foreground">
                          {label.text}
                        </span>
                        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                          <FileValue part={part} publicRead={visit.public} locale={visit.locale} link={link} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">{m.catalogue_file_reader_no_references({}, o)}</p>
        )}
      </section>
    </section>
  );
}

export function CatalogueFileReader({
  visit,
  link = PlainLink,
  source = visit.public,
  descriptor,
  currentHref,
  recoverCurrentPage,
}: {
  visit: CatalogueFileReaderVisit;
  link?: PageLink;
  source?: object;
  descriptor?: string;
  currentHref?: string | undefined;
  recoverCurrentPage?: (() => Promise<void>) | undefined;
}) {
  const o = options(visit.locale);
  const pickedTitle = pickText(visit.public.subject.labels, visit.locale);
  const title = pickedTitle.text || m.subject_value_unlabelled({}, o);
  const groupHeadings = useRef(new Map<string, HTMLElement>());
  const inspectionHeading = useRef<HTMLHeadingElement>(null);
  const recoveryButton = useRef<HTMLButtonElement>(null);
  const reading = useCatalogueFileReading({
    source,
    descriptor:
      descriptor ??
      JSON.stringify([
        visit.public.subject.id,
        visit.public.subject.revision,
        visit.public.subject.release,
        visit.digest ?? null,
        visit.locale,
      ]),
    currentHref,
    recoverCurrentPage,
  });
  const evidence = selectedEvidence(visit, reading);
  const fallback = () =>
    groupHeadings.current.get(reading.selection?.group ?? '') ?? recoveryButton.current ?? undefined;
  const setHeading = (key: string, element: HTMLElement | null) => {
    if (element) groupHeadings.current.set(key, element);
    else groupHeadings.current.delete(key);
  };
  useLayoutEffect(() => {
    if (evidence && reading.episode.current()) inspectionHeading.current?.focus();
  }, [evidence?.key, reading.episode]);

  return (
    <article
      id="catalogue-file-reader"
      tabIndex={-1}
      className="min-w-0 space-y-6"
      data-slot="catalogue-file-reader"
      aria-busy={visit.state === 'loading' || reading.recovery?.state === 'pending'}
    >
      <header className="min-w-0 space-y-2">
        <ContentItemHeading level={2} className="text-xl font-semibold">
          {m.catalogue_file_title({}, o)}
        </ContentItemHeading>
        <p className="text-muted-foreground">{m.catalogue_file_intro({}, o)}</p>
        <p>{m.catalogue_file_disclaimer({}, o)}</p>
        <p>{m.catalogue_file_owned_copy_boundary({}, o)}</p>
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1" data-slot="catalogue-file-reader-identity">
          <span>{title}</span>
          <span lang={visit.grain.lang ?? undefined}>{visit.grain.text}</span>
        </p>
      </header>
      {visit.state === 'loading' && <p role="status">{m.candidate_loading({}, o)}</p>}
      {visit.state === 'unavailable' && <p role="status">{m.catalogue_file_reader_unavailable({}, o)}</p>}
      {visit.state === 'unsupported' && <p role="status">{m.catalogue_file_reader_unsupported({}, o)}</p>}
      {visit.state === 'empty' && (
        <p role="status" data-slot="catalogue-file-reader-empty">
          {m.catalogue_file_empty({}, o)}
        </p>
      )}
      {visit.state === 'unavailable' && (
        <div className="flex min-w-0 flex-wrap gap-2" data-slot="catalogue-file-reader-recovery">
          <button
            ref={recoveryButton}
            type="button"
            className={readerControlClass}
            disabled={reading.recovery?.state === 'pending'}
            aria-busy={reading.recovery?.state === 'pending'}
            data-recovery-state={reading.recovery?.state ?? 'idle'}
            onClick={() => void reading.retry()}
          >
            {reading.recovery?.state === 'pending'
              ? m.catalogue_file_reader_retrying({}, o)
              : m.catalogue_file_reader_retry({}, o)}
          </button>
          {currentHref ? (
            <a className={`${readerControlClass} ${linkClass} ${linkColor}`} href={currentHref}>
              {m.catalogue_file_reader_open_again({}, o)}
            </a>
          ) : null}
          {reading.recovery?.state === 'failed' && (
            <p className="w-full" role="alert">
              {m.catalogue_file_reader_retry_failed({}, o)}
            </p>
          )}
        </div>
      )}
      {visit.state === 'ready' || visit.state === 'empty' ? (
        <>
          {evidence && (
            <InspectionPanel
              evidence={evidence}
              visit={visit}
              link={link}
              reading={reading}
              heading={inspectionHeading}
              fallback={fallback}
            />
          )}
          {(['identifiers', 'technical', 'language', 'facts', 'group', 'credits'] as const).map((group) =>
            visit.groups[group].length ? (
              <section key={group} className="min-w-0 space-y-3" data-slot={`catalogue-file-reader-${group}`}>
                <h2
                  ref={(element) => setHeading(group, element)}
                  tabIndex={-1}
                  className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {factGroupTitle(group, visit.locale)}
                </h2>
                {visit.groups[group].map((fact) => (
                  <FactValue
                    key={fact.property}
                    fact={fact}
                    visit={visit}
                    link={link}
                    group={group}
                    heading={() => groupHeadings.current.get(group)}
                    reading={reading}
                  />
                ))}
              </section>
            ) : null,
          )}
          {visit.unknownCodec && <p>{m.catalogue_file_unknown_codec({}, o)}</p>}
          {visit.associations.length > 0 || visit.bounds.length > 0 ? (
            <AssociationList
              visit={visit}
              link={link}
              reading={reading}
              heading={(element) => setHeading('associations', element)}
            />
          ) : null}
          <ProfileBoundNotes bounds={visit.bounds} locale={visit.locale} />
          <ProfileSourceList sources={visit.sources} locale={visit.locale} />
          {visit.correction && visit.release ? (
            <nav className="flex flex-wrap gap-2" data-slot="catalogue-file-reader-correction">
              <CatalogueFileProfileEntry
                id={visit.correction.id}
                type={visit.public.subject.type}
                label={title}
                locale={visit.locale}
                release={visit.release}
                returnSourceId={visit.public.subject.id}
              />
            </nav>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

/** Ordinary Subject overview: active admission plus the exact composed read already rendered on the page. */
export function CatalogueFileReaderOverview({
  page,
  public: publicRead,
  locale,
  link = PlainLink,
  returning = false,
  currentHref,
  recoverCurrentPage,
}: {
  page: SubjectPageData;
  public: SubjectRead;
  locale: string;
  link?: PageLink;
  returning?: boolean;
  currentHref?: string | undefined;
  recoverCurrentPage?: (() => Promise<void>) | undefined;
}) {
  const candidate = catalogueFileReaderCandidate(publicRead);
  if (!candidate) {
    if (!returning) return null;
    const visit = catalogueFileReaderVisit({
      locale,
      public: publicRead,
      unsupported: true,
      relationPages: profileRelationPages(page),
      bounds: boundedProfileRelations(page),
    });
    return (
      <CatalogueFileReader
        visit={visit}
        link={link}
        source={page}
        descriptor={readerDescriptor(page, publicRead, locale, currentHref)}
        currentHref={currentHref}
        recoverCurrentPage={recoverCurrentPage}
      />
    );
  }
  const catalogue = page.catalogue;
  const definitions = catalogue?.state === 'released' ? catalogue.definitions : undefined;
  const visit = catalogueFileReaderVisit({
    locale,
    public: publicRead,
    ...(definitions && catalogue?.digest ? { release: definitions, digest: catalogue.digest } : {}),
    ...(catalogue?.state === 'unsupported' ? { unsupported: true } : {}),
    ...(!catalogue || catalogue.state === 'unavailable' || (catalogue.state === 'released' && !definitions)
      ? { unavailable: true }
      : {}),
    allowCorrection:
      page.viewer?.actions.statementPropose === 'allowed' &&
      !page.requestedRealm &&
      page.context?.population.kind !== 'realm',
    relationPages: profileRelationPages(page),
    bounds: boundedProfileRelations(page),
  });
  return (
    <CatalogueFileReader
      visit={visit}
      link={link}
      source={page}
      descriptor={readerDescriptor(page, publicRead, locale, currentHref)}
      currentHref={currentHref}
      recoverCurrentPage={recoverCurrentPage}
    />
  );
}

function readerDescriptor(page: SubjectPageData, publicRead: SubjectRead, locale: string, currentHref?: string) {
  return JSON.stringify([
    publicRead.subject.id,
    publicRead.subject.revision,
    publicRead.subject.release,
    publicRead.subject.context,
    locale,
    page.subject,
    page.requestedReader ?? null,
    page.viewer?.account ?? null,
    page.viewer?.context ?? null,
    page.context?.id ?? null,
    page.requestedRealm ?? null,
    page.catalogue?.state ?? null,
    page.catalogue?.digest ?? null,
    currentHref ?? null,
  ]);
}

export function CatalogueFileReturnLink({
  id,
  locale,
  link = PlainLink,
}: {
  id: string;
  locale: string;
  link?: PageLink;
}) {
  const sourceId = catalogueFileSourceId(id);
  if (!sourceId) return null;
  const href = catalogueFileSourceReturnHref(sourceId, locale);
  if (!href) return null;
  const Link = link;
  return (
    <p data-slot="catalogue-file-reader-return">
      <Link className={`${readerLinkClass} ${linkClass} ${linkColor}`} href={href}>
        {m.catalogue_file_reader_return({}, options(locale))}
      </Link>
    </p>
  );
}
