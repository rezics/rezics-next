import { useId, type Ref } from 'react';
import { ContextNavigation, contextHref } from '../pages/context-navigation';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { CandidateValue } from '../pages/data';
import { SourcesSection, type OverviewValue } from '../pages/overview';
import { PlainLink, type PageLink } from '../pages/shared';
import { SubjectFrame, ViewHeading } from '../pages/subject-frame';
import { viewTabLabels } from '../pages/route-support';
import { defaultReader } from '../../subject/reader';
import { m } from '../../paraglide/messages.js';
import type { SourcePart, SourcesPageData, SourcesResult } from './subject-sources';

type Props = {
  result: SourcesResult | { kind: 'loading' };
  locale: string;
  onRetry?: () => void;
  busy?: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
};
const linkClassName =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function CitationPart({
  part,
  page,
  locale,
  link,
}: {
  part: SourcePart;
  page: SourcesPageData;
  locale: string;
  link: PageLink;
}) {
  return (
    <div className="min-w-0 break-words text-sm">
      {part.label.text && (
        <span lang={part.label.lang} className="me-2 text-muted-foreground">
          {part.label.text}
        </span>
      )}
      <CandidateValue snak={part.snak} related={page.related} locale={locale} link={link} />
    </div>
  );
}

/** The detailed public reader shares the subject frame, value renderer and original Sources presentation. */
export function SubjectSourcesPage({ result, locale, onRetry, busy = false, headingRef }: Props) {
  const headingId = useId();
  const o = { locale: locale as never };
  if (result.kind !== 'ready')
    return (
      <article className="space-y-4" aria-busy={busy || result.kind === 'loading'}>
        <ViewHeading
          label={m.subject_sources({}, o)}
          headingClassName="font-sans focus-visible:outline-2 focus-visible:outline-ring"
          headingRef={headingRef}
          headingTabIndex={-1}
        />
        <p role={result.kind === 'loading' ? 'status' : 'alert'}>
          {result.kind === 'loading'
            ? m.sources_loading({}, o)
            : result.kind === 'missing'
              ? m.not_found_message({}, o)
              : result.kind === 'denied'
                ? m.sources_denied({}, o)
                : result.kind === 'invalid'
                  ? m.sources_invalid({}, o)
                  : result.kind === 'conflict'
                    ? m.sources_conflict({}, o)
                    : m.sources_unavailable({}, o)}
        </p>
        {onRetry && result.kind !== 'loading' && result.kind !== 'missing' && (
          <Button
            variant="outline"
            className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere]"
            disabled={busy}
            onClick={() => onRetry()}
          >
            {m.sources_retry({}, o)}
          </Button>
        )}
      </article>
    );
  const { page } = result;
  const ContextLink: PageLink = ({ href, ...props }) => <PlainLink {...props} href={contextHref(href, page.realm)} />;
  const unlabelled = m.subject_value_unlabelled({}, o);
  const value: OverviewValue = {
    locale,
    subject: page.id,
    subjectLabel: page.title.text,
    link: ContextLink,
    realm: page.realm,
    reader: defaultReader,
    labels: { spoilerShow: '', documentSpoiler: '', cover: { withheld: '', reveal: '', credit: '', via: '' } },
    unlabelled,
    spoilerShow: '',
    details: m.subject_details({}, o),
    cover: m.subject_cover_credit({}, o),
    coverVia: m.subject_cover_via({}, o),
    licence: m.subject_source_licence({}, o),
    source: m.subject_source({}, o),
    sources: m.sources_metadata({}, o),
    sections: new Map(),
    relations: {},
    relationNodes: [],
  };
  const records = page.sources.records as { name: string; licence?: unknown; attribution?: string }[];
  return (
    <article data-slot="subject-sources-detail" className="flex min-w-0 flex-col gap-8 [overflow-wrap:anywhere]">
      <SubjectFrame
        frame={{ id: page.id, type: '', title: page.title, summary: null }}
        locale={locale}
        realm={page.realm}
        unlabelled={unlabelled}
        {...(page.typeLabel.text ? { typeLabel: page.typeLabel.text } : {})}
        tabs={[]}
        tabLabels={viewTabLabels()}
        view="details"
        navigation={
          <nav aria-label={m.subject_sources({}, o)} className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <a className={linkClassName} href={page.href}>
              {m.sources_back({}, o)}
            </a>
            <a className={linkClassName} href={contextHref(`${page.href.split('?', 1)[0]}/details`, page.realm)}>
              {m.subject_details({}, o)}
            </a>
            <span aria-current="page" className="font-medium">
              {m.subject_sources({}, o)}
            </span>
          </nav>
        }
      />
      <ContextNavigation
        context={page.context}
        realm={page.realm}
        href={page.sourcesHref.split('?', 1)[0]!}
        locale={locale}
      />
      <div className="space-y-2">
        <ViewHeading
          label={m.subject_sources({}, o)}
          headingClassName="font-sans focus-visible:outline-2 focus-visible:outline-ring"
          headingRef={headingRef}
          headingTabIndex={-1}
        />
        <p className="text-sm text-muted-foreground">{m.sources_intro({}, o)}</p>
      </div>
      <section aria-labelledby={`${headingId}-selected-facts-title`} className="min-w-0 space-y-5">
        <h2 id={`${headingId}-selected-facts-title`} className="text-xl font-semibold">
          {m.sources_selected({}, o)}
        </h2>
        {!page.fields.length && <p className="text-muted-foreground">{m.sources_empty({}, o)}</p>}
        {page.fields.map((field, index) => (
          <section key={field.property} aria-labelledby={`${headingId}-source-field-${index}`} className="min-w-0">
            <ContentItemFrame as="div" data-slot="source-property" className="min-w-0 space-y-3 py-3 sm:py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <ContentItemHeading
                  level={3}
                  id={`${headingId}-source-field-${index}`}
                  lang={field.label.lang}
                  className="min-w-0 font-semibold [overflow-wrap:anywhere]"
                >
                  {field.label.text || unlabelled}
                </ContentItemHeading>
                {field.compareHref && (
                  <a className={`${linkClassName} text-sm text-primary`} href={field.compareHref}>
                    {m.sources_compare({}, o)}
                  </a>
                )}
              </div>
              <ul className="space-y-1">
                {field.facts.map((fact, factIndex) => (
                  <li key={factIndex} className="min-w-0">
                    <ContentItemFrame
                      as="div"
                      data-slot="source-statement"
                      className="min-w-0 space-y-2 py-3 [overflow-wrap:anywhere] sm:py-4 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:items-center [&_a]:rounded-sm [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring"
                    >
                      <ContentItemHeading
                        level={4}
                        className="text-[17px] font-semibold leading-snug sm:text-lg md:text-xl"
                      >
                        {fact.display === 'document' ? (
                          m.sources_authored({}, o)
                        ) : fact.display === 'media' ? (
                          m.sources_media({}, o)
                        ) : (
                          <CandidateValue snak={fact.snak} related={page.related} locale={locale} link={ContextLink} />
                        )}
                      </ContentItemHeading>
                      {!!fact.qualifiers.length && (
                        <div data-content-item-slot="metadata" className="min-w-0 space-y-1 text-sm">
                          {fact.qualifiers.map((part, i) => (
                            <CitationPart key={i} part={part} page={page} locale={locale} link={ContextLink} />
                          ))}
                        </div>
                      )}
                      <div data-content-item-slot="preview" className="min-w-0 space-y-2 text-sm leading-relaxed">
                        {fact.citations.length ? (
                          <div className="space-y-2">
                            <p className="text-sm text-muted-foreground">{m.sources_citations({}, o)}</p>
                            <ol className="list-decimal space-y-2 ps-5">
                              {fact.citations.map((citation, i) => (
                                <li key={i}>
                                  {citation.map((part, j) => (
                                    <CitationPart key={j} part={part} page={page} locale={locale} link={ContextLink} />
                                  ))}
                                </li>
                              ))}
                            </ol>
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">{m.sources_no_citations({}, o)}</p>
                        )}
                      </div>
                    </ContentItemFrame>
                  </li>
                ))}
              </ul>
            </ContentItemFrame>
          </section>
        ))}
      </section>
      <div className="min-w-0 space-y-3 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:items-center [&_a]:rounded-sm [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring">
        <SourcesSection value={value} sources={page.sources} />
        <p className="text-sm text-muted-foreground">{m.sources_rights_scope({}, o)}</p>
        {!records.length && <p className="text-sm text-muted-foreground">{m.sources_metadata_unavailable({}, o)}</p>}
        {records
          .filter((record) => !record.licence || !record.attribution)
          .map((record, index) => (
            <p key={index} className="text-sm text-muted-foreground">
              {record.name}: {!record.licence && m.sources_licence_unknown({}, o)}
              {!record.licence && !record.attribution ? ' · ' : ''}
              {!record.attribution && m.sources_attribution_unknown({}, o)}
            </p>
          ))}
        {!page.sources.credit?.license && (
          <p className="text-sm text-muted-foreground">{m.sources_cover_unknown({}, o)}</p>
        )}
      </div>
    </article>
  );
}
