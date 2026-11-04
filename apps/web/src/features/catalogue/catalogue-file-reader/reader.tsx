import type { SubjectRead } from '@rezics/client';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { pickText } from '@rezics/composition';
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { m } from '../../../paraglide/messages.js';
import { languageName } from '../../../subject/language';
import { subjectHref } from '../../../subject/subject-href';
import { CatalogueFileProfileEntry } from '../catalogue-file-profile/entry';
import { CandidateValue } from '../../pages/data';
import { ProfileBoundNotes, ProfileSourceList } from '../music-reader-view';
import type { SubjectPageData } from '../../pages/subject';
import { boundedProfileRelations, profileRelationPages } from '../../pages/views';
import { linkClass, linkColor, PlainLink, type PageLink } from '../../pages/shared';
import {
  catalogueFileDestinationHref,
  catalogueFileSourceId,
  catalogueFileSourceReturnHref,
  fileEvidenceAt,
  fileEvidenceFragment,
  fileReaderRealm,
  fileReaderSlug,
  type FileEvidenceReturn,
} from './navigation';
import { SpoilerGate } from '../../pages/values';
import { spoilerLevel } from '../../pages/shared';
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
  part?: string | undefined;
  property: string;
  label: { text: string; lang: string | null };
  statement: Statement;
  association?: CatalogueFileAssociation | undefined;
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

const Navigation = createContext<{
  href?: string | undefined;
  spoiler: number;
  trigger?: (key: string, element: HTMLButtonElement | null) => void;
}>({ spoiler: 0 });

function receipt(
  visit: CatalogueFileReaderVisit,
  selection: { key: string; group: string; kind: 'assertion' | 'association' },
  href?: string,
): FileEvidenceReturn {
  const realm = fileReaderRealm(href, visit.public.subject.id, visit.locale);
  return {
    source: visit.public.subject.id,
    slug:
      fileReaderSlug(href, visit.public.subject.id, visit.locale) ??
      encodeURIComponent(
        subjectHref(
          { id: visit.public.subject.id, label: pickText(visit.public.subject.labels, visit.locale).text },
          visit.locale,
        ).params.slug,
      ),
    context: visit.public.subject.context,
    definition: visit.digest ?? '',
    ...(realm ? { realm } : {}),
    ...selection,
    part: 'part' in selection && typeof selection.part === 'string' ? selection.part : 'value',
  };
}

function EvidenceGate({ statement, locale, children }: { statement: Statement; locale: string; children: ReactNode }) {
  const navigation = useContext(Navigation);
  return spoilerLevel(statement) > navigation.spoiler ? (
    <SpoilerGate
      label={m.subject_spoiler_show({}, options(locale))}
      hideLabel={m.subject_spoiler_hide({}, options(locale))}
      unmountOnHide
    >
      {children}
    </SpoilerGate>
  ) : (
    children
  );
}

function assertionKey(visit: CatalogueFileReaderVisit, property: string, statement: Statement) {
  return JSON.stringify([
    'assertion',
    visit.public.subject.id,
    property,
    statement.id,
    statement.rezics.release,
    statement.rezics.revision,
  ]);
}

function associationKey(visit: CatalogueFileReaderVisit, association: CatalogueFileAssociation) {
  return JSON.stringify([
    'association',
    visit.public.subject.id,
    association.direction,
    association.property,
    association.statement.id,
    association.key,
    association.statement.rezics.release,
    association.statement.rezics.revision,
  ]);
}

function propertyLabel(visit: CatalogueFileReaderVisit, property: string) {
  const label = pickText(visit.release?.properties[property]?.labels ?? {}, visit.locale);
  return { text: label.text || m.candidate_value_unavailable({}, options(visit.locale)), lang: label.lang };
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
  visit,
  selection,
  historical = false,
  partKey = 'value',
}: {
  part: FilePart;
  visit: CatalogueFileReaderVisit;
  selection: { key: string; group: string; kind: 'assertion' | 'association' };
  historical?: boolean;
  partKey?: string;
  publicRead: SubjectRead;
  locale: string;
  link: PageLink;
}) {
  const o = options(locale);
  const navigation = useContext(Navigation);
  const content = part.value.type === 'value' ? part.value.content : undefined;
  if (part.property.data_type === 'wikibase-item' && typeof content === 'string') {
    const item = exactFileItem(part, publicRead.related);
    if (!item) return <span>{m.candidate_value_unavailable({}, o)}</span>;
    const picked = pickText(item.labels, locale);
    const label = picked.text || m.subject_value_unlabelled({}, o);
    const href =
      !historical && picked.text
        ? catalogueFileDestinationHref(
            subjectHref({ id: item.id, label }, locale).href,
            publicRead.subject.id,
            locale,
            { ...receipt(visit, selection, navigation.href), part: partKey },
          )
        : undefined;
    if (!href) return <span lang={picked.lang ?? undefined}>{label}</span>;
    const Link = link;
    return (
      <Link
        className={`${readerLinkClass} ${linkClass} ${linkColor}`}
        href={href}
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
  const navigation = useContext(Navigation);
  return (
    <section className="min-w-0 space-y-2" data-property={fact.property}>
      <h3 lang={fact.label.lang ?? undefined} className="text-sm font-medium text-muted-foreground">
        {fact.label.text || m.candidate_value_unavailable({}, o)}
      </h3>
      <ol className="min-w-0 space-y-3">
        {fact.statements.map((statement) => (
          <li key={statement.id} className="min-w-0" data-evidence-kind="assertion">
            <EvidenceGate
              key={assertionKey(visit, fact.property, statement)}
              statement={statement}
              locale={visit.locale}
            >
              <ContentItemFrame as="div" className="min-w-0 space-y-3 p-4">
                <div className="min-w-0 [overflow-wrap:anywhere]">
                  <FileValue
                    part={statement}
                    publicRead={visit.public}
                    locale={visit.locale}
                    link={link}
                    visit={visit}
                    selection={{ key: assertionKey(visit, fact.property, statement), group, kind: 'assertion' }}
                    historical={statement.rezics.release !== visit.digest}
                  />
                </div>
                <button
                  type="button"
                  className={readerControlClass}
                  data-inspection-trigger
                  data-inspection-kind="assertion"
                  ref={(element) => navigation.trigger?.(assertionKey(visit, fact.property, statement), element)}
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
            </EvidenceGate>
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
  const navigation = useContext(Navigation);
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
          const href = catalogueFileDestinationHref(
            destination,
            visit.public.subject.id,
            visit.locale,
            receipt(
              visit,
              { key: associationKey(visit, association), group: 'associations', kind: 'association' },
              navigation.href,
            ),
          );
          const readable = association.readability === 'readable' && !!related.label && !association.historical && href;
          const concealed =
            association.kind === 'episode'
              ? m.catalogue_file_episode_concealed({}, o)
              : m.candidate_value_unavailable({}, o);
          const relatedLabel =
            association.readability === 'concealed' ? concealed : related.label || m.candidate_value_unavailable({}, o);
          const sourceLabel = association.direction === 'forward' ? currentTitle : relatedLabel;
          const targetLabel = association.direction === 'forward' ? relatedLabel : currentTitle;
          const relationLabel = association.label.text || m.candidate_value_unavailable({}, o);
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
              <EvidenceGate
                key={associationKey(visit, association)}
                statement={association.statement}
                locale={visit.locale}
              >
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
                    ref={(element) => navigation.trigger?.(associationKey(visit, association), element)}
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
              </EvidenceGate>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function selectedEvidence(
  visit: CatalogueFileReaderVisit,
  selection: ReturnType<typeof useCatalogueFileReading>['selection'],
  exact = true,
) {
  const matches = (key: string) => {
    if (exact) return key === selection?.key;
    try {
      return (
        JSON.stringify(JSON.parse(key).slice(0, -2)) === JSON.stringify(JSON.parse(selection?.key ?? '').slice(0, -2))
      );
    } catch {
      return false;
    }
  };
  if (!selection) return;
  if (selection.kind === 'assertion') {
    for (const [group, facts] of Object.entries(visit.groups)) {
      if (selection.group !== group) continue;
      for (const fact of facts) {
        for (const statement of fact.statements) {
          if (matches(assertionKey(visit, fact.property, statement)))
            return {
              key: selection.key,
              kind: 'assertion' as const,
              group,
              part: selection.part,
              property: fact.property,
              label: fact.label,
              statement,
              association: visit.associations.find(
                (item) =>
                  item.direction === 'forward' && item.property === fact.property && item.statement.id === statement.id,
              ),
            } satisfies Evidence;
        }
      }
    }
    return;
  }
  const association = visit.associations.find((item) => matches(associationKey(visit, item)));
  if (!association) return;
  return {
    key: selection.key,
    kind: 'association' as const,
    group: selection.group,
    part: selection.part,
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
  const navigation = useContext(Navigation);
  const Link = link;
  const statement = evidence.statement;
  const association = evidence.association;
  const publicRead = association ? { ...visit.public, related: association.related } : visit.public;
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
          receipt(visit, evidence, navigation.href),
        )
      : undefined;
  const destinationAllowed =
    !!association &&
    association.readability === 'readable' &&
    !!related?.label &&
    !association.historical &&
    !!destination;
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
  const property = evidence.label.text || m.candidate_value_unavailable({}, o);
  const labelLanguage = evidence.label.lang || m.subject_value_unknown({}, o);

  if (association && association.readability !== 'readable')
    return (
      <section
        id="catalogue-file-inspection"
        data-slot="catalogue-file-inspection"
        role="region"
        aria-labelledby="catalogue-file-inspection-heading"
        className="space-y-3"
      >
        <h2 id="catalogue-file-inspection-heading" ref={heading} tabIndex={-1}>
          {m.catalogue_file_inspection_title({}, o)}
        </h2>
        <p>{concealed ?? m.candidate_value_unavailable({}, o)}</p>
        <button type="button" className={readerControlClass} onClick={() => reading.close(fallback())}>
          {m.catalogue_file_inspection_close({}, o)}
        </button>
      </section>
    );

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
            aria-label={`${sourceLabel} ${association.label.text || m.candidate_value_unavailable({}, o)} ${targetLabel}`}
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
              {association.label.text || m.candidate_value_unavailable({}, o)}
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
            <FileValue
              part={statement}
              publicRead={publicRead}
              locale={visit.locale}
              link={link}
              visit={visit}
              selection={evidence}
              historical={statement.rezics.release !== visit.digest}
            />
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
                        <li
                          key={index}
                          tabIndex={-1}
                          data-file-evidence-part={`q:${statement.qualifiers.indexOf(part)}`}
                        >
                          <FileValue
                            part={part}
                            partKey={`q:${statement.qualifiers.indexOf(part)}`}
                            publicRead={publicRead}
                            locale={visit.locale}
                            link={link}
                            visit={visit}
                            selection={evidence}
                            historical={statement.rezics.release !== visit.digest}
                          />
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
                        tabIndex={-1}
                        data-file-evidence-part={`r:${referenceIndex}:${partIndex}`}
                        className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
                      >
                        <span lang={label.lang ?? undefined} className="text-muted-foreground">
                          {label.text}
                        </span>
                        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                          <FileValue
                            part={part}
                            partKey={`r:${referenceIndex}:${partIndex}`}
                            publicRead={publicRead}
                            locale={visit.locale}
                            link={link}
                            visit={visit}
                            selection={evidence}
                            historical={statement.rezics.release !== visit.digest}
                          />
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
  readerSpoiler = 0,
  correctionAvailability,
}: {
  correctionAvailability?: 'allowed' | 'denied' | 'unavailable' | undefined;
  readerSpoiler?: number;
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
  const readerElement = useRef<HTMLElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  // A receipt is consumed once per address, never once per response or cache/session incarnation.
  const attemptedReturn = useRef<{ hash: string; episode: object } | undefined>(undefined);
  const [returnOutcome, setReturnOutcome] = useState<'changed' | 'historical' | 'unavailable' | 'retired'>();
  const inspectionHeading = useRef<HTMLHeadingElement>(null);
  const recoveryButton = useRef<HTMLButtonElement>(null);
  const reading = useCatalogueFileReading({
    source,
    descriptor: JSON.stringify([
      readerSpoiler,
      descriptor ??
        JSON.stringify([
          visit.public.subject.id,
          visit.public.subject.revision,
          visit.public.subject.release,
          visit.digest ?? null,
          visit.locale,
          visit.public.subject.context,
          currentHref,
        ]),
    ]),
    currentHref,
    recoverCurrentPage,
  });
  const evidence = selectedEvidence(visit, reading.selection);
  const returned = fileEvidenceAt(currentHref, visit.locale);
  const returnHash = returned?.source === visit.public.subject.id ? fileEvidenceFragment(returned) : undefined;
  const fallback = () =>
    groupHeadings.current.get(reading.selection?.group ?? '') ?? recoveryButton.current ?? undefined;
  const setHeading = (key: string, element: HTMLElement | null) => {
    if (element) groupHeadings.current.set(key, element);
    else groupHeadings.current.delete(key);
  };
  useEffect(() => {
    let cancelled = false;
    // Let the current session/cache subscription settle before consuming a navigation receipt.
    queueMicrotask(() => {
      if (cancelled) return;
      if (!returned || !returnHash) {
        attemptedReturn.current = undefined;
        setReturnOutcome(undefined);
        return;
      }
      if (!reading.episode.current()) return;
      if (attemptedReturn.current?.hash === returnHash) {
        if (attemptedReturn.current.episode === reading.episode) return;
        // Replacing an admitted reading must not replay the URL's old selection (including A/B/A).
        setReturnOutcome('retired');
        (groupHeadings.current.get(returned.group) ?? recoveryButton.current ?? readerElement.current)?.focus();
        return;
      }
      if (visit.state === 'loading') return;
      attemptedReturn.current = { hash: returnHash, episode: reading.episode };
      const resolved = selectedEvidence(visit, returned);
      const contextMatches =
        returned.context === visit.public.subject.context &&
        returned.realm === fileReaderRealm(currentHref, visit.public.subject.id, visit.locale);
      const currentRow = resolved ?? selectedEvidence(visit, returned, false);
      const historical =
        !!currentRow && (currentRow.statement.rezics.release !== visit.digest || !!currentRow.association?.historical);
      const available =
        (visit.state === 'ready' || visit.state === 'empty') &&
        (!resolved?.association || resolved.association.readability === 'readable') &&
        (!resolved || spoilerLevel(resolved.statement) <= readerSpoiler);
      const part = returned.part.split(':');
      const partExists =
        returned.part === 'value' ||
        (resolved &&
          (part[0] === 'q'
            ? !!resolved.statement.qualifiers[Number(part[1])]
            : !!resolved.statement.references[Number(part[1])]?.parts[Number(part[2])]));
      const opener = resolved ? triggers.current.get(resolved.key) : undefined;
      if (
        contextMatches &&
        returned.definition === visit.digest &&
        resolved &&
        partExists &&
        !historical &&
        available &&
        opener
      ) {
        setReturnOutcome(undefined);
        reading.select(returned, opener, groupHeadings.current.get(returned.group), true);
      } else {
        setReturnOutcome(!available ? 'unavailable' : historical ? 'historical' : 'changed');
        (groupHeadings.current.get(returned.group) ?? recoveryButton.current ?? readerElement.current)?.focus();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reading.episode, returnHash]);
  useLayoutEffect(() => {
    if (evidence && reading.episode.current()) {
      const part =
        evidence.part && evidence.part !== 'value'
          ? readerElement.current?.querySelector<HTMLElement>(
              `[data-slot="catalogue-file-inspection"] [data-file-evidence-part="${evidence.part}"]`,
            )
          : undefined;
      (part ?? inspectionHeading.current)?.focus();
    }
  }, [evidence?.key, reading.episode]);

  return (
    <Navigation.Provider
      value={{
        href: currentHref,
        spoiler: readerSpoiler,
        trigger: (key, element) => {
          if (element) triggers.current.set(key, element);
          else triggers.current.delete(key);
        },
      }}
    >
      <article
        ref={readerElement}
        onClickCapture={(event) => {
          if (!reading.episode.current() && (event.target as Element).closest('a')) event.preventDefault();
        }}
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
        {returnOutcome && (
          <p role="status" data-slot="catalogue-file-return-outcome">
            {returnOutcome === 'unavailable'
              ? m.catalogue_file_return_unavailable({}, o)
              : returnOutcome === 'historical'
                ? m.catalogue_file_return_historical({}, o)
                : returnOutcome === 'retired'
                  ? m.catalogue_file_return_retired({}, o)
                  : m.catalogue_file_return_changed({}, o)}
          </p>
        )}
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
              <EvidenceGate key={evidence.key} statement={evidence.statement} locale={visit.locale}>
                <InspectionPanel
                  evidence={evidence}
                  visit={visit}
                  link={link}
                  reading={reading}
                  heading={inspectionHeading}
                  fallback={fallback}
                />
              </EvidenceGate>
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
            {!visit.correction && correctionAvailability && correctionAvailability !== 'allowed' && (
              <p data-slot="catalogue-file-correction-advice">
                {correctionAvailability === 'denied'
                  ? m.changes_correction_denied({}, o)
                  : m.correction_actions_unavailable({}, o)}
              </p>
            )}
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
    </Navigation.Provider>
  );
}

/** Ordinary Subject overview: active admission plus the exact composed read already rendered on the page. */
export function CatalogueFileReaderOverview({
  page,
  public: publicRead,
  locale,
  link = PlainLink,
  returning = false,
  readerSpoiler = 0,
  currentHref,
  recoverCurrentPage,
}: {
  page: SubjectPageData;
  public: SubjectRead;
  locale: string;
  link?: PageLink;
  returning?: boolean;
  readerSpoiler?: number;
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
        readerSpoiler={readerSpoiler}
        correctionAvailability={page.viewer?.actions.statementPropose}
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
      readerSpoiler={readerSpoiler}
      correctionAvailability={page.viewer?.actions.statementPropose}
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
  currentHref,
  locale,
  link = PlainLink,
}: {
  id: string;
  currentHref?: string | undefined;
  locale: string;
  link?: PageLink;
}) {
  const sourceId = catalogueFileSourceId(id);
  if (!sourceId) return null;
  const href = catalogueFileSourceReturnHref(sourceId, locale, '', fileEvidenceAt(currentHref, locale));
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
