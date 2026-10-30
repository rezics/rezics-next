import { Button } from '@rezics/ui/shadcn/button';
import { CandidateValue } from '../pages/data';
import { SourcesSection, type OverviewValue } from '../pages/overview';
import { PlainLink } from '../pages/shared';
import { SubjectFrame, ViewHeading } from '../pages/subject-frame';
import { viewTabLabels } from '../pages/route-support';
import { defaultReader } from '../../subject/reader';
import { m } from '../../paraglide/messages.js';
import type { SourcePart, SourcesPageData, SourcesResult } from './subject-sources';

type Props = { result: SourcesResult | { kind: 'loading' }; locale: string; onRetry?: () => void; busy?: boolean };

function CitationPart({ part, page, locale }: { part: SourcePart; page: SourcesPageData; locale: string }) {
  return (
    <div className="min-w-0 break-words text-sm">
      {part.label.text && <span lang={part.label.lang} className="me-2 text-muted-foreground">{part.label.text}</span>}
      <CandidateValue snak={part.snak} related={page.related} locale={locale} />
    </div>
  );
}

/** The detailed public reader shares the subject frame, value renderer and original Sources presentation. */
export function SubjectSourcesPage({ result, locale, onRetry, busy = false }: Props) {
  const o = { locale: locale as never };
  if (result.kind !== 'ready') return (
    <article className="space-y-4" aria-busy={busy || result.kind === 'loading'}>
      <ViewHeading label={m.subject_sources({}, o)} />
      <p role={result.kind === 'loading' ? 'status' : 'alert'}>
        {result.kind === 'loading' ? m.sources_loading({}, o) : result.kind === 'missing' ? m.not_found_message({}, o) : result.kind === 'denied' ? m.sources_denied({}, o) : result.kind === 'invalid' ? m.sources_invalid({}, o) : result.kind === 'conflict' ? m.sources_conflict({}, o) : m.sources_unavailable({}, o)}
      </p>
      {onRetry && result.kind !== 'loading' && result.kind !== 'missing' && (
        <Button variant="outline" disabled={busy} onClick={onRetry}>{m.sources_retry({}, o)}</Button>
      )}
    </article>
  );
  const { page } = result;
  const unlabelled = m.subject_value_unlabelled({}, o);
  const value: OverviewValue = {
    locale, subject: page.id, subjectLabel: page.title.text, link: PlainLink, reader: defaultReader,
    labels: { spoilerShow: '', documentSpoiler: '', cover: { withheld: '', reveal: '', credit: '', via: '' } },
    unlabelled, spoilerShow: '', details: m.subject_details({}, o), cover: m.subject_cover_credit({}, o),
    coverVia: m.subject_cover_via({}, o), licence: m.subject_source_licence({}, o), source: m.subject_source({}, o),
    sources: m.sources_metadata({}, o), sections: new Map(), relations: {}, relationNodes: [],
  };
  const records = page.sources.records as { name: string; licence?: unknown; attribution?: string }[];
  return (
    <article data-slot="subject-sources-detail" className="flex min-w-0 flex-col gap-8">
      <SubjectFrame
        frame={{ id: page.id, type: '', title: page.title, summary: null }}
        locale={locale} unlabelled={unlabelled} typeLabel={page.typeLabel.text || undefined}
        tabs={[]} tabLabels={viewTabLabels()} view="details"
        navigation={
          <nav aria-label={m.subject_sources({}, o)} className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <a className="underline underline-offset-4" href={page.href}>{m.sources_back({}, o)}</a>
            <a className="underline underline-offset-4" href={`${page.href}/details`}>{m.subject_details({}, o)}</a>
            <span aria-current="page" className="font-medium">{m.subject_sources({}, o)}</span>
          </nav>
        }
      />
      <div className="space-y-2">
        <ViewHeading label={m.subject_sources({}, o)} />
        <p className="text-sm text-muted-foreground">{m.sources_intro({}, o)}</p>
      </div>
      <section aria-labelledby="selected-facts-title" className="min-w-0 space-y-5">
        <h2 id="selected-facts-title" className="text-xl font-semibold">{m.sources_selected({}, o)}</h2>
        {!page.fields.length && <p className="text-muted-foreground">{m.sources_empty({}, o)}</p>}
        {page.fields.map((field, index) => (
          <section key={field.property} aria-labelledby={`source-field-${index}`} className="min-w-0 space-y-3 border-t border-border/60 pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id={`source-field-${index}`} lang={field.label.lang} className="font-semibold">{field.label.text || unlabelled}</h3>
              {field.compareHref && <a className="text-sm text-primary underline underline-offset-4" href={field.compareHref}>{m.sources_compare({}, o)}</a>}
            </div>
            <ul className="space-y-5">
              {field.facts.map((fact, factIndex) => (
                <li key={factIndex} className="min-w-0 space-y-2 break-words">
                  <div className="font-medium">
                    {fact.snak.property.data_type === 'document' ? m.sources_authored({}, o) : fact.snak.property.data_type === 'media' ? m.sources_media({}, o) : <CandidateValue snak={fact.snak} related={page.related} locale={locale} />}
                  </div>
                  {fact.qualifiers.map((part, i) => <CitationPart key={i} part={part} page={page} locale={locale} />)}
                  {fact.citations.length ? (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">{m.sources_citations({}, o)}</p>
                      <ol className="list-decimal space-y-2 ps-5">
                        {fact.citations.map((citation, i) => <li key={i}>{citation.map((part, j) => <CitationPart key={j} part={part} page={page} locale={locale} />)}</li>)}
                      </ol>
                    </div>
                  ) : <p className="text-sm text-muted-foreground">{m.sources_no_citations({}, o)}</p>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </section>
      <div className="min-w-0 space-y-3">
        <SourcesSection value={value} sources={page.sources} />
        <p className="text-sm text-muted-foreground">{m.sources_rights_scope({}, o)}</p>
        {!records.length && <p className="text-sm text-muted-foreground">{m.sources_metadata_unavailable({}, o)}</p>}
        {records.filter((record) => !record.licence || !record.attribution).map((record, index) => (
          <p key={index} className="text-sm text-muted-foreground">
            {record.name}: {!record.licence && m.sources_licence_unknown({}, o)}{!record.licence && !record.attribution ? ' · ' : ''}{!record.attribution && m.sources_attribution_unknown({}, o)}
          </p>
        ))}
        {!page.sources.credit?.license && <p className="text-sm text-muted-foreground">{m.sources_cover_unknown({}, o)}</p>}
      </div>
    </article>
  );
}
