import type { SubjectRead } from '@rezics/client';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
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
import { loadCatalogueFileReaderDefinitions, type CatalogueFileReaderDefinitions } from './actions';
import {
  catalogueFileReaderCandidate,
  catalogueFileReaderVisit,
  exactFileItem,
  type CatalogueFileFact,
  type CatalogueFileReaderVisit,
} from './model';

const readerLinkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8';

type Statement = SubjectRead['subject']['statements'][string][number];
type FilePart = Statement | Statement['qualifiers'][number];

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
}: {
  fact: CatalogueFileFact;
  visit: CatalogueFileReaderVisit;
  link: PageLink;
}) {
  const o = options(visit.locale);
  const release = visit.release;
  if (!release || !visit.digest) return null;
  return (
    <section className="min-w-0 space-y-2" data-property={fact.property}>
      <h3 lang={fact.label.lang ?? undefined} className="text-sm font-medium text-muted-foreground">
        {fact.label.text || fact.property}
      </h3>
      <ol className="min-w-0 space-y-3">
        {fact.statements.map((statement) => (
          <li key={statement.id} className="min-w-0">
            <ContentItemFrame as="div" className="min-w-0 space-y-3 p-4">
              <div className="min-w-0 [overflow-wrap:anywhere]">
                <FileValue part={statement} publicRead={visit.public} locale={visit.locale} link={link} />
              </div>
              {statement.rezics.release !== visit.digest && (
                <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
              )}
              <p className="text-sm text-muted-foreground">
                {m.catalogue_file_statement_provenance(
                  { digest: statement.rezics.release, revision: String(statement.rezics.revision) },
                  o,
                )}
              </p>
              {statement.qualifiers.length > 0 && (
                <dl className="min-w-0 space-y-2 text-sm">
                  {statement.qualifiers.map((part, index) => {
                    const label = pickText(release.properties[part.property.id]?.labels ?? {}, visit.locale);
                    const property = label.text || part.property.id;
                    return (
                      <div
                        key={index}
                        className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
                      >
                        <dt className="text-muted-foreground">{property}</dt>
                        <dd className="min-w-0 [overflow-wrap:anywhere]">
                          <FileValue part={part} publicRead={visit.public} locale={visit.locale} link={link} />
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
              {statement.references.length > 0 && (
                <ol className="min-w-0 space-y-3">
                  {statement.references.map((reference, referenceIndex) => (
                    <li key={referenceIndex} className="min-w-0 border-s-2 border-border ps-3 text-sm">
                      <p className="mb-2 text-muted-foreground">
                        {m.correction_references({}, o)} {referenceIndex + 1}
                      </p>
                      <ul className="min-w-0 space-y-1">
                        {reference.parts.map((part, partIndex) => {
                          const label = pickText(release.properties[part.property.id]?.labels ?? {}, visit.locale);
                          const property = label.text || part.property.id;
                          return (
                            <li
                              key={partIndex}
                              className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
                            >
                              <span className="text-muted-foreground">{property}</span>
                              <span className="min-w-0 [overflow-wrap:anywhere]">
                                <FileValue part={part} publicRead={visit.public} locale={visit.locale} link={link} />
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                </ol>
              )}
            </ContentItemFrame>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AssociationList({ visit, link }: { visit: CatalogueFileReaderVisit; link: PageLink }) {
  const Link = link;
  const o = options(visit.locale);
  const current = pickText(visit.public.subject.labels, visit.locale);
  const currentTitle = current.text || m.subject_value_unlabelled({}, o);
  return (
    <section className="min-w-0 space-y-3" data-slot="catalogue-file-reader-associations">
      <ContentItemHeading level={2} className="text-lg font-semibold">
        {m.catalogue_file_related({}, o)}
      </ContentItemHeading>
      {!visit.associations.length && <p>{m.catalogue_file_empty({}, o)}</p>}
      <ul className="min-w-0 space-y-3">
        {visit.associations.map((association) => {
          const related = association.direction === 'forward' ? association.target : association.source;
          const destination = subjectHref({ id: related.id, label: related.label }, visit.locale).href;
          const href = catalogueFileDestinationHref(destination, visit.public.subject.id, visit.locale);
          const readable = association.readability === 'readable' && !association.historical && href;
          const sourceLabel = association.direction === 'forward' ? currentTitle : association.source.label;
          const targetLabel = association.direction === 'forward' ? association.target.label : currentTitle;
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
            <li key={association.key}>
              <ContentItemFrame as="div" className="min-w-0 space-y-2 p-4">
                <p className="text-sm text-muted-foreground">{kindLabel}</p>
                <p
                  className="min-w-0 [overflow-wrap:anywhere]"
                  aria-label={`${sourceLabel} ${relationLabel} ${targetLabel}`}
                  data-direction={association.direction}
                >
                  <span lang={association.direction === 'forward' ? undefined : association.source.lang}>
                    {sourceLabel}
                  </span>{' '}
                  <span lang={association.label.lang ?? undefined} className="text-muted-foreground">
                    {relationLabel}
                  </span>{' '}
                  <span lang={association.direction === 'forward' ? association.target.lang : undefined}>
                    {targetLabel}
                  </span>
                </p>
                {readable && href ? (
                  <Link className={`${readerLinkClass} ${linkClass} ${linkColor}`} href={href}>
                    {related.label || m.subject_value_unlabelled({}, o)}
                  </Link>
                ) : association.readability === 'concealed' ? (
                  <p>
                    {association.kind === 'episode'
                      ? m.catalogue_file_episode_concealed({}, o)
                      : m.candidate_value_unavailable({}, o)}
                  </p>
                ) : association.historical ? (
                  <p className="text-sm text-muted-foreground">{m.release_fidelity_historical({}, o)}</p>
                ) : (
                  <p>{m.release_fidelity_work_unreadable({}, o)}</p>
                )}
                {association.statement.qualifiers.length > 0 && (
                  <dl className="min-w-0 space-y-2 text-sm">
                    {association.statement.qualifiers.map((part, index) => {
                      const label = pickText(visit.release?.properties[part.property.id]?.labels ?? {}, visit.locale);
                      return (
                        <div
                          key={index}
                          className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
                        >
                          <dt className="text-muted-foreground">{label.text || part.property.id}</dt>
                          <dd className="min-w-0 [overflow-wrap:anywhere]">
                            <FileValue part={part} publicRead={visit.public} locale={visit.locale} link={link} />
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                )}
                {association.statement.references.length > 0 && (
                  <ol className="min-w-0 space-y-3 text-sm">
                    {association.statement.references.map((reference, referenceIndex) => (
                      <li key={referenceIndex} className="border-s-2 border-border ps-3">
                        <p className="mb-2 text-muted-foreground">
                          {m.correction_references({}, o)} {referenceIndex + 1}
                        </p>
                        <ul className="space-y-1">
                          {reference.parts.map((part, partIndex) => {
                            const label = pickText(
                              visit.release?.properties[part.property.id]?.labels ?? {},
                              visit.locale,
                            );
                            return (
                              <li
                                key={partIndex}
                                className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
                              >
                                <span className="text-muted-foreground">{label.text || part.property.id}</span>
                                <span className="min-w-0 [overflow-wrap:anywhere]">
                                  <FileValue part={part} publicRead={visit.public} locale={visit.locale} link={link} />
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </li>
                    ))}
                  </ol>
                )}
                <p className="text-sm text-muted-foreground">
                  {m.catalogue_file_statement_provenance(
                    {
                      digest: association.statement.rezics.release,
                      revision: String(association.statement.rezics.revision),
                    },
                    o,
                  )}
                </p>
              </ContentItemFrame>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function CatalogueFileReader({ visit, link = PlainLink }: { visit: CatalogueFileReaderVisit; link?: PageLink }) {
  const o = options(visit.locale);
  const pickedTitle = pickText(visit.public.subject.labels, visit.locale);
  const title = pickedTitle.text || m.subject_value_unlabelled({}, o);
  const Link = link;
  return (
    <article
      id="catalogue-file-reader"
      tabIndex={-1}
      className="min-w-0 space-y-6"
      data-slot="catalogue-file-reader"
      aria-busy={visit.state === 'loading'}
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
      {visit.state === 'ready' || visit.state === 'empty' ? (
        <>
          {(['identifiers', 'technical', 'language', 'facts', 'group', 'credits'] as const).map((group) =>
            visit.groups[group].length ? (
              <section key={group} className="min-w-0 space-y-3" data-slot={`catalogue-file-reader-${group}`}>
                <ContentItemHeading level={2} className="text-lg font-semibold">
                  {factGroupTitle(group, visit.locale)}
                </ContentItemHeading>
                {visit.groups[group].map((fact) => (
                  <FactValue key={fact.property} fact={fact} visit={visit} link={link} />
                ))}
              </section>
            ) : null,
          )}
          {visit.unknownCodec && <p>{m.catalogue_file_unknown_codec({}, o)}</p>}
          {visit.associations.length > 0 || visit.bounds.length > 0 ? (
            <AssociationList visit={visit} link={link} />
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

function definitionsQueryKey(publicRead: SubjectRead, page: SubjectPageData, locale: string) {
  return [
    'catalogue-file-reader-definitions',
    publicRead.subject.id,
    publicRead.subject.type,
    publicRead.subject.release,
    publicRead.subject.revision,
    publicRead.subject.context,
    page.context?.id ?? '',
    page.requestedRealm ?? '',
    page.requestedReader ?? '',
    locale,
  ] as const;
}

export const catalogueFileReaderDefinitionsKey = definitionsQueryKey;

/** Ordinary Subject overview: active admission plus the exact composed read already rendered on the page. */
export function CatalogueFileReaderOverview({
  page,
  public: publicRead,
  locale,
  link = PlainLink,
  returning = false,
}: {
  page: SubjectPageData;
  public: SubjectRead;
  locale: string;
  link?: PageLink;
  returning?: boolean;
}) {
  const candidate = catalogueFileReaderCandidate(publicRead);
  const query = useQuery<CatalogueFileReaderDefinitions>({
    queryKey: definitionsQueryKey(publicRead, page, locale),
    queryFn: () => loadCatalogueFileReaderDefinitions({ data: undefined }),
    enabled: candidate,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: false,
  });
  if (!candidate) {
    if (!returning) return null;
    const visit = catalogueFileReaderVisit({
      locale,
      public: publicRead,
      unsupported: true,
      relationPages: profileRelationPages(page),
      bounds: boundedProfileRelations(page),
    });
    return <CatalogueFileReader visit={visit} link={link} />;
  }
  const definitions = query.data?.ok ? query.data : undefined;
  const visit = catalogueFileReaderVisit({
    locale,
    public: publicRead,
    ...(definitions ? { release: definitions.release, digest: definitions.digest } : {}),
    ...(query.isPending ? { loading: true } : {}),
    ...(query.isError || query.data?.ok === false ? { unavailable: true } : {}),
    allowCorrection: !page.requestedRealm && page.context?.population.kind !== 'realm',
    relationPages: profileRelationPages(page),
    bounds: boundedProfileRelations(page),
  });
  return <CatalogueFileReader visit={visit} link={link} />;
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
