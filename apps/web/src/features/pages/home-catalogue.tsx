import { CoverCard, CoverGrid } from '@rezics/ui/cover-card';
import { subjectHref } from '../../subject/subject-href';
import { coverOf, coverSubject } from '../../media/summary';
import { coverSrc } from '../../media/cover-src';
import type { LocalHomeSubject } from './local-home-catalogue';
import { PageReadState } from './page-read-state';
import { m } from '../../paraglide/messages.js';
import { PageData } from './data';
import type { RoutePageLoad } from './route';
import { isRecord, pageText } from './shared';
import { TypeList } from './type-list';
import { SubjectLink, subjectPageMessages } from './route-support';

/** Keep the native Home plan and Search-owned TypeList admission, pagination and canonical destinations. */
export function HomeCatalogue({
  result,
  locale,
  localCatalogue,
}: {
  result?: RoutePageLoad | undefined;
  locale: string;
  localCatalogue?: LocalHomeSubject[] | undefined;
}) {
  const o = { locale: locale as never };
  const page = result?.kind === 'page' ? result.page : undefined;
  // These are the route's top-level catalogue slots, never a local search or imported seed manifest.
  const lists =
    page?.document.content.flatMap((node) =>
      isRecord(node) && node.type === 'TypeList' && isRecord(node.props) ? [node.props] : [],
    ) ?? [];
  const messages = subjectPageMessages(locale);
  const previews = new Map(
    lists.map(({ id, types }) => [
      id,
      page?.reads[String(id)]?.status === 503 && Array.isArray(types)
        ? localCatalogue?.filter((subject) => types.includes(subject.type))
        : undefined,
    ]),
  );
  const previewLabel =
    locale === 'zh-Hant' ? '本機驗收資料' : locale === 'zh-Hans' ? '本地验收数据' : 'Local acceptance preview';
  const failure =
    result?.kind === 'rejected' || result?.kind === 'unavailable' || result?.kind === 'preparing' ? result : undefined;
  return (
    <section aria-labelledby="home-catalogue" className="min-w-0 space-y-5 border-t border-border pt-6">
      <h2 id="home-catalogue" className="text-xl font-semibold sm:text-2xl">
        {m.home_catalogue({}, o)}
      </h2>
      {[...previews.values()].some((subjects) => subjects?.length) && (
        <p className="text-sm text-muted-foreground">{previewLabel}</p>
      )}
      {page && lists.length ? (
        <PageData
          locale={locale}
          subject={page.subject ?? null}
          document={page.document}
          reads={page.reads}
          messages={messages}
          link={SubjectLink}
          listTarget={{ route: '/' }}
          pageTarget={{ route: '/' }}
        >
          {lists.map((props) => {
            const candidates = previews.get(props.id);
            if (!candidates?.length) return <TypeList key={props.id as string} {...props} />;
            const title = pageText(props.title, locale);
            return (
              <section key={props.id as string} data-slot="local-home-catalogue" className="min-w-0 space-y-4">
                <h3 className="text-lg font-semibold" lang={title.lang}>
                  {title.text}
                </h3>
                <CoverGrid ratio="2:3">
                  {candidates.map((subject) => (
                    <CoverCard
                      key={subject.id}
                      href={subjectHref({ id: subject.id, label: subject.label.value }, locale).href}
                      title={subject.label.value}
                      titleLang={subject.label.language}
                      cover={{
                        subject: coverSubject(subject.id, subject.label.value, subject),
                        cover: coverOf(subject),
                        src: coverSrc,
                        labels: {
                          withheld: messages.coverWithheld,
                          reveal: messages.coverReveal,
                          credit: messages.coverCredit,
                          via: messages.coverVia,
                        },
                      }}
                    />
                  ))}
                </CoverGrid>
              </section>
            );
          })}
        </PageData>
      ) : (
        <div
          role={failure?.kind === 'preparing' ? 'status' : failure ? 'alert' : 'status'}
          data-home-catalogue-state={result?.kind ?? 'missing'}
          data-response-status={failure?.status ?? ''}
          data-response-code={failure?.code ?? ''}
          className="space-y-2"
        >
          {failure ? (
            <PageReadState key={JSON.stringify(failure)} failure={failure} locale={locale} href={`/${locale}`} />
          ) : result?.kind === 'missing' ? (
            <p>{m.not_found_heading({}, o)}</p>
          ) : null}
        </div>
      )}
      <a
        href={`/${locale}/search`}
        className="inline-flex max-w-full items-center whitespace-normal text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-ring"
      >
        {m.search_heading({}, o)}
      </a>
    </section>
  );
}

/** Stable public identity for the Home TypeList reads; private Library facts never enter this cache key. */
export function homeCatalogueObservation(result?: RoutePageLoad, localCatalogue?: LocalHomeSubject[]): string {
  if (result?.kind !== 'page') return JSON.stringify(['home-catalogue', result ?? { kind: 'missing' }]);
  const lists = result.page.document.content.flatMap((node) =>
    isRecord(node) && node.type === 'TypeList' && isRecord(node.props) && typeof node.props.id === 'string'
      ? [node.props.id]
      : [],
  );
  return JSON.stringify([
    result.page.route,
    result.page.profile,
    result.page.template,
    localCatalogue?.map(({ id, label }) => [id, label]),
    lists.map((id) => {
      const read = result.page.reads[id];
      const body = read?.body;
      const subjects = isRecord(body) && Array.isArray(body.subjects) ? body.subjects : [];
      return [
        id,
        read?.status ?? null,
        subjects.map((subject) =>
          isRecord(subject)
            ? [
                subject.id ?? null,
                subject.type ?? null,
                isRecord(subject.summary) ? subject.summary.creativeWork : null,
              ]
            : null,
        ),
      ];
    }),
  ]);
}
